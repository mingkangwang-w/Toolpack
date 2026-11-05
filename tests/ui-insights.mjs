import { chromium } from 'playwright-core';
import { resetTestLibrary } from './ui-helpers.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const errors = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

function dateKey(offset) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

const subjects = [
  { id: 'insight-math', name: '数学', createdAt: now, updatedAt: now },
  { id: 'insight-english', name: '英语', createdAt: now, updatedAt: now },
];
const banks = [
  {
    id: 'insight-functions',
    subjectId: 'insight-math',
    name: '函数',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'insight-geometry',
    subjectId: 'insight-math',
    name: '几何',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'insight-words',
    subjectId: 'insight-english',
    name: '词汇',
    createdAt: now,
    updatedAt: now,
  },
];

const seed = {
  version: 2,
  subjects,
  banks,
  questions: [
    {
      id: 'insight-q1',
      subjectId: 'insight-math',
      bankId: 'insight-functions',
      type: 'single',
      stem: '函数题',
      options: [
        { key: 'A', text: '甲' },
        { key: 'B', text: '乙' },
      ],
      answer: 'A',
      explanation: '',
      favorite: false,
      createdAt: now,
      updatedAt: now,
      stats: stats(),
    },
  ],
  history: [
    {
      date: dateKey(0),
      answered: 4,
      correct: 3,
      durationMs: 600_000,
      bySubject: {
        'insight-math': { answered: 3, correct: 2 },
        'insight-english': { answered: 1, correct: 1 },
      },
      byBank: {
        'insight-functions': { answered: 2, correct: 1 },
        'insight-geometry': { answered: 1, correct: 1 },
        'insight-words': { answered: 1, correct: 1 },
      },
    },
    {
      date: dateKey(2),
      answered: 5,
      correct: 5,
      durationMs: 900_000,
      bySubject: {
        'insight-math': { answered: 4, correct: 4 },
        'insight-english': { answered: 1, correct: 1 },
      },
      byBank: {
        'insight-functions': { answered: 3, correct: 3 },
        'insight-geometry': { answered: 1, correct: 1 },
        'insight-words': { answered: 1, correct: 1 },
      },
    },
    {
      date: dateKey(8),
      answered: 2,
      correct: 1,
      durationMs: 300_000,
      bySubject: {
        'insight-math': { answered: 2, correct: 1 },
      },
      byBank: {
        'insight-functions': { answered: 1, correct: 1 },
        'insight-geometry': { answered: 1, correct: 0 },
      },
    },
    {
      date: dateKey(31),
      answered: 99,
      correct: 0,
      durationMs: 99_000_000,
      bySubject: {},
      byBank: {},
    },
  ],
  settings: {
    theme: 'light',
    practiceCount: 'all',
    practiceShuffle: false,
    practiceFeedbackMode: 'immediate',
    lastBankId: 'insight-functions',
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
  await page.waitForSelector('.insights-panel');

  const metrics = await page.locator('.insight-metrics').innerText();
  if (!metrics.includes('30 分钟')) throw new Error(`Monthly duration missing: ${metrics}`);
  if (!metrics.includes('11')) throw new Error(`Monthly question count missing: ${metrics}`);
  if (!metrics.includes('82%')) throw new Error(`Monthly accuracy missing: ${metrics}`);
  if (!(await page.locator('[data-role="trend-bank"]').isDisabled())) {
    throw new Error('Bank filter should be disabled for all subjects');
  }

  const initialLineCount = await page.locator('[data-trend-chart] .trend-line').count();
  if (initialLineCount !== 1) throw new Error(`Expected one accuracy line, got ${initialLineCount}`);
  const initialRows = await page.locator('.trend-data-table tbody tr').count();
  if (initialRows !== 3) throw new Error(`Expected 3 overall chart rows, got ${initialRows}`);
  console.log('overall chart', await page.locator('.trend-kpi').innerText());

  await page.locator('[data-role="trend-subject"]').selectOption('insight-math');
  await page.waitForFunction(() =>
    document.querySelector('.trend-chart-heading p')?.textContent?.includes('数学'),
  );
  if (await page.locator('[data-role="trend-bank"]').isDisabled()) {
    throw new Error('Bank filter should be enabled after selecting a subject');
  }
  const mathText = await page.locator('[data-trend-chart]').innerText();
  if (!mathText.includes('数学 · 科目总题库')) throw new Error('Subject scope label missing');
  if (!mathText.includes('78%')) throw new Error('Subject accuracy summary is wrong');
  if ((await page.locator('[data-trend-chart] .trend-line').count()) !== 1) {
    throw new Error('Subject chart should still render one line');
  }

  await page.locator('[data-role="trend-bank"]').selectOption('insight-functions');
  await page.waitForFunction(() =>
    document.querySelector('.trend-chart-heading p')?.textContent?.includes('数学 / 函数'),
  );
  const bankText = await page.locator('[data-trend-chart]').innerText();
  if (!bankText.includes('83%')) throw new Error('Bank accuracy summary is wrong');
  const bankRows = await page.locator('.trend-data-table tbody tr').count();
  if (bankRows !== 3) throw new Error(`Expected 3 bank chart rows, got ${bankRows}`);
  if ((await page.locator('[data-trend-chart] .trend-line').count()) !== 1) {
    throw new Error('Bank chart should render one line only');
  }
  const lineLength = await page
    .locator('[data-trend-chart] .trend-line')
    .evaluate((node) => node.getTotalLength());
  if (!(lineLength > 0)) throw new Error('Accuracy line path is empty');

  const point = page.locator('.trend-point').last();
  await point.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  const pointBox = await point.boundingBox();
  if (!pointBox) throw new Error('Trend point is not rendered');
  await page.mouse.move(pointBox.x + pointBox.width / 2, pointBox.y + pointBox.height / 2);
  await page.waitForTimeout(120);
  const tooltipVisible = await page
    .locator('[data-trend-tooltip]')
    .evaluate((node) => !node.hidden);
  if (!tooltipVisible) throw new Error('Chart hover tooltip did not appear');
  console.log('tooltip', await page.locator('[data-trend-tooltip]').innerText());

  await page.locator('[data-role="trend-subject"]').selectOption('insight-english');
  await page.waitForFunction(() =>
    document.querySelector('.trend-chart-heading p')?.textContent?.includes('英语 · 科目总题库'),
  );
  const englishText = await page.locator('[data-trend-chart]').innerText();
  if (!englishText.includes('100%')) throw new Error('English accuracy summary is wrong');
  if ((await page.locator('[data-role="trend-bank"]').inputValue()) !== '') {
    throw new Error('Bank selection should reset when switching subjects');
  }
  console.log('english chart', await page.locator('.trend-kpi').innerText());

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'tests/insights-dark.png', fullPage: true });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'tests/insights-dashboard.png', fullPage: true });
  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('INSIGHTS UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/insights-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
