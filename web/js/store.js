/**
 * 题库数据层：本地持久化、题目规范化、练习选择与判分。
 * 所有数据只存在当前浏览器的 localStorage 中。
 */

export const STORAGE_KEY = 'shuati-helper:data:v1';

export const QUESTION_TYPES = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  fill: '填空题',
  short: '简答题',
};

const VALID_TYPES = new Set(Object.keys(QUESTION_TYPES));
const LETTERS = 'ABCDEFGH';

export const UNCLASSIFIED_SUBJECT_ID = 'subject_unclassified';
export const UNCLASSIFIED_BANK_ID = 'bank_unclassified';

function uid(prefix = 'q') {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function entityName(value, fallback = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;
}

const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

function canonicalSafeName(value) {
  let cleaned = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  cleaned = cleaned
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, 80)
    .replace(/^[ .]+|[ .]+$/g, '');
  if (!cleaned) cleaned = '未命名';
  if (WINDOWS_RESERVED_NAMES.has(cleaned.split('.', 1)[0].toUpperCase())) {
    cleaned = `_${cleaned}`;
  }
  return cleaned;
}

export function canonicalFolderKey(name) {
  return canonicalSafeName(name).toLowerCase();
}

export function canonicalBankKey(name) {
  let cleaned = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (cleaned.toLowerCase().endsWith('.md')) cleaned = cleaned.slice(0, -3);
  return canonicalSafeName(cleaned).toLowerCase();
}

export function createSubjectRecord(name) {
  const now = new Date().toISOString();
  return {
    id: uid('subject'),
    name: entityName(name, '未命名科目'),
    createdAt: now,
    updatedAt: now,
  };
}

export function createBankRecord(subjectId, name, order = null) {
  const now = new Date().toISOString();
  return {
    id: uid('bank'),
    subjectId: String(subjectId || ''),
    name: entityName(name, '未命名子题库'),
    order: Number.isInteger(order) && order >= 0 ? order : null,
    createdAt: now,
    updatedAt: now,
  };
}

export function subjectById(state, id) {
  return (state?.subjects || []).find((subject) => subject.id === id) || null;
}

export function bankById(state, id) {
  return (state?.banks || []).find((bank) => bank.id === id) || null;
}

function compareBankOrder(a, b) {
  const aOrder = Number.isInteger(a?.order) ? a.order : null;
  const bOrder = Number.isInteger(b?.order) ? b.order : null;
  if (aOrder !== null && bOrder !== null && aOrder !== bOrder) return aOrder - bOrder;
  if ((aOrder !== null) !== (bOrder !== null)) return aOrder !== null ? -1 : 1;

  const aTime = Date.parse(a?.createdAt || '');
  const bTime = Date.parse(b?.createdAt || '');
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid && bValid && aTime !== bTime) return aTime - bTime;
  if (aValid !== bValid) return aValid ? -1 : 1;
  return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-Hans-CN', {
    numeric: true,
  });
}

export function banksForSubject(state, subjectId) {
  return (state?.banks || [])
    .filter((bank) => bank.subjectId === subjectId)
    .sort(compareBankOrder);
}

/** 按当前显示顺序补齐 order，并返回下一个可用的排序值。 */
export function normalizeBankOrder(state, subjectId) {
  const banks = banksForSubject(state, subjectId);
  banks.forEach((bank, index) => {
    bank.order = index;
  });
  return banks.length;
}

/** 按给定 ID 顺序重写某个科目的子题库顺序。 */
export function applyBankOrder(state, subjectId, orderedIds) {
  const banks = banksForSubject(state, subjectId);
  const ids = Array.isArray(orderedIds) ? orderedIds : [];
  if (ids.length !== banks.length) return false;
  const byId = new Map(banks.map((bank) => [bank.id, bank]));
  if (new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) return false;
  ids.forEach((id, index) => {
    byId.get(id).order = index;
  });
  return true;
}

export function filterQuestionsByBank(questions, { subjectId = '', bankId = '' } = {}) {
  if (bankId) return questions.filter((question) => question.bankId === bankId);
  if (subjectId) return questions.filter((question) => question.subjectId === subjectId);
  return questions;
}

export function isChoiceType(type) {
  return type === 'single' || type === 'multiple' || type === 'judge';
}

export function isWrittenAnswerType(type) {
  return type === 'fill' || type === 'short';
}

function defaultStats() {
  return {
    attempts: 0,
    correct: 0,
    wrong: 0,
    streak: 0,
    lastResult: null,
    lastAt: null,
  };
}

