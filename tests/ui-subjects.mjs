import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { resetTestLibrary } from './ui-helpers.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const LIBRARY_DIR = process.env.LIBRARY_DIR || '';
const sample = path.resolve('示例/示例题目.png');
const errors = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

async function shot(name, fullPage = true) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `tests/${name}.png`, fullPage });
  console.log('shot', name);
}

try {
  await resetTestLibrary(BASE);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dashboard-page');

  // Create a subject.
  await page.locator('.nav-item[data-nav="library"]').click();
  await page.waitForSelector('.library-page');
  await page.locator('.page-header [data-action="new-subject"]').click();
  await page.waitForSelector('dialog[open] [data-entity-name]');
  await page.locator('dialog[open] [data-entity-name]').fill('高等数学');
  await page.locator('dialog[open] [data-entity-save]').click();
  await page.waitForSelector('.subject-card');
  console.log('subject created', await page.locator('.subject-card-copy h3').allInnerTexts());

  // Create a child question bank.
  await page.locator('.subject-card [data-action="new-bank"]').first().click();
  await page.waitForSelector('dialog[open] [data-entity-name]');
  await page.locator('dialog[open] [data-entity-name]').fill('第一章 极限');
  await page.locator('dialog[open] [data-entity-save]').click();
  await page.waitForSelector('.bank-row:not(.is-subject-total)');
  console.log('bank created', await page.locator('.bank-name').allInnerTexts());
  if (LIBRARY_DIR) {
    const subjectFile = path.join(LIBRARY_DIR, '高等数学', '.shuati-subject.json');
    const bankFile = path.join(LIBRARY_DIR, '高等数学', '第一章 极限.md');
    if (!fs.existsSync(subjectFile) || !fs.existsSync(bankFile)) {
      throw new Error('Expected Markdown folders/files were not created');
    }
    if (fs.existsSync(path.join(LIBRARY_DIR, '高等数学', '第一章 极限'))) {
      throw new Error('Bank should be a Markdown file, not a subfolder');
    }
    console.log('markdown files created');
  }
  await shot('subjects-created');

  // Import sample and save to the selected bank.
  await page.locator('.nav-item[data-nav="import"]').click();
  await page.waitForSelector('.import-page');
  const subjectValue = await page.locator('[data-role="import-subject"]').inputValue();
  const bankValue = await page.locator('[data-role="import-bank"]').inputValue();
  if (!subjectValue || !bankValue) throw new Error('Import target was not preselected');
  console.log('import target', subjectValue, bankValue);
  await shot('subjects-import-target', false);
  await page.locator('input[data-role="file-input"]:not([capture])').setInputFiles(sample);
  await page.waitForSelector('.preview-card', { timeout: 90_000 });
  await page.locator('.preview-actions [data-action="save"]').click();
  await page.waitForSelector('.library-page', { timeout: 20_000 });
  const rowCount = await page.locator('.question-row').count();
  console.log('saved rows', rowCount);
  if (rowCount !== 4) throw new Error(`Expected 4 saved questions, got ${rowCount}`);
  const rowBank = await page.locator('.row-bank').first().innerText();
  console.log('row bank', rowBank);
  if (!rowBank.includes('第一章')) throw new Error('Question row did not show the selected bank');
  if (LIBRARY_DIR) {
    const markdown = fs.readFileSync(
      path.join(LIBRARY_DIR, '高等数学', '第一章 极限.md'),
      'utf8',
    );
    if (!markdown.includes('**答案**') || !markdown.includes('下列关于细胞膜')) {
      throw new Error('Markdown did not contain the saved question and answer');
    }
    console.log('markdown contains question and answer');
  }
  await shot('subjects-library-bank');

  // Start practice for this bank, select all questions.
  await page.locator('.bank-row.is-active [data-action="practice-bank"]').first().click();
  await page.waitForSelector('.practice-setup-page');
  const practiceSubject = await page.locator('[data-role="practice-subject"]').inputValue();
  const practiceBank = await page.locator('[data-role="practice-bank"]').inputValue();
  if (!practiceSubject || !practiceBank) throw new Error('Practice target was not preselected');
  await page.locator('[data-count="all"]').click();
  const startCount = await page.locator('[data-start-count]').innerText();
  console.log('bank all count', startCount);
  if (Number(startCount) !== 4) throw new Error(`Expected 4 bank questions, got ${startCount}`);
  await shot('subjects-practice-setup');
  await page.locator('.setup-start-row [data-action="start"]').click();
  await page.waitForSelector('.session-page');
  console.log('session label', await page.locator('.session-progress-copy span').nth(1).innerText());

  // Leave session, then open all-subject practice setup.
  await page.locator('[data-action="exit-session"]').click();
  await page.waitForTimeout(200);
  if (await page.locator('dialog[open] [data-confirm]').count()) {
    await page.locator('dialog[open] [data-confirm]').click();
  }
  await page.waitForSelector('.practice-setup-page', { timeout: 10_000 });
  await page.locator('.nav-item[data-nav="library"]').click();
  await page.waitForSelector('.library-page');
  await page.locator('[data-action="practice-all"]').first().click();
  await page.waitForSelector('.practice-setup-page');
  const allSubject = await page.locator('[data-role="practice-subject"]').inputValue();
  if (allSubject !== '') throw new Error('Total practice should default to all subjects');
  await page.locator('[data-count="all"]').click();
  const allCount = await page.locator('[data-start-count]').innerText();
  console.log('global all count', allCount);
  if (Number(allCount) !== 4) throw new Error(`Expected 4 global questions, got ${allCount}`);
  await page.locator('[data-role="custom-count"]').fill('2');
  await page.waitForTimeout(150);
  const customCount = await page.locator('[data-start-count]').innerText();
  console.log('custom count', customCount);
  if (customCount !== '2') throw new Error(`Expected custom count 2, got ${customCount}`);
  await shot('subjects-practice-all');

  if (LIBRARY_DIR) {
    const bankFile = path.join(LIBRARY_DIR, '高等数学', '第一章 极限.md');
    let markdown = fs.readFileSync(bankFile, 'utf8');
    markdown = markdown.replace('下列关于细胞膜的叙述，正确的是（）', '手动编辑后的 Markdown 题干');
    fs.writeFileSync(bankFile, markdown, 'utf8');

    await page.locator('.nav-item[data-nav="library"]').click();
    await page.waitForSelector('.library-page');
    await page.locator('.sidebar-tool[data-global-action="data"]').click();
    await page.waitForSelector('.data-manager');
    await page.locator('[data-data-reload-disk]').click();
    await page.locator('.data-manager').waitFor({ state: 'detached', timeout: 15_000 });
    await page.waitForTimeout(300);
    const refreshedStems = await page.locator('.question-row-stem').allInnerTexts();
    console.log('reloaded stems', refreshedStems);
    if (!refreshedStems.some((stem) => stem.includes('手动编辑后的 Markdown 题干'))) {
      throw new Error('Reloading from disk did not pick up manual Markdown edits');
    }
  }

  console.log('errors', JSON.stringify(errors, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error('SUBJECT UI TEST FAILED', error);
  await page.screenshot({ path: 'tests/subjects-failure.png', fullPage: true }).catch(() => {});
  console.log('errors', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
