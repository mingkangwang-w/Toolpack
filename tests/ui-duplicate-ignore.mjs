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

function question(id, stem, answer) {
  return {
    id,
    subjectId: 'ignore-subject',
    bankId: 'ignore-bank',
    type: 'fill',
    stem,
    options: [],
    answer,
    explanation: '',
    favorite: false,
    createdAt: now,
    updatedAt: now,
    stats: stats(),
  };
}

const seed = {
  version: 2,
  subjects: [{ id: 'ignore-subject', name: '重复提醒测试', createdAt: now, updatedAt: now }],
  banks: [
    {
      id: 'ignore-bank',
      subjectId: 'ignore-subject',
      name: '已有题目',
      createdAt: now,
      updatedAt: now,
    },
  ],
  questions: [
    question('ignore-q1', '已有重复题：请填写答案。', '答案 A'),
    question('ignore-q2', '已有重复题 请填写答案', '答案 B'),
    question('ignore-q3', '与其他题不同的题干。', '答案 C'),
  ],
  history: [],
  duplicateIgnores: [],
  settings: {
    theme: 'light',
    practiceCount: 'all',
    practiceShuffle: false,
    practiceFeedbackMode: 'immediate',
    lastBankId: 'ignore-bank',
  },
};

async function openDuplicateFilter() {
  await page.locator('.nav-item[data-nav="library"]').click();
  await page.waitForSelector('.library-page');
  await page.locator('[data-filter="duplicates"]').click();
  await page.waitForSelector('.duplicate-manager');
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

  await openDuplicateFilter();
  if ((await page.locator('.duplicate-group-item').count()) !== 1) {
    throw new Error('Expected one existing duplicate group');
  }
  if ((await page.locator('[data-filter="duplicates"] b').innerText()) !== '2') {
    throw new Error('Duplicate filter count should start at 2');
  }
  if ((await page.locator('.question-row').count()) !== 2) {
    throw new Error('Duplicate filter should show both duplicate questions');
  }
  await page.screenshot({ path: 'tests/duplicate-ignore-before.png', fullPage: true });

  await page.locator('[data-action="ignore-duplicate-group"]').click();
  await page.waitForFunction(
    () => document.querySelector('[data-filter="duplicates"] b')?.textContent === '0',
  );
  if (!(await page.locator('.duplicate-ignored-note').count())) {
    throw new Error('Ignored duplicate notice missing');
  }
  const afterIgnore = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('shuati-helper:data:v1'));
    return {
      ignores: data.duplicateIgnores,
      questionCount: data.questions.length,
    };
  });
  if (afterIgnore.questionCount !== 3) throw new Error('Ignoring must not delete questions');
  if (!Array.isArray(afterIgnore.ignores) || afterIgnore.ignores.length !== 1) {
    throw new Error(`Duplicate ignore was not persisted: ${JSON.stringify(afterIgnore)}`);
  }
  await page.screenshot({ path: 'tests/duplicate-ignore-after.png', fullPage: true });

  // 忽略只取消提醒，题目仍应能回到普通题库列表。
  await page.locator('[data-action="view-ignored-duplicates"]').click();
  await page.waitForSelector('.filter-chip[data-filter="all"].is-active');
  if ((await page.locator('.question-row').count()) !== 3) {
    throw new Error('Ignored duplicates are not visible in the normal library');
  }

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dashboard-page');
  await openDuplicateFilter();
  if (!(await page.locator('.duplicate-ignored-note').count())) {
    throw new Error('Ignored duplicate reminder did not survive reload');
  }
  if ((await page.locator('[data-filter="duplicates"] b').innerText()) !== '0') {
    throw new Error('Ignored reminder returned after reload');
  }

  await page.locator('[data-action="restore-duplicate-ignores"]').click();
  await page.waitForFunction(
    () => document.querySelector('[data-filter="duplicates"] b')?.textContent === '2',
  );
  if ((await page.locator('.duplicate-group-item').count()) !== 1) {
    throw new Error('Restoring should bring the duplicate group back');
  }
  const restored = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('shuati-helper:data:v1'));
    return data.duplicateIgnores;
  });
  if (!Array.isArray(restored) || restored.length !== 0) {
    throw new Error(`Restore did not clear ignores: ${JSON.stringify(restored)}`);
  }

  console.log('duplicate ignore ok');
  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('DUPLICATE IGNORE UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/duplicate-ignore-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
