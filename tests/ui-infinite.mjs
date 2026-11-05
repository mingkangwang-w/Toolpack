import { chromium } from 'playwright-core';
import { resetTestLibrary } from './ui-helpers.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const errors = [];
const now = new Date().toISOString();
const subject = { id: 'infinite-subject', name: '无限模式测试', createdAt: now, updatedAt: now };
const bank = {
  id: 'infinite-bank',
  subjectId: subject.id,
  name: '循环题库',
  createdAt: now,
  updatedAt: now,
};

function question(id, stem, answer) {
  return {
    id,
    subjectId: subject.id,
    bankId: bank.id,
    type: 'single',
    stem,
    options: [
      { key: 'A', text: '选项甲' },
      { key: 'B', text: '选项乙' },
      { key: 'C', text: '选项丙' },
      { key: 'D', text: '选项丁' },
    ],
    answer,
    explanation: '',
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

const seed = {
  version: 2,
  subjects: [subject],
  banks: [bank],
  questions: [
    question('inf-1', '无限题一：1 + 1 等于多少？', 'B'),
    question('inf-2', '无限题二：2 + 2 等于多少？', 'A'),
    question('inf-3', '无限题三：3 + 3 等于多少？', 'C'),
  ],
  history: [],
  settings: {
    theme: 'light',
    practiceCount: 5,
    practiceShuffle: true,
    practiceFeedbackMode: 'immediate',
    practiceInfinite: false,
    practiceShowAI: true,
    lastBankId: bank.id,
  },
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
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

async function currentIndex() {
  return Number(
    await page.locator('.session-progress-copy b').first().innerText(),
  );
}

try {
  await resetTestLibrary(BASE);
  await page.route('**/api/ai/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, configured: false }),
    }),
  );
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((data) => {
    localStorage.clear();
    localStorage.setItem('shuati-helper:data:v1', JSON.stringify(data));
  }, seed);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.nav-item[data-nav="practice"]').click();
  await page.waitForSelector('.practice-setup-page');

  await page.locator('[data-infinite-mode]').click();
  await page.waitForTimeout(150);
  if (!(await page.locator('[data-infinite-mode]').getAttribute('class')).includes('is-selected')) {
    throw new Error('Infinite mode option was not selected');
  }
  for (const selector of ['[data-order="ordered"]', '[data-order="shuffle"]', '[data-feedback-mode="afterAll"]']) {
    if (!(await page.locator(selector).isDisabled())) {
      throw new Error(`${selector} should be disabled in infinite mode`);
    }
  }
  if (!(await page.locator('[data-role="custom-count"]').isDisabled())) {
    throw new Error('Custom question count should be disabled in infinite mode');
  }
  if ((await page.locator('[data-start-count]').innerText()).trim() !== '∞') {
    throw new Error('Infinite mode start count should be ∞');
  }
  console.log('infinite setup locks random order and immediate feedback');
  await shot('infinite-setup');

  await page.locator('.setup-start-row [data-action="start"]').click();
  await page.waitForSelector('.session-page');
  await page.waitForSelector('.practice-ai-panel');
  if (!(await page.locator('.session-infinite-tag').count())) {
    throw new Error('Infinite badge was not rendered in session');
  }
  if (await page.locator('[data-action="next-question"]').count()) {
    throw new Error('Infinite mode should not show a finish button before answering');
  }
  const stems = [];
  for (let round = 0; round < 6; round += 1) {
    const before = await currentIndex();
    stems.push((await page.locator('.question-stem').innerText()).trim());
    await page.locator('.answer-option[data-answer-key]').first().click();
    await page.waitForSelector('[data-feedback]');
    await page.locator('[data-action="next-question"]').click();
    await page.waitForFunction(
      (expected) => Number(document.querySelector('.session-progress-copy b')?.textContent) >= expected,
      before + 1,
    );
    if (await page.locator('.summary-page').count()) {
      throw new Error('Infinite mode ended automatically');
    }
  }
  const uniqueStems = new Set(stems);
  console.log('infinite rounds', stems.length, 'unique', uniqueStems.size, 'next index', await currentIndex());
  if (stems.length !== 6 || uniqueStems.size !== 3) {
    throw new Error('Infinite mode did not cycle through the shuffled question pool');
  }
  await shot('infinite-session');

  await page.locator('[data-ai-chat-hide]').click();
  await page.waitForSelector('.practice-ai-panel', { state: 'detached' });
  const hiddenSetting = await page.evaluate(
    () => JSON.parse(localStorage.getItem('shuati-helper:data:v1')).settings.practiceShowAI,
  );
  if (hiddenSetting !== false) throw new Error('Hiding AI should persist practiceShowAI=false');
  if (!(await page.locator('[data-action="show-ai-chat"]').count())) {
    throw new Error('The AI panel should be restorable from the question header');
  }
  await page.locator('[data-action="show-ai-chat"]').click();
  await page.waitForSelector('.practice-ai-panel');
  console.log('AI panel can be hidden and restored during practice');

  await page.locator('[data-action="exit-session"]').click();
  await page.waitForSelector('dialog[open] [data-confirm]');
  await page.locator('dialog[open] [data-confirm]').click();
  await page.waitForSelector('.summary-page');
  const summaryText = await page.locator('.summary-page').innerText();
  if (!summaryText.includes('手动结束') || !summaryText.includes('无限练习')) {
    throw new Error('Infinite manual exit should show an infinite-session summary');
  }
  console.log('infinite manual exit summary shown');
  await shot('infinite-summary');

  await page.locator('[data-action="new-session"]').click();
  await page.waitForSelector('.practice-setup-page');
  if (!(await page.locator('[data-infinite-mode]').getAttribute('class')).includes('is-selected')) {
    throw new Error('Infinite mode should remain selected for the next setup');
  }
  const aiSwitch = page.locator('[data-role="practice-show-ai"]');
  if (!(await aiSwitch.isChecked())) {
    throw new Error('AI switch should remain enabled after restoring the panel');
  }
  await aiSwitch.uncheck();
  await page.locator('.setup-start-row [data-action="start"]').click();
  await page.waitForSelector('.session-page');
  if (await page.locator('.practice-ai-panel').count()) {
    throw new Error('AI panel should stay hidden when the setup switch is off');
  }
  if (await page.locator('.session-layout.has-ai').count()) {
    throw new Error('Session layout should not reserve the AI column when AI is hidden');
  }
  console.log('AI assistance is optional at session start');

  await page.locator('[data-action="exit-session"]').click();
  await page.waitForTimeout(200);

  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('INFINITE UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/infinite-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
