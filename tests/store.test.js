import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerIssueReason,
  applyBankOrder,
  banksForSubject,
  canonicalBankKey,
  canonicalFolderKey,
  createBankRecord,
  createQuestion,
  createSubjectRecord,
  defaultState,
  exportBackup,
  getAccuracySeries,
  getLibraryIssues,
  getStats,
  gradeQuestion,
  historySummary,
  importBackup,
  isQuestionAnswerable,
  localDateKey,
  normalizeAnswer,
  normalizeBankOrder,
  questionDuplicateKey,
  recordAttempt,
  recordStudyDuration,
  repairQuestionPlacements,
  sanitizeQuestion,
  scopeCount,
  selectPracticeQuestions,
} from '../web/js/store.js';

function makeOptions() {
  return [
    { key: 'A', text: '甲' },
    { key: 'B', text: '乙' },
    { key: 'C', text: '丙' },
    { key: 'D', text: '丁' },
  ];
}

test('答题方式默认为每题查看答案', () => {
  assert.equal(defaultState().settings.practiceFeedbackMode, 'immediate');
});

test('无限模式默认关闭，AI 侧栏默认显示', () => {
  const settings = defaultState().settings;
  assert.equal(settings.practiceInfinite, false);
  assert.equal(settings.practiceShowAI, true);
});

test('磁盘科目和子题库名称使用与后端一致的冲突键', () => {
  assert.equal(canonicalFolderKey('A/B'), canonicalFolderKey('A?B'));
  assert.equal(canonicalFolderKey('Math'), canonicalFolderKey('math'));
  assert.equal(canonicalBankKey('第一章'), canonicalBankKey('第一章.md'));
  assert.equal(canonicalBankKey('A/B'), canonicalBankKey('A?B.md'));
});

test('子题库列表按创建时间排序，而不是按名称或存储顺序', () => {
  const state = defaultState();
  const subject = createSubjectRecord('数学');
  state.subjects.push(subject);
  const later = { ...createBankRecord(subject.id, '10 第十章'), createdAt: '2026-01-01T10:03:00+08:00' };
  const first = { ...createBankRecord(subject.id, '1 第一章'), createdAt: '2026-01-01T10:01:00+08:00' };
  const second = { ...createBankRecord(subject.id, '2 第二章'), createdAt: '2026-01-01T10:02:00+08:00' };
  state.banks.push(later, first, second);

  assert.deepEqual(
    banksForSubject(state, subject.id).map((bank) => bank.name),
    ['1 第一章', '2 第二章', '10 第十章'],
  );
});

test('拖拽后的子题库顺序优先于创建时间并会写回 order', () => {
  const state = defaultState();
  const subject = createSubjectRecord('数学');
  state.subjects.push(subject);
  const one = {
    ...createBankRecord(subject.id, '第一章'),
    order: 2,
    createdAt: '2026-01-01T10:01:00+08:00',
  };
  const two = {
    ...createBankRecord(subject.id, '第二章'),
    order: 0,
    createdAt: '2026-01-01T10:02:00+08:00',
  };
  const three = {
    ...createBankRecord(subject.id, '第三章'),
    order: 1,
    createdAt: '2026-01-01T10:03:00+08:00',
  };
  state.banks.push(one, two, three);
  assert.deepEqual(
    banksForSubject(state, subject.id).map((bank) => bank.name),
    ['第二章', '第三章', '第一章'],
  );

  assert.equal(
    applyBankOrder(state, subject.id, [three.id, one.id, two.id]),
    true,
  );
  assert.deepEqual(
    banksForSubject(state, subject.id).map((bank) => bank.name),
    ['第三章', '第一章', '第二章'],
  );
  assert.deepEqual([one.order, two.order, three.order], [1, 2, 0]);
  assert.equal(normalizeBankOrder(state, subject.id), 3);
  assert.deepEqual([one.order, two.order, three.order], [1, 2, 0]);
});

