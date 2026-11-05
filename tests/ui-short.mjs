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
  subjects: [{ id: 'short-subject', name: '简答题测试', createdAt: now, updatedAt: now }],
  banks: [
    {
      id: 'short-bank',
      subjectId: 'short-subject',
      name: '主观题',
      createdAt: now,
      updatedAt: now,
    },
  ],
  questions: [
    {
      id: 'short-q1',
      subjectId: 'short-subject',
      bankId: 'short-bank',
      type: 'short',
      stem: '简述光合作用的主要阶段。',
      options: [],
      answer: '光反应阶段\n暗反应阶段',
      explanation: '光反应在类囊体薄膜上进行，暗反应在基质中进行。',
      favorite: false,
      createdAt: now,
      updatedAt: now,
      stats: stats(),
    },
    {
      id: 'short-q2',
      subjectId: 'short-subject',
      bankId: 'short-bank',
      type: 'short',
      stem: '简述牛顿第一定律，参考答案可以留空。',
      options: [],
      answer: '',
      explanation: '参考答案未录入时，仍可自由作答并自评。',
      favorite: false,
      createdAt: new Date(Date.parse(now) + 1000).toISOString(),
      updatedAt: new Date(Date.parse(now) + 1000).toISOString(),
      stats: stats(),
    },
    {
      id: 'short-q3',
      subjectId: 'short-subject',
      bankId: 'short-bank',
      type: 'single',
      stem: '下列哪一项属于选择题？',
      options: [
        { key: 'A', text: '甲' },
        { key: 'B', text: '乙' },
        { key: 'C', text: '丙' },
        { key: 'D', text: '丁' },
      ],
      answer: 'A',
      explanation: '',
      favorite: false,
      createdAt: new Date(Date.parse(now) + 2000).toISOString(),
      updatedAt: new Date(Date.parse(now) + 2000).toISOString(),
      stats: stats(),
    },
  ],
  history: [],
  settings: {
    theme: 'light',
    practiceCount: 'all',
    practiceShuffle: false,
    practiceFeedbackMode: 'immediate',
    lastBankId: 'short-bank',
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
  await page.locator('[data-count="all"]').click();
  await page.locator('[data-order="ordered"]').click();
  await page.locator('.setup-start-row [data-action="start"]').click();
  await page.waitForSelector('.session-page');

  const shortBadge = page.locator('.type-badge.type-short');
  if (!(await shortBadge.count())) throw new Error('Short-answer type badge missing');
  if ((await shortBadge.innerText()) !== '简答题') throw new Error('Short-answer badge label is wrong');
  const shortColor = await shortBadge.evaluate((node) => getComputedStyle(node).color);
  const shortBackground = await shortBadge.evaluate((node) => getComputedStyle(node).backgroundColor);
  if (shortColor === shortBackground) throw new Error('Short-answer badge color is not distinct');

  const answerInput = page.locator('textarea[data-role="fill-answer"]');
  if (!(await answerInput.count())) throw new Error('Short-answer textarea missing');
  if (await page.locator('[data-answer-key]').count()) {
    throw new Error('Short-answer question should not render choice options');
  }

  await answerInput.fill('光反应和暗反应两个阶段。');
  await page.waitForTimeout(1100);
  await page.locator('[data-action="submit-answer"]').click();
  await page.waitForSelector('[data-action="self-grade"]', { timeout: 10_000 });
  const pendingText = await page.locator('[data-feedback]').innerText();
  if (!pendingText.includes('参考答案') || !pendingText.includes('暗反应阶段')) {
    throw new Error('Reference answer missing while waiting for self-grade');
  }
  if (await page.locator('[data-action="next-question"]').count()) {
    throw new Error('Next button should wait for short-answer self-grade');
  }
  await shot('short-answer-pending', false);

  const beforeStats = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('shuati-helper:data:v1'));
    return data.questions.find((item) => item.id === 'short-q1').stats;
  });
  if (beforeStats.attempts !== 0) throw new Error('Short answer was counted before self-grade');

  await page.locator('[data-action="self-grade"][data-correct="true"]').click();
  await page.waitForSelector('.feedback.is-correct', { timeout: 10_000 });
  const feedbackText = await page.locator('[data-feedback]').innerText();
  if (!feedbackText.includes('自评为答对')) throw new Error('Self-grade feedback missing');
  await shot('short-answer-graded', false);

  const afterStats = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('shuati-helper:data:v1'));
    const questionStats = data.questions.find((item) => item.id === 'short-q1').stats;
    const history = data.history.find((entry) => entry.byBank?.['short-bank']);
    return { questionStats, history };
  });
  if (afterStats.questionStats.attempts !== 1 || afterStats.questionStats.correct !== 1) {
    throw new Error(`Unexpected short-answer stats: ${JSON.stringify(afterStats.questionStats)}`);
  }
  if (!afterStats.history || afterStats.history.durationMs < 1000) {
    throw new Error(`Study duration was not recorded: ${JSON.stringify(afterStats.history)}`);
  }
  if (
    afterStats.history.bySubject['short-subject']?.answered !== 1 ||
    afterStats.history.byBank['short-bank']?.correct !== 1
  ) {
    throw new Error(`Scope history was not recorded: ${JSON.stringify(afterStats.history)}`);
  }

  await page.locator('[data-action="next-question"]').click();
  await page.waitForFunction(
    () => document.querySelector('.session-progress-copy b')?.textContent === '2',
    undefined,
    { timeout: 10_000 },
  );

  // Second question has no reference answer; it must still be practiceable.
  if (!(await page.locator('.type-badge.type-short').count())) {
    throw new Error('Short-answer without reference answer did not enter practice');
  }
  const noReferenceInput = page.locator('textarea[data-role="fill-answer"]');
  await noReferenceInput.fill('物体在不受外力时保持静止或匀速直线运动。');
  await page.locator('[data-action="submit-answer"]').click();
  await page.waitForSelector('[data-action="self-grade"]', { timeout: 10_000 });
  const noReferenceText = await page.locator('[data-feedback]').innerText();
  if (!noReferenceText.includes('未提供参考答案')) {
    throw new Error('Missing-reference fallback was not shown');
  }
  await shot('short-answer-no-reference', false);
  await page.locator('[data-action="self-grade"][data-correct="false"]').click();
  await page.waitForSelector('.feedback.is-wrong', { timeout: 10_000 });
  const noReferenceStats = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('shuati-helper:data:v1'));
    return data.questions.find((item) => item.id === 'short-q2').stats;
  });
  if (noReferenceStats.attempts !== 1 || noReferenceStats.wrong !== 1) {
    throw new Error(`Unexpected no-reference stats: ${JSON.stringify(noReferenceStats)}`);
  }

  await page.locator('[data-action="next-question"]').click();
  await page.waitForFunction(
    () => document.querySelector('.session-progress-copy b')?.textContent === '3',
    undefined,
    { timeout: 10_000 },
  );
  const singleBadge = page.locator('.type-badge.type-single');
  if (!(await singleBadge.count())) throw new Error('Single-choice badge missing on third question');
  const singleColor = await singleBadge.evaluate((node) => getComputedStyle(node).color);
  if (singleColor === shortColor) {
    throw new Error(`Short-answer color should differ from choice color (${shortColor})`);
  }
  console.log('type colors', { shortColor, singleColor });
  await shot('short-answer-next-question', false);

  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('SHORT ANSWER UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/short-answer-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
