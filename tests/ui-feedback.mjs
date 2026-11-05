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

async function shot(name, fullPage = false) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `tests/${name}.png`, fullPage });
  console.log('shot', name);
}

function question(id, stem, options, answer) {
  const now = new Date().toISOString();
  return {
    id,
    subjectId: 'feedback-subject',
    bankId: 'feedback-bank',
    type: 'single',
    stem,
    options: options.map((text, index) => ({ key: 'ABCD'[index], text })),
    answer,
    explanation: `${stem}的解析`,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    stats: {
      attempts: 0,
      correct: 0,
      wrong: 0,
      streak: 0,
      lastResult: null,
      lastAt: null,
    },
  };
}

const now = new Date().toISOString();
const seed = {
  version: 2,
  subjects: [{ id: 'feedback-subject', name: '答题方式测试', createdAt: now, updatedAt: now }],
  banks: [
    {
      id: 'feedback-bank',
      subjectId: 'feedback-subject',
      name: '测试子题库',
      createdAt: now,
      updatedAt: now,
    },
  ],
  questions: [
    question('feedback-q1', '第一题：选择甲。', ['甲', '乙', '丙', '丁'], 'A'),
    question('feedback-q2', '第二题：选择乙。', ['甲', '乙', '丙', '丁'], 'B'),
  ],
  history: [],
  settings: {
    theme: 'light',
    practiceCount: 'all',
    practiceShuffle: false,
    practiceFeedbackMode: 'afterAll',
    lastBankId: 'feedback-bank',
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

  await page.locator('.nav-item[data-nav="practice"]').click();
  await page.waitForSelector('.practice-setup-page');
  await page.locator('[data-feedback-mode="afterAll"]').click();
  const selectedMode = await page.locator('[data-feedback-mode="afterAll"]').getAttribute('aria-pressed');
  if (selectedMode !== 'true') throw new Error('Deferred feedback mode was not selected');
  await page.locator('[data-count="all"]').click();
  await page.locator('[data-order="ordered"]').click();
  await shot('feedback-mode-setup', true);
  await page.locator('.setup-start-row [data-action="start"]').click();
  await page.waitForSelector('.session-page');

  const badge = await page.locator('.feedback-mode-badge').innerText();
  if (!badge.includes('全部做完后查看')) throw new Error('Deferred mode badge missing');
  if (await page.locator('.session-score .score-correct').count()) {
    throw new Error('Correct count should be hidden while answering in deferred mode');
  }
  const metricsBefore = await page.locator('.session-metrics').innerText();
  if (metricsBefore.includes('答对')) throw new Error('Answer metrics leaked during deferred mode');

  // First single-choice answer auto-submits and moves on without feedback.
  await page.locator('[data-answer-key="A"]').click();
  await page.waitForFunction(
    () => document.querySelector('.session-progress-copy b')?.textContent === '2',
    undefined,
    { timeout: 10_000 },
  );
  if (await page.locator('[data-feedback]').count()) {
    throw new Error('Deferred mode should not reveal feedback after each answer');
  }
  if (await page.locator('.question-dot.is-answered').count() !== 1) {
    throw new Error('Answered dot should be neutral in deferred mode');
  }
  console.log('deferred first answer recorded', await page.locator('.score-pending').innerText());
  await shot('feedback-mode-session');

  // Returning to the previous question restores the choice but not correctness.
  await page.locator('[data-action="prev-question"]').click();
  await page.waitForFunction(
    () => document.querySelector('.session-progress-copy b')?.textContent === '1',
  );
  if (!(await page.locator('.deferred-review-note').count())) {
    throw new Error('Deferred review note missing on previous question');
  }
  if (await page.locator('[data-feedback]').count()) {
    throw new Error('Previous question leaked correctness in deferred mode');
  }
  const selectedOnReview = await page.locator('.answer-option.is-selected').count();
  if (selectedOnReview !== 1) throw new Error('Previous selected answer was not restored');
  await page.locator('[data-action="next-question"]').click();
  await page.waitForFunction(
    () => document.querySelector('.session-progress-copy b')?.textContent === '2',
  );

  // Second answer intentionally wrong; summary should show 50%.
  await page.locator('[data-answer-key="A"]').click();
  await page.waitForSelector('.summary-page', { timeout: 10_000 });
  const summaryText = await page.locator('.summary-page').innerText();
  console.log('summary accuracy', await page.locator('.summary-score').innerText());
  if (!summaryText.includes('50%') && !summaryText.includes('50\n%')) {
    throw new Error('Expected 50% accuracy on deferred summary');
  }
  if (!summaryText.includes('需要再看一眼')) throw new Error('Wrong answer review missing on summary');
  await shot('feedback-mode-summary', true);

  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('FEEDBACK UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/feedback-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