test('AI 复核标记会规范化并随题目保留', () => {
  const question = sanitizeQuestion({
    type: 'single',
    stem: '带 AI 警告的题目',
    options: makeOptions(),
    answer: 'A',
    aiReview: {
      flagged: true,
      confidence: 0.62,
      warnings: ['选项可能有识别歧义', '选项可能有识别歧义'],
      sourceFilename: '第 2 页.png',
      pageNumber: 2,
    },
  });
  assert.deepEqual(question.aiReview, {
    flagged: true,
    confidence: 0.62,
    warnings: ['选项可能有识别歧义'],
    sourceFilename: '第 2 页.png',
    pageNumber: 2,
  });

  const lowConfidence = sanitizeQuestion({
    type: 'fill',
    stem: '低置信度题目',
    options: [],
    answer: '答案',
    aiReview: { confidence: 0.4 },
  });
  assert.equal(lowConfidence.aiReview.flagged, true);
  assert.equal(lowConfidence.aiReview.confidence, 0.4);

  const normal = sanitizeQuestion({
    type: 'fill',
    stem: '普通题目',
    options: [],
    answer: '答案',
  });
  assert.equal(normal.aiReview, null);
});

test('单选题的多个答案会保留为异常而不是静默截断', () => {
  const question = sanitizeQuestion({
    type: 'single',
    stem: '单选题',
    options: makeOptions(),
    answer: 'AB',
  });
  assert.equal(question.answer, 'AB');
  assert.equal(answerIssueReason(question), '单选题存在多个答案');
  assert.equal(isQuestionAnswerable(question), false);
});

test('多选答案会去重并排序', () => {
  const answer = normalizeAnswer('D、A、D', 'multiple', makeOptions());
  assert.equal(answer, 'AD');
});

test('单选题只保留一个有效字母', () => {
  const answer = normalizeAnswer(' c ', 'single', makeOptions());
  assert.equal(answer, 'C');
});

test('判断题文字答案会映射到选项字母', () => {
  const options = [
    { key: 'A', text: '正确' },
    { key: 'B', text: '错误' },
  ];
  assert.equal(normalizeAnswer('错', 'judge', options), 'B');
  assert.equal(normalizeAnswer('√', 'judge', options), 'A');
});

test('填空题判分忽略空格和常见标点', () => {
  const question = createQuestion({
    type: 'fill',
    stem: '水的化学式是______。',
    options: [],
    answer: 'H₂O',
  });
  assert.equal(gradeQuestion(question, 'h₂ o').correct, true);
  assert.equal(gradeQuestion(question, 'H2O').correct, true);
  assert.equal(gradeQuestion(question, 'CO2').correct, false);
});

test('填空题支持用竖线分隔多个可接受答案', () => {
  const question = createQuestion({
    type: 'fill',
    stem: '首都是？',
    options: [],
    answer: '北京|北京市',
  });
  assert.equal(gradeQuestion(question, ' 北京市 ').correct, true);
  assert.equal(gradeQuestion(question, '上海').correct, false);
});

test('简答题保留文本答案、无选项，并等待自评', () => {
  const question = createQuestion({
    type: 'short',
    stem: '简述光合作用的过程。',
    options: makeOptions(),
    answer: '光反应阶段\n暗反应阶段',
  });
  assert.equal(question.type, 'short');
  assert.deepEqual(question.options, []);
  assert.equal(question.answer, '光反应阶段\n暗反应阶段');
  assert.equal(isQuestionAnswerable(question), true);
  assert.equal(answerIssueReason(question), '');

  const graded = gradeQuestion(question, '光反应和暗反应');
  assert.equal(graded.correct, null);
  assert.equal(graded.pendingSelfGrade, true);
  assert.equal(graded.given, '光反应和暗反应');
});

test('简答题没有参考答案也可以进入练习，参考答案仅供自评参考', () => {
  const question = createQuestion({
    type: 'short',
    stem: '简述光合作用的过程。',
    options: [],
    answer: '',
  });
  assert.equal(question.type, 'short');
  assert.equal(isQuestionAnswerable(question), true);

  const state = defaultState();
  state.questions.push(question);
  assert.equal(scopeCount(state, 'all'), 1);
  assert.equal(selectPracticeQuestions(state, { count: 'all' })[0]?.id, question.id);
});

test('选择题判分不依赖选项顺序', () => {
  const question = createQuestion({
    type: 'multiple',
    stem: '选出正确的',
    options: makeOptions(),
    answer: 'AC',
  });
  assert.equal(gradeQuestion(question, 'C,A').correct, true);
  assert.equal(gradeQuestion(question, 'A').correct, false);
});

