import { createDashboardView } from './views/dashboard.js';
import { createImportView } from './views/import.js';
import { createLibraryView } from './views/library.js';
import { createPracticeView } from './views/practice.js';
import { QuestionForm } from './question-form.js';
import {
  applyBankOrder,
  bankById,
  banksForSubject,
  canonicalBankKey,
  canonicalFolderKey,
  createBankRecord,
  createQuestion,
  createSubjectRecord,
  exportBackup,
  getStats,
  importBackup,
  loadState,
  localDateKey,
  makeEmptyDraft,
  normalizeBankOrder,
  sanitizeQuestion,
  saveState,
  subjectById,
} from './store.js';
import { openAIAssistant as openAIAssistantDialog } from './ai-assistant.js';
import {
  confirmAction,
  downloadJSON,
  escapeHTML,
  icon,
  openDialog,
  relativeDate,
  toast,
} from './ui.js';
import {
  getAIConfig,
  loadLibraryFromDisk,
  saveAIConfig,
  syncLibraryToDisk,
  testAIConnection,
} from './api.js';

const state = loadState();
const LIBRARY_DIRTY_KEY = 'shuati-helper:library-dirty:v1';
const main = document.getElementById('main-content');
const titleByView = {
  dashboard: '刷题助手 · 图片转题库',
  import: '导入题目 · 刷题助手',
  library: '我的题库 · 刷题助手',
  practice: '专注练习 · 刷题助手',
};

let currentViewName = null;
let views = null;

function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolvedTheme() {
  return state.settings.theme || systemTheme();
}