function cleanString(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function normalizeAiReview(value) {
  if (!value || typeof value !== 'object') return null;
  const warnings = Array.isArray(value.warnings)
    ? [...new Set(value.warnings.map((item) => cleanString(item)).filter(Boolean))].slice(0, 8)
    : [];
  const confidenceRaw = Number(value.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.min(1, Math.max(0, confidenceRaw))
    : null;
  const lowConfidence = confidence !== null && confidence < 0.7;
  if (!value.flagged && !warnings.length && !lowConfidence) return null;
  const pageRaw = Number.parseInt(value.pageNumber, 10);
  return {
    flagged: true,
    confidence,
    warnings,
    sourceFilename: cleanString(value.sourceFilename).slice(0, 200),
    pageNumber: Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : null,
  };
}

function normalizeTruth(value) {
  const token = cleanString(value)
    .replace(/[\s。.!！,，:：;；]/g, '')
    .toLowerCase();
  if (['正确', '对', '是', '√', '✓', 't', 'true'].includes(token)) return '正确';
  if (['错误', '错', '否', '×', '✗', 'f', 'false'].includes(token)) return '错误';
  return null;
}

function answerLetters(answer, options) {
  const validKeys = new Set(options.map((option) => option.key));
  const compact = cleanString(answer)
    .replace(/\s+/g, '')
    .replace(/[.．、,，;；/／和及。]/g, '')
    .toUpperCase();
  if (!/^[A-H]+$/.test(compact)) return [];
  const letters = [...new Set(compact.split(''))];
  return letters.every((letter) => validKeys.has(letter)) ? letters.sort() : [];
}

/**
 * 把各种答案写法整理成统一的答案。
 * 选择/判断题保存为字母组合，填空/简答题保留原文。
 */
export function normalizeAnswer(answer, type, options) {
  const raw = cleanString(answer);
  if (!raw) return '';

  if (isWrittenAnswerType(type)) return raw;

  const letters = answerLetters(raw, options);
  if (letters.length) {
    if (type === 'single' || type === 'judge') return letters[0];
    return letters.join('');
  }

  if (type === 'judge') {
    const truth = normalizeTruth(raw);
    if (truth) {
      const matched = options.find((option) => normalizeTruth(option.text) === truth);
      if (matched) return matched.key;
    }
  }

  const compactText = raw
    .replace(/\s+/g, '')
    .replace(/[，,。.；;、：:！!？?“”"'‘’（）()【】[\]]/g, '')
    .toLowerCase();
  const textMatches = options.filter((option) => {
    const optionText = option.text
      .replace(/\s+/g, '')
      .replace(/[，,。.；;、：:！!？?“”"'‘’（）()【】[\]]/g, '')
      .toLowerCase();
    return optionText && optionText === compactText;
  });
  if (textMatches.length === 1) return textMatches[0].key;

  return raw;
}

function normalizeOptionObjects(rawOptions) {
  if (!Array.isArray(rawOptions)) return [];
  return rawOptions
    .map((option) => {
      if (typeof option === 'string') return { key: '', text: cleanString(option) };
      return {
        key: String(option?.key || '').trim().toUpperCase(),
        text: cleanString(option?.text ?? option?.label ?? option?.value),
      };
    })
    .filter((option) => option.text)
    .slice(0, LETTERS.length);
}

/**
 * 统一题目的字段。会重新分配连续的选项字母，并同步答案字母。
 */
export function sanitizeQuestion(raw, { keepId = true, preserveStats = true } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const originalOptions = normalizeOptionObjects(source.options);

  const oldToNew = new Map();
  const options = originalOptions.map((option, index) => {
    const newKey = LETTERS[index];
    if (option.key) oldToNew.set(option.key, newKey);
    return { key: newKey, text: option.text };
  });

  let type = VALID_TYPES.has(source.type) ? source.type : 'fill';
  if (isChoiceType(type) && options.length < 2) type = 'fill';
  if (type === 'short') options.length = 0;

  let answer = cleanString(source.answer ?? source.answerText);
  if (isChoiceType(type)) {
    const rawLetters = answerLetters(answer, originalOptions);
    let mappedMultiple = false;
    if (rawLetters.length) {
      const mapped = rawLetters
        .map((letter) => oldToNew.get(letter))
        .filter(Boolean)
        .sort();
      if (mapped.length) {
        answer = mapped.join('');
        mappedMultiple =
          mapped.length > 1 && (type === 'single' || type === 'judge');
      }
    }
    if (!mappedMultiple) answer = normalizeAnswer(answer, type, options);
  }

  if (type === 'judge' && options.length !== 2) {
    answer = '';
  }

  const statsSource = preserveStats && source.stats && typeof source.stats === 'object' ? source.stats : {};
  const toCount = (value) => Math.max(0, Number.parseInt(value, 10) || 0);
  const stats = {
    attempts: toCount(statsSource.attempts),
    correct: toCount(statsSource.correct),
    wrong: toCount(statsSource.wrong),
    streak: toCount(statsSource.streak),
    lastResult: ['correct', 'wrong'].includes(statsSource.lastResult) ? statsSource.lastResult : null,
    lastAt: typeof statsSource.lastAt === 'string' ? statsSource.lastAt : null,
  };
  if (stats.correct + stats.wrong > stats.attempts) stats.attempts = stats.correct + stats.wrong;

  const createdAt = typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString();
  return {
    id: keepId && typeof source.id === 'string' && source.id ? source.id : uid(),
    subjectId: typeof source.subjectId === 'string' ? source.subjectId : '',
    bankId: typeof source.bankId === 'string' ? source.bankId : '',
    type,
    stem: cleanString(source.stem),
    options,
    answer,
    explanation: cleanString(source.explanation),
    favorite: Boolean(source.favorite),
    aiReview: normalizeAiReview(source.aiReview),
    createdAt,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : createdAt,
    stats,
  };
}

export function createQuestion(draft) {
  const question = sanitizeQuestion({ ...draft, stats: defaultStats() }, { keepId: false });
  question.createdAt = new Date().toISOString();
  question.updatedAt = question.createdAt;
  return question;
}

function normalizedStemKey(question) {
  return String(question?.stem || '')
    .replace(/\s+/g, '')
    .replace(/[，,。.；;：:！!？?“”"'‘’（）()【】[\]]/g, '')
    .toLowerCase();
}

export function questionDuplicateKey(question) {
  return normalizedStemKey(question);
}

function normalizeDuplicateIgnores(raw) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const key = item.trim().slice(0, 10_000);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
    if (result.length >= 1000) break;
  }
  return result;
}

export function findDuplicateGroups(questions) {
  const groups = new Map();
  for (const question of questions) {
    const key = normalizedStemKey(question);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(question);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

export function answerIssueReason(question) {
  if (!question || !isChoiceType(question.type)) return '';
  if (!cleanString(question.answer)) return '';
  if (!Array.isArray(question.options) || question.options.length < 2) return '选项不足';

  const keys = new Set(question.options.map((option) => option.key));
  const compact = cleanString(question.answer)
    .replace(/\s+/g, '')
    .replace(/[.．、,，;；/／和及。]/g, '')
    .toUpperCase();
  if (!/^[A-H]+$/.test(compact)) return '答案无法对应选项';
  const letters = [...new Set(compact.split(''))];
  if (!letters.every((letter) => keys.has(letter))) return '答案不在选项中';
  if ((question.type === 'single' || question.type === 'judge') && letters.length > 1) {
    return '单选题存在多个答案';
  }
  return '';
}

export function getLibraryIssues(questions, { ignoredDuplicateKeys = [] } = {}) {
  const ignored =
    ignoredDuplicateKeys instanceof Set
      ? ignoredDuplicateKeys
      : new Set(normalizeDuplicateIgnores(ignoredDuplicateKeys));
  const allDuplicateGroups = findDuplicateGroups(questions);
  const duplicateGroups = [];
  const ignoredDuplicateGroups = [];
  for (const group of allDuplicateGroups) {
    const key = questionDuplicateKey(group[0]);
    if (ignored.has(key)) ignoredDuplicateGroups.push(group);
    else duplicateGroups.push(group);
  }
  const duplicateIds = new Set(duplicateGroups.flat().map((question) => question.id));
  const missing = questions.filter(
    (question) => !isQuestionAnswerable(question) && !answerIssueReason(question),
  );
  const answerIssues = questions
    .map((question) => ({ question, reason: answerIssueReason(question) }))
    .filter((entry) => entry.reason);
  return {
    missing,
    duplicateGroups,
    ignoredDuplicateGroups,
    duplicateIds,
    answerIssues,
    missingCount: missing.length,
    duplicateQuestionCount: duplicateIds.size,
    duplicateGroupCount: duplicateGroups.length,
    ignoredDuplicateGroupCount: ignoredDuplicateGroups.length,
    ignoredDuplicateQuestionCount: ignoredDuplicateGroups.reduce(
      (sum, group) => sum + group.length,
      0,
    ),
    answerIssueCount: answerIssues.length,
  };
}

export function questionFingerprint(question) {
  return [
    question.type,
    cleanString(question.stem).replace(/\s+/g, ' ').toLowerCase(),
    question.options.map((option) => cleanString(option.text).replace(/\s+/g, ' ').toLowerCase()).join('|'),
    cleanString(question.answer).toLowerCase(),
  ].join('::');
}

export function makeEmptyDraft() {
  return {
    id: '',
    type: 'single',
    stem: '',
    options: [
      { key: 'A', text: '' },
      { key: 'B', text: '' },
      { key: 'C', text: '' },
      { key: 'D', text: '' },
    ],
    answer: '',
    explanation: '',
    favorite: false,
    stats: defaultStats(),
  };
}

function normalizeSubjectRecords(rawSubjects) {
  if (!Array.isArray(rawSubjects)) return [];
  const seen = new Set();
  const subjects = [];
  for (const raw of rawSubjects) {
    if (!raw || typeof raw !== 'object') continue;
    const name = entityName(raw.name);
    if (!name) continue;
    let id = typeof raw.id === 'string' && raw.id ? raw.id : uid('subject');
    if (seen.has(id)) id = uid('subject');
    seen.add(id);
    const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
    subjects.push({
      id,
      name,
      createdAt,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt,
    });
  }
  return subjects;
}

function normalizeBankRecords(rawBanks, subjects) {
  if (!Array.isArray(rawBanks)) return [];
  const subjectIds = new Set(subjects.map((subject) => subject.id));
  const seen = new Set();
  const banks = [];
  for (const raw of rawBanks) {
    if (!raw || typeof raw !== 'object') continue;
    const name = entityName(raw.name);
    const subjectId = typeof raw.subjectId === 'string' ? raw.subjectId : '';
    if (!name || !subjectIds.has(subjectId)) continue;
    let id = typeof raw.id === 'string' && raw.id ? raw.id : uid('bank');
    if (seen.has(id)) id = uid('bank');
    seen.add(id);
    const rawOrder = Number(raw.order);
    const order =
      raw.order !== null && raw.order !== undefined && raw.order !== '' &&
      Number.isInteger(rawOrder) && rawOrder >= 0
        ? rawOrder
        : null;
    const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
    banks.push({
      id,
      subjectId,
      name,
      order,
      createdAt,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt,
    });
  }
  return banks;
}

function fallbackSubjectFor(state) {
  let subject =
    state.subjects.find((item) => item.id === UNCLASSIFIED_SUBJECT_ID) ||
    state.subjects.find((item) => item.name === '未分类科目');
  if (!subject) {
    const now = new Date().toISOString();
    subject = {
      id: UNCLASSIFIED_SUBJECT_ID,
      name: '未分类科目',
      createdAt: now,
      updatedAt: now,
    };
    state.subjects.push(subject);
  }
  return subject;
}

function fallbackBankFor(state, subject) {
  const preferredId =
    subject.id === UNCLASSIFIED_SUBJECT_ID
      ? UNCLASSIFIED_BANK_ID
      : `bank_unclassified_${subject.id}`;
  let bank =
    state.banks.find((item) => item.id === preferredId && item.subjectId === subject.id) ||
    state.banks.find((item) => item.subjectId === subject.id && item.name === '未分类题库');
  if (!bank) {
    const now = new Date().toISOString();
    bank = {
      id: preferredId,
      subjectId: subject.id,
      name: '未分类题库',
      createdAt: now,
      updatedAt: now,
    };
    state.banks.push(bank);
  }
  return bank;
}

/**
 * 旧版数据没有科目/子题库。迁移时放入“未分类”，不丢题。
 * 同时修复失效的归属关系，保证每道题都落在可展示的子题库中。
 */
export function repairQuestionPlacements(state) {
  let changed = false;
  const validSubjects = new Map(state.subjects.map((subject) => [subject.id, subject]));
  state.banks = state.banks.filter((bank) => validSubjects.has(bank.subjectId));

  for (const question of state.questions) {
    const bank = state.banks.find((item) => item.id === question.bankId);
    if (bank) {
      if (question.subjectId !== bank.subjectId) {
        question.subjectId = bank.subjectId;
        changed = true;
      }
      continue;
    }

    const subject = validSubjects.get(question.subjectId);
    if (subject) {
      const fallback = fallbackBankFor(state, subject);
      question.bankId = fallback.id;
      question.subjectId = subject.id;
      changed = true;
      continue;
    }

    const fallbackSubject = fallbackSubjectFor(state);
    validSubjects.set(fallbackSubject.id, fallbackSubject);
    const fallback = fallbackBankFor(state, fallbackSubject);
    question.subjectId = fallbackSubject.id;
    question.bankId = fallback.id;
    changed = true;
  }

  return changed;
}

const MAX_HISTORY_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPT_DURATION_MS = 6 * 60 * 60 * 1000;
const RECENT_SESSION_LIMIT = 500;
// 只有完整做完的「全部题目」或「未掌握」练习进入正确率记录。
const ACCURACY_SCOPES = ['all', 'unmastered'];

/**
 * 一条记录代表一次完整做完的练习，而不是一道题。
 * 正确率只按这种整组记录计算，避免把收藏、错题复习和半途退出混在一起。
 */
function normalizeCompletedSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!ACCURACY_SCOPES.includes(raw.scope)) return null;
  const at = typeof raw.at === 'string' ? raw.at : '';
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const answered = Math.max(0, Number.parseInt(raw.answered, 10) || 0);
  const total = Math.max(0, Number.parseInt(raw.total, 10) || answered);
  // 未答完的练习不是完整测试，不能进入正确率记录。
  if (!answered || total !== answered) return null;
  const correct = Math.min(answered, Math.max(0, Number.parseInt(raw.correct, 10) || 0));
  return {
    at,
    scope: raw.scope,
    subjectId: cleanString(raw.subjectId).slice(0, 200),
    bankId: cleanString(raw.bankId).slice(0, 200),
    label: cleanString(raw.label).slice(0, 300),
    total,
    answered,
    correct,
    accuracy: Math.round((correct / answered) * 100),
  };
}

function completedSessionKey(session) {
  return [
    session.at,
    session.scope,
    session.subjectId,
    session.bankId,
    session.total,
    session.correct,
  ].join('|');
}

function normalizeRecentSessions(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const sessions = [];
  for (const item of raw) {
    const session = normalizeCompletedSession(item);
    if (!session) continue;
    const key = completedSessionKey(session);
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(session);
  }
  sessions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return sessions.slice(-RECENT_SESSION_LIMIT);
}

/**
 * 记录一次完整练习。调用方必须保证本次练习已全部作答，
 * 且不属于错题复习、收藏练习、指定题目或无限模式。
 */
export function recordCompletedSession(state, entry) {
  const session = normalizeCompletedSession(entry);
  if (!session) return null;
  state.recentSessions = normalizeRecentSessions([...(state.recentSessions || []), session]);
  return session;
}

function sessionsForScope(state, { subjectId = '', bankId = '', days = 0 } = {}) {
  let sessions = normalizeRecentSessions(state?.recentSessions);
  if (bankId) {
    sessions = sessions.filter((session) => session.bankId === bankId);
  } else if (subjectId) {
    // 科目总题库只汇总该科目总题库的完整练习，不能混入子题库成绩。
    sessions = sessions.filter(
      (session) => session.subjectId === subjectId && !session.bankId,
    );
  }
  if (days > 0) {
    const dateKeys = new Set(recentDateKeys(days));
    sessions = sessions.filter((session) => dateKeys.has(localDateKey(new Date(session.at))));
  }
  return sessions;
}

/**
 * 子题库只汇总该子题库；科目只汇总该科目总题库（bankId 为空）的完整练习。
 * 不传范围时才汇总全部科目的全部完整练习。
 */
export function getCompletedAccuracySummary(
  state,
  { subjectId = '', bankId = '', days = 0 } = {},
) {
  const sessions = sessionsForScope(state, { subjectId, bankId, days });
  const answered = sessions.reduce((sum, session) => sum + session.answered, 0);
  const correct = sessions.reduce((sum, session) => sum + session.correct, 0);
  return {
    sessions: sessions.length,
    answered,
    correct,
    accuracy: answered ? Math.round((correct / answered) * 100) : null,
    latestAt: sessions[sessions.length - 1]?.at || null,
  };
}

export function getLatestCompletedSession(
  state,
  { subjectId = '', bankId = '', days = 0 } = {},
) {
  const sessions = sessionsForScope(state, { subjectId, bankId, days });
  return sessions[sessions.length - 1] || null;
}

/**
 * 每次完整练习一个点，点值就是这组练习本身的正确率，不做跨次累计。
 */
export function getSessionAccuracySeries(
  state,
  { subjectId = '', bankId = '', limit = 30 } = {},
) {
  const sessions = sessionsForScope(state, { subjectId, bankId });
  const count = Math.min(RECENT_SESSION_LIMIT, Math.max(1, Number.parseInt(limit, 10) || 30));
  const selected = sessions.slice(-count);
  const offset = sessions.length - selected.length;
  return selected.map((session, index) => ({
    index,
    sessionNumber: offset + index + 1,
    ...session,
  }));
}

function remapRecentSessions(raw, maps) {
  return normalizeRecentSessions(raw).map((session) => {
    const subjectId = session.subjectId
      ? maps?.subjectIdMap?.get(session.subjectId) || session.subjectId
      : '';
    const bankId = session.bankId ? maps?.bankIdMap?.get(session.bankId) || session.bankId : '';
    return { ...session, subjectId, bankId };
  });
}

function mergeRecentSessions(target, source) {
  return normalizeRecentSessions([...(target || []), ...(source || [])]);
}

function normalizeKnowledgeMapRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seen = new Set();
  const nodes = [];
  for (const rawNode of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (!rawNode || typeof rawNode !== 'object') continue;
    const id = cleanString(rawNode.id).slice(0, 100);
    if (!id || id === 'root' || id === 'unclassified' || seen.has(id)) continue;
    seen.add(id);
    const questionIds = [
      ...new Set(
        (Array.isArray(rawNode.questionIds) ? rawNode.questionIds : [])
          .map((value) => cleanString(value).slice(0, 200))
          .filter(Boolean),
      ),
    ].slice(0, 2000);
    const keywords = [
      ...new Set(
        (Array.isArray(rawNode.keywords) ? rawNode.keywords : [])
          .map((value) => cleanString(value).slice(0, 80))
          .filter(Boolean),
      ),
    ].slice(0, 20);
    const relations = (Array.isArray(rawNode.relations) ? rawNode.relations : [])
      .map((relation) => ({
        to: cleanString(relation?.to).slice(0, 100),
        label: cleanString(relation?.label || '相关').slice(0, 80),
      }))
      .filter((relation) => relation.to)
      .slice(0, 24);
    nodes.push({
      id,
      parentId: cleanString(rawNode.parentId || 'root').slice(0, 100) || 'root',
      label: cleanString(rawNode.label || '未命名知识点').slice(0, 200),
      summary: cleanString(rawNode.summary).slice(0, 2000),
      keywords,
      questionIds,
      relations,
    });
  }
  if (!nodes.length) return null;
  return {
    bankId: cleanString(raw.bankId).slice(0, 200),
    subjectId: cleanString(raw.subjectId).slice(0, 200),
    subjectName: cleanString(raw.subjectName).slice(0, 200),
    bankName: cleanString(raw.bankName).slice(0, 200),
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    importedAt: typeof raw.importedAt === 'string' ? raw.importedAt : '',
    model: cleanString(raw.model).slice(0, 120),
    fingerprint: cleanString(raw.fingerprint).slice(0, 40),
    questionCount: Math.max(0, Number.parseInt(raw.questionCount, 10) || 0),
    unmappedCount: Math.max(0, Number.parseInt(raw.unmappedCount, 10) || 0),
    sourceBankId: cleanString(raw.sourceBankId).slice(0, 200),
    summary: cleanString(raw.summary).slice(0, 4000),
    nodes: nodes.slice(0, 1000),
  };
}

function normalizeKnowledgeMaps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    const bankId = cleanString(key).slice(0, 200);
    if (!bankId) continue;
    const map = normalizeKnowledgeMapRecord(value);
    if (map) result[bankId] = { ...map, bankId };
  }
  return result;
}

export function getLocalKnowledgeMap(state, bankId) {
  if (!bankId) return null;
  const map = state?.knowledgeMaps?.[bankId];
  return map && Array.isArray(map.nodes) ? map : null;
}

export function saveLocalKnowledgeMap(state, bankId, map) {
  if (!bankId) return null;
  const record = normalizeKnowledgeMapRecord(map);
  if (!record) return null;
  state.knowledgeMaps = normalizeKnowledgeMaps({
    ...(state.knowledgeMaps || {}),
    [bankId]: { ...record, bankId },
  });
  return state.knowledgeMaps[bankId] || null;
}

export function removeLocalKnowledgeMap(state, bankId) {
  if (!state?.knowledgeMaps || !bankId || !state.knowledgeMaps[bankId]) return false;
  delete state.knowledgeMaps[bankId];
  return true;
}

function normalizeHistoryScopeBucket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const answered = Math.max(0, Number.parseInt(raw.answered, 10) || 0);
  if (!answered) return null;
  const correct = Math.min(answered, Math.max(0, Number.parseInt(raw.correct, 10) || 0));
  return { answered, correct };
}

function normalizeHistoryScopeMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  for (const [key, bucket] of Object.entries(raw)) {
    const id = String(key || '').trim().slice(0, 200);
    const normalized = normalizeHistoryScopeBucket(bucket);
    if (id && normalized) result[id] = normalized;
  }
  return result;
}

function normalizeHistoryEntry(entry) {
  const answered = Math.max(0, Number.parseInt(entry?.answered, 10) || 0);
  const correct = Math.min(answered, Math.max(0, Number.parseInt(entry?.correct, 10) || 0));
  const durationMs = Math.min(
    MAX_HISTORY_DURATION_MS,
    Math.max(0, Math.round(Number(entry?.durationMs) || 0)),
  );
  return {
    date: String(entry?.date || ''),
    answered,
    correct,
    durationMs,
    bySubject: normalizeHistoryScopeMap(entry?.bySubject),
    byBank: normalizeHistoryScopeMap(entry?.byBank),
  };
}

function createHistoryEntry(date) {
  return {
    date,
    answered: 0,
    correct: 0,
    durationMs: 0,
    bySubject: {},
    byBank: {},
  };
}

function clampStudyDuration(durationMs, limit = MAX_ATTEMPT_DURATION_MS) {
  return Math.min(limit, Math.max(0, Math.round(Number(durationMs) || 0)));
}

function addHistoryScopeResult(map, key, correct) {
  const id = String(key || '').trim();
  if (!id) return;
  const bucket = map[id] || { answered: 0, correct: 0 };
  bucket.answered += 1;
  if (correct) bucket.correct += 1;
  map[id] = bucket;
}

function mergeHistoryScopeMaps(target, source) {
  for (const [key, bucket] of Object.entries(source || {})) {
    const existing = target[key];
    if (!existing) {
      target[key] = { answered: bucket.answered, correct: bucket.correct };
    } else {
      existing.answered = Math.max(existing.answered, bucket.answered);
      existing.correct = Math.max(existing.correct, bucket.correct);
    }
  }
}

function mergeHistoryEntry(target, source) {
  target.answered = Math.max(target.answered, source.answered);
  target.correct = Math.max(target.correct, source.correct);
  target.durationMs = Math.max(target.durationMs || 0, source.durationMs || 0);
  target.bySubject = target.bySubject || {};
  target.byBank = target.byBank || {};
  mergeHistoryScopeMaps(target.bySubject, source.bySubject);
  mergeHistoryScopeMaps(target.byBank, source.byBank);
}

function remapHistoryScopeMap(map, idMap) {
  const result = {};
  for (const [key, bucket] of Object.entries(map || {})) {
    const mapped = idMap?.get(key) || key;
    const existing = result[mapped];
    if (!existing) {
      result[mapped] = { answered: bucket.answered, correct: bucket.correct };
    } else {
      existing.answered = Math.max(existing.answered, bucket.answered);
      existing.correct = Math.max(existing.correct, bucket.correct);
    }
  }
  return result;
}

function ensureTodayHistory(state) {
  const date = localDateKey();
  let entry = state.history.find((item) => item.date === date);
  if (!entry) {
    entry = createHistoryEntry(date);
    state.history.push(entry);
  } else {
    entry.answered = Math.max(0, Number.parseInt(entry.answered, 10) || 0);
    entry.correct = Math.min(entry.answered, Math.max(0, Number.parseInt(entry.correct, 10) || 0));
    entry.durationMs = Math.max(0, Number(entry.durationMs) || 0);
    entry.bySubject = normalizeHistoryScopeMap(entry.bySubject);
    entry.byBank = normalizeHistoryScopeMap(entry.byBank);
  }
  return entry;
}

export function recentDateKeys(days = 30) {
  const count = Math.min(400, Math.max(1, Number.parseInt(days, 10) || 30));
  const end = new Date();
  end.setHours(12, 0, 0, 0);
  const keys = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setDate(end.getDate() - offset);
    keys.push(localDateKey(date));
  }
  return keys;
}

