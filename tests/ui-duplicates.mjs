import { chromium } from 'playwright-core';
import { resetTestLibrary } from './ui-helpers.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const errors = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

const now = new Date().toISOString();
const stats = () => ({
  attempts: 0,
  correct: 0,
  wrong: 0,
  streak: 0,
  lastResult: null,
  lastAt: null,
});

const seed = {
  version: 2,
  subjects: [{ id: 'dup-subject', name: '重复题测试', createdAt: now, updatedAt: now }],
  banks: [
    {
      id: 'dup-bank',
      subjectId: 'dup-subject',
      name: '测试题库',
      createdAt: now,
      updatedAt: now,
    },
  ],
  questions: [
    {
      id: 'dup-existing',
      subjectId: 'dup-subject',
      bankId: 'dup-bank',
      type: 'fill',
      stem: '重复题：请填写答案。',
      options: [],
      answer: '已有答案',
      explanation: '',
      favorite: false,
      createdAt: now,
      updatedAt: now,
      stats: stats(),
    },
  ],
  history: [],
  settings: {
    theme: 'light',
    practiceCount: 'all',
    practiceShuffle: false,
    practiceFeedbackMode: 'immediate',
    lastBankId: 'dup-bank',
  },
};

async function fillPreview(index, stem, answer) {
  const card = page.locator('.preview-card').nth(index);
  await card.locator('[data-field="type"]').selectOption('fill');
  await card.locator('[data-field="stem"]').fill(stem);
  await card.locator('[data-field="answer-text"]').fill(answer);
  await page.waitForTimeout(80);
}

try {
  await resetTestLibrary(BASE);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((data) => {
    localStorage.clear();
    localStorage.setItem('shuati-helper:data:v1', JSON.stringify(data));
  }, seed);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dashboard-page');

  await page.locator('.nav-item[data-nav="import"]').click();
  await page.waitForSelector('.import-page');
  // 测试不跑 OCR，直接展开校对工作区以添加空白题。
  await page.evaluate(() => {
    const workbench = document.querySelector('[data-workbench]');
    if (workbench) workbench.hidden = false;
  });
  await page.locator('[data-action="add-preview"]').click();
  await page.locator('[data-action="add-preview"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.preview-card').length === 2);

  await fillPreview(0, '全新的题目：请填写答案。', '新题答案');
  await fillPreview(1, '重复题 请填写答案', '另一份答案');

  await page.locator('.preview-actions [data-action="save"]').click();
  await page.waitForSelector('dialog[open] .duplicate-choice', { timeout: 10_000 });
  if ((await page.locator('.duplicate-choice').count()) !== 1) {
    throw new Error('Expected exactly one duplicate candidate');
  }
  const duplicateText = await page.locator('.duplicate-choice').innerText();
  if (!duplicateText.includes('重复题') || !duplicateText.includes('已保存题目')) {
    throw new Error(`Duplicate row is missing match context: ${duplicateText}`);
  }
  const keepBox = page.locator('[data-keep-duplicate]');
  if (!(await keepBox.isChecked())) throw new Error('Duplicate should be kept by default');
  const initialConfirm = await page.locator('[data-duplicate-confirm]').innerText();
  if (!initialConfirm.includes('保存 2 道题')) {
    throw new Error(`Unexpected initial save count: ${initialConfirm}`);
  }

  await keepBox.uncheck();
  const skippedConfirm = await page.locator('[data-duplicate-confirm]').innerText();
  if (!skippedConfirm.includes('保存 1 道题')) {
    throw new Error(`Unexpected skip save count: ${skippedConfirm}`);
  }
  await page.screenshot({ path: 'tests/duplicates-dialog.png' });
  await page.locator('[data-duplicate-confirm]').click();
  await page.waitForSelector('.library-page', { timeout: 20_000 });

  const stored = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('shuati-helper:data:v1'));
    return data.questions.map((question) => question.stem);
  });
  if (stored.length !== 2 || !stored.includes('全新的题目：请填写答案。')) {
    throw new Error(`Unexpected saved questions: ${JSON.stringify(stored)}`);
  }
  if (stored.filter((stem) => stem === '重复题：请填写答案。').length !== 1) {
    throw new Error(`Duplicate was not skipped: ${JSON.stringify(stored)}`);
  }
  const toastText = await page.locator('.toast-message').last().innerText();
  if (!toastText.includes('跳过') || !toastText.includes('1 道重复题')) {
    throw new Error(`Skip count missing from toast: ${toastText}`);
  }

  console.log('duplicates dialog ok', toastText);
  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('DUPLICATES UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/duplicates-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
