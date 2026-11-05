import { chromium } from 'playwright-core';
import path from 'node:path';
import { resetTestLibrary } from './ui-helpers.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8766/';
const sample = path.resolve('示例/示例题目.png');
const errors = [];

const now = new Date().toISOString();
const testSubject = { id: 'assistant-subject', name: 'AI 测试科目', createdAt: now, updatedAt: now };
const testBank = {
  id: 'assistant-bank',
  subjectId: testSubject.id,
  name: 'AI 测试子题库',
  createdAt: now,
  updatedAt: now,
};

function q(id, stem, options, answer, extra = {}) {
  return {
    id,
    subjectId: testSubject.id,
    bankId: testBank.id,
    type: 'single',
    stem,
    options: options.map((text, index) => ({ key: 'ABCD'[index], text })),
    answer,
    explanation: extra.explanation || '',
    favorite: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: {
      attempts: 0,
      correct: 0,
      wrong: 0,
      streak: 0,
      lastResult: null,
      lastAt: null,
      ...(extra.stats || {}),
    },
  };
}

const seed = {
  version: 2,
  subjects: [testSubject],
  banks: [testBank],
  questions: [
    q('a1', '1 + 1 等于多少？', ['1', '2', '3', '4'], 'B'),
    q('a2', '1 + 1 等于多少？', ['1', '2', '3', '4'], 'B'),
    q('a3', '水的化学式是什么？', ['CO2', 'H2O', 'O2', 'NaCl'], ''),
    q('a4', '这是一个答案异常的测试题。', ['甲', '乙'], 'C'),
  ],
  history: [],
  settings: {
    theme: 'light',
    practiceCount: 'all',
    practiceShuffle: false,
    lastBankId: testBank.id,
  },
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

async function shot(name, fullPage = false) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `tests/${name}.png`, fullPage });
  console.log('shot', name);
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

  // 1. Global assistant on dashboard.
  await page.locator('.ai-fab').click();
  await page.waitForSelector('dialog[open] .ai-chat-option', { timeout: 30_000 });
  console.log('global options', await page.locator('.ai-chat-option').count());
  await shot('assistant-global');
  await page.locator('dialog[open] .dialog-close').click();
  await page.waitForTimeout(250);

  // 2. Library inspector -> filter action.
  await page.locator('.nav-item[data-nav="library"]').click();
  await page.waitForSelector('.library-page');
  await page.locator('[data-action="ai-inspect"]').click();
  await page.waitForSelector('dialog[open] .ai-chat-option', { timeout: 30_000 });
  await shot('assistant-library');
  const filterLabels = await page.locator('.ai-chat-option strong').allInnerTexts();
  console.log('library options', filterLabels);
  await page.locator('.ai-chat-option').first().click();
  await page.waitForSelector('.filter-chip.is-active');
  await page.waitForTimeout(400);
  const activeFilter = await page.locator('.filter-chip.is-active').getAttribute('data-filter');
  console.log('active filter', activeFilter);
  await shot('assistant-library-filtered');

  // 3. Practice tutor: the inline AI panel stays beside the question.
  await page.locator('.nav-item[data-nav="practice"]').click();
  await page.waitForSelector('.practice-setup-page');
  await page.locator('[data-count="all"]').click();
  await page.locator('[data-order="ordered"]').click();
  await page.locator('.setup-start-row [data-action="start"]').click();
  await page.waitForSelector('.session-page');
  await page.waitForSelector('.practice-ai-panel');
  const stageBox = await page.locator('.question-stage').boundingBox();
  const panelBox = await page.locator('.practice-ai-panel').boundingBox();
  if (!stageBox || !panelBox || panelBox.x < stageBox.x + stageBox.width) {
    throw new Error('Practice AI panel should sit beside the question stage');
  }
  console.log('inline ai panel beside question');
  await page.waitForSelector('.practice-ai-chip');
  await page.waitForFunction(
    () => document.querySelectorAll('.practice-ai-log .ai-chat-msg.is-assistant:not(.is-typing)').length >= 1,
  );
  await page.locator('[data-action="focus-ai-chat"]').click();
  await page.waitForTimeout(320);
  const inlineInputFocused = await page.evaluate(
    () => document.activeElement?.matches('[data-ai-chat-input]') === true,
  );
  if (!inlineInputFocused) {
    throw new Error('The AI 辅导 button should focus the inline chat input');
  }
  await shot('assistant-tutor');

  await page.locator('.practice-ai-chip').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('.practice-ai-log .ai-chat-msg.is-assistant:not(.is-typing)').length >= 2,
    undefined,
    { timeout: 30_000 },
  );
  const quickReply = await page
    .locator('.practice-ai-log .ai-chat-msg.is-assistant')
    .last()
    .innerText();
  console.log('tutor inline quick reply', quickReply);
  if (await page.locator('dialog[open]').count()) {
    throw new Error('Inline AI should not open a modal dialog');
  }

  await page.locator('[data-ai-chat-input]').fill('这题考查什么知识点？');
  await page.locator('[data-ai-chat-send]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.practice-ai-log .ai-chat-msg.is-assistant:not(.is-typing)').length >= 3,
    undefined,
    { timeout: 30_000 },
  );
  const messagesBeforeNext = await page
    .locator('.practice-ai-log .ai-chat-msg.is-assistant')
    .count();

  await page.locator('[data-answer-key="B"]').click();
  await page.waitForSelector('.feedback');
  await page.locator('[data-action="next-question"]').click();
  await page.waitForFunction(
    () => document.querySelector('.session-progress-copy b')?.textContent === '2',
  );
  await page.waitForTimeout(300);
  const messagesAfterNext = await page
    .locator('.practice-ai-log .ai-chat-msg.is-assistant')
    .count();
  const inlineContext = await page.locator('[data-ai-chat-context]').innerText();
  console.log('tutor context after next', inlineContext, 'messages', messagesAfterNext);
  if (messagesAfterNext < messagesBeforeNext) {
    throw new Error('Inline AI conversation should survive question navigation');
  }
  if (!inlineContext.includes('2 / 2')) {
    throw new Error(`Inline AI context did not follow the new question: ${inlineContext}`);
  }
  await shot('assistant-tutor-followup');

  // Leave the active practice session before switching to import.
  await page.locator('[data-action="exit-session"]').click();
  await page.waitForTimeout(250);
  if (await page.locator('dialog[open] [data-confirm]').count()) {
    await page.locator('dialog[open] [data-confirm]').click();
  }
  await page.waitForSelector('.practice-setup-page', { timeout: 10_000 });

  // 4. Import: OCR, AI text analysis, then let AI decide -> open picker.
  await page.locator('.nav-item[data-nav="import"]').click();
  await page.waitForSelector('.import-page');
  await page.locator('input[data-role="file-input"]:not([capture])').setInputFiles(sample);
  await page.waitForSelector('.preview-card', { timeout: 90_000 });
  await page.locator('[data-action="ai-review"]').click();
  await page.waitForSelector('dialog[open] .confirm-message');
  await page.locator('dialog[open] [data-confirm]').click();
  await page.waitForSelector('.ai-result', { timeout: 60_000 });
  await page.locator('[data-ai-ask-decision]').click();
  await page.waitForSelector('dialog[open] .ai-chat-option', { timeout: 30_000 });
  await shot('assistant-import');
  const importOptions = await page.locator('.ai-chat-option strong').allInnerTexts();
  console.log('import options', importOptions);
  const pickerButton = page.locator('.ai-chat-option', { hasText: '逐题查看' });
  if (await pickerButton.count()) {
    await pickerButton.first().click();
    await page.waitForSelector('.ai-result', { timeout: 15_000 });
    console.log('picker reopened via AI action');
  } else {
    console.log('mock did not expose picker; closing');
    await page.locator('dialog[open] .dialog-close').click();
  }

  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('ASSISTANT UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/assistant-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