function updateThemeControls(theme) {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const nextLabel = nextTheme === 'dark' ? '深色模式' : '浅色模式';
  document.querySelectorAll('[data-theme-icon]').forEach((node) => {
    node.innerHTML = icon(nextTheme === 'dark' ? 'moon' : 'sun', 18);
  });
  document.querySelectorAll('[data-theme-label]').forEach((node) => {
    node.textContent = nextLabel;
  });
  document.querySelectorAll('[data-global-action="theme"]').forEach((button) => {
    button.setAttribute('aria-label', `切换到${nextLabel}`);
    button.title = `切换到${nextLabel}`;
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0d1117' : '#f6f8fa');
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  updateThemeControls(theme);
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  state.settings.theme = next;
  applyTheme(next);
  persist();
}

function persist() {
  try {
    saveState(state);
    return true;
  } catch (error) {
    console.error(error);
    toast('保存失败：浏览器本地空间可能已满，请先导出备份并清理空间。', 'error', 5200);
    return false;
  }
}

let librarySyncChain = Promise.resolve();
let libraryRevision = 0;
let libraryRootLabel = '题库';
let lastLibrarySyncAt = '';
let lastLibrarySyncErrorAt = 0;

function libraryDirty() {
  try {
    return window.localStorage.getItem(LIBRARY_DIRTY_KEY) === '1';
  } catch {
    return false;
  }
}

function markLibraryDirty() {
  try {
    window.localStorage.setItem(LIBRARY_DIRTY_KEY, '1');
  } catch {
    // 本地存储不可用时仍可继续同步磁盘。
  }
}

function clearLibraryDirty() {
  try {
    window.localStorage.removeItem(LIBRARY_DIRTY_KEY);
  } catch {
    // 忽略。
  }
}

function hasLocalLibrary() {
  return state.subjects.length > 0 || state.banks.length > 0 || state.questions.length > 0;
}

function librarySnapshot() {
  return {
    subjects: state.subjects.map(({ id, name, createdAt, updatedAt }) => ({
      id,
      name,
      createdAt,
      updatedAt,
    })),
    banks: state.banks.map(({ id, subjectId, name, order, createdAt, updatedAt }) => ({
      id,
      subjectId,
      name,
      order,
      createdAt,
      updatedAt,
    })),
    questions: state.questions.map(({ stats, ...question }) => ({
      ...question,
      options: Array.isArray(question.options)
        ? question.options.map(({ key, text }) => ({ key, text }))
        : [],
    })),
  };
}

function syncLibraryNow({ notify = true } = {}) {
  libraryRevision += 1;
  const revision = libraryRevision;
  markLibraryDirty();

  const task = librarySyncChain.then(async () => {
    try {
      const result = await syncLibraryToDisk(librarySnapshot());
      libraryRootLabel = result.root || libraryRootLabel;
      lastLibrarySyncAt = result.updatedAt || new Date().toISOString();
      if (revision === libraryRevision) clearLibraryDirty();
      return { ok: true, result };
    } catch (error) {
      console.error('写入 Markdown 题库失败', error);
      const now = Date.now();
      if (notify && now - lastLibrarySyncErrorAt > 4000) {
        lastLibrarySyncErrorAt = now;
        toast(
          `写入磁盘题库失败：${error.message || '未知错误'}。数据仍保留在浏览器中，可导出备份后重试。`,
          'error',
          5600,
        );
      }
      return { ok: false, error };
    }
  });
  librarySyncChain = task.then(() => undefined);
  return task;
}

function applyLibraryFromDisk(disk) {
  const statsById = new Map(state.questions.map((question) => [question.id, question.stats]));
  const subjects = Array.isArray(disk.subjects)
    ? disk.subjects.map((subject) => ({
        id: String(subject.id || ''),
        name: String(subject.name || ''),
        createdAt: String(subject.createdAt || new Date().toISOString()),
        updatedAt: String(subject.updatedAt || subject.createdAt || new Date().toISOString()),
      }))
    : [];
  const subjectIds = new Set(subjects.map((subject) => subject.id));
  const banks = Array.isArray(disk.banks)
    ? disk.banks
        .filter((bank) => subjectIds.has(String(bank.subjectId || '')))
        .map((bank) => {
          const rawOrder = Number(bank.order);
          return {
            id: String(bank.id || ''),
            subjectId: String(bank.subjectId || ''),
            name: String(bank.name || ''),
            order:
              bank.order !== null &&
              bank.order !== undefined &&
              bank.order !== '' &&
              Number.isInteger(rawOrder) &&
              rawOrder >= 0
                ? rawOrder
                : null,
            createdAt: String(bank.createdAt || new Date().toISOString()),
            updatedAt: String(bank.updatedAt || bank.createdAt || new Date().toISOString()),
          };
        })
    : [];
  const bankIds = new Set(banks.map((bank) => bank.id));
  const questions = Array.isArray(disk.questions)
    ? disk.questions
        .filter((question) => bankIds.has(String(question.bankId || '')))
        .map((question) => {
          const cached = statsById.get(question.id);
          return sanitizeQuestion(
            { ...question, stats: cached },
            { keepId: true, preserveStats: true },
          );
        })
        .filter((question) => question.stem)
    : [];

  state.subjects = subjects.filter((subject) => subject.id && subject.name);
  state.banks = banks.filter((bank) => bank.id && bank.name);
  state.questions = questions;
  if (!state.banks.some((bank) => bank.id === state.settings.lastBankId)) {
    state.settings.lastBankId = state.banks[0]?.id || '';
  }
  persist();
}

async function loadLibraryOnBoot() {
  let disk;
  try {
    disk = await loadLibraryFromDisk();
    libraryRootLabel = disk.root || libraryRootLabel;
  } catch (error) {
    console.error('读取 Markdown 题库失败', error);
    toast(
      `读取磁盘题库失败：${error.message || '未知错误'}。暂时使用浏览器缓存。`,
      'error',
      5400,
    );
    return;
  }

  if (libraryDirty() && hasLocalLibrary()) {
    const result = await syncLibraryNow({ notify: true });
    if (!result.ok) {
      toast('当前使用浏览器中的题库。磁盘同步失败，请检查题库文件夹权限。', 'error', 5200);
    }
    return;
  }

  if (disk.initialized) {
    applyLibraryFromDisk(disk);
    clearLibraryDirty();
    // 写回一次，让用户直接放进【题库保存】的 MD 文件补齐索引元数据。
    const synced = await syncLibraryNow({ notify: false });
    if (!synced.ok) {
      toast(
        '题库已从磁盘读取，但暂时无法回写【题库保存】目录。请检查文件夹权限。',
        'error',
        5200,
      );
    }
    return;
  }

  if (hasLocalLibrary()) {
    const result = await syncLibraryNow({ notify: false });
    if (!result.ok) {
      toast(
        `浏览器中已有题库，但创建磁盘题库失败：${result.error?.message || '未知错误'}`,
        'error',
        5600,
      );
    }
    return;
  }

  clearLibraryDirty();
}

function updateNavigation(name) {
  document.querySelectorAll('.nav-item[data-nav], .mobile-tab[data-nav]').forEach((button) => {
    const active = button.dataset.nav === name;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function renderView(name, { preserveScroll = false, ...viewOptions } = {}) {
  if (!views?.[name]) return;
  const previousScroll = window.scrollY;
  currentViewName = name;
  updateNavigation(name);
  document.title = titleByView[name] || '刷题助手';

  const root = document.createElement('section');
  root.className = `view-root view-${name}`;
  main.replaceChildren(root);
  views[name].render(root, viewOptions);

  if (preserveScroll) window.scrollTo({ top: previousScroll, behavior: 'auto' });
  else window.scrollTo({ top: 0, behavior: 'auto' });
}

async function navigate(name, options = {}) {
  if (!views?.[name]) return false;

  if (
    currentViewName === 'practice' &&
    name !== 'practice' &&
    views.practice.hasActiveSession() &&
    !options.skipGuard
  ) {
    const proceed = await confirmAction({
      title: '离开这组练习？',
      message: '已经提交的作答会保留在练习记录中，但本组未完成的进度不会保留。',
      confirmText: '离开练习',
    });
    if (!proceed) return false;
  }

  if (currentViewName === 'practice' && name !== 'practice') {
    views.practice.resetOnLeave();
  }

  const { preserveScroll, skipGuard, ...viewOptions } = options;
  renderView(name, { ...viewOptions, preserveScroll: preserveScroll === true });
  return true;
}

function promptEntityName({
  title,
  eyebrow = '',
  description = '',
  label = '名称',
  value = '',
  placeholder = '',
  confirmText = '保存',
  exists = () => false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let control = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      control?.close();
    };

    control = openDialog({
      title,
      eyebrow,
      description,
      size: 'sm',
      content: `
        <form class="entity-form" data-entity-form>
          <label class="entity-field">
            <span>${escapeHTML(label)}</span>
            <input class="input" type="text" maxlength="60" value="${escapeHTML(value)}"
              placeholder="${escapeHTML(placeholder)}" data-entity-name autocomplete="off">
          </label>
          <p class="entity-form-error" data-entity-error role="alert" hidden></p>
        </form>
      `,
      footer: `
        <button type="button" class="btn subtle" data-entity-cancel>取消</button>
        <button type="button" class="btn primary" data-entity-save>${escapeHTML(confirmText)}</button>
      `,
      onMount: ({ dialog }) => {
        const form = dialog.querySelector('[data-entity-form]');
        const input = dialog.querySelector('[data-entity-name]');
        const errorNode = dialog.querySelector('[data-entity-error]');

        const submit = () => {
          const name = input.value.replace(/\s+/g, ' ').trim();
          if (!name) {
            errorNode.textContent = `请填写${label}。`;
            errorNode.hidden = false;
            input.focus();
            return;
          }
          const error = exists(name);
          if (error) {
            errorNode.textContent = error;
            errorNode.hidden = false;
            input.focus();
            return;
          }
          finish(name);
        };

        form.addEventListener('submit', (event) => {
          event.preventDefault();
          submit();
        });
        dialog.querySelector('[data-entity-cancel]')?.addEventListener('click', () => finish(null));
        dialog.querySelector('[data-entity-save]')?.addEventListener('click', submit);
        dialog.addEventListener('close', () => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        });
        window.setTimeout(() => {
          input.focus();
          input.select();
        }, 60);
      },
    });
  });
}

function subjectNameError(name, excludeId = '') {
  const nameKey = String(name || '').trim().toLowerCase();
  const folderKey = canonicalFolderKey(name);
  return state.subjects.some(
    (subject) =>
      subject.id !== excludeId &&
      (subject.name.trim().toLowerCase() === nameKey ||
        canonicalFolderKey(subject.name) === folderKey),
  )
    ? '已经有同名或会生成同名文件夹的科目了，换一个名称。'
    : '';
}

function bankNameError(name, subjectId, excludeId = '') {
  const nameKey = String(name || '').trim().toLowerCase();
  const fileKey = canonicalBankKey(name);
  return state.banks.some(
    (bank) =>
      bank.subjectId === subjectId &&
      bank.id !== excludeId &&
      (bank.name.trim().toLowerCase() === nameKey ||
        canonicalBankKey(bank.name) === fileKey),
  )
    ? '这个科目下已经有同名或会生成同名文件的子题库了，换一个名称。'
    : '';
}

const app = {
  state,
  persist,
  navigate,
  refreshCurrent() {
    if (currentViewName) renderView(currentViewName, { preserveScroll: true });
  },
  async addQuestions(questions, target = {}) {
    const bank = bankById(state, target.bankId);
    const subject = bank ? subjectById(state, bank.subjectId) : subjectById(state, target.subjectId);
    for (const question of questions) {
      if (bank && subject) {
        question.subjectId = subject.id;
        question.bankId = bank.id;
      } else if (subject) {
        question.subjectId = subject.id;
        question.bankId = '';
      }
    }
    state.questions.push(...questions);
    if (bank) state.settings.lastBankId = bank.id;
    persist();
    await syncLibraryNow({ notify: true });
  },
  subjectById(id) {
    return subjectById(state, id);
  },
  bankById(id) {
    return bankById(state, id);
  },
  banksForSubject(subjectId) {
    return banksForSubject(state, subjectId);
  },
  async createSubject() {
    const name = await promptEntityName({
      title: '新建科目',
      eyebrow: 'NEW SUBJECT',
      description: '科目是题目的最外层分类，例如「高等数学」「计算机基础」。',
      label: '科目名称',
      placeholder: '例如：高等数学',
      confirmText: '创建科目',
      exists: (value) => subjectNameError(value),
    });
    if (!name) return null;
    const subject = createSubjectRecord(name);
    state.subjects.push(subject);
    persist();
    await syncLibraryNow({ notify: true });
    return subject;
  },
  async renameSubject(subjectId) {
    const subject = subjectById(state, subjectId);
    if (!subject) return false;
    const name = await promptEntityName({
      title: '重命名科目',
      eyebrow: 'RENAME SUBJECT',
      label: '科目名称',
      value: subject.name,
      confirmText: '保存名称',
      exists: (value) => subjectNameError(value, subject.id),
    });
    if (!name) return false;
    subject.name = name;
    subject.updatedAt = new Date().toISOString();
    persist();
    await syncLibraryNow({ notify: true });
    return true;
  },
  async deleteSubject(subjectId) {
    const subject = subjectById(state, subjectId);
    if (!subject) return false;
    const questions = state.questions.filter((question) => question.subjectId === subject.id);
    const banks = state.banks.filter((bank) => bank.subjectId === subject.id);
    if (questions.length) {
      toast(`「${subject.name}」里还有 ${questions.length} 道题，请先删除或移走题目。`, 'info', 4200);
      return false;
    }
    const proceed = await confirmAction({
      title: `删除科目「${subject.name}」？`,
      message: banks.length
        ? `这个科目下的 ${banks.length} 个子题库都会一并删除；题库中没有它的题目。`
        : '这个科目还没有题目，删除后无法恢复。',
      confirmText: '删除科目',
      danger: true,
    });
    if (!proceed) return false;
    state.subjects = state.subjects.filter((item) => item.id !== subject.id);
    state.banks = state.banks.filter((bank) => bank.subjectId !== subject.id);
    if (!state.banks.some((bank) => bank.id === state.settings.lastBankId)) {
      state.settings.lastBankId = state.banks[0]?.id || '';
    }
    persist();
    await syncLibraryNow({ notify: true });
    return true;
  },
  async createBank(subjectId) {
    const subject = subjectById(state, subjectId);
    if (!subject) {
      toast('先选择或创建一个科目。', 'info');
      return null;
    }
    const name = await promptEntityName({
      title: `新建子题库 · ${subject.name}`,
      eyebrow: 'NEW QUESTION BANK',
      description: '子题库用于把同一科目的题目分成不同章节或练习单元。',
      label: '子题库名称',
      placeholder: '例如：第一章 函数与极限',
      confirmText: '创建子题库',
      exists: (value) => bankNameError(value, subject.id),
    });
    if (!name) return null;
    const nextOrder = normalizeBankOrder(state, subject.id);
    const bank = createBankRecord(subject.id, name, nextOrder);
    state.banks.push(bank);
    state.settings.lastBankId = bank.id;
    persist();
    await syncLibraryNow({ notify: true });
    return bank;
  },
  async reorderBanks(subjectId, orderedIds) {
    const banks = banksForSubject(state, subjectId);
    if (banks.length !== orderedIds.length) return false;
    const previous = banks.map((bank) => bank.id);
    if (previous.every((id, index) => id === orderedIds[index])) return true;
    if (!applyBankOrder(state, subjectId, orderedIds)) return false;
    const now = new Date().toISOString();
    for (const bank of banks) bank.updatedAt = now;
    persist();
    await syncLibraryNow({ notify: true });
    return true;
  },
  async renameBank(bankId) {
    const bank = bankById(state, bankId);
    if (!bank) return false;
    const name = await promptEntityName({
      title: '重命名子题库',
      eyebrow: 'RENAME QUESTION BANK',
      label: '子题库名称',
      value: bank.name,
      confirmText: '保存名称',
      exists: (value) => bankNameError(value, bank.subjectId, bank.id),
    });
    if (!name) return false;
    bank.name = name;
    bank.updatedAt = new Date().toISOString();
    persist();
    await syncLibraryNow({ notify: true });
    return true;
  },
  async deleteBank(bankId) {
    const bank = bankById(state, bankId);
    if (!bank) return false;
    const questions = state.questions.filter((question) => question.bankId === bank.id);
    if (questions.length) {
      toast(`「${bank.name}」里还有 ${questions.length} 道题，请先删除或移走题目。`, 'info', 4200);
      return false;
    }
    const proceed = await confirmAction({
      title: `删除子题库「${bank.name}」？`,
      message: '这个子题库当前没有题目，删除后无法恢复。',
      confirmText: '删除子题库',
      danger: true,
    });
    if (!proceed) return false;
    state.banks = state.banks.filter((item) => item.id !== bank.id);
    if (state.settings.lastBankId === bank.id) {
      state.settings.lastBankId = banksForSubject(state, bank.subjectId)[0]?.id || '';
    }
    persist();
    await syncLibraryNow({ notify: true });
    return true;
  },
  getDefaultTarget(subjectId = '') {
    const subject = subjectById(state, subjectId) || state.subjects[0] || null;
    if (!subject) return { subjectId: '', bankId: '' };
    const banks = banksForSubject(state, subject.id);
    const remembered = banks.find((bank) => bank.id === state.settings.lastBankId);
    return {
      subjectId: subject.id,
      bankId: (remembered || banks[0])?.id || '',
    };
  },
  getLibraryInfo() {
    return {
      root: libraryRootLabel,
      lastSyncAt: lastLibrarySyncAt,
      dirty: libraryDirty(),
    };
  },
  syncLibrary(options = {}) {
    return syncLibraryNow(options);
  },
  async reloadLibraryFromDisk() {
    if (currentViewName === 'practice' && views?.practice?.hasActiveSession()) {
      toast('先结束当前练习，再从磁盘重新读取题库。', 'info');
      return false;
    }
    if (libraryDirty()) {
      const proceed = await confirmAction({
        title: '从磁盘重新读取？',
        message: '浏览器里还有尚未成功写入磁盘的改动。重新读取会以 Markdown 文件为准，这些改动会被覆盖。',
        confirmText: '重新读取',
      });
      if (!proceed) return false;
    }
    await librarySyncChain;
    try {
      const disk = await loadLibraryFromDisk();
      libraryRootLabel = disk.root || libraryRootLabel;
      if (!disk.initialized) {
        toast('磁盘题库还是空的，未覆盖当前浏览器数据。', 'info', 4200);
        return false;
      }
      applyLibraryFromDisk(disk);
      clearLibraryDirty();
      return true;
    } catch (error) {
      toast(`读取磁盘题库失败：${error.message || '未知错误'}`, 'error', 4600);
      return false;
    }
  },
  async clearLibraryFiles() {
    await librarySyncChain;
    libraryRevision += 1;
    try {
      const result = await syncLibraryToDisk({ subjects: [], banks: [], questions: [] });
      libraryRootLabel = result.root || libraryRootLabel;
      lastLibrarySyncAt = result.updatedAt || new Date().toISOString();
      clearLibraryDirty();
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error };
    }
  },
  toggleFavorite(id) {
    const question = state.questions.find((item) => item.id === id);
    if (!question) return false;
    question.favorite = !question.favorite;
    question.updatedAt = new Date().toISOString();
    persist();
    void syncLibraryNow({ notify: true });
    return question.favorite;
  },
  deleteQuestion(id) {
    state.questions = state.questions.filter((question) => question.id !== id);
    persist();
    void syncLibraryNow({ notify: true });
  },
  deleteQuestions(ids) {
    const selected = new Set(Array.isArray(ids) ? ids : []);
    if (!selected.size) return 0;
    const before = state.questions.length;
    state.questions = state.questions.filter((question) => !selected.has(question.id));
    const removed = before - state.questions.length;
    if (removed) {
      persist();
      void syncLibraryNow({ notify: true });
    }
    return removed;
  },
  async bulkUpdateQuestions(ids, { subjectId = '', bankId = '', favoriteMode = 'keep' } = {}) {
    const selected = new Set(Array.isArray(ids) ? ids : []);
    const bank = bankById(state, bankId);
    const subject = bank ? subjectById(state, bank.subjectId) : null;
    if (!selected.size || !bank || !subject || bank.subjectId !== subjectId) return 0;
    let changed = 0;
    const now = new Date().toISOString();
    for (const question of state.questions) {
      if (!selected.has(question.id)) continue;
      let touched = false;
      if (question.subjectId !== subject.id || question.bankId !== bank.id) {
        question.subjectId = subject.id;
        question.bankId = bank.id;
        touched = true;
      }
      if (favoriteMode === 'favorite' && !question.favorite) {
        question.favorite = true;
        touched = true;
      } else if (favoriteMode === 'unfavorite' && question.favorite) {
        question.favorite = false;
        touched = true;
      }
      if (touched) {
        question.updatedAt = now;
        changed += 1;
      }
    }
    if (changed) {
      state.settings.lastBankId = bank.id;
      persist();
      await syncLibraryNow({ notify: true });
    }
    return changed;
  },
  ignoreDuplicateGroup(key) {
    const normalized = String(key || '').trim();
    if (!normalized) return false;
    const ignores = new Set(Array.isArray(state.duplicateIgnores) ? state.duplicateIgnores : []);
    ignores.add(normalized);
    state.duplicateIgnores = [...ignores].slice(-1000);
    persist();
    return true;
  },
  restoreDuplicateIgnores(key = '') {
    const normalized = String(key || '').trim();
    state.duplicateIgnores = normalized
      ? (state.duplicateIgnores || []).filter((item) => item !== normalized)
      : [];
    persist();
  },
  async startPractice(options = {}) {
    if (currentViewName !== 'practice') {
      const entered = await navigate('practice');
      if (!entered) return;
    }
    views.practice.start(options);
  },
  openManualQuestion(options = {}) {
    return openQuestionEditor(null, options);
  },
  openQuestionEditor(question, options = {}) {
    return openQuestionEditor(question, options);
  },
  openAISettings(options = {}) {
    return openAISettings(options);
  },
  openAIAssistant(config = {}) {
    return openAIAssistantDialog(app, {
      ...config,
      onAction: handleAssistantAction,
    });
  },
  openContextAIAssistant() {
    return openContextAIAssistant();
  },
  openDataDialog,
};

views = {
  dashboard: createDashboardView(app),
  import: createImportView(app),
  library: createLibraryView(app),
  practice: createPracticeView(app),
};

const VIEW_LABELS = {
  dashboard: '概览',
  import: '导入题目',
  library: '我的题库',
  practice: '练习',
};

function buildDefaultAssistantConfig() {
  const stats = getStats(state);
  const actions = [];
  if (stats.answerable > 0) actions.push('assistant_start_random');
  if (stats.wrong > 0) actions.push('assistant_start_wrong');
  actions.push(
    'assistant_go_import',
    'assistant_go_library',
    'assistant_go_practice',
    'assistant_open_settings',
  );
  return {
    mode: 'assistant',
    contextLabel: VIEW_LABELS[currentViewName] || '当前页面',
    context: {
      page: currentViewName,
      pageLabel: VIEW_LABELS[currentViewName] || '',
      stats: {
        total: stats.total,
        answerable: stats.answerable,
        missingAnswers: stats.missingAnswers,
        wrong: stats.wrong,
        mastered: stats.mastered,
        accuracy: stats.accuracy,
      },
      recentTitles: state.questions
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 5)
        .map((question) => question.stem.slice(0, 120)),
    },
    availableActions: actions,
  };
}

