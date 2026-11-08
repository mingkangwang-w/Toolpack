import { parseMarkdownBanks } from '../api.js';
import { OFFLINE_MODE } from '../runtime.js';
import {
  answerDisplay,
  answerIssueReason,
  canonicalBankKey,
  canonicalFolderKey,
  exportLibraryPackage,
  filterQuestionsByBank,
  getLibraryIssues,
  getStats,
  importBackup,
  localDateKey,
  isMastered,
  isQuestionAnswerable,
  questionDuplicateKey,
  QUESTION_TYPES,
} from '../store.js';
import {
  confirmAction,
  downloadJSON,
  escapeHTML,
  icon,
  openDialog,
  relativeDate,
  toast,
  typeClass,
} from '../ui.js';

function importUid(prefix) {
  return `${prefix}_${
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  }`;
}

function parsedBanksToPayload(banks) {
  const now = new Date().toISOString();
  const subjectsByKey = new Map();
  const banksByKey = new Map();
  const questions = [];

  for (const parsed of banks || []) {
    const subjectName = String(parsed?.subjectName || '导入题库').trim() || '导入题库';
    const subjectKey = canonicalFolderKey(subjectName);
    let subject = subjectsByKey.get(subjectKey);
    if (!subject) {
      subject = {
        id: importUid('subject'),
        name: subjectName,
        createdAt: now,
        updatedAt: now,
      };
      subjectsByKey.set(subjectKey, subject);
    }

    const bankName = String(parsed?.bankName || '导入题库').trim() || '导入题库';
    const bankKey = `${subjectKey}::${canonicalBankKey(bankName)}`;
    let bank = banksByKey.get(bankKey);
    if (!bank) {
      bank = {
        id: importUid('bank'),
        subjectId: subject.id,
        name: bankName,
        createdAt: now,
        updatedAt: now,
      };
      banksByKey.set(bankKey, bank);
    }

    for (const raw of Array.isArray(parsed?.questions) ? parsed.questions : []) {
      if (!raw || !String(raw.stem || '').trim()) continue;
      questions.push({
        ...raw,
        id: importUid('q'),
        subjectId: subject.id,
        bankId: bank.id,
      });
    }
  }

  return {
    app: '刷题助手',
    version: 2,
    exportedAt: now,
    subjects: [...subjectsByKey.values()],
    banks: [...banksByKey.values()],
    questions,
    history: [],
    duplicateIgnores: [],
  };
}

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'wrong', label: '错题' },
  { key: 'unmastered', label: '未掌握' },
  { key: 'favorites', label: '收藏' },
  { key: 'missing', label: '缺答案' },
  { key: 'duplicates', label: '重复题' },
  { key: 'answerIssues', label: '答案异常' },
];

function countForFilter(questions, key, ignoredDuplicateKeys = []) {
  if (key === 'wrong') return questions.filter((q) => q.stats.lastResult === 'wrong').length;
  if (key === 'unmastered') {
    return questions.filter((q) => isQuestionAnswerable(q) && !isMastered(q)).length;
  }
  if (key === 'favorites') return questions.filter((q) => q.favorite).length;
  if (key === 'missing') {
    return questions.filter(
      (q) => !isQuestionAnswerable(q) && !answerIssueReason(q),
    ).length;
  }
  if (key === 'duplicates') {
    return getLibraryIssues(questions, { ignoredDuplicateKeys }).duplicateQuestionCount;
  }
  if (key === 'answerIssues') return getLibraryIssues(questions).answerIssueCount;
  return questions.length;
}

function statusFor(question) {
  if (answerIssueReason(question)) return { label: '答案异常', tone: 'danger' };
  if (!isQuestionAnswerable(question)) {
    return { label: '缺答案', tone: 'warning' };
  }
  if (question.stats.lastResult === 'wrong') return { label: '错题', tone: 'danger' };
  if (isMastered(question)) return { label: '已掌握', tone: 'success' };
  if (question.stats.attempts > 0) return { label: '练习中', tone: 'neutral' };
  return { label: '未练习', tone: 'quiet' };
}

function answerSummary(question) {
  if (!question.answer) {
    return question.type === 'short' ? '参考答案可选（练习时自评）' : '尚未设置答案';
  }
  if (question.type === 'short') return `参考答案：${answerDisplay(question)}`;
  if (question.type === 'fill') return `答案：${answerDisplay(question)}`;
  return `答案：${question.answer}`;
}

function aiReviewSummary(question) {
  const review = question.aiReview;
  if (!review?.flagged) return '';
  const parts = Array.isArray(review.warnings) ? [...review.warnings] : [];
  const confidence = Number(review.confidence);
  if (Number.isFinite(confidence) && confidence < 0.7) {
    parts.push(`AI 置信度 ${Math.round(confidence * 100)}%`);
  }
  const source = [review.sourceFilename, review.pageNumber ? `第 ${review.pageNumber} 页` : '']
    .filter(Boolean)
    .join(' · ');
  if (source) parts.push(`来源：${source}`);
  return parts.join('；') || 'AI 标记这道题需要人工复核';
}

function questionRowHTML(question, index, bankName = '', selected = false) {
  const status = statusFor(question);
  const answerable = isQuestionAnswerable(question);
  const aiReview = aiReviewSummary(question);
  const accuracy =
    question.stats.attempts > 0
      ? `${Math.round((question.stats.correct / question.stats.attempts) * 100)}%`
      : '—';

  return `
    <article class="question-row ${selected ? 'is-selected' : ''}"
      data-question-row="${escapeHTML(question.id)}">
      <label class="question-select" title="选择这道题">
        <input type="checkbox" data-select-question="${escapeHTML(question.id)}"
          aria-label="选择第 ${index + 1} 题" ${selected ? 'checked' : ''}>
      </label>
      <span class="question-order">${String(index + 1).padStart(2, '0')}</span>
      <div class="question-row-copy">
        <div class="question-row-meta">
          <span class="type-badge type-${typeClass(question.type)}">${QUESTION_TYPES[question.type] || '题目'}</span>
          ${bankName ? `<span class="row-bank">${escapeHTML(bankName)}</span>` : ''}
          <span class="status-badge status-${status.tone}">${status.label}</span>
          ${
            aiReview
              ? `<span class="ai-review-badge" title="${escapeHTML(aiReview)}">${icon('alert', 12)} AI 需复核</span>`
              : ''
          }
          <span class="row-date">${relativeDate(question.createdAt)}</span>
        </div>
        <p class="question-row-stem">${escapeHTML(question.stem)}</p>
        <div class="question-row-foot">
          <span class="${answerable ? '' : 'is-warning'}">${escapeHTML(answerSummary(question))}</span>
          <span>练习 ${question.stats.attempts} 次</span>
          <span>正确率 ${accuracy}</span>
          ${question.options.length ? `<span>${question.options.length} 个选项</span>` : ''}
        </div>
      </div>
      <div class="question-row-actions">
        <button type="button" class="icon-btn favorite-button ${question.favorite ? 'is-favorite' : ''}"
          data-action="favorite" data-id="${escapeHTML(question.id)}"
          aria-label="${question.favorite ? '取消收藏' : '收藏'}" aria-pressed="${question.favorite}">
          ${icon('star', 17)}
        </button>
        <button type="button" class="icon-btn" data-action="practice-one" data-id="${escapeHTML(question.id)}"
          aria-label="练习这道题" title="${answerable ? '练习这道题' : '先补充答案才能练习'}"
          ${answerable ? '' : 'disabled'}>
          ${icon('play', 16)}
        </button>
        <button type="button" class="icon-btn" data-action="edit" data-id="${escapeHTML(question.id)}"
          aria-label="编辑题目" title="编辑">
          ${icon('edit', 16)}
        </button>
        <button type="button" class="icon-btn danger-hover" data-action="delete" data-id="${escapeHTML(question.id)}"
          aria-label="删除题目" title="删除">
          ${icon('trash', 16)}
        </button>
      </div>
    </article>
  `;
}