export function historySummary(state, days = 30) {
  const dateKeys = new Set(recentDateKeys(days));
  let answered = 0;
  let correct = 0;
  let durationMs = 0;
  let activeDays = 0;
  for (const entry of state.history || []) {
    if (!dateKeys.has(entry.date)) continue;
    const dayAnswered = Math.max(0, Number.parseInt(entry.answered, 10) || 0);
    const dayCorrect = Math.min(dayAnswered, Math.max(0, Number.parseInt(entry.correct, 10) || 0));
    answered += dayAnswered;
    correct += dayCorrect;
    durationMs += Math.max(0, Number(entry.durationMs) || 0);
    if (dayAnswered > 0) activeDays += 1;
  }
  return {
    days: Math.min(400, Math.max(1, Number.parseInt(days, 10) || 30)),
    answered,
    correct,
    durationMs: Math.min(MAX_HISTORY_DURATION_MS * 30, durationMs),
    activeDays,
    accuracy: answered > 0 ? Math.round((correct / answered) * 100) : null,
  };
}

/** 近 N 天每天的学习时长，包含没有练习的 0 值日期。 */
export function getDailyStudyDurations(state, days = 30) {
  const dateKeys = recentDateKeys(days);
  const byDate = new Map();
  for (const entry of state.history || []) {
    if (entry && typeof entry.date === 'string') byDate.set(entry.date, entry);
  }
  return dateKeys.map((date) => {
    const entry = byDate.get(date);
    return {
      date,
      durationMs: Math.min(
        MAX_HISTORY_DURATION_MS,
        Math.max(0, Math.round(Number(entry?.durationMs) || 0)),
      ),
      answered: Math.max(0, Number.parseInt(entry?.answered, 10) || 0),
    };
  });
}