async function openContextAIAssistant() {
  let config = null;
  const activeView = currentViewName ? views?.[currentViewName] : null;
  if (activeView && typeof activeView.getAssistantConfig === 'function') {
    try {
      config = activeView.getAssistantConfig();
    } catch (error) {
      console.error('构建 AI 助手上下文失败', error);
    }
  }
  if (!config) config = buildDefaultAssistantConfig();
  return app.openAIAssistant(config);
}

async function handleAssistantAction(action) {
  const libraryFilters = {
    library_filter_missing: 'missing',
    library_filter_duplicates: 'duplicates',
    library_filter_answer_issues: 'answerIssues',
    library_filter_unmastered: 'unmastered',
  };
  if (libraryFilters[action]) {
    await navigate('library', { filter: libraryFilters[action] });
    return;
  }

  if (action === 'assistant_go_import') {
    await navigate('import');
    return;
  }
  if (action === 'assistant_go_library') {
    await navigate('library');
    return;
  }
  if (action === 'assistant_go_practice') {
    await navigate('practice');
    return;
  }
  if (action === 'assistant_go_dashboard') {
    await navigate('dashboard');
    return;
  }
  if (action === 'assistant_start_random') {
    await app.startPractice({ scope: 'all', count: 10, shuffle: true, subjectId: '', bankId: '' });
    return;
  }
  if (action === 'assistant_start_wrong') {
    await app.startPractice({ scope: 'wrong', count: 10, shuffle: true, subjectId: '', bankId: '' });
    return;
  }
  if (action === 'assistant_open_settings') {
    openAISettings();
    return;
  }
  if (action.startsWith('import_') && typeof views.import?.handleAssistantAction === 'function') {
    await views.import.handleAssistantAction(action);
    return;
  }
  toast('这个 AI 选项当前没有可执行的操作。', 'info');
}