export function createLibraryView(app) {
  let rootRef = null;
  let controller = null;
  let draggedBank = null;
  const viewState = {
    filter: 'all',
    type: 'all',
    sort: 'newest',
    search: '',
    limit: 60,
    subjectId: '',
    bankId: '',
    taxonomyScroll: 0,
    selectedIds: new Set(),
    filteredIds: [],
  };

  function scopedQuestions() {
    return filterQuestionsByBank(app.state.questions, viewState);
  }

  function currentScopeLabel() {
    const bank = viewState.bankId ? app.bankById(viewState.bankId) : null;
    const subject = viewState.subjectId ? app.subjectById(viewState.subjectId) : null;
    if (bank && subject) return `${subject.name} / ${bank.name}`;
    if (subject) return `${subject.name} · 科目总题库`;
    return '总题库';
  }

  function bankCounts(bankId) {
    const questions = app.state.questions.filter((question) => question.bankId === bankId);
    return {
      total: questions.length,
      answerable: questions.filter(isQuestionAnswerable).length,
    };
  }

  function subjectCounts(subjectId) {
    const questions = app.state.questions.filter((question) => question.subjectId === subjectId);
    return {
      total: questions.length,
      answerable: questions.filter(isQuestionAnswerable).length,
    };
  }

  function bankRowHTML(subject, bank) {
    const counts = bankCounts(bank.id);
    const active = viewState.bankId === bank.id;
    return `
      <div class="bank-row ${active ? 'is-active' : ''}"
        data-bank-row="${escapeHTML(bank.id)}" data-bank-id="${escapeHTML(bank.id)}"
        data-subject-id="${escapeHTML(subject.id)}">
        <span class="bank-drag-handle" draggable="true" data-bank-drag-handle
          role="button" tabindex="0"
          aria-label="拖动调整${escapeHTML(bank.name)}的顺序，聚焦后可按上下方向键"
          title="拖动调整顺序；聚焦后按上下方向键">${icon('grip-vertical', 14)}</span>
        <button type="button" class="bank-open" data-action="view-bank"
          data-id="${escapeHTML(bank.id)}" data-subject-id="${escapeHTML(subject.id)}"
          aria-pressed="${active}">
          <span class="bank-dot"></span>
          <span class="bank-name">${escapeHTML(bank.name)}</span>
          <span class="bank-count">${counts.answerable}/${counts.total} 可练</span>
        </button>
        <div class="bank-row-actions">
          <button type="button" class="icon-btn" data-action="practice-bank"
            data-id="${escapeHTML(bank.id)}" data-subject-id="${escapeHTML(subject.id)}"
            title="${counts.answerable ? '练习这个子题库' : '暂无有答案的题目'}"
            aria-label="练习${escapeHTML(bank.name)}" ${counts.answerable ? '' : 'disabled'}>
            ${icon('play', 14)}
          </button>
          <button type="button" class="icon-btn" data-action="rename-bank" data-id="${escapeHTML(bank.id)}"
            title="重命名子题库" aria-label="重命名${escapeHTML(bank.name)}">${icon('edit', 14)}</button>
          <button type="button" class="icon-btn danger-hover" data-action="delete-bank" data-id="${escapeHTML(bank.id)}"
            title="删除子题库" aria-label="删除${escapeHTML(bank.name)}">${icon('trash', 14)}</button>
        </div>
      </div>
    `;
  }

  function subjectCardHTML(subject) {
    const counts = subjectCounts(subject.id);
    const banks = app.banksForSubject(subject.id);
    const active = viewState.subjectId === subject.id;
    return `
      <article class="subject-card ${active ? 'is-active' : ''}">
        <header class="subject-card-head">
          <span class="subject-mark">${icon('book', 18)}</span>
          <div class="subject-card-copy">
            <h3>${escapeHTML(subject.name)}</h3>
            <p>${banks.length} 个子题库 · ${counts.answerable} 道可练 / 共 ${counts.total} 道</p>
          </div>
          <div class="subject-tools">
            <button type="button" class="icon-btn" data-action="rename-subject" data-id="${escapeHTML(subject.id)}"
              title="重命名科目" aria-label="重命名${escapeHTML(subject.name)}">${icon('edit', 14)}</button>
            <button type="button" class="icon-btn danger-hover" data-action="delete-subject" data-id="${escapeHTML(subject.id)}"
              title="删除科目" aria-label="删除${escapeHTML(subject.name)}">${icon('trash', 14)}</button>
          </div>
        </header>
        <div class="bank-list">
          <div class="bank-row is-subject-total ${active && !viewState.bankId ? 'is-active' : ''}">
            <button type="button" class="bank-open" data-action="view-subject" data-id="${escapeHTML(subject.id)}"
              aria-pressed="${active && !viewState.bankId}">
              <span class="bank-dot is-total"></span>
              <span class="bank-name">科目总题库</span>
              <span class="bank-count">${counts.answerable}/${counts.total} 可练</span>
            </button>
            <div class="bank-row-actions">
              <button type="button" class="icon-btn" data-action="practice-subject" data-id="${escapeHTML(subject.id)}"
                title="${counts.answerable ? '练习本科目总题库' : '暂无有答案的题目'}"
                aria-label="练习${escapeHTML(subject.name)}总题库" ${counts.answerable ? '' : 'disabled'}>
                ${icon('play', 14)}
              </button>
            </div>
          </div>
          ${
            banks.length
              ? banks.map((bank) => bankRowHTML(subject, bank)).join('')
              : '<p class="bank-empty">还没有子题库，先创建一个再导入题目。</p>'
          }
        </div>
        <footer class="subject-card-foot">
          <button type="button" class="text-button" data-action="new-bank" data-subject-id="${escapeHTML(subject.id)}">
            ${icon('plus', 14)} 新建子题库
          </button>
          <button type="button" class="btn subtle subject-practice-button"
            data-action="practice-subject" data-id="${escapeHTML(subject.id)}" ${counts.answerable ? '' : 'disabled'}>
            ${icon('play', 14)} 刷本科目
          </button>
        </footer>
      </article>
    `;
  }

  function taxonomyHTML() {
    const stats = getStats(app.state);
    const subjects = app.state.subjects;
    const libraryInfo = app.getLibraryInfo();
    return `
      <section class="panel taxonomy-panel">
        <header class="taxonomy-head">
          <div>
            <p class="eyebrow">SUBJECTS · 科目与子题库</p>
            <h2>按科目组织，按子题库练习</h2>
            <p>先建科目，再建子题库。也可以直接练一个科目的总题库；科目列表较长时在右侧区域内滚动，总题库保持固定。</p>
            <p class="taxonomy-storage ${libraryInfo.dirty ? 'is-dirty' : ''}">
              ${icon('layers', 12)}
              Markdown 题库：${escapeHTML(libraryInfo.root)}/科目名/子题库名.md
              ${libraryInfo.dirty ? ' · 等待写入磁盘' : ''}
            </p>
          </div>
        </header>
        <div class="taxonomy-layout">
          <article class="taxonomy-all-card ${!viewState.subjectId ? 'is-active' : ''}">
            <div class="taxonomy-all-top">
              <span class="taxonomy-all-mark">${icon('layers', 22)}</span>
              <div>
                <span class="eyebrow">ALL SUBJECTS</span>
                <h3>总题库</h3>
              </div>
            </div>
            <p>所有科目的题目汇总在一起，也可以按数量或全部刷一遍。</p>
            <div class="taxonomy-stat-line">
              <span><b>${stats.answerable}</b> 道可练</span>
              <span>共 ${stats.total} 道</span>
              <span>${subjects.length} 个科目</span>
            </div>
            <div class="taxonomy-all-actions">
              <button type="button" class="btn subtle" data-action="view-all">查看全部题目</button>
              <button type="button" class="btn primary" data-action="practice-all" ${stats.answerable ? '' : 'disabled'}>
                ${icon('play', 14)} 刷总题库
              </button>
            </div>
          </article>
          <div class="taxonomy-grid" data-taxonomy-scroll role="region"
            aria-label="科目与子题库列表，可在区域内滚动">
            ${subjects.map((subject) => subjectCardHTML(subject)).join('')}
            ${
              subjects.length
                ? ''
                : `<div class="taxonomy-empty">
                    <span>${icon('book', 22)}</span>
                    <div><h3>还没有科目</h3><p>先创建第一个科目，再在科目里创建子题库。</p></div>
                  </div>`
            }
          </div>
        </div>
      </section>
    `;
  }

  function subjectFilterOptionsHTML() {
    return `
      <option value="">全部科目</option>
      ${app.state.subjects
        .map(
          (subject) =>
            `<option value="${escapeHTML(subject.id)}" ${subject.id === viewState.subjectId ? 'selected' : ''}>${escapeHTML(subject.name)}</option>`,
        )
        .join('')}
    `;
  }

  function bankFilterOptionsHTML() {
    if (!viewState.subjectId) return '<option value="">全部子题库</option>';
    return `
      <option value="">科目总题库</option>
      ${app
        .banksForSubject(viewState.subjectId)
        .map(
          (bank) =>
            `<option value="${escapeHTML(bank.id)}" ${bank.id === viewState.bankId ? 'selected' : ''}>${escapeHTML(bank.name)}</option>`,
        )
        .join('')}
    `;
  }

  function applyFilter(questions) {
    let result = [...questions];
    if (viewState.filter === 'wrong') result = result.filter((q) => q.stats.lastResult === 'wrong');
    else if (viewState.filter === 'unmastered') {
      result = result.filter((q) => isQuestionAnswerable(q) && !isMastered(q));
    } else if (viewState.filter === 'favorites') result = result.filter((q) => q.favorite);
    else if (viewState.filter === 'missing') {
      result = result.filter((q) => !isQuestionAnswerable(q) && !answerIssueReason(q));
    } else if (viewState.filter === 'duplicates') {
      const duplicateIds = getLibraryIssues(questions, {
        ignoredDuplicateKeys: app.state.duplicateIgnores || [],
      }).duplicateIds;
      result = result.filter((q) => duplicateIds.has(q.id));
    } else if (viewState.filter === 'answerIssues') {
      result = result.filter((q) => Boolean(answerIssueReason(q)));
    }

    if (viewState.type !== 'all') result = result.filter((q) => q.type === viewState.type);

    const query = viewState.search.trim().toLowerCase();
    if (query) {
      result = result.filter((question) => {
        const haystack = [
          question.stem,
          question.answer,
          question.explanation,
          ...question.options.map((option) => option.text),
          QUESTION_TYPES[question.type] || '',
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(query);
      });
    }

    if (viewState.sort === 'practice') {
      result.sort((a, b) => b.stats.attempts - a.stats.attempts || String(b.createdAt).localeCompare(String(a.createdAt)));
    } else if (viewState.sort === 'wrong') {
      result.sort(
        (a, b) =>
          b.stats.wrong - a.stats.wrong ||
          (b.stats.attempts ? b.stats.wrong / b.stats.attempts : 0) -
            (a.stats.attempts ? a.stats.wrong / a.stats.attempts : 0) ||
          String(b.createdAt).localeCompare(String(a.createdAt)),
      );
    } else if (viewState.sort === 'accuracy') {
      result.sort((a, b) => {
        if (!a.stats.attempts && !b.stats.attempts) return String(b.createdAt).localeCompare(String(a.createdAt));
        if (!a.stats.attempts) return 1;
        if (!b.stats.attempts) return -1;
        return a.stats.correct / a.stats.attempts - b.stats.correct / b.stats.attempts;
      });
    } else {
      result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }

    return result;
  }

  function countStatusLabel() {
    const counts = {};
    const questions = scopedQuestions();
    const ignoredDuplicateKeys = app.state.duplicateIgnores || [];
    FILTERS.forEach((filter) => {
      counts[filter.key] = countForFilter(questions, filter.key, ignoredDuplicateKeys);
    });
    return counts;
  }

  function updateFilterCounts() {
    if (!rootRef) return;
    const counts = countStatusLabel();
    FILTERS.forEach((filter) => {
      const node = rootRef.querySelector(`[data-filter="${filter.key}"] b`);
      if (node) node.textContent = String(counts[filter.key]);
    });
  }

  function updateFilterActive() {
    if (!rootRef) return;
    rootRef.querySelectorAll('[data-filter]').forEach((button) => {
      const active = button.dataset.filter === viewState.filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function duplicateManagerHTML() {
    const issues = getLibraryIssues(scopedQuestions(), {
      ignoredDuplicateKeys: app.state.duplicateIgnores || [],
    });
    if (!issues.duplicateGroupCount && !issues.ignoredDuplicateGroupCount) return '';

    const items = issues.duplicateGroups
      .map((group, index) => {
        const key = questionDuplicateKey(group[0]);
        const first = group[0];
        const subject = app.subjectById(first.subjectId);
        const bank = app.bankById(first.bankId);
        const location = [subject?.name, bank?.name].filter(Boolean).join(' / ') || '未分类';
        return `
          <article class="duplicate-group-item">
            <div class="duplicate-group-copy">
              <span>重复组 ${index + 1}</span>
              <b>${escapeHTML(String(first.stem || '').replace(/\s+/g, ' '))}</b>
              <small>${group.length} 道 · ${escapeHTML(location)}</small>
            </div>
            <button type="button" class="btn subtle" data-action="ignore-duplicate-group"
              data-key="${escapeHTML(key)}">忽略提醒，保留在题库</button>
          </article>
        `;
      })
      .join('');

    return `
      <section class="panel duplicate-manager">
        <header class="duplicate-manager-head">
          <div>
            <h2>重复题处理</h2>
            <p>选择“忽略提醒”后，重复题仍保留在题库中，可以继续查看、练习和抽题。</p>
          </div>
          <span class="duplicate-manager-count">${issues.duplicateGroupCount} 组待处理</span>
        </header>
        ${
          items
            ? `<div class="duplicate-manager-list">${items}</div>`
            : '<p class="duplicate-manager-empty">当前没有待处理的重复组；已忽略的重复题仍保留在题库中。</p>'
        }
        ${
          issues.ignoredDuplicateGroupCount
            ? `<div class="duplicate-ignored-note">
                ${icon('info', 13)}
                <span>已忽略 ${issues.ignoredDuplicateGroupCount} 组，共 ${issues.ignoredDuplicateQuestionCount} 道题仍在题库中，可正常练习。</span>
                <div class="duplicate-ignored-actions">
                  <button type="button" class="text-button" data-action="view-ignored-duplicates">在全部题库中查看</button>
                  <button type="button" class="text-button" data-action="restore-duplicate-ignores">恢复重复提醒</button>
                </div>
              </div>`
            : ''
        }
      </section>
    `;
  }

  function selectionBarHTML(selectedCount, total) {
    const allSelected = total > 0 && selectedCount === total;
    return `
      <div class="library-selection-bar" data-selection-bar>
        <label class="selection-all">
          <input type="checkbox" data-select-all ${allSelected ? 'checked' : ''}>
          <span>全选当前结果</span>
        </label>
        <span class="selection-count" data-selection-count>已选 ${selectedCount} 道</span>
        <div class="selection-actions">
          <button type="button" class="btn subtle" data-action="bulk-edit" ${selectedCount ? '' : 'disabled'}>
            ${icon('edit', 14)} 批量编辑
          </button>
          <button type="button" class="btn danger-ghost" data-action="bulk-delete" ${selectedCount ? '' : 'disabled'}>
            ${icon('trash', 14)} 删除选中
          </button>
        </div>
      </div>
    `;
  }

  function updateSelectionUi() {
    if (!rootRef) return;
    const selected = viewState.selectedIds;
    rootRef.querySelectorAll('[data-select-question]').forEach((checkbox) => {
      checkbox.checked = selected.has(checkbox.dataset.selectQuestion);
      checkbox.closest('.question-row')?.classList.toggle('is-selected', checkbox.checked);
    });
    const countNode = rootRef.querySelector('[data-selection-count]');
    if (countNode) countNode.textContent = `已选 ${selected.size} 道`;
    const selectAll = rootRef.querySelector('[data-select-all]');
    if (selectAll) {
      selectAll.checked = viewState.filteredIds.length > 0 && selected.size === viewState.filteredIds.length;
      selectAll.indeterminate = selected.size > 0 && selected.size < viewState.filteredIds.length;
    }
    rootRef.querySelectorAll('[data-action="bulk-edit"], [data-action="bulk-delete"]').forEach((button) => {
      button.disabled = selected.size === 0;
    });
  }

  function renderList() {
    if (!rootRef) return;
    const list = rootRef.querySelector('[data-library-list]');
    const footer = rootRef.querySelector('[data-list-footer]');
    const summary = rootRef.querySelector('[data-list-summary]');
    if (!list || !footer) return;

    const filtered = applyFilter(scopedQuestions());
    const visible = filtered.slice(0, viewState.limit);
    const duplicatePanel = viewState.filter === 'duplicates' ? duplicateManagerHTML() : '';
    const filteredIds = filtered.map((question) => question.id);
    const filteredIdSet = new Set(filteredIds);
    viewState.filteredIds = filteredIds;
    viewState.selectedIds = new Set(
      [...viewState.selectedIds].filter((id) => filteredIdSet.has(id)),
    );
    const selectionBar =
      filtered.length > 0
        ? selectionBarHTML(viewState.selectedIds.size, filtered.length)
        : '';

    if (!filtered.length) {
      list.innerHTML = `
        ${duplicatePanel}
        <div class="library-empty filtered-empty">
          <span class="empty-illustration">${icon('search', 28)}</span>
          <h2>没有符合条件的题目</h2>
          <p>换一个筛选条件，或者清空搜索词再试试。</p>
          <button type="button" class="btn subtle" data-action="clear-filters">${icon('rotate', 15)} 清除筛选</button>
        </div>
      `;
    } else {
      const subjectsById = new Map(app.state.subjects.map((subject) => [subject.id, subject.name]));
      const bankNames = new Map(
        app.state.banks.map((bank) => [
          bank.id,
          subjectsById.get(bank.subjectId)
            ? `${subjectsById.get(bank.subjectId)} / ${bank.name}`
            : bank.name,
        ]),
      );
      list.innerHTML = `${duplicatePanel}${selectionBar}${visible
        .map((question, index) =>
          questionRowHTML(
            question,
            index,
            bankNames.get(question.bankId),
            viewState.selectedIds.has(question.id),
          ),
        )
        .join('')}`;
    }

    footer.innerHTML =
      filtered.length > viewState.limit
        ? `<button type="button" class="btn subtle" data-action="load-more">
            再显示 ${Math.min(60, filtered.length - viewState.limit)} 道 ${icon('chevron-down', 15)}
          </button>`
        : '';

    if (summary) {
      summary.textContent = filtered.length
        ? `${currentScopeLabel()} · 显示 ${visible.length} / ${filtered.length} 道`
        : `${currentScopeLabel()} · 没有匹配结果`;
    }
    updateFilterCounts();
    updateFilterActive();
    updateSelectionUi();
  }

  function renderPage(root, options = {}) {
    if (options.filter && FILTERS.some((filter) => filter.key === options.filter)) {
      viewState.filter = options.filter;
      viewState.limit = 60;
    }
    if (typeof options.subjectId === 'string') {
      viewState.subjectId = app.subjectById(options.subjectId) ? options.subjectId : '';
      viewState.bankId = '';
    }
    if (typeof options.bankId === 'string') {
      const bank = app.bankById(options.bankId);
      viewState.bankId = bank ? bank.id : '';
      if (bank) viewState.subjectId = bank.subjectId;
    }
    if (!viewState.subjectId) viewState.bankId = '';
    if (viewState.bankId) {
      const bank = app.bankById(viewState.bankId);
      if (!bank) viewState.bankId = '';
      else viewState.subjectId = bank.subjectId;
    }

    if (rootRef?.isConnected) {
      const currentScroll = rootRef.querySelector('[data-taxonomy-scroll]');
      if (currentScroll) viewState.taxonomyScroll = currentScroll.scrollTop;
    }

    controller?.abort();
    controller = new AbortController();
    rootRef = root;
    const state = app.state;
    const stats = getStats(state);
    const issues = getLibraryIssues(state.questions, {
      ignoredDuplicateKeys: state.duplicateIgnores || [],
    });
    const counts = countStatusLabel();
    const hasQuestions = state.questions.length > 0;
    const hasSubjects = state.subjects.length > 0;
    const hasBanks = state.banks.length > 0;

    root.innerHTML = `
      <div class="page library-page">
        <header class="page-header">
          <div class="page-heading">
            <p class="eyebrow">LIBRARY · 我的题库</p>
            <h1>我的题库</h1>
            <p class="page-sub">${state.subjects.length} 个科目 · ${state.banks.length} 个子题库 · 共 ${stats.total} 道题，${stats.answerable} 道可练${
              issues.missingCount ? `；${issues.missingCount} 道缺答案` : ''
            }${
              issues.answerIssueCount ? `，${issues.answerIssueCount} 道答案异常` : ''
            }。</p>
          </div>
          <div class="header-actions">
            <button type="button" class="btn ghost" data-action="ai-inspect">${icon('sparkles', 16)} AI 巡检</button>
            ${
              OFFLINE_MODE
                ? `<button type="button" class="btn ghost" data-action="offline-guide">${icon('list', 16)} 配置向导</button>`
                : `<button type="button" class="btn ghost" data-action="share-library">${icon('tablet', 16)} 分享给平板</button>`
            }
            <button type="button" class="btn ghost" data-action="import-library">${icon('database', 16)} 导入题库</button>
            <button type="button" class="btn ghost" data-action="export-library">${icon('download', 16)} 导出题库</button>
            <button type="button" class="btn ghost" data-action="manual">${icon('edit', 16)} 手动录入</button>
            <button type="button" class="btn subtle" data-action="import">${icon('image', 16)} 导入图片</button>
            <button type="button" class="btn primary" data-action="new-subject">${icon('plus', 17)} 新建科目</button>
          </div>
        </header>

        ${taxonomyHTML()}

        ${
          hasQuestions
            ? `
              <section class="library-toolbar panel">
                <div class="library-toolbar-top">
                  <label class="search-box">
                    ${icon('search', 18)}
                    <input type="search" data-role="search" placeholder="搜索题干、选项或答案…"
                      aria-label="搜索题目" value="${escapeHTML(viewState.search)}" autocomplete="off" spellcheck="false">
                    <kbd>搜</kbd>
                  </label>
                  <div class="library-selects">
                    <label class="select-wrap">
                      <select data-role="subject-filter" aria-label="按科目筛选">
                        ${subjectFilterOptionsHTML()}
                      </select>
                      ${icon('chevron-down', 14)}
                    </label>
                    <label class="select-wrap">
                      <select data-role="bank-filter" aria-label="按子题库筛选" ${viewState.subjectId ? '' : 'disabled'}>
                        ${bankFilterOptionsHTML()}
                      </select>
                      ${icon('chevron-down', 14)}
                    </label>
                    <label class="select-wrap">
                      <select data-role="type-filter" aria-label="按题型筛选">
                        <option value="all" ${viewState.type === 'all' ? 'selected' : ''}>全部题型</option>
                        ${Object.entries(QUESTION_TYPES)
                          .map(([value, label]) => `<option value="${value}" ${viewState.type === value ? 'selected' : ''}>${label}</option>`)
                          .join('')}
                      </select>
                      ${icon('chevron-down', 14)}
                    </label>
                    <label class="select-wrap">
                      <select data-role="sort" aria-label="排序方式">
                        <option value="newest" ${viewState.sort === 'newest' ? 'selected' : ''}>最近添加</option>
                        <option value="practice" ${viewState.sort === 'practice' ? 'selected' : ''}>练习最多</option>
                        <option value="wrong" ${viewState.sort === 'wrong' ? 'selected' : ''}>错误最多</option>
                        <option value="accuracy" ${viewState.sort === 'accuracy' ? 'selected' : ''}>正确率最低</option>
                      </select>
                      ${icon('chevron-down', 14)}
                    </label>
                  </div>
                </div>
                <div class="filter-row">
                  <div class="filter-chips">
                    ${FILTERS.map(
                      (filter) => `
                        <button type="button" class="filter-chip ${viewState.filter === filter.key ? 'is-active' : ''}"
                          data-filter="${filter.key}" aria-pressed="${viewState.filter === filter.key}">
                          ${filter.label} <b>${counts[filter.key]}</b>
                        </button>
                      `,
                    ).join('')}
                  </div>
                  <span class="list-summary" data-list-summary></span>
                </div>
              </section>
              <section class="library-list" data-library-list></section>
              <div class="list-footer" data-list-footer></div>
            `
            : `
              <section class="library-empty panel">
                <div class="empty-stack" aria-hidden="true">
                  <span class="empty-sheet back"></span>
                  <span class="empty-sheet front">${icon(hasSubjects ? 'file-text' : 'book', 28)}</span>
                  <span class="empty-check">${icon(hasSubjects ? 'check' : 'plus', 16)}</span>
                </div>
                <h2>${hasSubjects ? '科目已建好，下一步导入题目' : '先创建第一个科目'}</h2>
                <p>${
                  hasSubjects
                    ? hasBanks
                      ? '把图片导入到对应的子题库，识别校对后就能分类练习。'
                      : '这个科目还没有子题库，先建一个子题库再导入题目。'
                    : '你的题库按「科目 → 子题库」组织。创建科目后，再在科目下创建子题库。'
                }</p>
                <div class="empty-actions">
                  ${
                    hasSubjects
                      ? hasBanks
                        ? `<button type="button" class="btn primary" data-action="import">${icon('image', 16)} 导入题目</button>
                           <button type="button" class="btn subtle" data-action="manual">${icon('edit', 16)} 手动录入</button>`
                        : `<button type="button" class="btn primary" data-action="new-bank"
                             data-subject-id="${escapeHTML(state.subjects[0].id)}">${icon('plus', 16)} 创建子题库</button>`
                      : `<button type="button" class="btn primary" data-action="new-subject">${icon('plus', 16)} 新建科目</button>`
                  }
                </div>
              </section>
            `
        }
      </div>
    `;

    const taxonomyScroll = root.querySelector('[data-taxonomy-scroll]');
    if (taxonomyScroll) taxonomyScroll.scrollTop = viewState.taxonomyScroll;

    if (hasQuestions) renderList();
    bind(root);
  }

  function clearBankDragState(root) {
    draggedBank = null;
    root.querySelectorAll('.bank-row.is-dragging, .bank-row.is-drop-before, .bank-row.is-drop-after').forEach(
      (row) => row.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after'),
    );
  }

  function exportLibraryDialog() {
    const groups = app.state.subjects
      .map((subject) => {
        const banks = app.banksForSubject(subject.id).map((bank) => ({
          bank,
          count: app.state.questions.filter((question) => question.bankId === bank.id).length,
        }));
        return {
          subject,
          banks,
          questionCount: banks.reduce((sum, item) => sum + item.count, 0),
        };
      })
      .filter((group) => group.banks.length);

    if (!groups.length) {
      toast('还没有可以导出的子题库。', 'info');
      return;
    }
    if (!groups.some((group) => group.questionCount > 0)) {
      toast('题库中还没有题目，暂时无法导出。', 'info');
      return;
    }

    openDialog({
      title: '导出题库',
      eyebrow: 'EXPORT LIBRARY',
      description: '选择要包含的科目或子题库，全部内容会合并导出为一个 JSON 文件。',
      size: 'md',
      content: `
        <div class="library-export">
          <div class="library-export-head">
            <div>
              <h3>选择要导出的题库</h3>
              <p>导出后可在「导入题库」中选择这个文件，合并到当前题库。</p>
            </div>
            <div class="library-export-bulk">
              <button type="button" class="btn ghost" data-export-all>全选</button>
              <button type="button" class="btn ghost" data-export-none>清空</button>
            </div>
          </div>
          <div class="library-export-list">
            ${groups
              .map(
                ({ subject, banks, questionCount }) => `
                  <section class="library-export-group">
                    <label class="library-export-subject">
                      <input type="checkbox" data-export-subject="${escapeHTML(subject.id)}" checked>
                      <span>
                        <b>${escapeHTML(subject.name)}</b>
                        <small>${banks.length} 个子题库 · ${questionCount} 道题</small>
                      </span>
                    </label>
                    <div class="library-export-banks">
                      ${banks
                        .map(
                          ({ bank, count }) => `
                            <label class="library-export-bank">
                              <input type="checkbox" data-export-bank="${escapeHTML(bank.id)}"
                                data-subject-id="${escapeHTML(subject.id)}" data-question-count="${count}" checked>
                              <span>${escapeHTML(bank.name)}</span>
                              <small>${count} 道题</small>
                            </label>
                          `,
                        )
                        .join('')}
                    </div>
                  </section>
                `,
              )
              .join('')}
          </div>
          <p class="library-export-summary" data-export-summary></p>
          <p class="library-export-note">
            ${icon('info', 14)}
            题目、答案、解析、收藏和每道题的练习统计会随文件保存；每日学习历史和正确率折线不包含在题库文件中。
          </p>
        </div>
      `,
      footer: `
        <button type="button" class="btn subtle" data-export-cancel>取消</button>
        <button type="button" class="btn primary" data-export-confirm>${icon('download', 15)} 导出为一个文件</button>
      `,
      onMount: ({ dialog, close }) => {
        const bankInputs = [...dialog.querySelectorAll('[data-export-bank]')];
        const subjectInputs = [...dialog.querySelectorAll('[data-export-subject]')];
        const summary = dialog.querySelector('[data-export-summary]');
        const confirmButton = dialog.querySelector('[data-export-confirm]');

        const refresh = () => {
          let bankCount = 0;
          let questionCount = 0;
          const subjectIds = new Set();
          for (const input of bankInputs) {
            if (!input.checked) continue;
            bankCount += 1;
            questionCount += Number(input.dataset.questionCount) || 0;
            subjectIds.add(input.dataset.subjectId);
          }
          for (const input of subjectInputs) {
            const group = bankInputs.filter(
              (bankInput) => bankInput.dataset.subjectId === input.dataset.exportSubject,
            );
            const checked = group.filter((bankInput) => bankInput.checked).length;
            input.checked = checked > 0 && checked === group.length;
            input.indeterminate = checked > 0 && checked < group.length;
          }
          if (summary) {
            summary.textContent = `已选 ${subjectIds.size} 个科目 · ${bankCount} 个子题库 · ${questionCount} 道题`;
          }
          if (confirmButton) {
            confirmButton.disabled = questionCount === 0;
            confirmButton.innerHTML =
              questionCount === 0
                ? '没有可导出的题目'
                : `${icon('download', 15)} 导出为一个文件 · ${questionCount} 道题`;
          }
        };

        dialog.querySelector('[data-export-all]')?.addEventListener('click', () => {
          bankInputs.forEach((input) => {
            input.checked = true;
          });
          refresh();
        });
        dialog.querySelector('[data-export-none]')?.addEventListener('click', () => {
          bankInputs.forEach((input) => {
            input.checked = false;
          });
          refresh();
        });
        subjectInputs.forEach((input) => {
          input.addEventListener('change', () => {
            bankInputs
              .filter((bankInput) => bankInput.dataset.subjectId === input.dataset.exportSubject)
              .forEach((bankInput) => {
                bankInput.checked = input.checked;
              });
            refresh();
          });
        });
        bankInputs.forEach((input) => input.addEventListener('change', refresh));

        dialog.querySelector('[data-export-cancel]')?.addEventListener('click', close);
        confirmButton?.addEventListener('click', () => {
          const bankIds = bankInputs
            .filter((input) => input.checked)
            .map((input) => input.dataset.exportBank);
          const payload = exportLibraryPackage(app.state, { bankIds });
          if (!payload.questions.length) {
            toast('所选题库中没有可导出的题目。', 'info');
            return;
          }
          downloadJSON(payload, `刷题助手题库-${localDateKey()}.json`);
          close();
          toast(
            `已导出 ${payload.subjects.length} 个科目、${payload.banks.length} 个子题库、${payload.questions.length} 道题。`,
            'success',
            5000,
          );
        });
        refresh();
      },
    });
  }

  function importLibraryDialog(root) {
    let busy = false;
    let statusNode = null;
    let actionButtons = [];

    const setStatus = (message, tone = '') => {
      if (!statusNode) return;
      statusNode.textContent = message;
      statusNode.className = `library-import-status ${tone ? `is-${tone}` : ''}`.trim();
    };

    const setBusy = (value) => {
      busy = value;
      actionButtons.forEach((button) => {
        button.disabled = value;
      });
    };

    const applyPayload = async (payload) => {
      setBusy(true);
      setStatus('正在合并到本地题库…', 'pending');
      try {
        const result = importBackup(app.state, payload);
        app.persist();
        const parts = [`新增 ${result.added} 道题`];
        if (result.skipped) parts.push(`合并 ${result.skipped} 道重复题`);
        if (result.subjectsAdded) parts.push(`新增 ${result.subjectsAdded} 个科目`);
        if (result.banksAdded) parts.push(`新增 ${result.banksAdded} 个子题库`);
        control.close();
        renderPage(root);
        toast(`导入完成：${parts.join('，')}。`, result.added ? 'success' : 'info', 5000);
        const synced = await app.syncLibrary({ notify: false });
        if (!synced.ok) {
          toast(
            `导入内容已保留在当前浏览器，但写入 Markdown 失败：${
              synced.error?.message || '未知错误'
            }`,
            'error',
            6000,
          );
        }
      } catch (error) {
        setBusy(false);
        setStatus(error.message || '导入失败，请检查文件格式。', 'error');
        toast(`导入失败：${error.message || '文件格式不正确'}`, 'error', 4200);
      }
    };

    const importMarkdownFiles = async (fileList) => {
      if (busy) return;
      const allFiles = [...(fileList || [])];
      const files = allFiles.filter((file) => file.name.toLowerCase().endsWith('.md'));
      if (!files.length) {
        setStatus('请选择 .md 格式的 Markdown 题库文件。', 'error');
        return;
      }
      if (files.length > 500) {
        setStatus('一次最多导入 500 个 Markdown 文件，请分批导入。', 'error');
        return;
      }
      const totalSize = files.reduce((sum, file) => sum + file.size, 0);
      if (totalSize > 20 * 1024 * 1024) {
        setStatus('Markdown 文件总大小不能超过 20MB，请分批导入。', 'error');
        return;
      }

      setBusy(true);
      setStatus(`正在解析 ${files.length} 个 Markdown 文件…`, 'pending');
      try {
        const entries = [];
        for (const file of files) {
          entries.push({
            path: file.webkitRelativePath || file.name,
            text: await file.text(),
          });
        }
        const response = await parseMarkdownBanks(entries);
        const payload = parsedBanksToPayload(response.banks);
        if (!payload.questions.length) throw new Error('Markdown 中没有可导入的题目。');
        await applyPayload(payload);
      } catch (error) {
        setBusy(false);
        setStatus(error.message || 'Markdown 解析失败。', 'error');
        toast(`导入失败：${error.message || '文件格式不正确'}`, 'error', 4200);
      }
    };

    const importJsonFile = async (file) => {
      if (busy || !file) return;
      if (file.size > 20 * 1024 * 1024) {
        setStatus('JSON 题库文件不能超过 20MB。', 'error');
        return;
      }
      setBusy(true);
      setStatus('正在读取 JSON 题库文件…', 'pending');
      try {
        const payload = JSON.parse(await file.text());
        await applyPayload(payload);
      } catch (error) {
        setBusy(false);
        setStatus(error.message || 'JSON 文件格式不正确。', 'error');
        toast(`导入失败：${error.message || '文件格式不正确'}`, 'error', 4200);
      }
    };

    const importAnyFiles = (fileList) => {
      if (busy) return;
      const files = [...(fileList || [])];
      if (!files.length) return;
      const jsonFiles = files.filter((file) => file.name.toLowerCase().endsWith('.json'));
      if (OFFLINE_MODE) {
        if (jsonFiles.length !== 1 || files.length !== 1) {
          setStatus('离线版一次只能导入一个由电脑端导出的 .json 题库文件。', 'error');
          return;
        }
        importJsonFile(jsonFiles[0]);
        return;
      }
      if (jsonFiles.length) {
        if (files.length > 1) {
          setStatus('JSON 题库文件一次只能选择一个；多个 Markdown 文件请单独选择。', 'error');
          return;
        }
        importJsonFile(jsonFiles[0]);
        return;
      }
      importMarkdownFiles(files);
    };

    const control = openDialog({
      title: '导入题库',
      eyebrow: 'IMPORT LIBRARY',
      description: OFFLINE_MODE
        ? '选择电脑端「导出题库」生成的单个 JSON 文件；内容会合并到平板上的离线题库。'
        : '选择一个 JSON 题库文件，或选择一个/多个 Markdown 文件；内容会合并进现有题库，不会覆盖已有题目。',
      size: 'md',
      content: `
        <div class="library-import">
          <section class="library-import-card">
            <span class="library-import-icon">${icon('upload', 20)}</span>
            <div>
              <h3>选择本地题库文件</h3>
              <p>${
                OFFLINE_MODE
                  ? '在电脑端打开「我的题库 → 导出题库」，勾选需要的科目或子题库并导出为一个 JSON 文件，然后在这里选择它。'
                  : '推荐使用「导出题库」生成的单个 .json 文件，也可以选择刷题助手生成的 .md 文件。JSON 会保留每道题的练习统计，Markdown 只包含题目内容。'
              }</p>
              <div class="library-import-actions">
                <button type="button" class="btn primary" data-import-action data-import-any-button>
                  ${icon('upload', 15)} ${OFFLINE_MODE ? '选择 .json 文件' : '选择 .json / .md 文件'}
                </button>
                ${
                  OFFLINE_MODE
                    ? ''
                    : `<button type="button" class="btn subtle" data-import-action data-import-folder-button>
                         ${icon('folder', 15)} 选择题库文件夹
                       </button>`
                }
              </div>
              <input type="file" hidden ${OFFLINE_MODE ? '' : 'multiple'} accept="${OFFLINE_MODE ? '.json,application/json' : '.json,.md,application/json,text/markdown'}" data-import-md-files>
              ${OFFLINE_MODE ? '' : '<input type="file" hidden multiple webkitdirectory directory data-import-md-folder>'}
            </div>
          </section>
          <p class="library-import-status" data-import-status role="status"></p>
        </div>
      `,
      footer: '<button type="button" class="btn subtle" data-import-close>关闭</button>',
      onMount: ({ dialog, close }) => {
        statusNode = dialog.querySelector('[data-import-status]');
        actionButtons = [...dialog.querySelectorAll('[data-import-action]')];
        const anyInput = dialog.querySelector('[data-import-md-files]');
        const folderInput = dialog.querySelector('[data-import-md-folder]');

        dialog.querySelector('[data-import-any-button]')?.addEventListener('click', () => {
          if (!busy) anyInput?.click();
        });
        dialog.querySelector('[data-import-folder-button]')?.addEventListener('click', () => {
          if (!busy) folderInput?.click();
        });
        anyInput?.addEventListener('change', () => {
          const files = [...(anyInput.files || [])];
          anyInput.value = '';
          importAnyFiles(files);
        });
        folderInput?.addEventListener('change', () => {
          const files = [...(folderInput.files || [])];
          folderInput.value = '';
          importMarkdownFiles(files);
        });
        dialog.querySelector('[data-import-close]')?.addEventListener('click', close);
      },
    });
  }

  function bulkEditDialog(root) {
    const ids = [...viewState.selectedIds];
    const selectedQuestions = app.state.questions.filter((question) => ids.includes(question.id));
    if (!selectedQuestions.length) return;
    const first = selectedQuestions[0];
    const initialSubject =
      app.subjectById(viewState.subjectId) ||
      app.subjectById(first.subjectId) ||
      app.state.subjects[0] ||
      null;
    const subjectId = initialSubject?.id || '';
    const samePlacement =
      first &&
      selectedQuestions.every(
        (question) => question.subjectId === first.subjectId && question.bankId === first.bankId,
      );
    let bankId =
      viewState.bankId && app.bankById(viewState.bankId)?.subjectId === subjectId
        ? viewState.bankId
        : samePlacement && first.subjectId === subjectId
          ? first.bankId
          : '';
    if (!app.banksForSubject(subjectId).some((bank) => bank.id === bankId)) {
      bankId = app.banksForSubject(subjectId)[0]?.id || '';
    }

    const subjectOptionsHTML = (selectedId) =>
      app.state.subjects
        .map(
          (subject) =>
            `<option value="${escapeHTML(subject.id)}" ${
              subject.id === selectedId ? 'selected' : ''
            }>${escapeHTML(subject.name)}</option>`,
        )
        .join('');
    const bankOptionsHTML = (selectedId) =>
      app.banksForSubject(subjectId)
        .map(
          (bank) =>
            `<option value="${escapeHTML(bank.id)}" ${
              bank.id === selectedId ? 'selected' : ''
            }>${escapeHTML(bank.name)}</option>`,
        )
        .join('');

    openDialog({
      title: `批量编辑 ${selectedQuestions.length} 道题`,
      eyebrow: 'BULK EDIT',
      description: '统一调整所属科目、子题库和收藏状态；题干、选项和答案不会被改动。',
      size: 'sm',
      content: `
        <div class="bulk-edit">
          <p class="bulk-edit-note">已选择 ${selectedQuestions.length} 道题。单题内容请使用题目右侧的编辑按钮。</p>
          <div class="bulk-edit-fields">
            <label class="bulk-edit-field">
              <span>所属科目</span>
              <div class="select-wrap">
                <select data-bulk-subject>${subjectOptionsHTML(subjectId)}</select>
                ${icon('chevron-down', 14)}
              </div>
            </label>
            <label class="bulk-edit-field">
              <span>子题库</span>
              <div class="select-wrap">
                <select data-bulk-bank ${app.banksForSubject(subjectId).length ? '' : 'disabled'}>
                  ${bankOptionsHTML(bankId) || '<option value="">该科目还没有子题库</option>'}
                </select>
                ${icon('chevron-down', 14)}
              </div>
            </label>
            <label class="bulk-edit-field">
              <span>收藏状态</span>
              <div class="select-wrap">
                <select data-bulk-favorite>
                  <option value="keep">不修改</option>
                  <option value="favorite">设为收藏</option>
                  <option value="unfavorite">取消收藏</option>
                </select>
                ${icon('chevron-down', 14)}
              </div>
            </label>
          </div>
        </div>
      `,
      footer: `
        <button type="button" class="btn subtle" data-bulk-cancel>取消</button>
        <button type="button" class="btn primary" data-bulk-save ${bankId ? '' : 'disabled'}>
          ${icon('check', 16)} 应用修改
        </button>
      `,
      onMount: ({ dialog, close }) => {
        const subjectSelect = dialog.querySelector('[data-bulk-subject]');
        const bankSelect = dialog.querySelector('[data-bulk-bank]');
        const favoriteSelect = dialog.querySelector('[data-bulk-favorite]');
        const saveButton = dialog.querySelector('[data-bulk-save]');
        let saving = false;

        subjectSelect?.addEventListener('change', () => {
          const nextBanks = app.banksForSubject(subjectSelect.value);
          if (bankSelect) {
            bankSelect.innerHTML =
              nextBanks
                .map(
                  (bank) =>
                    `<option value="${escapeHTML(bank.id)}">${escapeHTML(bank.name)}</option>`,
                )
                .join('') || '<option value="">该科目还没有子题库</option>';
            bankSelect.disabled = nextBanks.length === 0;
          }
          if (saveButton) saveButton.disabled = nextBanks.length === 0;
        });

        dialog.querySelector('[data-bulk-cancel]')?.addEventListener('click', close);
        saveButton?.addEventListener('click', async () => {
          if (saving) return;
          const targetSubjectId = subjectSelect?.value || '';
          const targetBankId = bankSelect?.value || '';
          if (!targetSubjectId || !targetBankId) {
            toast('请选择有效的科目和子题库。', 'error', 3400);
            return;
          }
          saving = true;
          saveButton.disabled = true;
          saveButton.textContent = '正在保存…';
          const changed = await app.bulkUpdateQuestions(ids, {
            subjectId: targetSubjectId,
            bankId: targetBankId,
            favoriteMode: favoriteSelect?.value || 'keep',
          });
          close();
          viewState.selectedIds.clear();
          renderPage(root);
          toast(
            changed ? `已批量更新 ${changed} 道题。` : '没有需要修改的题目。',
            changed ? 'success' : 'info',
            3200,
          );
        });
      },
    });
  }

  async function commitBankOrder(subjectId, orderedIds, root, focusBankId = '') {
    if (!subjectId || !Array.isArray(orderedIds)) return;
    await app.reorderBanks(subjectId, orderedIds);
    if (!root.isConnected) return;
    renderPage(root);
    if (focusBankId) {
      window.requestAnimationFrame(() => {
        const safeId =
          typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(focusBankId) : focusBankId;
        root
          .querySelector(`[data-bank-row="${safeId}"] [data-bank-drag-handle]`)
          ?.focus({ preventScroll: true });
      });
    }
  }

  function bind(root) {
    const { signal } = controller;

    root.addEventListener(
      'dragstart',
      (event) => {
        const handle = event.target.closest?.('[data-bank-drag-handle]');
        const row = handle?.closest('[data-bank-row]');
        if (!row) return;
        draggedBank = {
          id: row.dataset.bankId || '',
          subjectId: row.dataset.subjectId || '',
        };
        row.classList.add('is-dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', draggedBank.id);
          try {
            event.dataTransfer.setDragImage(row, 18, 18);
          } catch {
            // 某些浏览器不允许自定义拖动图像。
          }
        }
      },
      { signal },
    );

    root.addEventListener(
      'dragover',
      (event) => {
        if (!draggedBank) return;
        const row = event.target.closest?.('[data-bank-row]');
        if (
          !row ||
          row.dataset.bankId === draggedBank.id ||
          row.dataset.subjectId !== draggedBank.subjectId
        ) {
          return;
        }
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        root
          .querySelectorAll('.bank-row.is-drop-before, .bank-row.is-drop-after')
          .forEach((item) => item.classList.remove('is-drop-before', 'is-drop-after'));
        const rect = row.getBoundingClientRect();
        row.classList.add(
          event.clientY < rect.top + rect.height / 2 ? 'is-drop-before' : 'is-drop-after',
        );
      },
      { signal },
    );

    root.addEventListener(
      'dragleave',
      (event) => {
        const row = event.target.closest?.('[data-bank-row]');
        if (row && !row.contains(event.relatedTarget)) {
          row.classList.remove('is-drop-before', 'is-drop-after');
        }
      },
      { signal },
    );

    root.addEventListener(
      'drop',
      async (event) => {
        if (!draggedBank) return;
        const row = event.target.closest?.('[data-bank-row]');
        if (
          !row ||
          row.dataset.bankId === draggedBank.id ||
          row.dataset.subjectId !== draggedBank.subjectId
        ) {
          return;
        }
        event.preventDefault();
        const subjectId = draggedBank.subjectId;
        const sourceId = draggedBank.id;
        const targetId = row.dataset.bankId || '';
        const rect = row.getBoundingClientRect();
        const insertAfter = event.clientY >= rect.top + rect.height / 2;
        const banks = app.banksForSubject(subjectId);
        const orderedIds = banks.map((bank) => bank.id).filter((id) => id !== sourceId);
        const targetIndex = orderedIds.indexOf(targetId);
        if (targetIndex < 0) {
          clearBankDragState(root);
          return;
        }
        orderedIds.splice(targetIndex + (insertAfter ? 1 : 0), 0, sourceId);
        clearBankDragState(root);
        await commitBankOrder(subjectId, orderedIds, root, sourceId);
      },
      { signal },
    );

    root.addEventListener(
      'dragend',
      () => {
        clearBankDragState(root);
      },
      { signal },
    );

    root.addEventListener(
      'keydown',
      async (event) => {
        const handle = event.target.closest?.('[data-bank-drag-handle]');
        if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const row = handle.closest('[data-bank-row]');
        if (!row) return;
        const subjectId = row.dataset.subjectId || '';
        const bankId = row.dataset.bankId || '';
        const banks = app.banksForSubject(subjectId);
        const index = banks.findIndex((bank) => bank.id === bankId);
        const nextIndex = index + (event.key === 'ArrowUp' ? -1 : 1);
        if (index < 0 || nextIndex < 0 || nextIndex >= banks.length) return;
        const orderedIds = banks.map((bank) => bank.id);
        [orderedIds[index], orderedIds[nextIndex]] = [orderedIds[nextIndex], orderedIds[index]];
        await commitBankOrder(subjectId, orderedIds, root, bankId);
      },
      { signal },
    );

    root.addEventListener(
      'click',
      async (event) => {
        const filterButton = event.target.closest('[data-filter]');
        if (filterButton) {
          viewState.filter = filterButton.dataset.filter;
          viewState.limit = 60;
          renderList();
          return;
        }

        const actionElement = event.target.closest('[data-action]');
        if (!actionElement) return;
        const action = actionElement.dataset.action;
        const id = actionElement.dataset.id;

        if (action === 'import') {
          app.navigate('import', {
            subjectId: viewState.subjectId,
            bankId: viewState.bankId,
          });
          return;
        }
        if (action === 'manual') {
          app.openManualQuestion({
            subjectId: viewState.subjectId,
            bankId: viewState.bankId,
          });
          return;
        }
        if (action === 'data') {
          app.openDataDialog();
          return;
        }
        if (action === 'ai-inspect') {
          app.openContextAIAssistant();
          return;
        }
        if (action === 'import-library') {
          importLibraryDialog(root);
          return;
        }
        if (action === 'offline-guide') {
          app.openOfflineSetupGuide();
          return;
        }
        if (action === 'share-library') {
          app.openShareLibraryDialog();
          return;
        }
        if (action === 'export-library') {
          exportLibraryDialog();
          return;
        }
        if (action === 'new-subject') {
          const subject = await app.createSubject();
          if (subject) {
            viewState.subjectId = subject.id;
            viewState.bankId = '';
            viewState.limit = 60;
            renderPage(root);
          }
          return;
        }
        if (action === 'new-bank') {
          const subjectId = actionElement.dataset.subjectId || viewState.subjectId;
          const bank = await app.createBank(subjectId);
          if (bank) {
            viewState.subjectId = bank.subjectId;
            viewState.bankId = bank.id;
            viewState.limit = 60;
            renderPage(root);
          }
          return;
        }
        if (action === 'rename-subject') {
          if (await app.renameSubject(id)) renderPage(root);
          return;
        }
        if (action === 'delete-subject') {
          if (await app.deleteSubject(id)) {
            if (viewState.subjectId === id) {
              viewState.subjectId = '';
              viewState.bankId = '';
            }
            renderPage(root);
          }
          return;
        }
        if (action === 'rename-bank') {
          if (await app.renameBank(id)) renderPage(root);
          return;
        }
        if (action === 'delete-bank') {
          if (await app.deleteBank(id)) {
            if (viewState.bankId === id) viewState.bankId = '';
            renderPage(root);
          }
          return;
        }
        if (action === 'view-all') {
          viewState.subjectId = '';
          viewState.bankId = '';
          viewState.limit = 60;
          renderPage(root);
          return;
        }
        if (action === 'view-subject') {
          viewState.subjectId = actionElement.dataset.id || '';
          viewState.bankId = '';
          viewState.limit = 60;
          renderPage(root);
          return;
        }
        if (action === 'view-bank') {
          viewState.subjectId = actionElement.dataset.subjectId || '';
          viewState.bankId = actionElement.dataset.id || '';
          viewState.limit = 60;
          renderPage(root);
          return;
        }
        if (action === 'practice-all') {
          await app.navigate('practice', { subjectId: '', bankId: '' });
          return;
        }
        if (action === 'practice-subject') {
          await app.navigate('practice', { subjectId: actionElement.dataset.id || '', bankId: '' });
          return;
        }
        if (action === 'practice-bank') {
          await app.navigate('practice', {
            subjectId: actionElement.dataset.subjectId || '',
            bankId: actionElement.dataset.id || '',
          });
          return;
        }
        if (action === 'clear-filters') {
          viewState.filter = 'all';
          viewState.type = 'all';
          viewState.search = '';
          viewState.subjectId = '';
          viewState.bankId = '';
          viewState.limit = 60;
          renderPage(root);
          return;
        }
        if (action === 'load-more') {
          viewState.limit += 60;
          renderList();
          return;
        }
        if (action === 'bulk-edit') {
          bulkEditDialog(root);
          return;
        }
        if (action === 'bulk-delete') {
          const selectedIds = [...viewState.selectedIds].filter((questionId) =>
            app.state.questions.some((question) => question.id === questionId),
          );
          if (!selectedIds.length) return;
          const proceed = await confirmAction({
            title: `删除选中的 ${selectedIds.length} 道题？`,
            message: '这些题会从题库中移除，题目上的练习统计也会删除；此操作无法撤销。',
            confirmText: `删除 ${selectedIds.length} 道`,
            danger: true,
          });
          if (!proceed) return;
          const removed = app.deleteQuestions(selectedIds);
          viewState.selectedIds.clear();
          renderPage(root);
          toast(removed ? `已删除 ${removed} 道题。` : '没有题目被删除。', 'info', 3200);
          return;
        }
        if (action === 'ignore-duplicate-group') {
          if (app.ignoreDuplicateGroup(actionElement.dataset.key || '')) {
            renderList();
            toast('已忽略重复提醒，题目仍在题库中，可正常练习。', 'success', 3600);
          }
          return;
        }
        if (action === 'view-ignored-duplicates') {
          viewState.filter = 'all';
          viewState.type = 'all';
          viewState.search = '';
          viewState.limit = 60;
          renderPage(root);
          return;
        }
        if (action === 'restore-duplicate-ignores') {
          app.restoreDuplicateIgnores();
          renderList();
          toast('已恢复重复提醒。', 'info', 3000);
          return;
        }
        if (action === 'favorite') {
          app.toggleFavorite(id);
          renderList();
          return;
        }
        if (action === 'practice-one') {
          app.startPractice({ questionIds: [id] });
          return;
        }
        if (action === 'edit') {
          const question = app.state.questions.find((item) => item.id === id);
          if (question) app.openQuestionEditor(question);
          return;
        }
        if (action === 'delete') {
          const question = app.state.questions.find((item) => item.id === id);
          if (!question) return;
          const proceed = await confirmAction({
            title: '删除这道题？',
            message: `「${question.stem.slice(0, 48)}${question.stem.length > 48 ? '…' : ''}」将从题库中移除，练习记录也会一并删除。`,
            confirmText: '删除',
            danger: true,
          });
          if (!proceed) return;
          app.deleteQuestion(id);
          toast('题目已删除。', 'info');
          app.refreshCurrent();
        }
      },
      { signal },
    );

    root.addEventListener(
      'input',
      (event) => {
        if (event.target.matches('[data-role="search"]')) {
          viewState.search = event.target.value;
          viewState.limit = 60;
          renderList();
        }
      },
      { signal },
    );

    root.addEventListener(
      'change',
      (event) => {
        if (event.target.matches('[data-select-question]')) {
          const id = event.target.dataset.selectQuestion || '';
          if (event.target.checked) viewState.selectedIds.add(id);
          else viewState.selectedIds.delete(id);
          updateSelectionUi();
          return;
        }
        if (event.target.matches('[data-select-all]')) {
          viewState.selectedIds = event.target.checked
            ? new Set(viewState.filteredIds)
            : new Set();
          updateSelectionUi();
          return;
        }
        if (event.target.matches('[data-role="subject-filter"]')) {
          viewState.subjectId = event.target.value;
          viewState.bankId = '';
          viewState.limit = 60;
          renderPage(root);
        } else if (event.target.matches('[data-role="bank-filter"]')) {
          viewState.bankId = event.target.value;
          viewState.limit = 60;
          renderPage(root);
        } else if (event.target.matches('[data-role="type-filter"]')) {
          viewState.type = event.target.value;
          viewState.limit = 60;
          renderList();
        } else if (event.target.matches('[data-role="sort"]')) {
          viewState.sort = event.target.value;
          viewState.limit = 60;
          renderList();
        }
      },
      { signal },
    );
  }

  function getAssistantConfig() {
    const stats = getStats(app.state);
    const issues = getLibraryIssues(app.state.questions, {
      ignoredDuplicateKeys: app.state.duplicateIgnores || [],
    });
    const unmastered = app.state.questions.filter(
      (question) => isQuestionAnswerable(question) && !isMastered(question),
    ).length;
    const actions = [];
    if (issues.missingCount) actions.push('library_filter_missing');
    if (issues.duplicateQuestionCount) actions.push('library_filter_duplicates');
    if (issues.answerIssueCount) actions.push('library_filter_answer_issues');
    if (unmastered) actions.push('library_filter_unmastered');

    return {
      mode: 'library',
      contextLabel: `题库 · ${stats.total} 道题`,
      context: {
        page: 'library',
        total: stats.total,
        answerable: stats.answerable,
        missingAnswers: issues.missingCount,
        duplicateQuestionCount: issues.duplicateQuestionCount,
        duplicateGroupCount: issues.duplicateGroupCount,
        answerIssueCount: issues.answerIssueCount,
        unmastered,
        examples: {
          missing: issues.missing.slice(0, 4).map((question) => ({
            stem: question.stem.slice(0, 120),
          })),
          duplicates: issues.duplicateGroups.slice(0, 3).map((group) =>
            group.slice(0, 3).map((question) => question.stem.slice(0, 120)),
          ),
          answerIssues: issues.answerIssues.slice(0, 4).map(({ question, reason }) => ({
            stem: question.stem.slice(0, 120),
            reason,
          })),
        },
      },
      availableActions: actions,
    };
  }

  return { render: renderPage, getAssistantConfig };
}