export function defaultState() {
  return {
    version: 2,
    subjects: [],
    banks: [],
    questions: [],
    history: [],
    recentSessions: [],
    knowledgeMaps: {},
    duplicateIgnores: [],
    settings: {
      theme: null,
      practiceCount: 10,
      practiceShuffle: true,
      practiceFeedbackMode: 'immediate',
      practiceInfinite: false,
      practiceShowAI: true,
      lastBankId: '',
    },
  };
}

export function loadState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultState();

    const subjects = normalizeSubjectRecords(parsed.subjects);
    const banks = normalizeBankRecords(parsed.banks, subjects);
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions
          .map((question) => sanitizeQuestion(question))
          .filter((question) => question.stem)
      : [];
    const rawCount = parsed?.settings?.practiceCount;
    const practiceCount =
      rawCount === 'all' ||
      (Number.isInteger(rawCount) && rawCount > 0 && rawCount <= 1000)
        ? rawCount
        : 10;

    const state = {
      version: 2,
      subjects,
      banks,
      questions,
      history: Array.isArray(parsed.history)
        ? parsed.history
            .filter((entry) => entry && typeof entry.date === 'string')
            .map((entry) => normalizeHistoryEntry(entry))
            .slice(-400)
        : [],
      recentSessions: normalizeRecentSessions(parsed.recentSessions),
      knowledgeMaps: normalizeKnowledgeMaps(parsed.knowledgeMaps),
      duplicateIgnores: normalizeDuplicateIgnores(parsed.duplicateIgnores),
      settings: {
        theme: ['light', 'dark'].includes(parsed?.settings?.theme) ? parsed.settings.theme : null,
        practiceCount,
        practiceShuffle: parsed?.settings?.practiceShuffle !== false,
        practiceFeedbackMode:
          parsed?.settings?.practiceFeedbackMode === 'afterAll' ? 'afterAll' : 'immediate',
        practiceInfinite: parsed?.settings?.practiceInfinite === true,
        practiceShowAI: parsed?.settings?.practiceShowAI !== false,
        lastBankId:
          typeof parsed?.settings?.lastBankId === 'string' ? parsed.settings.lastBankId : '',
      },
    };

    const repaired = repairQuestionPlacements(state);
    if (parsed.version !== 2 || repaired) {
      try {
        saveState(state);
      } catch {
        // 浏览器禁止写入时仍允许本次使用；后续保存会再次提示。
      }
    }
    return state;
  } catch (error) {
    console.warn('读取题库失败，已使用空题库。', error);
    return defaultState();
  }
}