function placementBankOptionsHTML(subjectId, selectedBankId = '') {
  const banks = banksForSubject(state, subjectId);
  if (!banks.length) return '<option value="">该科目暂无子题库</option>';
  return banks
    .map(
      (bank) =>
        `<option value="${escapeHTML(bank.id)}" ${bank.id === selectedBankId ? 'selected' : ''}>${escapeHTML(bank.name)}</option>`,
    )
    .join('');
}

function editorPlacementHTML(subjectId, bankId) {
  return `
    <div class="editor-placement">
      <div class="editor-placement-head">
        ${icon('layers', 16)}
        <div><strong>保存位置</strong><span>题目会归入所选科目的子题库。</span></div>
      </div>
      <label class="editor-target">
        <span>科目</span>
        <select data-editor-subject>
          ${state.subjects
            .map(
              (subject) =>
                `<option value="${escapeHTML(subject.id)}" ${subject.id === subjectId ? 'selected' : ''}>${escapeHTML(subject.name)}</option>`,
            )
            .join('')}
        </select>
      </label>
      <label class="editor-target">
        <span>子题库</span>
        <select data-editor-bank>${placementBankOptionsHTML(subjectId, bankId)}</select>
      </label>
    </div>
  `;
}

async function openQuestionEditor(question = null, options = {}) {
  const isNew = !question;
  if (!state.subjects.length) {
    toast('先创建科目和子题库，再录入题目。', 'info', 4200);
    await navigate('library');
    return null;
  }

  let targetSubject =
    (question && subjectById(state, question.subjectId)) ||
    subjectById(state, options.subjectId) ||
    subjectById(state, state.settings.lastBankId ? bankById(state, state.settings.lastBankId)?.subjectId : '') ||
    state.subjects[0];
  let targetBank = banksForSubject(state, targetSubject.id).find((bank) =>
    question ? bank.id === question.bankId : bank.id === options.bankId,
  );

  if (!targetBank) {
    targetBank = banksForSubject(state, targetSubject.id)[0];
  }
  if (!targetBank) {
    const created = await app.createBank(targetSubject.id);
    if (!created) {
      toast('题目需要保存到子题库，请先创建子题库。', 'info', 4200);
      return null;
    }
    targetBank = created;
  }

  const form = new QuestionForm(isNew ? makeEmptyDraft() : question, { compact: false });

  let control;
  control = openDialog({
    title: isNew ? '手动录入题目' : '编辑题目',
    eyebrow: isNew ? 'NEW QUESTION' : 'EDIT QUESTION',
    description: isNew
      ? '填写题干、选项和正确答案。答案决定这道题能否进入练习。'
      : '修改后会自动保存到题库，已有的练习记录不会丢失。',
    size: 'lg',
    content: `
      ${editorPlacementHTML(targetSubject.id, targetBank.id)}
      <div class="dialog-form-mount"></div>
    `,
    footer: `
      <button type="button" class="btn subtle" data-editor-cancel>取消</button>
      <button type="button" class="btn primary" data-editor-save>${icon('check', 16)} 保存题目</button>
    `,
    onMount: ({ dialog, body, close }) => {
      body.querySelector('.dialog-form-mount').appendChild(form.element);
      const subjectSelect = dialog.querySelector('[data-editor-subject]');
      const bankSelect = dialog.querySelector('[data-editor-bank]');
      const saveButton = dialog.querySelector('[data-editor-save]');
      let saving = false;

      subjectSelect?.addEventListener('change', () => {
        const nextSubject = subjectById(state, subjectSelect.value);
        if (!nextSubject) return;
        const banks = banksForSubject(state, nextSubject.id);
        bankSelect.innerHTML = placementBankOptionsHTML(nextSubject.id, banks[0]?.id || '');
      });

      const save = async () => {
        if (saving) return;
        const validation = form.validate();
        if (validation) {
          toast(validation, 'error', 3400);
          window.setTimeout(() => {
            form.element
              .querySelector('.has-error, [data-field="stem"], [data-option-index]')
              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 50);
          return;
        }

        const targetBankRecord = bankById(state, bankSelect?.value || '');
        const targetSubjectRecord = targetBankRecord
          ? subjectById(state, targetBankRecord.subjectId)
          : null;
        if (!targetSubjectRecord || !targetBankRecord) {
          toast('请选择有效的科目和子题库。', 'error', 3400);
          return;
        }

        saving = true;
        if (saveButton) {
          saveButton.disabled = true;
          saveButton.textContent = '写入题库…';
        }

        let changed = false;
        const draft = form.getQuestion();
        if (isNew) {
          const created = createQuestion({
            ...draft,
            subjectId: targetSubjectRecord.id,
            bankId: targetBankRecord.id,
          });
          state.questions.push(created);
          state.settings.lastBankId = targetBankRecord.id;
          persist();
          changed = true;
          toast(
            created.answer
              ? '题目已加入题库。'
              : '题目已保存；补充答案后才会进入练习。',
            'success',
          );
        } else {
          const index = state.questions.findIndex((item) => item.id === question.id);
          if (index >= 0) {
            state.questions[index] = sanitizeQuestion(
              {
                ...question,
                ...draft,
                id: question.id,
                subjectId: targetSubjectRecord.id,
                bankId: targetBankRecord.id,
                stats: question.stats,
                favorite: question.favorite,
                createdAt: question.createdAt,
                updatedAt: new Date().toISOString(),
              },
              { keepId: true },
            );
            state.settings.lastBankId = targetBankRecord.id;
            persist();
            changed = true;
            toast('题目已更新。', 'success');
          }
        }

        if (changed) await syncLibraryNow({ notify: true });
        close();
        app.refreshCurrent();
      };

      dialog.querySelector('[data-editor-cancel]')?.addEventListener('click', close);
      dialog.querySelector('[data-editor-save]')?.addEventListener('click', save);
      dialog.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          save();
        }
      });

      window.setTimeout(() => form.focusStem(), 80);
    },
  });

  return control;
}

