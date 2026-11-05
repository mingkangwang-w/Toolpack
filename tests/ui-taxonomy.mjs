import { chromium } from 'playwright-core';
import { resetTestLibrary } from './ui-helpers.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const errors = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'zh-CN' });
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

const now = new Date().toISOString();
const subjects = Array.from({ length: 10 }, (_, index) => ({
  id: `taxonomy-subject-${index + 1}`,
  name: `科目 ${String(index + 1).padStart(2, '0')}`,
  createdAt: now,
  updatedAt: now,
}));
const banks = subjects.flatMap((subject, index) => {
  if (index === 0) {
    // 故意打乱数组顺序，并让文件名顺序不同于创建顺序。
    return [
      {
        id: 'taxonomy-bank-10',
        subjectId: subject.id,
        name: '10 第十章',
        createdAt: '2026-01-01T10:03:00+08:00',
        updatedAt: '2026-01-01T10:03:00+08:00',
      },
      {
        id: 'taxonomy-bank-1',
        subjectId: subject.id,
        name: '1 第一章',
        createdAt: '2026-01-01T10:01:00+08:00',
        updatedAt: '2026-01-01T10:01:00+08:00',
      },
      {
        id: 'taxonomy-bank-2',
        subjectId: subject.id,
        name: '2 第二章',
        createdAt: '2026-01-01T10:02:00+08:00',
        updatedAt: '2026-01-01T10:02:00+08:00',
      },
    ];
  }
  return [
    {
      id: `taxonomy-bank-${index + 1}`,
      subjectId: subject.id,
      name: '章节题库',
      createdAt: now,
      updatedAt: now,
    },
  ];
});
const seed = {
  version: 2,
  subjects,
  banks,
  questions: [],
  history: [],
  settings: {
    theme: 'light',
    practiceCount: 'all',
    practiceShuffle: false,
    practiceFeedbackMode: 'immediate',
    lastBankId: banks[0].id,
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
  await page.waitForSelector('.library-page');
  await page.waitForSelector('.taxonomy-layout .subject-card');
  if ((await page.locator('.taxonomy-grid .subject-card').count()) !== 10) {
    throw new Error('Expected all subject cards in the scrollable subject area');
  }
  const firstBankNames = await page
    .locator('.taxonomy-grid .subject-card')
    .first()
    .locator('.bank-name')
    .allInnerTexts();
  const childBankNames = firstBankNames.filter((name) => name !== '科目总题库');
  if (JSON.stringify(childBankNames) !== JSON.stringify(['1 第一章', '2 第二章', '10 第十章'])) {
    throw new Error(`Child banks are not in creation order: ${JSON.stringify(childBankNames)}`);
  }

  const layout = await page.evaluate(() => {
    const taxonomyLayout = document.querySelector('.taxonomy-layout');
    const allCard = taxonomyLayout?.querySelector(':scope > .taxonomy-all-card');
    const grid = taxonomyLayout?.querySelector(':scope > .taxonomy-grid[data-taxonomy-scroll]');
    if (!taxonomyLayout || !allCard || !grid) return null;

    const allTopBefore = allCard.getBoundingClientRect().top;
    const gridTopBefore = grid.getBoundingClientRect().top;
    const overflowY = getComputedStyle(grid).overflowY;
    grid.scrollTop = grid.scrollHeight;
    const allTopAfter = allCard.getBoundingClientRect().top;
    const gridTopAfter = grid.getBoundingClientRect().top;
    return {
      directAllCard: allCard.parentElement === taxonomyLayout,
      allCardInsideGrid: Boolean(grid.querySelector('.taxonomy-all-card')),
      overflowY,
      clientHeight: grid.clientHeight,
      scrollHeight: grid.scrollHeight,
      scrollTop: grid.scrollTop,
      allTopBefore,
      allTopAfter,
      gridTopBefore,
      gridTopAfter,
    };
  });

  if (!layout) throw new Error('Taxonomy layout was not rendered');
  if (!layout.directAllCard || layout.allCardInsideGrid) {
    throw new Error('总题库 must stay outside the scrollable subject area');
  }
  if (layout.overflowY !== 'auto') {
    throw new Error(`Subject area should scroll independently, got overflow-y: ${layout.overflowY}`);
  }
  if (layout.scrollHeight <= layout.clientHeight || layout.scrollTop <= 0) {
    throw new Error('Subject area did not become scrollable with many subjects');
  }
  if (Math.abs(layout.allTopBefore - layout.allTopAfter) > 1) {
    throw new Error('总题库 moved while scrolling the subject area');
  }
  if (Math.abs(layout.gridTopBefore - layout.gridTopAfter) > 1) {
    throw new Error('Subject area itself moved while scrolling its content');
  }

  await page.waitForTimeout(250);
  await page.screenshot({ path: 'tests/taxonomy-scroll.png', fullPage: true });
  console.log('taxonomy scroll ok', layout);
  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('TAXONOMY UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/taxonomy-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