export function saveState(state) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function isQuestionAnswerable(question) {
  if (!question) return false;
  // 简答题的参考答案仅供对照，允许留空；作答后由用户自行评分。
  if (question.type === 'short') return true;
  if (!cleanString(question.answer)) return false;
  if (question.type === 'fill') return true;
  if (!Array.isArray(question.options) || question.options.length < 2) return false;
  const letters = answerLetters(question.answer, question.options);
  if (!letters.length) return false;
  if (question.type === 'single' || question.type === 'judge') return letters.length === 1;
  return true;
}

export function isMastered(question) {
  return Boolean(question?.stats?.streak >= 2);
}

export function questionAccuracy(question) {
  const attempts = question?.stats?.attempts || 0;
  return attempts > 0 ? Math.round(((question.stats.correct || 0) / attempts) * 100) : null;
}

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function previousDateKey(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() - 1);
  return localDateKey(date);
}

export function getStats(state) {
  const questions = state.questions;
  const total = questions.length;
  const answerable = questions.filter(isQuestionAnswerable).length;
  const mastered = questions.filter((question) => isQuestionAnswerable(question) && isMastered(question)).length;
  const wrong = questions.filter(
    (question) => isQuestionAnswerable(question) && question.stats.lastResult === 'wrong',
  ).length;
  const practiced = questions.filter((question) => question.stats.attempts > 0).length;

  const attempts = questions.reduce((sum, question) => sum + question.stats.attempts, 0);
  const correct = questions.reduce((sum, question) => sum + question.stats.correct, 0);
  const accuracy = attempts > 0 ? Math.round((correct / attempts) * 100) : null;

  const todayKey = localDateKey();
  const todayEntry = state.history.find((entry) => entry.date === todayKey);
  const todayAnswered = Math.max(0, Number.parseInt(todayEntry?.answered, 10) || 0);
  const today = {
    date: todayKey,
    answered: todayAnswered,
    correct: Math.min(
      todayAnswered,
      Math.max(0, Number.parseInt(todayEntry?.correct, 10) || 0),
    ),
    durationMs: Math.min(
      MAX_HISTORY_DURATION_MS,
      Math.max(0, Math.round(Number(todayEntry?.durationMs) || 0)),
    ),
  };

  const activeDays = new Set(state.history.filter((entry) => entry.answered > 0).map((entry) => entry.date));
  let streakDays = 0;
  let cursor = activeDays.has(todayKey) ? todayKey : previousDateKey(todayKey);
  while (activeDays.has(cursor)) {
    streakDays += 1;
    cursor = previousDateKey(cursor);
  }

  const wrongIds = new Set(
    questions.filter((question) => question.stats.lastResult === 'wrong').map((question) => question.id),
  );

  return {
    total,
    answerable,
    missingAnswers: total - answerable,
    mastered,
    wrong,
    practiced,
    attempts,
    correct,
    accuracy,
    today,
    streakDays,
    favorites: questions.filter((question) => question.favorite).length,
    wrongIds,
  };
}