async function openAISettings({ onSaved = null } = {}) {
  let config;
  try {
    config = await getAIConfig();
  } catch (error) {
    toast(`读取 AI 设置失败：${error.message || '未知错误'}`, 'error', 4200);
    return null;
  }

  let clearKey = false;
  let saving = false;

  const control = openDialog({
    title: 'AI 设置',
    eyebrow: 'OPTIONAL AI',
    description: '接入普通 OpenAI 兼容对话模型即可；程序逐张提取 OCR 文字，AI 只分析文字、不接收图片。',
    size: 'md',
    content: `
      <div class="ai-settings">
        <div class="ai-policy">
          <span class="ai-policy-icon">${icon('sparkles', 20)}</span>
          <div>
            <h3>本地 OCR 看图，AI 只分析文字</h3>
            <p>只有你点击「AI 逐图分析」时，每张图片单独提取出的 OCR 文字才会发送到你配置的模型服务；图片本身不会发送。AI 结果不会自动入库，必须由你确认。若模型服务本身支持联网搜索，答案冲突时可按规则自主核验并在警告中标注来源；不支持联网的模型不会虚构搜索结果。</p>
          </div>
        </div>

        <div class="ai-current ${config.configured ? 'is-ready' : ''}" data-ai-current>
          <span class="status-dot ${config.configured ? 'is-ok' : ''}"></span>
          ${config.configured ? 'AI 服务已配置，可以进行 AI 分析。' : '尚未配置 AI 服务。'}
        </div>

        <div class="ai-fields">
          <label class="ai-field">
            <span>接口地址</span>
            <input class="input" type="url" data-ai-endpoint value="${escapeHTML(config.endpoint || '')}"
              placeholder="https://api.openai.com/v1" autocomplete="off" spellcheck="false">
            <small>OpenAI 兼容的 base URL；也可以直接填写完整的 /chat/completions 地址。</small>
          </label>

          <label class="ai-field">
            <span>API Key <em>本机保存</em></span>
            <div class="ai-key-row">
              <input class="input" type="password" data-ai-key
                placeholder="${config.hasApiKey ? `已保存（${escapeHTML(config.apiKeyHint || '已保存')}），留空不修改` : '如果服务需要鉴权，在这里填写'}"
                autocomplete="new-password" spellcheck="false">
              <button type="button" class="icon-btn" data-ai-toggle-key aria-label="显示 API Key">${icon('eye', 17)}</button>
            </div>
            <small data-ai-key-hint>${config.hasApiKey ? 'API Key 已保存在本机，不会写入题库备份。' : '本地模型通常可以不填。'}</small>
          </label>
          ${
            config.hasApiKey
              ? '<button type="button" class="text-button ai-clear-key" data-ai-clear-key>清除已保存的密钥</button>'
              : ''
          }

          <label class="ai-field">
            <span>模型名称</span>
            <input class="input" type="text" data-ai-model value="${escapeHTML(config.model || '')}"
              placeholder="填写服务商提供的普通对话模型名称" autocomplete="off" spellcheck="false">
            <small>普通对话模型即可，不需要专门的 OCR 或文档识别模型，也不需要模型支持图片输入。</small>
          </label>
        </div>

        <section class="ai-instruction-editor">
          <div class="ai-instruction-head">
            <span>运行规则与指导 <em>可选</em></span>
            <span class="ai-instruction-count" data-ai-instructions-count>0 / 8000</span>
          </div>
          <textarea class="ai-instruction-input" data-ai-instructions rows="7" maxlength="8000"
            placeholder="例如：&#10;- 回答保持简洁，先给结论，再给依据。&#10;- 使用简体中文和标准术语。&#10;- 题目文字与答案冲突时，先核对并注明依据。">${escapeHTML(config.customInstructions || '')}</textarea>
          <small>会附加到逐图分析、AI 辅导、AI 助手和题库巡检。自定义规则只能补充偏好，不能覆盖安全约束、来源真实性要求和动作白名单。</small>
          <div class="ai-instruction-actions">
            <button type="button" class="text-button" data-ai-instructions-sample>插入规则模板</button>
            <button type="button" class="text-button" data-ai-instructions-clear>清空</button>
          </div>
        </section>

        <details class="ai-examples">
          <summary>常见接口地址示例</summary>
          <div>
            <p><b>DeepSeek</b><code>https://api.deepseek.com/chat/completions</code></p>
            <p><b>OpenAI</b><code>https://api.openai.com/v1</code></p>
            <p><b>阿里云百炼</b><code>https://dashscope.aliyuncs.com/compatible-mode/v1</code></p>
            <p><b>智谱 AI</b><code>https://open.bigmodel.cn/api/paas/v4</code></p>
            <p><b>本地 LM Studio / Ollama</b><code>http://127.0.0.1:1234/v1</code></p>
            <small>以上只演示地址格式，模型名称请以服务商当前文档为准。</small>
            <button type="button" class="text-button ai-preset-button" data-ai-preset="deepseek">
              ${icon('sparkles', 14)} 一键填入 DeepSeek 配置
            </button>
          </div>
        </details>

        <div class="ai-test-row">
          <button type="button" class="btn subtle" data-ai-test>
            ${icon('scan', 16)} <span data-ai-test-label>测试连接</span>
          </button>
          <span class="ai-test-status" data-ai-test-status role="status"></span>
        </div>

        <div class="ai-safety">
          ${icon('info', 15)}
          <p>API Key 只保存在本机的 <code>ai-config.json</code>，不会进入题库备份。请求由本机服务转发；远程服务请优先使用 HTTPS，不要把包含隐私的 OCR 文字交给不可信的服务商。</p>
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn subtle" data-ai-cancel>取消</button>
      <button type="button" class="btn primary" data-ai-save>${icon('check', 16)} 保存设置</button>
    `,
    onMount: ({ dialog, close }) => {
      const endpointInput = dialog.querySelector('[data-ai-endpoint]');
      const modelInput = dialog.querySelector('[data-ai-model]');
      const keyInput = dialog.querySelector('[data-ai-key]');
      const keyHint = dialog.querySelector('[data-ai-key-hint]');
      const clearButton = dialog.querySelector('[data-ai-clear-key]');
      const testButton = dialog.querySelector('[data-ai-test]');
      const testLabel = dialog.querySelector('[data-ai-test-label]');
      const testStatus = dialog.querySelector('[data-ai-test-status]');
      const saveButton = dialog.querySelector('[data-ai-save]');
      const currentBadge = dialog.querySelector('[data-ai-current]');
      const toggleKeyButton = dialog.querySelector('[data-ai-toggle-key]');
      const instructionsInput = dialog.querySelector('[data-ai-instructions]');
      const instructionsCount = dialog.querySelector('[data-ai-instructions-count]');

      const setTestStatus = (message, tone = '') => {
        testStatus.textContent = message || '';
        testStatus.className = `ai-test-status ${tone ? `is-${tone}` : ''}`;
      };

      const updateInstructionsCount = () => {
        if (!instructionsInput || !instructionsCount) return;
        instructionsCount.textContent = `${instructionsInput.value.length} / 8000`;
      };
      updateInstructionsCount();
      instructionsInput?.addEventListener('input', updateInstructionsCount);

      if (config.hasApiKey && /^http/i.test(config.apiKeyHint || '')) {
        setTestStatus('已保存的 API Key 看起来是接口地址，请清除后重新填写服务商提供的密钥。', 'error');
      }

      toggleKeyButton?.addEventListener('click', () => {
        const revealing = keyInput.type === 'password';
        keyInput.type = revealing ? 'text' : 'password';
        toggleKeyButton.setAttribute('aria-label', revealing ? '隐藏 API Key' : '显示 API Key');
      });

      dialog.querySelector('[data-ai-preset="deepseek"]')?.addEventListener('click', () => {
        endpointInput.value = 'https://api.deepseek.com/chat/completions';
        modelInput.value = 'deepseek-flash';
        endpointInput.dispatchEvent(new Event('input', { bubbles: true }));
        modelInput.dispatchEvent(new Event('input', { bubbles: true }));
        setTestStatus('已填入 DeepSeek 配置，请填写 API Key 后测试连接。', 'pending');
        keyInput.focus();
      });

      dialog.querySelector('[data-ai-instructions-sample]')?.addEventListener('click', () => {
        if (!instructionsInput) return;
        const sample = [
          '- 回答保持简洁，先给结论，再给依据。',
          '- 使用简体中文和标准术语。',
          '- 题目文字与答案冲突时，先核对 OCR 文字；如果当前模型支持联网搜索，优先查证权威资料并在 warnings 中注明来源。',
          '- 无法联网或来源无法互相印证时，保留原答案、降低 confidence，并说明冲突，不得编造搜索结果。',
          '- 解析面向复习，指出考点和常见误区，不编造信息。',
        ].join('\n');
        const current = instructionsInput.value.trim();
        instructionsInput.value = current ? `${current}\n\n${sample}` : sample;
        instructionsInput.dispatchEvent(new Event('input', { bubbles: true }));
        instructionsInput.focus();
      });

      dialog.querySelector('[data-ai-instructions-clear]')?.addEventListener('click', () => {
        if (!instructionsInput) return;
        instructionsInput.value = '';
        instructionsInput.dispatchEvent(new Event('input', { bubbles: true }));
        instructionsInput.focus();
      });

      clearButton?.addEventListener('click', () => {
        clearKey = !clearKey;
        keyInput.disabled = clearKey;
        keyInput.value = '';
        clearButton.textContent = clearKey ? '取消清除已保存的密钥' : '清除已保存的密钥';
        keyInput.placeholder = clearKey ? '保存后将移除密钥' : '已保存，留空不修改';
        if (keyHint) {
          keyHint.textContent = clearKey
            ? '保存设置后会移除已保存的密钥。'
            : 'API Key 已保存在本机，不会写入题库备份。';
        }
      });

      const validateFields = () => {
        const endpoint = endpointInput.value.trim();
        const model = modelInput.value.trim();
        if (!endpoint) {
          setTestStatus('请先填写接口地址。', 'error');
          endpointInput.focus();
          return null;
        }
        if (!model) {
          setTestStatus('请先填写模型名称。', 'error');
          modelInput.focus();
          return null;
        }
        if (!/^https?:\/\/\S+$/i.test(endpoint)) {
          setTestStatus('接口地址需要以 http:// 或 https:// 开头。', 'error');
          endpointInput.focus();
          return null;
        }
        const apiKey = clearKey ? '' : keyInput.value.trim();
        if (/^https?:\/\//i.test(apiKey)) {
          setTestStatus('API Key 看起来是接口地址，请把地址填到上方「接口地址」，这里填写服务商提供的密钥。', 'error');
          keyInput.focus();
          return null;
        }
        return { endpoint, model, apiKey };
      };

      testButton?.addEventListener('click', async () => {
        const values = validateFields();
        if (!values) return;
        testButton.disabled = true;
        testLabel.textContent = '测试中…';
        setTestStatus('正在请求模型…', 'pending');
        try {
          const result = await testAIConnection({ ...values, clearKey });
          setTestStatus(result.message || '连接成功。', 'success');
        } catch (error) {
          setTestStatus(`${error.message || '连接失败'}${error.hint ? ` ${error.hint}` : ''}`, 'error');
        } finally {
          testButton.disabled = false;
          testLabel.textContent = '测试连接';
        }
      });

      saveButton?.addEventListener('click', async () => {
        if (saving) return;
        const values = validateFields();
        if (!values) return;
        saving = true;
        saveButton.disabled = true;
        saveButton.textContent = '保存中…';
        try {
          const saved = await saveAIConfig({
            endpoint: values.endpoint,
            model: values.model,
            apiKey: values.apiKey,
            customInstructions: instructionsInput?.value.trim() || '',
            clearKey,
          });
          if (currentBadge) {
            currentBadge.classList.toggle('is-ready', saved.configured);
            currentBadge.innerHTML = `<span class="status-dot ${saved.configured ? 'is-ok' : ''}"></span>${
              saved.configured ? 'AI 服务已配置，可以进行 AI 分析。' : '尚未配置 AI 服务。'
            }`;
          }
          close();
          toast('AI 设置已保存。现在可以使用「AI 逐图分析」。', 'success');
          onSaved?.(saved);
        } catch (error) {
          setTestStatus(`${error.message || '保存失败'}${error.hint ? ` ${error.hint}` : ''}`, 'error');
          toast(`保存 AI 设置失败：${error.message || '未知错误'}`, 'error', 4200);
          saving = false;
          saveButton.disabled = false;
          saveButton.innerHTML = `${icon('check', 16)} 保存设置`;
        }
      });

      dialog.querySelector('[data-ai-cancel]')?.addEventListener('click', close);
      dialog.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          saveButton?.click();
        }
      });
    },
  });

  return control;
}

