import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { resetTestLibrary } from './ui-helpers.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const sample = fs.readFileSync(path.resolve('示例/示例题目.png'));
const errors = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

let analyzeCalls = 0;
function aiQuestion(pageNumber) {
  return {
    sourceNumber: String(pageNumber),
    type: 'single',
    stem: `第 ${pageNumber} 张图片的模拟题目`,
    options: [
      { key: 'A', text: '错误项' },
      { key: 'B', text: '正确项' },
    ],
    answer: 'B',
    explanation: '',
    confidence: 0.95,
    warnings: [],
    page: pageNumber,
  };
}

try {
  await resetTestLibrary(BASE);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  await page.route('**/api/ai/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        configured: true,
        endpoint: 'http://mock.local/v1',
        model: 'mock-text',
        hasApiKey: true,
      }),
    }),
  );
  await page.route('**/api/ai/analyze', async (route) => {
    analyzeCalls += 1;
    if (analyzeCalls === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: '模拟 AI 暂时失败' }),
      });
      return;
    }
    const payload = route.request().postDataJSON();
    const pageNumber = Number(payload?.pageNumber) || 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        questions: [aiQuestion(pageNumber)],
        pageWarnings: [],
        pageNumber,
        model: 'mock-text',
        usage: {},
      }),
    });
  });

  await page.locator('.nav-item[data-nav="import"]').click();
  await page.waitForSelector('.import-page');
  await page.locator('input[data-role="file-input"]:not([capture])').setInputFiles([
    { name: 'page-a.png', mimeType: 'image/png', buffer: sample },
    { name: 'page-b.png', mimeType: 'image/png', buffer: sample },
  ]);
  await page.waitForFunction(
    () => document.querySelector('[data-ocr-summary]')?.innerText.includes('已识别 2 / 2'),
    undefined,
    { timeout: 120_000 },
  );

  await page.locator('[data-action="ai-review"]').click();
  await page.waitForSelector('dialog[open] [data-confirm]');
  await page.locator('dialog[open] [data-confirm]').click();
  await page.waitForSelector('.ai-result', { timeout: 30_000 });
  const firstSummary = await page.locator('.ai-result-summary').innerText();
  console.log('first AI summary', firstSummary);
  if (!firstSummary.includes('分析失败')) {
    throw new Error('Expected one failed AI page in the first analysis');
  }
  if (analyzeCalls !== 2) throw new Error(`Expected 2 analyze calls, got ${analyzeCalls}`);
  await page.locator('[data-ai-dialog-cancel]').click();
  await page.waitForSelector('.ai-result', { state: 'detached' });

  const retryButton = page.locator('[data-action="retry-ai-failed"]');
  await retryButton.waitFor({ state: 'visible' });
  console.log('retry button', await retryButton.innerText());
  await retryButton.click();
  await page.waitForSelector('dialog[open] [data-confirm]');
  await page.locator('dialog[open] [data-confirm]').click();
  await page.waitForSelector('.ai-result', { timeout: 30_000 });
  const retriedSummary = await page.locator('.ai-result-summary').innerText();
  console.log('retried AI summary', retriedSummary);
  if (retriedSummary.includes('分析失败')) {
    throw new Error('Retry should resolve the failed AI page');
  }
  if (analyzeCalls !== 3) throw new Error(`Expected 3 analyze calls, got ${analyzeCalls}`);
  await page.locator('[data-ai-dialog-cancel]').click();
  await page.waitForSelector('.ai-result', { state: 'detached' });
  if (await retryButton.isVisible()) {
    throw new Error('Retry button should disappear after all AI pages succeed');
  }
  const aiStates = await page.locator('.file-ai-state').allInnerTexts();
  console.log('final AI states', aiStates);
  if (aiStates.some((label) => label.includes('失败'))) {
    throw new Error('A file is still marked as AI failed');
  }

  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('AI RETRY UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/ai-retry-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