test('答题统计、连续答对和错题状态会更新', () => {
  const state = defaultState();
  const question = createQuestion({
    type: 'single',
    stem: '1 + 1 = ?',
    options: makeOptions(),
    answer: 'A',
  });
  state.questions.push(question);

  recordAttempt(state, question, true);
  recordAttempt(state, question, true);
  assert.equal(question.stats.attempts, 2);
  assert.equal(question.stats.correct, 2);
  assert.equal(question.stats.streak, 2);
  assert.equal(getStats(state).mastered, 1);

  recordAttempt(state, question, false);
  assert.equal(question.stats.wrong, 1);
  assert.equal(question.stats.streak, 0);
  assert.equal(question.stats.lastResult, 'wrong');
  assert.equal(getStats(state).wrong, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].answered, 3);
});

test('重复题判断会忽略空格和常见标点', () => {
  const first = createQuestion({
    type: 'single',
    stem: '下列关于细胞膜的叙述，正确的是（  ）',
    options: makeOptions(),
    answer: 'A',
  });
  const second = createQuestion({
    type: 'single',
    stem: '下列关于细胞膜的叙述 正确的是()',
    options: makeOptions(),
    answer: 'B',
  });
  assert.equal(questionDuplicateKey(first), questionDuplicateKey(second));
  assert.equal(questionDuplicateKey(first).length > 0, true);
});

test('忽略重复提醒后题目仍保留，但不再计入重复统计', () => {
  const first = createQuestion({
    type: 'single',
    stem: '已有的重复题',
    options: makeOptions(),
    answer: 'A',
  });
  const second = createQuestion({
    type: 'single',
    stem: '已有的重复题',
    options: makeOptions(),
    answer: 'B',
  });
  const questions = [first, second];

  const issues = getLibraryIssues(questions);
  assert.equal(issues.duplicateGroupCount, 1);
  assert.equal(issues.duplicateQuestionCount, 2);

  const key = questionDuplicateKey(first);
  const ignored = getLibraryIssues(questions, { ignoredDuplicateKeys: [key] });
  assert.equal(ignored.duplicateGroupCount, 0);
  assert.equal(ignored.duplicateQuestionCount, 0);
  assert.equal(ignored.ignoredDuplicateGroupCount, 1);
  assert.equal(ignored.ignoredDuplicateQuestionCount, 2);
  assert.equal(questions.length, 2);
});

test('学习时长和分科目、子题库正确率会按日累计', () => {
  const state = defaultState();
  const subject = createSubjectRecord('数学');
  const bank = createBankRecord(subject.id, '第一章');
  state.subjects.push(subject);
  state.banks.push(bank);
  const question = createQuestion({
    type: 'single',
    stem: '学习统计题',
    options: makeOptions(),
    answer: 'A',
    subjectId: subject.id,
    bankId: bank.id,
  });
  state.questions.push(question);

  recordAttempt(state, question, true, { durationMs: 120_000 });
  recordAttempt(state, question, false, { durationMs: 60_000 });
  recordStudyDuration(state, 30_000);

  const today = localDateKey();
  const entry = state.history.find((item) => item.date === today);
  assert.equal(entry.durationMs, 210_000);
  assert.deepEqual(entry.bySubject[subject.id], { answered: 2, correct: 1 });
  assert.deepEqual(entry.byBank[bank.id], { answered: 2, correct: 1 });

  const summary = historySummary(state, 30);
  assert.equal(summary.answered, 2);
  assert.equal(summary.correct, 1);
  assert.equal(summary.durationMs, 210_000);
  assert.equal(summary.activeDays, 1);
  assert.equal(summary.accuracy, 50);

  const subjectSeries = getAccuracySeries(state, { subjectId: subject.id, days: 30 });
  assert.equal(subjectSeries.at(-1).answered, 2);
  assert.equal(subjectSeries.at(-1).accuracy, 50);
  const bankSeries = getAccuracySeries(state, { bankId: bank.id, days: 30 });
  assert.equal(bankSeries.at(-1).accuracy, 50);
  const otherSeries = getAccuracySeries(state, { subjectId: 'subject_other', days: 30 });
  assert.equal(otherSeries.reduce((sum, point) => sum + point.answered, 0), 0);
});