function openDataDialog() {
  if (currentViewName === 'practice' && views.practice.hasActiveSession()) {
    toast('先结束当前练习，再管理题库数据。', 'info');
    return;
  }

  let confirmArmed = false;
  let confirmTimer = null;
  let serialized = '';
  try {
    serialized = JSON.stringify(state);
  } catch {
    serialized = '';
  }
  const approxSize = serialized ? `${Math.max(1, Math.round(new Blob([serialized]).size / 1024))} KB` : '—';
  const attempts = state.questions.reduce((sum, question) => sum + question.stats.attempts, 0);
  const libraryInfo = app.getLibraryInfo();

  const control = openDialog({
    title: '题库文件与备份',
    eyebrow: 'LIBRARY FILES',
    description: '题目和答案会保存为项目「题库保存」文件夹中的 Markdown 文件；导出的 JSON 是额外备份。',
    size: 'md',
    content: `
      <div class="data-manager">
        <div class="data-overview">
          <span class="data-overview-icon">${icon('database', 21)}</span>
          <div>
            <h3>${state.subjects.length} 个科目 · ${state.banks.length} 个子题库 · ${state.questions.length} 道题</h3>
            <p>已练习 ${attempts} 次 · 本地数据约 ${approxSize} · 图片不会被保存</p>
          </div>
          <span class="local-pill"><i></i> 本机</span>
        </div>

        <div class="data-card-grid">
          <section class="data-card">
            <span class="data-card-icon">${icon('download', 20)}</span>
            <h3>导出备份</h3>
            <p>把全部科目、子题库、题目、答案和练习记录保存成一个 JSON 文件。</p>
            <button type="button" class="btn subtle full-width" data-data-export>${icon('download', 15)} 导出 JSON</button>
          </section>
          <section class="data-card">
            <span class="data-card-icon">${icon('upload', 20)}</span>
            <h3>导入备份</h3>
            <p>从备份文件恢复题库；内容相同的题目会合并练习统计，不会重复添加。</p>
            <button type="button" class="btn subtle full-width" data-data-import>${icon('upload', 15)} 选择文件</button>
            <input type="file" hidden accept=".json,application/json" data-data-file>
          </section>
        </div>

        <section class="data-disk-card">
          <span class="data-card-icon">${icon('layers', 20)}</span>
          <div class="data-disk-copy">
            <h3>Markdown 题库</h3>
            <code>${escapeHTML(libraryInfo.root)}/科目名/子题库名.md</code>
            <p>${
              libraryInfo.dirty
                ? '有改动尚未写入磁盘，请检查题库文件夹权限或稍后重试。'
                : libraryInfo.lastSyncAt
                  ? `上次写入：${relativeDate(libraryInfo.lastSyncAt)}`
                  : '启动后会自动读取这里的题库文件。'
            }</p>
          </div>
          <button type="button" class="btn subtle" data-data-reload-disk>${icon('refresh', 15)} 从磁盘刷新</button>
        </section>

        <div class="data-hint">
          ${icon('info', 16)}
          <p>每次启动会直接读取 Markdown 题库，做题时不会调用 AI。只有导入和识别新题时才需要 AI。数据不会上传到云端。</p>
        </div>

        <div class="data-danger">
          <div>
            <h3>清空全部数据</h3>
            <p>删除所有程序管理的题库 Markdown 与练习记录；同文件夹里的图片等非管理文件会保留。建议先导出备份。</p>
          </div>
          <button type="button" class="btn danger-ghost" data-data-clear>清空数据</button>
        </div>
      </div>
    `,
    footer: `<button type="button" class="btn subtle" data-data-close>关闭</button>`,
    onMount: ({ dialog, body, close }) => {
      dialog.querySelector('[data-data-close]')?.addEventListener('click', close);

      dialog.querySelector('[data-data-export]')?.addEventListener('click', () => {
        const payload = exportBackup(state);
        downloadJSON(payload, `刷题助手-备份-${localDateKey()}.json`);
        toast('备份文件已导出。', 'success');
      });

      const fileInput = dialog.querySelector('[data-data-file]');
      dialog.querySelector('[data-data-import]')?.addEventListener('click', () => fileInput?.click());
      fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) {
          toast('备份文件过大，无法导入。', 'error');
          return;
        }
        try {
          const text = await file.text();
          const payload = JSON.parse(text);
          const result = importBackup(state, payload);
          persist();
          const synced = await syncLibraryNow({ notify: false });
          close();
          renderView(currentViewName, { preserveScroll: true });
          if (!synced.ok) {
            toast(
              `导入内容已保留在当前浏览器，但写入 Markdown 失败：${
                synced.error?.message || '未知错误'
              }`,
              'error',
              6000,
            );
            return;
          }
          toast(
            result.added
              ? `导入完成：新增 ${result.added} 道题，合并 ${result.skipped} 道重复题。`
              : `没有新增题目，已合并 ${result.skipped} 道重复题。`,
            result.added ? 'success' : 'info',
            4200,
          );
        } catch (error) {
          console.error(error);
          toast(`导入失败：${error.message || '文件格式不正确'}`, 'error', 4200);
        }
      });

      dialog.querySelector('[data-data-reload-disk]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = '正在读取…';
        const reloaded = await app.reloadLibraryFromDisk();
        if (reloaded) {
          close();
          renderView(currentViewName, { preserveScroll: true });
          toast('已从磁盘重新读取 Markdown 题库。', 'success');
        } else {
          button.disabled = false;
          button.innerHTML = `${icon('refresh', 15)} 从磁盘刷新`;
        }
      });

      const clearButton = dialog.querySelector('[data-data-clear]');
      clearButton?.addEventListener('click', async () => {
        if (!confirmArmed) {
          confirmArmed = true;
          clearButton.classList.add('is-armed');
          clearButton.textContent = '再次点击确认清空';
          clearTimeout(confirmTimer);
          confirmTimer = window.setTimeout(() => {
            confirmArmed = false;
            clearButton.classList.remove('is-armed');
            clearButton.textContent = '清空数据';
          }, 4200);
          return;
        }

        clearButton.disabled = true;
        clearButton.textContent = '正在清理…';
        const diskResult = await app.clearLibraryFiles();
        if (!diskResult.ok) {
          clearButton.disabled = false;
          clearButton.textContent = '清空数据';
          clearButton.classList.remove('is-armed');
          confirmArmed = false;
          toast(
            `磁盘题库清理失败：${diskResult.error?.message || '未知错误'}。浏览器数据未清空。`,
            'error',
            5200,
          );
          return;
        }

        state.questions = [];
        state.history = [];
        state.duplicateIgnores = [];
        state.subjects = [];
        state.banks = [];
        state.settings.lastBankId = '';
        persist();
        close();
        renderView(currentViewName, { preserveScroll: true });
        toast('浏览器与 Markdown 题库已清空；图片等非题库文件会保留。', 'info', 4200);
      });
    },
  });

  return control;
}