export function recordAttempt(state, question, correct, { durationMs = 0 } = {}) {
  const target = state.questions.find((item) => item.id === question.id);
  if (!target) return;

  target.stats.attempts += 1;
  if (correct) {
    target.stats.correct += 1;
    target.stats.streak += 1;
    target.stats.lastResult = 'correct';
  } else {
    target.stats.wrong += 1;
    target.stats.streak = 0;
    target.stats.lastResult = 'wrong';
  }
  target.stats.lastAt = new Date().toISOString();
  target.updatedAt = target.stats.lastAt;

  const entry = ensureTodayHistory(state);
  entry.answered += 1;
  if (correct) entry.correct += 1;
  entry.durationMs = Math.min(
    MAX_HISTORY_DURATION_MS,
    (entry.durationMs || 0) + clampStudyDuration(durationMs),
  );

  const bank = state.banks.find((item) => item.id === question.bankId);
  const subjectId = question.subjectId || bank?.subjectId || '';
  addHistoryScopeResult(entry.bySubject, subjectId, correct);
  addHistoryScopeResult(entry.byBank, question.bankId, correct);

  state.history.sort((a, b) => a.date.localeCompare(b.date));
  if (state.history.length > 400) state.history = state.history.slice(-400);
}

export function recordStudyDuration(state, durationMs) {
  const duration = clampStudyDuration(durationMs);
  if (!duration) return;
  const entry = ensureTodayHistory(state);
  entry.durationMs = Math.min(MAX_HISTORY_DURATION_MS, (entry.durationMs || 0) + duration);
  state.history.sort((a, b) => a.date.localeCompare(b.date));
  if (state.history.length > 400) state.history = state.history.slice(-400);
}

export function normalizeFillText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，,。.；;：:！!？?“”"'‘’（）()【】[\]]/g, '');
}

