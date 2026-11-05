import { chromium } from 'playwright-core';
import path from 'node:path';
import { resetTestLibrary } from './ui-helpers.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const sample = path.resolve('示例/示例题目.png');
const errors = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

try {
  await resetTestLibrary(BASE);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const now = new Date().toISOString();
    localStorage.clear();
    localStorage.setItem(
      'shuati-helper:data:v1',
      JSON.stringify({
        version: 2,
        subjects: [{ id: 'subject-ui-ai', name: 'AI 测试科目', createdAt: now, updatedAt: now }],
        banks: [
          {
            id: 'bank-ui-ai',
            subjectId: 'subject-ui-ai',
            name: 'AI 测试子题库',
            createdAt: now,
            updatedAt: now,
          },
        ],
        questions: [],
        history: [],
        settings: {
          theme: null,
          practiceCount: 10,
          practiceShuffle: true,
          lastBankId: 'bank-ui-ai',
        },
      }),
    );
  });
  await page.reload({ waitUntil: 'networkidle' });

  // AI settings should surface the server config but never expose the key.
  await page.locator('.sidebar-tool[data-global-action="ai"]').click();
  await page.waitForSelector('.ai-settings');
  await page.waitForTimeout(350);
  const bodyText = await page.locator('body').innerText();
  if (bodyText.includes('sk-test-shuati-123456')) throw new Error('API key leaked into page DOM');
  const keyField = await page.locator('[data-ai-key]').inputValue();
  if (keyField) throw new Error('API key was prefilled in the key field');
  if (!bodyText.includes('AI 只分析文字')) {
    throw new Error('AI settings should state that AI only analyzes text');
  }
  const instructionInput = page.locator('[data-ai-instructions]');
  if (!(await instructionInput.isVisible())) {
    throw new Error('AI settings should expose the custom instruction editor');
  }
  await page.locator('[data-ai-instructions-sample]').click();
  if (!(await instructionInput.inputValue()).includes('回答保持简洁')) {
    throw new Error('Instruction template was not inserted');
  }
  const customRules = 'UI 测试规则：回答保持简洁，先给结论。';
  await instructionInput.fill(customRules);
  await page.screenshot({ path: 'tests/ai-settings.png', fullPage: false });

  await page.locator('[data-ai-test]').click();
  await page.waitForSelector('.ai-test-status.is-success', { timeout: 30_000 });
  console.log('AI text test:', await page.locator('.ai-test-status').innerText());
  await page.screenshot({ path: 'tests/ai-settings-tested.png', fullPage: false });
  await page.locator('[data-ai-save]').click();
  await page.waitForSelector('.ai-settings', { state: 'detached' });
  await page.waitForTimeout(250);
  const savedConfig = await page.evaluate(async () => {
    const response = await fetch('/api/ai/config');
    return response.json();
  });
  if (savedConfig.customInstructions !== customRules) {
    throw new Error('Custom AI instructions were not persisted');
  }
  console.log('AI settings save works');

  // Import one sample page, run AI text analysis, confirm, apply, save.
  await page.locator('.nav-item[data-nav="import"]').click();
  await page.waitForSelector('.import-page');
  await page.locator('input[data-role="file-input"]:not([capture])').setInputFiles(sample);
  await page.waitForSelector('.preview-card', { timeout: 90_000 });
  await page.waitForFunction(() => !document.querySelector('[data-ai-review-status]:not([hidden])'));

  await page.locator('[data-action="ai-review"]').click();
  await page.waitForSelector('dialog[open] .confirm-message');
  await page.locator('dialog[open] [data-confirm]').click();
  await page.waitForSelector('.ai-result', { timeout: 60_000 });
  await page.waitForTimeout(400);
  console.log('AI cards', await page.locator('[data-ai-pick]').count());
  await page.screenshot({ path: 'tests/ai-review-result.png', fullPage: false });

  const mismatch = await page.locator('.ai-count-warning').count();
  console.log('count mismatch shown', mismatch);

  await page.locator('[data-ai-dialog-apply]').click();
  await page.waitForTimeout(500);
  const previewCount = await page.locator('.preview-card').count();
  console.log('preview after apply', previewCount);
  if (previewCount !== 3) throw new Error(`Expected 3 AI previews, got ${previewCount}`);
  await page.screenshot({ path: 'tests/ai-applied-preview.png', fullPage: true });

  await page.locator('.preview-actions [data-action="save"]').click();
  await page.waitForSelector('.library-page', { timeout: 10_000 });
  const saved = await page.locator('.question-row').count();
  console.log('library rows after AI save', saved);
  if (saved !== 3) throw new Error(`Expected 3 saved questions, got ${saved}`);
  const reviewBadges = await page.locator('.question-row .ai-review-badge').count();
  console.log('AI review badges', reviewBadges);
  if (!reviewBadges) throw new Error('AI warnings were not marked in the library');

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.nav-item[data-nav="library"]').click();
  await page.waitForSelector('.library-page');
  const persistedBadges = await page.locator('.question-row .ai-review-badge').count();
  console.log('AI review badges after disk reload', persistedBadges);
  if (persistedBadges !== reviewBadges) {
    throw new Error('AI review warnings did not persist through Markdown reload');
  }

  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('AI UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/ai-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