function hydrateStaticIcons() {
  document.querySelectorAll('[data-nav-icon]').forEach((node) => {
    node.innerHTML = icon(node.dataset.navIcon, 18);
  });
  document.querySelectorAll('[data-static-icon]').forEach((node) => {
    node.innerHTML = icon(node.dataset.staticIcon, 18);
  });
}

function bindShellEvents() {
  document.querySelectorAll('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.nav));
  });

  document.querySelectorAll('[data-global-action]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.globalAction === 'assistant') openContextAIAssistant();
      else if (button.dataset.globalAction === 'ai') openAISettings();
      else if (button.dataset.globalAction === 'data') openDataDialog();
      else if (button.dataset.globalAction === 'theme') toggleTheme();
    });
  });

  document.addEventListener('paste', async (event) => {
    if (document.querySelector('dialog[open]')) return;
    const items = [...(event.clipboardData?.items || [])];
    const files = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;

    event.preventDefault();
    const entered = await navigate('import');
    if (entered) {
      views.import.addFiles(files);
      toast('已从剪贴板添加截图。', 'success');
    }
  });

  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (!state.settings.theme) applyTheme(systemTheme());
  });
}

async function boot() {
  hydrateStaticIcons();
  applyTheme(resolvedTheme());
  main.innerHTML = `
    <div class="boot-loading">
      <span class="mini-spinner" aria-hidden="true"></span>
      <p>正在读取本地 Markdown 题库…</p>
    </div>
  `;
  try {
    await loadLibraryOnBoot();
  } catch (error) {
    console.error('初始化题库失败', error);
    toast(`初始化题库失败：${error.message || '未知错误'}`, 'error', 5200);
  }
  bindShellEvents();
  renderView('dashboard');
  document.documentElement.classList.add('app-ready');
}

boot();