test('练习题库只包含有答案的题，并按范围筛选', () => {
  const state = defaultState();
  const good = createQuestion({
    type: 'single',
    stem: '有答案的题',
    options: makeOptions(),
    answer: 'A',
  });
  const wrong = createQuestion({
    type: 'single',
    stem: '有答案但答错的题',
    options: makeOptions(),
    answer: 'B',
  });
  wrong.stats.lastResult = 'wrong';
  wrong.stats.wrong = 1;
  wrong.stats.attempts = 1;
  const missing = createQuestion({
    type: 'single',
    stem: '没有答案的题',
    options: makeOptions(),
    answer: '',
  });
  state.questions.push(good, wrong, missing);

  assert.equal(scopeCount(state, 'all'), 2);
  assert.equal(scopeCount(state, 'wrong'), 1);
  assert.equal(scopeCount(state, 'favorites'), 0);
  assert.deepEqual(
    selectPracticeQuestions(state, { scope: 'wrong', count: 10, shuffle: false }).map((q) => q.id),
    [wrong.id],
  );
});

test('按科目和子题库筛选可练习题', () => {
  const state = defaultState();
  const math = createSubjectRecord('数学');
  const english = createSubjectRecord('英语');
  const chapterOne = createBankRecord(math.id, '第一章');
  const chapterTwo = createBankRecord(math.id, '第二章');
  const words = createBankRecord(english.id, '单词');
  state.subjects.push(math, english);
  state.banks.push(chapterOne, chapterTwo, words);

  const q1 = createQuestion({
    type: 'single',
    stem: '数学第一章',
    options: makeOptions(),
    answer: 'A',
    subjectId: math.id,
    bankId: chapterOne.id,
  });
  const q2 = createQuestion({
    type: 'fill',
    stem: '数学第二章',
    options: [],
    answer: '答案',
    subjectId: math.id,
    bankId: chapterTwo.id,
  });
  const q3 = createQuestion({
    type: 'fill',
    stem: '英语单词',
    options: [],
    answer: 'word',
    subjectId: english.id,
    bankId: words.id,
  });
  state.questions.push(q1, q2, q3);

  assert.equal(scopeCount(state, 'all', { subjectId: math.id }), 2);
  assert.equal(scopeCount(state, 'all', { bankId: chapterOne.id }), 1);
  assert.deepEqual(
    selectPracticeQuestions(state, {
      scope: 'all',
      count: 'all',
      shuffle: false,
      subjectId: math.id,
    }).map((question) => question.id),
    [q1.id, q2.id],
  );
  assert.deepEqual(
    selectPracticeQuestions(state, {
      scope: 'all',
      count: 10,
      shuffle: false,
      bankId: words.id,
    }).map((question) => question.id),
    [q3.id],
  );
});

test('旧题目迁移时自动放入未分类科目和子题库', () => {
  const state = defaultState();
  const question = createQuestion({
    type: 'fill',
    stem: '没有归属的旧题目',
    options: [],
    answer: '答案',
  });
  state.questions.push(question);

  assert.equal(repairQuestionPlacements(state), true);
  assert.equal(state.subjects.length, 1);
  assert.equal(state.banks.length, 1);
  assert.equal(state.subjects[0].name, '未分类科目');
  assert.equal(state.banks[0].name, '未分类题库');
  assert.equal(question.subjectId, state.subjects[0].id);
  assert.equal(question.bankId, state.banks[0].id);
});

test('导入备份会恢复科目、子题库与题目归属', () => {
  const source = defaultState();
  const subject = createSubjectRecord('物理');
  const bank = createBankRecord(subject.id, '力学');
  source.subjects.push(subject);
  source.banks.push(bank);
  source.questions.push(
    createQuestion({
      type: 'fill',
      stem: '重力加速度',
      options: [],
      answer: 'g',
      subjectId: subject.id,
      bankId: bank.id,
    }),
  );

  const target = defaultState();
  const result = importBackup(target, exportBackup(source));
  assert.equal(result.added, 1);
  assert.equal(result.subjectsAdded, 1);
  assert.equal(result.banksAdded, 1);
  assert.equal(target.subjects[0].name, '物理');
  assert.equal(target.banks[0].name, '力学');
  assert.equal(target.questions[0].subjectId, target.subjects[0].id);
  assert.equal(target.questions[0].bankId, target.banks[0].id);
});

