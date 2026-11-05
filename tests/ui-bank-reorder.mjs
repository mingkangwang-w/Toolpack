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
const seed = {
  version: 2,
  subjects: [{ id: 'reorder-subject', name: '排序测试', createdAt: now, updatedAt: now }],
  banks: [
    {
      id: 'reorder-a',
      subjectId: 'reorder-subject',
      name: '第一章',
      createdAt: '2026-01-01T10:01:00+08:00',
      updatedAt: '2026-01-01T10:01:00+08:00',
    },
    {
      id: 'reorder-b',
      subjectId: 'reorder-subject',
      name: '第二章',
      createdAt: '2026-01-01T10:02:00+08:00',
      updatedAt: '2026-01-01T10:02:00+08:00',
    },
    {
      id: 'reorder-c',
      subjectId: 'reorder-subject',
      name: '第三章',
      createdAt: '2026-01-01T10:03:00+08:00',
      updatedAt: '2026-01-01T10:03:00+08:00',
    },
  ],
  questions: [],
  history: [],
  duplicateIgnores: [],
  settings: {
    theme: 'light',
    practiceCount: 'all',
    practiceShuffle: false,
    practiceFeedbackMode: 'immediate',
    lastBankId: 'reorder-a',
  },
};

async function childBankNames() {
  const names = await page.locator('.subject-card').first().locator('.bank-name').allInnerTexts();
  return names.filter((name) => name !== '科目总题库');
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

  await page.locator('.nav-item[data-nav="library"]').click();
  await page.waitForSelector('.bank-row[data-bank-id="reorder-a"]');
  if (JSON.stringify(await childBankNames()) !== JSON.stringify(['第一章', '第二章', '第三章'])) {
    throw new Error(`Unexpected initial bank order: ${JSON.stringify(await childBankNames())}`);
  }

  const source = page.locator('[data-bank-row="reorder-c"] [data-bank-drag-handle]');
  const target = page.locator('[data-bank-row="reorder-a"]');
  await source.dragTo(target, { targetPosition: { x: 24, y: 2 } });
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll('.subject-card')]
      .flatMap((card) => [...card.querySelectorAll('.bank-name')])
      .map((node) => node.textContent?.trim())
      .filter((name) => name && name !== '科目总题库');
    return JSON.stringify(names) === JSON.stringify(['第三章', '第一章', '第二章']);
  });

  const stored = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('shuati-helper:data:v1'));
    return data.banks
      .filter((bank) => bank.subjectId === 'reorder-subject')
      .sort((a, b) => a.order - b.order)
      .map((bank) => ({ name: bank.name, order: bank.order }));
  });
  if (JSON.stringify(stored.map((item) => item.name)) !== JSON.stringify(['第三章', '第一章', '第二章'])) {
    throw new Error(`Stored bank order is wrong: ${JSON.stringify(stored)}`);
  }
  if (JSON.stringify(stored.map((item) => item.order)) !== JSON.stringify([0, 1, 2])) {
    throw new Error(`Stored order values are wrong: ${JSON.stringify(stored)}`);
  }
  await page.waitForTimeout(250);
  if (await page.locator('dialog[open]').count()) {
    throw new Error('A dialog should not remain open after bank drag');
  }
  await page.screenshot({ path: 'tests/bank-reorder-after.png', fullPage: true });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dashboard-page');
  await page.locator('.nav-item[data-nav="library"]').click();
  await page.waitForSelector('.bank-row[data-bank-id="reorder-c"]');
  if (JSON.stringify(await childBankNames()) !== JSON.stringify(['第三章', '第一章', '第二章'])) {
    throw new Error(`Bank order did not persist after reload: ${JSON.stringify(await childBankNames())}`);
  }

  console.log('bank reorder ok');
  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('BANK REORDER UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/bank-reorder-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