export function gradeQuestion(question, response) {
  const given = cleanString(response);
  if (question.type === 'short') {
    return {
      correct: null,
      given,
      expected: question.answer,
      pendingSelfGrade: true,
    };
  }
  if (question.type === 'fill') {
    const expectedVariants = cleanString(question.answer)
      .split(/[|｜]/)
      .map(normalizeFillText)
      .filter(Boolean);
    const normalizedGiven = normalizeFillText(given);
    return {
      correct: Boolean(normalizedGiven) && expectedVariants.includes(normalizedGiven),
      given,
      expected: question.answer,
    };
  }

  const givenLetters = answerLetters(given, question.options);
  const expectedLetters = answerLetters(question.answer, question.options);
  const normalizedGiven = question.type === 'multiple' ? givenLetters.join('') : givenLetters[0] || '';
  const normalizedExpected =
    question.type === 'multiple'
      ? expectedLetters.join('')
      : expectedLetters.length === 1
        ? expectedLetters[0]
        : '';

  return {
    correct: Boolean(normalizedGiven) && normalizedGiven === normalizedExpected,
    given: normalizedGiven || given,
    expected: normalizedExpected || question.answer,
  };
}

export function answerDisplay(question) {
  if (!question.answer) return '未设置';
  return question.answer;
}

/**
 * 生成一份仅用于本次练习的选项乱序副本。
 * 原题对象、题库归属和存储内容都不会被修改。
 */
export function shuffleQuestionOptions(question, random = Math.random) {
  if (
    !question ||
    !isChoiceType(question.type) ||
    !Array.isArray(question.options) ||
    question.options.length < 2
  ) {
    return question;
  }

  const originalOptions = question.options.map((option) => ({
    key: String(option?.key || '').toUpperCase(),
    text: String(option?.text || ''),
  }));
  const validKeys = new Set(originalOptions.map((option) => option.key));
  const answerKeys = [
    ...new Set((String(question.answer || '').toUpperCase().match(/[A-H]/g) || [])),
  ].filter((key) => validKeys.has(key));
  if (!answerKeys.length) return question;

  const ordered = [...originalOptions];
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [ordered[index], ordered[swapIndex]] = [ordered[swapIndex], ordered[index]];
  }
  if (ordered.every((option, index) => option.key === originalOptions[index].key)) {
    ordered.push(ordered.shift());
  }

  const keyMap = new Map();
  const options = ordered.map((option, index) => {
    const newKey = LETTERS[index];
    keyMap.set(option.key, newKey);
    return { key: newKey, text: option.text };
  });
  const answer = [...new Set(answerKeys.map((key) => keyMap.get(key)).filter(Boolean))]
    .sort()
    .join('');

  return {
    ...question,
    options,
    answer,
  };
}

export function answerOptionTexts(question) {
  if (!isChoiceType(question.type)) return [];
  const keys = answerLetters(question.answer, question.options);
  return keys
    .map((key) => question.options.find((option) => option.key === key))
    .filter(Boolean)
    .map((option) => `${option.key}. ${option.text}`);
}

const SCOPES = new Set(['all', 'wrong', 'unmastered', 'favorites']);

export function selectPracticeQuestions(
  state,
  { scope = 'all', count = 10, shuffle = true, subjectId = '', bankId = '' } = {},
) {
  const safeScope = SCOPES.has(scope) ? scope : 'all';
  let pool = filterQuestionsByBank(state.questions, { subjectId, bankId }).filter(
    isQuestionAnswerable,
  );

  if (safeScope === 'wrong') {
    pool = pool.filter((question) => question.stats.lastResult === 'wrong');
  } else if (safeScope === 'unmastered') {
    pool = pool.filter((question) => !isMastered(question));
  } else if (safeScope === 'favorites') {
    pool = pool.filter((question) => question.favorite);
  }

  if (shuffle) {
    const copy = [...pool];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    pool = copy;
  }

  const limit = count === 'all' ? pool.length : Math.max(1, Number.parseInt(count, 10) || 10);
  return pool.slice(0, limit);
}

export function scopeCount(state, scope, { subjectId = '', bankId = '' } = {}) {
  const answerable = filterQuestionsByBank(state.questions, { subjectId, bankId }).filter(
    isQuestionAnswerable,
  );
  if (scope === 'wrong') return answerable.filter((question) => question.stats.lastResult === 'wrong').length;
  if (scope === 'unmastered') return answerable.filter((question) => !isMastered(question)).length;
  if (scope === 'favorites') return answerable.filter((question) => question.favorite).length;
  return answerable.length;
}

export function exportBackup(state) {
  return {
    app: '刷题助手',
    version: 2,
    exportedAt: new Date().toISOString(),
    subjects: state.subjects,
    banks: state.banks,
    questions: state.questions,
    history: state.history,
    recentSessions: state.recentSessions || [],
    knowledgeMaps: state.knowledgeMaps || {},
    duplicateIgnores: state.duplicateIgnores || [],
  };
}

/**
 * 把选中的子题库合并导出成一个题库文件。
 * 题目自带的练习统计会随文件保留；每日历史和折线数据不包含在题库文件中。
 */
export function exportLibraryPackage(state, { bankIds = [] } = {}) {
  const selectedBankIds = new Set(
    (Array.isArray(bankIds) ? bankIds : []).filter(Boolean),
  );
  const banks = state.banks.filter((bank) => selectedBankIds.has(bank.id));
  const includedBankIds = new Set(banks.map((bank) => bank.id));
  const includedSubjectIds = new Set(banks.map((bank) => bank.subjectId));
  const subjects = state.subjects.filter((subject) => includedSubjectIds.has(subject.id));
  const questions = state.questions.filter((question) => includedBankIds.has(question.bankId));
  return {
    app: '刷题助手',
    kind: 'question-bank',
    version: 2,
    exportedAt: new Date().toISOString(),
    subjects,
    banks,
    questions,
    history: [],
    recentSessions: [],
    knowledgeMaps: {},
    duplicateIgnores: [],
  };
}