test('导入备份会跳过重复题目并合并历史', () => {
  const state = defaultState();
  const original = createQuestion({
    type: 'single',
    stem: '重复题',
    options: makeOptions(),
    answer: 'A',
  });
  state.questions.push(original);
  const newQuestion = createQuestion({
    type: 'fill',
    stem: '新题',
    options: [],
    answer: '答案',
  });
  const changedCopy = { ...original, answer: 'C' };
  const result = importBackup(state, {
    questions: [changedCopy, newQuestion],
    history: [{ date: '2026-01-01', answered: 5, correct: 4 }],
  });
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(state.questions.length, 2);
  assert.equal(state.questions[0].answer, 'A');
  assert.deepEqual(state.history, [
    {
      date: '2026-01-01',
      answered: 5,
      correct: 4,
      durationMs: 0,
      bySubject: {},
      byBank: {},
    },
  ]);
});

test('导入备份会保留学习时长和分科目、子题库历史', () => {
  const state = defaultState();
  const question = createQuestion({
    type: 'single',
    stem: '备份历史题',
    options: makeOptions(),
    answer: 'A',
  });
  state.questions.push(question);
  const historyEntry = {
    date: '2026-01-01',
    answered: 2,
    correct: 1,
    durationMs: 420_000,
    bySubject: { subject_math: { answered: 2, correct: 1 } },
    byBank: { bank_limits: { answered: 2, correct: 1 } },
  };
  importBackup(state, { questions: [question], history: [historyEntry] });
  assert.deepEqual(state.history, [historyEntry]);
});

test('导入备份会为已存在的题目合并练习统计和收藏', () => {
  const state = defaultState();
  const original = createQuestion({
    type: 'single',
    stem: '统计恢复题',
    options: makeOptions(),
    answer: 'A',
  });
  state.questions.push(original);
  const backupQuestion = {
    ...original,
    favorite: true,
    stats: {
      attempts: 5,
      correct: 4,
      wrong: 1,
      streak: 2,
      lastResult: 'wrong',
      lastAt: '2026-02-01T10:00:00+08:00',
    },
  };

  const result = importBackup(state, { questions: [backupQuestion], history: [] });
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
  assert.equal(state.questions.length, 1);
  assert.equal(state.questions[0].favorite, true);
  assert.deepEqual(state.questions[0].stats, backupQuestion.stats);
});

test('导入备份按大小写和磁盘文件名合并科目与子题库', () => {
  const state = defaultState();
  const subject = {
    id: 'subject-local',
    name: 'Math',
    createdAt: '2026-01-01T10:00:00+08:00',
    updatedAt: '2026-01-01T10:00:00+08:00',
  };
  const bank = {
    id: 'bank-local',
    subjectId: subject.id,
    name: 'Chapter/One',
    createdAt: '2026-01-01T10:00:00+08:00',
    updatedAt: '2026-01-01T10:00:00+08:00',
  };
  state.subjects.push(subject);
  state.banks.push(bank);

  const result = importBackup(state, {
    subjects: [
      {
        id: 'subject-remote',
        name: 'math',
        createdAt: '2026-01-02T10:00:00+08:00',
        updatedAt: '2026-01-02T10:00:00+08:00',
      },
    ],
    banks: [
      {
        id: 'bank-remote',
        subjectId: 'subject-remote',
        name: 'Chapter?One.md',
        createdAt: '2026-01-02T10:00:00+08:00',
        updatedAt: '2026-01-02T10:00:00+08:00',
      },
    ],
    questions: [
      {
        id: 'question-remote',
        subjectId: 'subject-remote',
        bankId: 'bank-remote',
        type: 'fill',
        stem: '远端题目',
        options: [],
        answer: '答案',
      },
    ],
  });

  assert.equal(result.subjectsAdded, 0);
  assert.equal(result.banksAdded, 0);
  assert.equal(state.subjects.length, 1);
  assert.equal(state.banks.length, 1);
  assert.equal(state.questions[0].subjectId, subject.id);
  assert.equal(state.questions[0].bankId, bank.id);
});
