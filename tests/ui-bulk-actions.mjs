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

function question(id, stem) {
  return {
    id,
    subjectId: 'bulk-subject',
    bankId: 'bulk-bank-a',
    type: 'fill',
    stem,
    options: [],
    answer: `${stem}答案`,
    explanation: '',
    favorite: false,
    createdAt: now,
    updatedAt: now,
    stats: stats(),
  };
}

const seed = {
  version: 2,
  subjects: [{ id: 'bulk-subject', name: '批量操作测试', createdAt: now, updatedAt: now }],
  banks: [
    {
      id: 'bulk-bank-a',
      subjectId: 'bulk-subject',
      name: '来源题库',
      order: 0,
      createdAt: '2026-01-01T10:01:00+08:00',
      updatedAt: '2026-01-01T10:01:00+08:00',
    },
    {
      id: 'bulk-bank-b',
      subjectId: 'bulk-subject',
      name: '目标题库',
      order: 1,
      createdAt: '2026-01-01T10:02:00+08:00',
      updatedAt: '2026-01-01T10:02:00+08:00',
    },
  ],
  questions: [
    question('bulk-q1', '第一道批量题'),
    question('bulk-q2', '第二道批量题'),
    question('bulk-q3', '第三道批量题'),
  ],
  history: [],
  duplicateIgnores: [],
  settings: {
    theme: 'light',
    practiceCount: 'all',
    practiceShuffle: false,
    practiceFeedbackMode: 'immediate',
    lastBankId: 'bulk-bank-a',
  },
};

try {
  await resetTestLibrary(BASE);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((data) => {
    localStorage.clear();
    localStorage.setItem('shuati-helper:data:v1', JSON.stringify(data));
  }, seed);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dashboard-page');

  await page.locator('.nav-item[data-nav="library"]').click();
  await page.waitForSelector('[data-question-row="bulk-q1"]');
  if ((await page.locator('[data-select-question]').count()) !== 3) {
    throw new Error('Expected a selection checkbox on every question row');
  }

  await page.locator('[data-question-row="bulk-q1"] [data-select-question]').check();
  await page.locator('[data-question-row="bulk-q2"] [data-select-question]').check();
  if (!(await page.locator('[data-selection-count]').innerText()).includes('2')) {
    throw new Error('Selected question count is wrong');
  }

  await page.locator('[data-action="bulk-edit"]').click();
  await page.waitForSelector('dialog[open] [data-bulk-bank]');
  await page.locator('dialog[open] [data-bulk-bank]').selectOption('bulk-bank-b');
  await page.locator('dialog[open] [data-bulk-favorite]').selectOption('favorite');
  await page.locator('dialog[open] [data-bulk-save]').click();
  await page.waitForSelector('dialog[open]', { state: 'detached' });

  const afterEdit = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('shuati-helper:data:v1'));
    return data.questions.map((item) => ({
      id: item.id,
      bankId: item.bankId,
      favorite: item.favorite,
    }));
  });
  const byId = Object.fromEntries(afterEdit.map((item) => [item.id, item]));
  if (byId['bulk-q1'].bankId !== 'bulk-bank-b' || byId['bulk-q2'].bankId !== 'bulk-bank-b') {
    throw new Error(`Bulk edit did not move selected questions: ${JSON.stringify(afterEdit)}`);
  }
  if (!byId['bulk-q1'].favorite || !byId['bulk-q2'].favorite) {
    throw new Error('Bulk edit did not update favorite state');
  }
  if (byId['bulk-q3'].bankId !== 'bulk-bank-a') {
    throw new Error('Bulk edit changed an unselected question');
  }

  // Select all, then deselect q2 so only q1 and q3 are deleted.
  await page.locator('[data-question-row="bulk-q1"] [data-select-question]').check();
  await page.locator('[data-select-all]').check();
  await page.locator('[data-question-row="bulk-q2"] [data-select-question]').uncheck();
  if (!(await page.locator('[data-selection-count]').innerText()).includes('2')) {
    throw new Error(`Select-all state is wrong: ${await page.locator('[data-selection-count]').innerText()}`);
  }
  await page.screenshot({ path: 'tests/bulk-actions-selection.png', fullPage: true });

  await page.locator('[data-action="bulk-delete"]').click();
  await page.waitForSelector('dialog[open] [data-confirm]');
  if (!(await page.locator('dialog[open]').innerText()).includes('2 道题')) {
    throw new Error('Bulk delete confirmation count is wrong');
  }
  await page.locator('dialog[open] [data-confirm]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-question-row]').length === 1,
    undefined,
    { timeout: 10_000 },
  );

  const remaining = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('shuati-helper:data:v1'));
    return data.questions.map((item) => item.id);
  });
  if (JSON.stringify(remaining) !== JSON.stringify(['bulk-q2'])) {
    throw new Error(`Bulk delete removed wrong questions: ${JSON.stringify(remaining)}`);
  }
  await page.screenshot({ path: 'tests/bulk-actions-after.png', fullPage: true });

  console.log('bulk actions ok');
  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('BULK ACTIONS UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/bulk-actions-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