function mergeImportedTaxonomy(state, payload) {
  const subjectIdMap = new Map();
  const bankIdMap = new Map();
  let subjectsAdded = 0;
  let banksAdded = 0;

  const incomingSubjects = normalizeSubjectRecords(payload?.subjects);
  for (const incoming of incomingSubjects) {
    const nameKey = incoming.name.toLowerCase();
    const folderKey = canonicalFolderKey(incoming.name);
    let local =
      state.subjects.find((subject) => subject.id === incoming.id) ||
      state.subjects.find((subject) => subject.name.toLowerCase() === nameKey) ||
      state.subjects.find((subject) => canonicalFolderKey(subject.name) === folderKey);
    if (!local) {
      const id = state.subjects.some((subject) => subject.id === incoming.id)
        ? uid('subject')
        : incoming.id;
      local = { ...incoming, id };
      state.subjects.push(local);
      subjectsAdded += 1;
    }
    subjectIdMap.set(incoming.id, local.id);
  }

  const incomingBanks = normalizeBankRecords(payload?.banks, incomingSubjects);
  for (const incoming of incomingBanks) {
    const localSubjectId = subjectIdMap.get(incoming.subjectId);
    if (!localSubjectId) continue;
    const nameKey = incoming.name.toLowerCase();
    const fileKey = canonicalBankKey(incoming.name);
    let local =
      state.banks.find(
        (bank) => bank.id === incoming.id && bank.subjectId === localSubjectId,
      ) ||
      state.banks.find(
        (bank) => bank.subjectId === localSubjectId && bank.name.toLowerCase() === nameKey,
      ) ||
      state.banks.find(
        (bank) =>
          bank.subjectId === localSubjectId && canonicalBankKey(bank.name) === fileKey,
      );
    if (!local) {
      const id = state.banks.some((bank) => bank.id === incoming.id)
        ? uid('bank')
        : incoming.id;
      local = { ...incoming, id, subjectId: localSubjectId };
      state.banks.push(local);
      banksAdded += 1;
    }
    bankIdMap.set(incoming.id, local.id);
  }

  return { subjectIdMap, bankIdMap, subjectsAdded, banksAdded };
}

function mergeImportedQuestionProgress(existing, incoming) {
  if (!existing?.stats) return;
  const current = existing.stats;
  const source = incoming?.stats || {};
  const toCount = (value) => Math.max(0, Number.parseInt(value, 10) || 0);
  current.attempts = Math.max(toCount(current.attempts), toCount(source.attempts));
  current.correct = Math.max(toCount(current.correct), toCount(source.correct));
  current.wrong = Math.max(toCount(current.wrong), toCount(source.wrong));
  current.streak = Math.max(toCount(current.streak), toCount(source.streak));
  if (current.correct + current.wrong > current.attempts) {
    current.attempts = current.correct + current.wrong;
  }
  if (incoming?.favorite) existing.favorite = true;

  const currentAt = Date.parse(current.lastAt || '') || 0;
  const sourceAt = Date.parse(source.lastAt || '') || 0;
  const sourceResult = ['correct', 'wrong'].includes(source.lastResult)
    ? source.lastResult
    : null;
  if (sourceResult && (sourceAt > currentAt || !current.lastResult)) {
    current.lastResult = sourceResult;
    current.lastAt = source.lastAt || current.lastAt;
  }
}

function placeImportedQuestion(state, question, maps) {
  const candidateBankId = maps.bankIdMap.get(question.bankId) || question.bankId;
  const bank = state.banks.find((item) => item.id === candidateBankId);
  if (bank) {
    question.subjectId = bank.subjectId;
    question.bankId = bank.id;
    return;
  }

  const candidateSubjectId = maps.subjectIdMap.get(question.subjectId) || question.subjectId;
  const subject = subjectById(state, candidateSubjectId);
  if (subject) {
    const fallback = fallbackBankFor(state, subject);
    question.subjectId = subject.id;
    question.bankId = fallback.id;
    return;
  }

  const fallbackSubject = fallbackSubjectFor(state);
  const fallback = fallbackBankFor(state, fallbackSubject);
  question.subjectId = fallbackSubject.id;
  question.bankId = fallback.id;
}

export function importBackup(state, payload) {
  const rawQuestions = Array.isArray(payload) ? payload : payload?.questions;
  if (!Array.isArray(rawQuestions)) {
    throw new Error('文件格式不正确，没有找到题目数组。');
  }

  const incoming = rawQuestions
    .map((question) => sanitizeQuestion(question, { keepId: true, preserveStats: true }))
    .filter((question) => question.stem);
  if (!incoming.length) throw new Error('文件中没有可导入的题目。');

  const maps = mergeImportedTaxonomy(state, payload);
  const byId = new Map(state.questions.map((question) => [question.id, question]));
  const byFingerprint = new Map(
    state.questions.map((question) => [questionFingerprint(question), question]),
  );
  let added = 0;
  let skipped = 0;

  for (const question of incoming) {
    const fingerprint = questionFingerprint(question);
    const existing = byId.get(question.id) || byFingerprint.get(fingerprint);
    if (existing) {
      mergeImportedQuestionProgress(existing, question);
      skipped += 1;
      continue;
    }
    placeImportedQuestion(state, question, maps);
    byId.set(question.id, question);
    byFingerprint.set(fingerprint, question);
    state.questions.push(question);
    added += 1;
  }

  const rawHistory = Array.isArray(payload?.history) ? payload.history : [];
  for (const entry of rawHistory) {
    if (!entry || typeof entry.date !== 'string') continue;
    const incomingEntry = normalizeHistoryEntry(entry);
    incomingEntry.bySubject = remapHistoryScopeMap(incomingEntry.bySubject, maps.subjectIdMap);
    incomingEntry.byBank = remapHistoryScopeMap(incomingEntry.byBank, maps.bankIdMap);
    const existing = state.history.find((item) => item.date === incomingEntry.date);
    if (!existing) {
      state.history.push(incomingEntry);
    } else {
      const merged = normalizeHistoryEntry(existing);
      mergeHistoryEntry(merged, incomingEntry);
      Object.assign(existing, merged);
    }
  }
  state.history.sort((a, b) => a.date.localeCompare(b.date));
  if (state.history.length > 400) state.history = state.history.slice(-400);
  const incomingSessions = remapRecentSessions(payload?.recentSessions, maps);
  state.recentSessions = mergeRecentSessions(state.recentSessions, incomingSessions);
  const incomingKnowledgeMaps = normalizeKnowledgeMaps(payload?.knowledgeMaps);
  if (!state.knowledgeMaps || typeof state.knowledgeMaps !== 'object') {
    state.knowledgeMaps = {};
  }
  for (const [sourceBankId, map] of Object.entries(incomingKnowledgeMaps)) {
    const localBankId = maps.bankIdMap.get(sourceBankId) || sourceBankId;
    const bank = state.banks.find((item) => item.id === localBankId);
    if (!bank) continue;
    const normalized = normalizeKnowledgeMapRecord(map);
    if (!normalized) continue;
    state.knowledgeMaps[localBankId] = {
      ...normalized,
      bankId: localBankId,
      subjectId: bank.subjectId,
      bankName: bank.name,
    };
  }
  state.knowledgeMaps = normalizeKnowledgeMaps(state.knowledgeMaps);
  state.duplicateIgnores = normalizeDuplicateIgnores([
    ...(state.duplicateIgnores || []),
    ...normalizeDuplicateIgnores(payload?.duplicateIgnores),
  ]);

  return {
    added,
    skipped,
    incoming: incoming.length,
    subjectsAdded: maps.subjectsAdded,
    banksAdded: maps.banksAdded,
  };
}
