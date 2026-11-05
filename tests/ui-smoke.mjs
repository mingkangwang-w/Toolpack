import { chromium } from 'playwright-core';
import path from 'node:path';
import { resetTestLibrary } from './ui-helpers.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const sample = path.resolve('示例/示例题目.png');
const errors = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

async function shot(name, fullPage = true) {
  await page.screenshot({ path: `tests/${name}.png`, fullPage });
  console.log('shot', name);
}

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
        subjects: [{ id: 'subject-ui-smoke', name: '测试科目', createdAt: now, updatedAt: now }],
        banks: [
          {
            id: 'bank-ui-smoke',
            subjectId: 'subject-ui-smoke',
            name: '测试子题库',
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
          lastBankId: 'bank-ui-smoke',
        },
      }),
    );
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dashboard-page');
  console.log('dashboard loaded');

  await page.locator('.nav-item[data-nav="import"]').click();
  await page.waitForSelector('.import-page');
  await page.locator('input[data-role="file-input"]:not([capture])').setInputFiles(sample);
  await page.waitForSelector('.preview-card', { timeout: 90_000 });
  const previewCount = await page.locator('.preview-card').count();
  console.log('preview count', previewCount);
  await shot('import-preview');

  await page.locator('.preview-actions [data-action="save"]').click();
  await page.waitForSelector('.library-page', { timeout: 10_000 });
  const libraryCount = await page.locator('.question-row').count();
  console.log('library count', libraryCount);
  await shot('library');

  await page.locator('.nav-item[data-nav="practice"]').click();
  await page.waitForSelector('.practice-setup-page');
  await shot('practice-setup');

  await page.locator('[data-count="all"]').click();
  await page.locator('[data-order="ordered"]').click();
  await page.locator('.setup-start-row [data-action="start"]').click();
  await page.waitForSelector('.session-page');
  await shot('practice-session', false);

  // Q1: single, B. Choosing a single-choice option auto-submits and shows feedback.
  await page.locator('[data-answer-key="B"]').click();
  await page.waitForSelector('[data-feedback]');
  await shot('practice-feedback', false);
  await page.locator('[data-action="next-question"]').click();

  // Go back to verify the previous answer and feedback are restored.
  await page.locator('[data-action="prev-question"]').click();
  await page.waitForFunction(
    () => document.querySelector('.session-progress-copy b')?.textContent === '1',
  );
  if (!(await page.locator('[data-feedback]').count())) {
    throw new Error('Previous answer feedback was not restored');
  }
  await page.locator('[data-action="next-question"]').click();

  // Q2: single, C
  await page.locator('[data-answer-key="C"]').click();
  await page.waitForSelector('[data-feedback]');
  await page.locator('[data-action="next-question"]').click();

  // Q3: fill, OCR gives H□O (whatever is stored), answer from localStorage
  const fillAnswer = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('shuati-helper:data:v1'));
    return data.questions[2]?.answer || '';
  });
  await page.locator('[data-role="fill-answer"]').fill(fillAnswer);
  await page.locator('[data-action="submit-answer"]').click();
  await page.waitForSelector('[data-feedback]');
  await page.locator('[data-action="next-question"]').click();

  // Q4: judge, B. Judge options also auto-submit.
  await page.locator('[data-answer-key="B"]').click();
  await page.waitForSelector('[data-feedback]');
  await page.locator('[data-action="next-question"]').click();

  await page.waitForSelector('.summary-page');
  await shot('practice-summary');
  console.log('summary reached');

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.nav-item[data-nav="library"]').click();
  await page.waitForSelector('.library-page');
  console.log('persisted rows', await page.locator('.question-row').count());
  const statuses = await page.locator('.question-row .status-badge').allInnerTexts();
  console.log('persisted statuses', statuses);
  if (statuses.every((label) => label === '未练习')) {
    throw new Error('Practice statistics were lost after reading Markdown library');
  }

  await page.locator('.sidebar-tool[data-global-action="data"]').click();
  await page.waitForSelector('.data-manager');
  await shot('data-dialog', false);
  await page.locator('[data-data-close]').click();

  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('TEST FAILED', error);
  await shot('failure');
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
