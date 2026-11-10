import {
  generateKnowledgeMap,
  getAIConfig,
  loadKnowledgeMap,
  saveKnowledgeMap,
} from '../api.js';
import {
  banksForSubject,
  isMastered,
  isQuestionAnswerable,
  localDateKey,
  questionAccuracy,
  questionFingerprint,
  QUESTION_TYPES,
  subjectById,
} from '../store.js';
import {
  confirmAction,
  downloadJSON,
  escapeHTML,
  icon,
  toast,
  typeClass,
} from '../ui.js';
import { OFFLINE_MODE } from '../runtime.js';
import { createMindMap } from '../knowledge-map.js';

const MAX_KNOWLEDGE_QUESTIONS = 300;
const MAX_KNOWLEDGE_CHARS = 40000;

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 内容指纹只包含题目内容，不包含练习统计和 updatedAt。 */
function fingerprintQuestions(questions) {
  const parts = questions.map((question) =>
    [
      question.id,
      question.type,
      question.stem,
      (question.options || []).map((option) => `${option.key}:${option.text}`).join('|'),
      question.answer,
      question.explanation,
    ].join('\u0001'),
  );
  parts.sort();
  return fnv1a(parts.join('\u0002'));
}

function summarizeQuestions(questions) {
  let attempts = 0;
  let correct = 0;
  let mastered = 0;
  let wrong = 0;
  let answerable = 0;
  for (const question of questions) {
    const stats = question.stats || {};
    attempts += stats.attempts || 0;
    correct += stats.correct || 0;
    if (isMastered(question)) mastered += 1;
    if (stats.lastResult === 'wrong') wrong += 1;
    if (isQuestionAnswerable(question)) answerable += 1;
  }
  return {
    total: questions.length,
    answerable,
    attempts,
    correct,
    accuracy: attempts > 0 ? Math.round((correct / attempts) * 100) : null,
    mastered,
    wrong,
  };
}

function toneFor(stats) {
  if (!stats.total || !stats.attempts) return 'none';
  if (stats.accuracy < 60) return 'bad';
  if (stats.accuracy < 80) return 'warn';
  return 'good';
}

function formatGeneratedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function countMappedQuestions(map, validQuestions) {
  const valid = new Set(validQuestions.map((question) => String(question.id)));
  const ids = new Set();
  for (const node of map?.nodes || []) {
    for (const id of node.questionIds || []) {
      const key = String(id);
      if (valid.has(key)) ids.add(key);
    }
  }
  return ids.size;
}

function questionsForBank(state, bankId) {
  return state.questions.filter((question) => question.bankId === bankId);
}

export function createKnowledgeView(app) {
  let rootEl = null;
  let controller = null;
  let activeBankId = '';
  let lastBankId = '';
  let mapData = null;
  let displayRoot = null;
  let loading = false;
  let loadError = '';
  let loadWarning = '';
  let generating = false;
  let generateError = '';
  let selectedNodeId = 'root';
  let currentFingerprint = '';
  let mindMap = null;
  let loadSeq = 0;
  let generationSeq = 0;
  let searchQuery = '';

  function bankQuestions(bankId) {
    return questionsForBank(app.state, bankId);
  }

  function getBank(bankId) {
    const bank = app.state.banks.find((item) => item.id === bankId) || null;
    const subject = bank ? subjectById(app.state, bank.subjectId) : null;
    return { bank, subject };
  }

  function bankGroups() {
    const groups = [];
    for (const subject of app.state.subjects) {
      const banks = banksForSubject(app.state, subject.id).filter(
        (bank) => bankQuestions(bank.id).length > 0,
      );
      if (banks.length) groups.push({ subject, banks });
    }
    return groups;
  }

  function defaultBankId(groups) {
    const ids = groups.flatMap((group) => group.banks.map((bank) => bank.id));
    if (activeBankId && ids.includes(activeBankId)) return activeBankId;
    if (lastBankId && ids.includes(lastBankId)) return lastBankId;
    const preferred = app.state.settings.lastBankId;
    if (preferred && ids.includes(preferred)) return preferred;
    return ids[0] || '';
  }

  function bankSelectHTML(groups, selectedId) {
    return groups
      .map(
        ({ subject, banks }) => `
          <optgroup label="${escapeHTML(subject.name)}">
            ${banks
              .map((bank) => {
                const count = bankQuestions(bank.id).length;
                return `<option value="${escapeHTML(bank.id)}" ${
                  bank.id === selectedId ? 'selected' : ''
                }>${escapeHTML(bank.name)} · ${count} 题</option>`;
              })
              .join('')}
          </optgroup>
        `,
      )
      .join('');
  }

  function buildDisplayTree(map, bank, subject) {
    const bankQuestionsList = bankQuestions(bank.id);
    const questionsById = new Map(bankQuestionsList.map((question) => [question.id, question]));
    const allowedIds = new Set(questionsById.keys());
    const nodes = new Map();

    for (const raw of Array.isArray(map?.nodes) ? map.nodes : []) {
      const id = String(raw?.id || '');
      if (!id || id === 'root' || id === 'unclassified' || nodes.has(id)) continue;
      const questionIds = [
        ...new Set(
          (Array.isArray(raw.questionIds) ? raw.questionIds : [])
            .map(String)
            .filter((questionId) => allowedIds.has(questionId)),
        ),
      ];
      nodes.set(id, {
        id,
        parentId: String(raw.parentId || 'root'),
        label: String(raw.label || '未命名知识点'),
        summary: String(raw.summary || ''),
        keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String) : [],
        questionIds,
        children: [],
        kind: 'point',
        isUnclassified: false,
      });
    }

    const root = {
      id: 'root',
      kind: 'root',
      label: bank.name,
      summary: map?.summary || '',
      keywords: [],
      questionIds: [],
      children: [],
      parentId: null,
      isUnclassified: false,
    };

    for (const node of nodes.values()) {
      const parent = nodes.get(node.parentId) || root;
      parent.children.push(node);
    }

    function enrich(node, depth = 0, path = new Set()) {
      if (path.has(node.id) || depth > 20) {
        const ownQuestions = node.questionIds
          .map((questionId) => questionsById.get(questionId))
          .filter(Boolean);
        const stats = summarizeQuestions(ownQuestions);
        Object.assign(node, {
          ownStats: stats,
          stats,
          questionCount: ownQuestions.length,
          ownCount: ownQuestions.length,
          tone: toneFor(stats),
          subtreeQuestionIds: [...node.questionIds],
          ownQuestionIds: [...node.questionIds],
        });
        return node;
      }
      const nextPath = new Set(path);
      nextPath.add(node.id);
      node.children = node.children.filter((child) => !nextPath.has(child.id));
      const childQuestionIds = [];
      for (const child of node.children) {
        enrich(child, depth + 1, nextPath);
        childQuestionIds.push(...child.subtreeQuestionIds);
      }
      const ownIds = [...new Set(node.questionIds)];
      const subtreeIds = [...new Set([...ownIds, ...childQuestionIds])];
      const ownQuestions = ownIds
        .map((questionId) => questionsById.get(questionId))
        .filter(Boolean);
      const subtreeQuestions = subtreeIds
        .map((questionId) => questionsById.get(questionId))
        .filter(Boolean);
      const ownStats = summarizeQuestions(ownQuestions);
      const stats = summarizeQuestions(subtreeQuestions);
      Object.assign(node, {
        ownStats,
        stats,
        questionCount: subtreeQuestions.length,
        ownCount: ownQuestions.length,
        tone: toneFor(stats),
        subtreeQuestionIds: subtreeIds,
        ownQuestionIds: ownIds,
      });
      return node;
    }

    enrich(root);

    const classified = new Set();
    const collectClassified = (node) => {
      for (const questionId of node.questionIds) classified.add(questionId);
      for (const child of node.children) collectClassified(child);
    };
    collectClassified(root);
    const unclassifiedIds = [...allowedIds].filter((questionId) => !classified.has(questionId));
    if (unclassifiedIds.length) {
      const unclassifiedQuestions = unclassifiedIds
        .map((questionId) => questionsById.get(questionId))
        .filter(Boolean);
      const stats = summarizeQuestions(unclassifiedQuestions);
      root.children.push({
        id: 'unclassified',
        parentId: 'root',
        kind: 'point',
        isUnclassified: true,
        label: '未归类题目',
        summary: 'AI 没有把这些题归入具体知识点，可以单独练习，或重新生成图谱。',
        keywords: [],
        questionIds: unclassifiedIds,
        children: [],
        ownStats: stats,
        stats,
        questionCount: unclassifiedQuestions.length,
        ownCount: unclassifiedQuestions.length,
        tone: toneFor(stats),
        subtreeQuestionIds: [...unclassifiedIds],
        ownQuestionIds: [...unclassifiedIds],
      });
    }

    const rootStats = summarizeQuestions(bankQuestionsList);
    Object.assign(root, {
      ownStats: rootStats,
      stats: rootStats,
      questionCount: bankQuestionsList.length,
      ownCount: bankQuestionsList.length,
      tone: toneFor(rootStats),
      subtreeQuestionIds: bankQuestionsList.map((question) => question.id),
      ownQuestionIds: bankQuestionsList.map((question) => question.id),
      rootSubtitle: `${bankQuestionsList.length} 道题 · 正确率 ${
        rootStats.accuracy == null ? '—' : `${rootStats.accuracy}%`
      }`,
      subjectLabel: subject?.name || '',
    });
    return root;
  }

  function prepareDisplay() {
    const { bank, subject } = getBank(activeBankId);
    if (!bank || !mapData) {
      displayRoot = null;
      return;
    }
    displayRoot = buildDisplayTree(mapData, bank, subject);
    currentFingerprint = fingerprintQuestions(bankQuestions(bank.id));
  }

  function renderOffline(root) {
    root.innerHTML = `
      <div class="page knowledge-page">
        <header class="page-header">
          <div class="page-heading">
            <p class="eyebrow">KNOWLEDGE MAP · AI 知识图谱</p>
            <h1>知识图谱</h1>
            <p class="page-sub">请先在电脑端生成并导出知识图谱，再到本设备的「知识树」页面导入。</p>
          </div>
        </header>
        <section class="panel kg-empty-panel">
          <span class="kg-state-icon">${icon('graph', 28)}</span>
          <h2>当前是离线模式</h2>
          <p>请在电脑端打开刷题助手，并在「AI 设置」中配置模型后使用知识图谱。</p>
        </section>
      </div>
    `;
  }

  function renderNoBanks(root) {
    root.innerHTML = `
      <div class="page knowledge-page">
        <header class="page-header">
          <div class="page-heading">
            <p class="eyebrow">KNOWLEDGE MAP · AI 知识图谱</p>
            <h1>把子题库，<br>画成一张知识地图。</h1>
            <p class="page-sub">准备好了题目之后，AI 可以把一个子题库归纳成树状知识点。</p>
          </div>
        </header>
        <section class="panel kg-empty-panel">
          <span class="kg-state-icon">${icon('graph', 28)}</span>
          <h2>还没有可生成图谱的子题库</h2>
          <p>先在「导入题目」或「我的题库」中准备至少一个有题目的子题库。</p>
          <div class="kg-state-actions">
            <button type="button" class="btn primary" data-kg-go-import>${icon('image', 16)} 去导入题目</button>
            <button type="button" class="btn subtle" data-kg-go-library>${icon('book', 16)} 打开我的题库</button>
          </div>
        </section>
      </div>
    `;
    root.addEventListener(
      'click',
      (event) => {
        if (event.target.closest('[data-kg-go-import]')) {
          app.navigate('import');
          return;
        }
        if (event.target.closest('[data-kg-go-library]')) {
          app.navigate('library');
        }
      },
      { signal: controller.signal },
    );
  }

  function shellHTML(groups, selectedId) {
    return `
      <div class="page knowledge-page">
        <header class="page-header">
          <div class="page-heading">
            <p class="eyebrow">KNOWLEDGE MAP · AI 知识图谱</p>
            <h1>把子题库，<br>画成一张知识地图。</h1>
            <p class="page-sub">AI 只读取题干和解析，把当前子题库归纳成树状思维导图。结果以 JSON 保存到「题库保存」目录，刷题后掌握度会实时更新。</p>
          </div>
          <div class="header-actions">
            <button type="button" class="btn subtle" data-kg-export disabled>
              ${icon('download', 16)} 导出知识图谱
            </button>
            <button type="button" class="btn primary" data-kg-generate>
              ${icon('sparkles', 16)} <span data-kg-generate-label>AI 生成图谱</span>
            </button>
          </div>
        </header>

        <section class="panel kg-toolbar-panel">
          <div class="kg-toolbar">
            <label class="kg-scope">
              <span class="kg-scope-copy">
                <strong>子题库</strong>
                <small>每次只为当前子题库生成</small>
              </span>
              <span class="select-wrap kg-select-wrap">
                <select data-kg-bank aria-label="选择子题库">
                  ${bankSelectHTML(groups, selectedId)}
                </select>
                ${icon('chevron-down', 14)}
              </span>
            </label>
            <div class="kg-legend" aria-label="掌握度图例">
              <span class="kg-legend-item"><i class="kg-dot tone-none"></i>未练习</span>
              <span class="kg-legend-item"><i class="kg-dot tone-bad"></i>薄弱</span>
              <span class="kg-legend-item"><i class="kg-dot tone-warn"></i>一般</span>
              <span class="kg-legend-item"><i class="kg-dot tone-good"></i>掌握</span>
            </div>
          </div>
          <div class="kg-meta" data-kg-meta></div>
          <div class="kg-banner" data-kg-banner hidden></div>
        </section>

        <div class="kg-workspace">
          <section class="panel kg-map-panel">
            <div class="kg-map-tools">
              <div class="kg-map-title">
                <span class="eyebrow">MIND MAP</span>
                <strong data-kg-map-title>知识图谱</strong>
              </div>
              <div class="kg-map-controls">
                <label class="kg-search">
                  ${icon('search', 15)}
                  <input type="search" data-kg-search placeholder="搜索知识点…" aria-label="搜索知识点" autocomplete="off" disabled>
                </label>
                <div class="kg-zoom" role="group" aria-label="缩放">
                  <button type="button" class="kg-zoom-btn" data-kg-zoom="out" aria-label="缩小" disabled>−</button>
                  <button type="button" class="kg-zoom-btn is-text" data-kg-zoom="fit" disabled>适应</button>
                  <button type="button" class="kg-zoom-btn" data-kg-zoom="in" aria-label="放大" disabled>+</button>
                </div>
              </div>
            </div>
            <div class="kg-canvas" data-kg-canvas></div>
          </section>
          <aside class="panel kg-detail" data-kg-detail></aside>
        </div>
      </div>
    `;
  }

  function setMapControlsEnabled(enabled) {
    rootEl?.querySelectorAll('[data-kg-search], [data-kg-zoom]').forEach((node) => {
      node.disabled = !enabled;
    });
  }

  function updateGenerateButton() {
    if (!rootEl) return;
    const { bank } = getBank(activeBankId);
    const total = bank ? bankQuestions(bank.id).length : 0;
    rootEl.querySelectorAll('[data-kg-generate]').forEach((button) => {
      button.disabled = generating || loading || !bank || total === 0;
    });
    const label = rootEl.querySelector('[data-kg-generate-label]');
    if (label) {
      label.textContent = generating ? 'AI 正在生成…' : mapData ? '重新生成' : 'AI 生成图谱';
    }
    const exportButton = rootEl.querySelector('[data-kg-export]');
    if (exportButton) exportButton.disabled = generating || loading || !mapData;
    const select = rootEl.querySelector('[data-kg-bank]');
    if (select) select.disabled = generating;
  }

  function renderMeta() {
    if (!rootEl) return;
    const meta = rootEl.querySelector('[data-kg-meta]');
    const banner = rootEl.querySelector('[data-kg-banner]');
    if (!meta || !banner) return;
    const { bank, subject } = getBank(activeBankId);
    if (!bank) {
      meta.textContent = '';
      banner.hidden = true;
      return;
    }
    const total = bankQuestions(bank.id).length;
    if (generating) {
      meta.innerHTML = `<span class="mini-spinner" aria-hidden="true"></span> AI 正在归纳「${escapeHTML(
        bank.name,
      )}」的知识点，通常需要 10–40 秒…`;
    } else if (loading) {
      meta.innerHTML = `<span class="mini-spinner" aria-hidden="true"></span> 正在读取「${escapeHTML(
        bank.name,
      )}」的知识图谱…`;
    } else if (mapData) {
      const mapped = countMappedQuestions(mapData, bankQuestions(bank.id));
      const nodes = Array.isArray(mapData.nodes) ? mapData.nodes.length : 0;
      meta.textContent = `生成于 ${formatGeneratedAt(mapData.generatedAt)} · ${
        mapData.model || '已配置模型'
      } · 覆盖 ${mapped}/${total} 题 · ${nodes} 个知识点${
        mapData.questionCount && mapData.questionCount !== total
          ? `（生成时 ${mapData.questionCount} 题）`
          : ''
      }`;
    } else {
      meta.textContent = `${subject?.name ? `${subject.name} / ` : ''}${
        bank.name
      } · 共 ${total} 道题 · 尚未生成知识图谱`;
    }

    const stale =
      Boolean(mapData?.fingerprint) &&
      Boolean(currentFingerprint) &&
      mapData.fingerprint !== currentFingerprint;
    if (generateError) {
      banner.hidden = false;
      banner.className = 'kg-banner is-error';
      banner.innerHTML = `${icon('alert', 15)} 生成失败：${escapeHTML(
        generateError,
      )} <button type="button" class="kg-banner-action" data-kg-generate>重试</button>`;
    } else if (loadError) {
      banner.hidden = false;
      banner.className = 'kg-banner is-error';
      banner.innerHTML = `${icon('alert', 15)} 读取失败：${escapeHTML(
        loadError,
      )} <button type="button" class="kg-banner-action" data-kg-retry>重试</button>`;
    } else if (loadWarning) {
      banner.hidden = false;
      banner.className = 'kg-banner is-warning';
      banner.innerHTML = `${icon('info', 15)} ${escapeHTML(loadWarning)}`;
    } else if (stale) {
      banner.hidden = false;
      banner.className = 'kg-banner is-warning';
      banner.innerHTML = `${icon('info', 15)} 题库内容已变化，当前图谱可能过期。 <button type="button" class="kg-banner-action" data-kg-generate>重新生成</button>`;
    } else {
      banner.hidden = true;
      banner.innerHTML = '';
    }
  }

  function renderDetail(node = null) {
    if (!rootEl) return;
    const detail = rootEl.querySelector('[data-kg-detail]');
    if (!detail) return;
    const activeNode = node || findNode(displayRoot, selectedNodeId) || displayRoot;
    if (!activeNode || !mapData) {
      detail.innerHTML = `
        <div class="kg-detail-empty">
          <p class="eyebrow">DETAIL</p>
          <p>生成或打开一个知识图谱后，点击左侧节点查看知识点摘要、掌握度和相关题目。</p>
        </div>
      `;
      return;
    }

    const stats = activeNode.stats || summarizeQuestions([]);
    const accuracy = stats.accuracy == null ? '—' : `${stats.accuracy}%`;
    const questions = (activeNode.subtreeQuestionIds || [])
      .map((questionId) => app.state.questions.find((question) => question.id === questionId))
      .filter(Boolean);
    const shown = questions.slice(0, 24);
    const total = bankQuestions(activeBankId).length;
    const mapped = countMappedQuestions(mapData, bankQuestions(activeBankId));
    const keywords = (activeNode.keywords || [])
      .map((keyword) => `<span class="kg-keyword">${escapeHTML(keyword)}</span>`)
      .join('');
    const isRoot = activeNode.kind === 'root';
    const relations = (activeNode.relations || [])
      .map((relation) => {
        const target = findNode(displayRoot, relation.to);
        if (!target) return '';
        return `<button type="button" class="kg-relation" data-kg-relation="${escapeHTML(
          relation.to,
        )}">${escapeHTML(relation.label || '相关')} · ${escapeHTML(target.label)}</button>`;
      })
      .filter(Boolean)
      .join('');
    const questionItems = shown
      .map((question) => {
        const questionAccuracyValue = questionAccuracy(question);
        return `
          <li class="kg-question">
            <div class="kg-question-head">
              <span class="type-badge type-${typeClass(question.type)}">${
                QUESTION_TYPES[question.type] || '题目'
              }</span>
              <span class="kg-question-stat">${
                questionAccuracyValue == null ? '未练习' : `正确率 ${questionAccuracyValue}%`
              }</span>
            </div>
            <p>${escapeHTML(question.stem.slice(0, 110))}${
              question.stem.length > 110 ? '…' : ''
            }</p>
          </li>
        `;
      })
      .join('');

    detail.innerHTML = `
      <div class="kg-detail-head">
        <p class="eyebrow">${isRoot ? 'KNOWLEDGE MAP' : 'KNOWLEDGE POINT'}</p>
        <h2>${escapeHTML(activeNode.label)}</h2>
        ${
          isRoot
            ? `<p class="kg-detail-sub">${escapeHTML(activeNode.subjectLabel || '')}${
                activeNode.subjectLabel ? ' · ' : ''
              }${escapeHTML(activeNode.rootSubtitle || '')}</p>`
            : activeNode.isUnclassified
              ? '<p class="kg-detail-sub">这些题没有被 AI 归入具体知识点</p>'
              : ''
        }
      </div>
      ${
        activeNode.summary
          ? `<p class="kg-detail-summary">${escapeHTML(activeNode.summary)}</p>`
          : '<p class="kg-detail-summary is-muted">这个节点还没有摘要。</p>'
      }
      ${keywords ? `<div class="kg-keywords">${keywords}</div>` : ''}
      ${
        relations
          ? `<div class="kg-relations"><span class="kg-relations-label">相关知识点</span>${relations}</div>`
          : ''
      }
      ${
        isRoot
          ? `<p class="kg-detail-note">覆盖 ${mapped}/${total} 题 · 生成于 ${formatGeneratedAt(
              mapData.generatedAt,
            )} · 保存于 题库保存/.shuati-knowledge/</p>`
          : ''
      }
      <div class="kg-stat-grid">
        <div class="kg-stat"><span>题目</span><strong>${stats.total}</strong></div>
        <div class="kg-stat"><span>正确率</span><strong>${accuracy}</strong></div>
        <div class="kg-stat"><span>已掌握</span><strong>${stats.mastered}</strong></div>
        <div class="kg-stat"><span>错题</span><strong>${stats.wrong}</strong></div>
      </div>
      <div class="kg-detail-actions">
        <button type="button" class="btn primary kg-practice-btn" data-kg-practice ${
          stats.answerable ? '' : 'disabled'
        }>
          ${icon('play', 16)} ${isRoot ? '练习整个子题库' : '练习这个知识点'}
        </button>
      </div>
      ${
        questions.length
          ? `<div class="kg-question-block">
              <div class="kg-question-title">
                <span>相关题目</span>
                <small>${questions.length} 道</small>
              </div>
              <ul class="kg-question-list">${questionItems}</ul>
              ${
                questions.length > shown.length
                  ? `<p class="kg-question-more">还有 ${questions.length - shown.length} 道题，练习时会全部包含。</p>`
                  : ''
              }
            </div>`
          : '<p class="kg-detail-note">这个知识点暂时没有关联题目。</p>'
      }
    `;
  }

  function renderCanvas() {
    if (!rootEl) return;
    const canvas = rootEl.querySelector('[data-kg-canvas]');
    if (!canvas) return;
    mindMap?.destroy();
    mindMap = null;
    setMapControlsEnabled(false);

    const { bank } = getBank(activeBankId);
    if (!bank) {
      canvas.innerHTML = '';
      return;
    }
    const total = bankQuestions(bank.id).length;

    if (loading) {
      canvas.innerHTML = `
        <div class="kg-state">
          <span class="mini-spinner" aria-hidden="true"></span>
          <p>正在读取知识图谱…</p>
        </div>
      `;
      return;
    }

    if (generating && !mapData) {
      canvas.innerHTML = `
        <div class="kg-state">
          <span class="mini-spinner" aria-hidden="true"></span>
          <h3>AI 正在归纳知识点</h3>
          <p>正在分析「${escapeHTML(
            bank.name,
          )}」的 ${total} 道题，通常需要 10–40 秒。完成后会自动保存到题库保存目录。</p>
        </div>
      `;
      return;
    }

    if (!mapData) {
      if (loadError) {
        canvas.innerHTML = `
          <div class="kg-state">
            <span class="kg-state-icon is-error">${icon('alert', 28)}</span>
            <h3>读取知识图谱失败</h3>
            <p>${escapeHTML(loadError)}</p>
            <div class="kg-state-actions">
              <button type="button" class="btn subtle" data-kg-retry>重试</button>
              <button type="button" class="btn primary" data-kg-generate>${icon(
                'sparkles',
                16,
              )} AI 生成图谱</button>
            </div>
          </div>
        `;
      } else {
        canvas.innerHTML = `
          <div class="kg-state kg-state-empty">
            <span class="kg-state-icon">${icon('graph', 28)}</span>
            <h3>为「${escapeHTML(bank.name)}」生成知识图谱</h3>
            <p>AI 会读取这个子题库的 ${total} 道题的题干和解析，归纳成树状知识点；图片不会被发送。生成一次后会保存到题库保存目录，之后打开不再产生费用。</p>
            <div class="kg-state-actions">
              <button type="button" class="btn primary" data-kg-generate>${icon(
                'sparkles',
                16,
              )} AI 生成图谱</button>
              <button type="button" class="btn subtle" data-kg-ai-settings>${icon(
                'settings',
                15,
              )} AI 设置</button>
            </div>
          </div>
        `;
      }
      return;
    }

    if (!displayRoot) {
      prepareDisplay();
    }
    if (!displayRoot) {
      canvas.innerHTML = `
        <div class="kg-state">
          <p>这个子题库暂时没有可展示的知识点。</p>
        </div>
      `;
      return;
    }

    canvas.innerHTML = '<div class="kg-map-host" data-kg-map-host></div>';
    const host = canvas.querySelector('[data-kg-map-host]');
    if (!host) return;
    mindMap = createMindMap(host, {
      onSelect: (node) => {
        selectedNodeId = node.id;
        renderDetail(node);
      },
    });
    mindMap.render(displayRoot);
    const target = findNode(displayRoot, selectedNodeId) || displayRoot;
    selectedNodeId = target.id;
    mindMap.select(target.id, false);
    renderDetail(target);
    setMapControlsEnabled(true);
    const searchInput = rootEl.querySelector('[data-kg-search]');
    if (searchInput && searchQuery) mindMap.search(searchQuery);
  }

  function renderAll() {
    renderMeta();
    renderCanvas();
    renderDetail();
    updateGenerateButton();
  }

  async function loadBankMap(bankId) {
    const seq = ++loadSeq;
    loading = true;
    loadError = '';
    loadWarning = '';
    generateError = '';
    mapData = null;
    displayRoot = null;
    selectedNodeId = 'root';
    renderAll();
    try {
      const response = await loadKnowledgeMap(bankId);
      if (seq !== loadSeq || !rootEl) return;
      loading = false;
      loadWarning = response.warning || '';
      mapData = response.map || null;
      if (mapData) prepareDisplay();
      renderAll();
    } catch (error) {
      if (seq !== loadSeq || !rootEl) return;
      loading = false;
      loadError = error.message || '读取知识图谱失败。';
      renderAll();
    }
  }

  async function generate() {
    if (generating) return;
    const { bank, subject } = getBank(activeBankId);
    if (!bank) return;
    const questions = bankQuestions(bank.id);
    if (!questions.length) {
      toast('这个子题库还没有题目。', 'info');
      return;
    }
    if (questions.length > MAX_KNOWLEDGE_QUESTIONS) {
      toast(
        `这个子题库有 ${questions.length} 道题，超过单次分析上限 ${MAX_KNOWLEDGE_QUESTIONS} 道，请先拆分子题库。`,
        'info',
        5200,
      );
      return;
    }
    const totalChars = questions.reduce(
      (sum, question) =>
        sum +
        Math.min(question.stem.length, 3000) +
        Math.min((question.explanation || '').length, 2000),
      0,
    );
    if (totalChars > MAX_KNOWLEDGE_CHARS) {
      toast(
        `这个子题库的题干和解析共约 ${totalChars} 字，超过单次分析上限 ${MAX_KNOWLEDGE_CHARS} 字，请先拆分子题库。`,
        'info',
        5600,
      );
      return;
    }

    let config;
    try {
      config = await getAIConfig();
    } catch (error) {
      toast(`读取 AI 设置失败：${error.message || '未知错误'}`, 'error', 4200);
      return;
    }
    if (!config.configured) {
      toast('先配置 AI 服务，才能生成知识图谱。', 'info', 3800);
      app.openAISettings({
        onSaved: () => toast('AI 设置已保存，可以生成图谱了。', 'success'),
      });
      return;
    }

    const proceed = await confirmAction({
      title: mapData ? '重新生成知识图谱？' : '用 AI 生成知识图谱？',
      message: `将把「${bank.name}」的 ${questions.length} 道题的题干和解析发送给 ${
        config.model || '已配置模型'
      }（不发送图片、选项和答案），可能产生模型调用费用。生成结果会写入「题库保存/.shuati-knowledge/」。`,
      confirmText: '开始生成',
    });
    if (!proceed) return;

    const seq = ++generationSeq;
    const targetBankId = bank.id;
    generating = true;
    generateError = '';
    searchQuery = '';
    const searchInput = rootEl?.querySelector('[data-kg-search]');
    if (searchInput) searchInput.value = '';
    renderAll();

    const generationFingerprint = fingerprintQuestions(questions);
    const payloadQuestions = questions.map((question, index) => ({
      i: index + 1,
      type: question.type,
      stem: question.stem.slice(0, 3000),
      explanation: (question.explanation || '').slice(0, 2000),
    }));

    try {
      const response = await generateKnowledgeMap({
        bankId: bank.id,
        bankName: bank.name,
        subjectName: subject?.name || '',
        questions: payloadQuestions,
        maxNodes: 24,
      });
      if (seq !== generationSeq || !rootEl) return;
      if (!response?.map || !Array.isArray(response.map.nodes)) {
        throw new Error('AI 返回的知识图谱格式不正确。');
      }
      const idByIndex = new Map(
        payloadQuestions.map((item, index) => [item.i, questions[index].id]),
      );
      const storedMap = {
        bankId: bank.id,
        subjectId: bank.subjectId,
        subjectName: subject?.name || '',
        bankName: bank.name,
        generatedAt: response.generatedAt || new Date().toISOString(),
        model: response.model || config.model || '',
        fingerprint: generationFingerprint,
        questionCount: questions.length,
        summary: response.map.summary || '',
        usage: response.usage || {},
        nodes: response.map.nodes.map((node) => ({
          id: node.id,
          parentId: node.parentId || 'root',
          label: node.label,
          summary: node.summary || '',
          keywords: Array.isArray(node.keywords) ? node.keywords : [],
          questionIds: (Array.isArray(node.questions) ? node.questions : [])
            .map((questionIndex) => idByIndex.get(questionIndex))
            .filter(Boolean),
          relations: Array.isArray(node.relations) ? node.relations : [],
        })),
      };

      let saveError = '';
      let savedMap = storedMap;
      try {
        const saveResponse = await saveKnowledgeMap(storedMap);
        if (saveResponse?.map && Array.isArray(saveResponse.map.nodes)) {
          savedMap = saveResponse.map;
        }
      } catch (error) {
        saveError = error.message || '保存失败';
      }
      if (seq !== generationSeq) return;
      generating = false;
      if (!rootEl || activeBankId !== targetBankId) return;
      mapData = savedMap;
      currentFingerprint = fingerprintQuestions(questions);
      selectedNodeId = 'root';
      prepareDisplay();
      renderAll();
      if (saveError) {
        toast(`图谱已生成，但写入题库保存失败：${saveError}`, 'error', 5200);
      } else {
        toast('知识图谱已生成并保存到题库保存。', 'success', 3600);
      }
      if (response.warning) {
        toast(response.warning, 'info', 5600);
      }
    } catch (error) {
      if (seq !== generationSeq) return;
      generating = false;
      if (!rootEl) return;
      generateError = `${error.message || '生成知识图谱失败。'}${
        error.hint ? ` ${error.hint}` : ''
      }`;
      renderAll();
      toast(`生成知识图谱失败：${generateError}`, 'error', 5200);
    }
  }

  function exportKnowledgeMap() {
    const { bank, subject } = getBank(activeBankId);
    if (!bank || !mapData) {
      toast('当前子题库还没有可导出的知识图谱。', 'info');
      return;
    }
    const questionRefs = bankQuestions(bank.id).map((question) => ({
      id: question.id,
      fingerprint: questionFingerprint(question),
    }));
    const payload = {
      app: '刷题助手',
      kind: 'knowledge-map',
      version: 1,
      exportedAt: new Date().toISOString(),
      bank: {
        id: bank.id,
        name: bank.name,
        subjectId: bank.subjectId,
        subjectName: subject?.name || '',
      },
      questionRefs,
      map: {
        ...mapData,
        bankId: bank.id,
        subjectId: bank.subjectId,
        subjectName: subject?.name || mapData.subjectName || '',
        bankName: bank.name,
      },
    };
    const safeName = String(bank.name || '知识图谱')
      .replace(/[\\/:*?"<>|]/g, '-')
      .slice(0, 40);
    downloadJSON(
      payload,
      `刷题助手知识图谱-${safeName}-${localDateKey()}.json`,
    );
    toast('知识图谱已导出，可在安卓或苹果客户端导入。', 'success', 4600);
  }

  function startPracticeForNode(nodeId) {
    const node = findNode(displayRoot, nodeId) || displayRoot;
    if (!node) return;
    const questionIds = node.subtreeQuestionIds || [];
    if (!questionIds.length) {
      toast('这个知识点还没有关联题目。', 'info');
      return;
    }
    const { bank } = getBank(activeBankId);
    const label =
      node.kind === 'root'
        ? `知识图谱 · ${bank?.name || '子题库'}`
        : `知识图谱 · ${node.label}`;
    app.startPractice({ questionIds, label, shuffle: true });
  }

  function bindShellEvents(root) {
    root.addEventListener(
      'change',
      (event) => {
        const select = event.target.closest('[data-kg-bank]');
        if (!select) return;
        activeBankId = select.value;
        lastBankId = activeBankId;
        selectedNodeId = 'root';
        searchQuery = '';
        const searchInput = root.querySelector('[data-kg-search]');
        if (searchInput) searchInput.value = '';
        loadBankMap(activeBankId);
      },
      { signal: controller.signal },
    );

    root.addEventListener(
      'input',
      (event) => {
        const input = event.target.closest('[data-kg-search]');
        if (!input) return;
        searchQuery = input.value;
        mindMap?.search(searchQuery);
      },
      { signal: controller.signal },
    );

    root.addEventListener(
      'click',
      (event) => {
        if (event.target.closest('[data-kg-export]')) {
          exportKnowledgeMap();
          return;
        }
        const generateButton = event.target.closest('[data-kg-generate]');
        if (generateButton) {
          generate();
          return;
        }
        const retryButton = event.target.closest('[data-kg-retry]');
        if (retryButton) {
          loadBankMap(activeBankId);
          return;
        }
        const zoomButton = event.target.closest('[data-kg-zoom]');
        if (zoomButton) {
          const mode = zoomButton.dataset.kgZoom;
          if (mode === 'in') mindMap?.zoomIn();
          else if (mode === 'out') mindMap?.zoomOut();
          else if (mode === 'fit') mindMap?.fit();
          return;
        }
        const relationButton = event.target.closest('[data-kg-relation]');
        if (relationButton) {
          const target = findNode(displayRoot, relationButton.dataset.kgRelation);
          if (target) {
            selectedNodeId = target.id;
            mindMap?.select(target.id, false);
            renderDetail(target);
          }
          return;
        }
        const practiceButton = event.target.closest('[data-kg-practice]');
        if (practiceButton) {
          startPracticeForNode(selectedNodeId);
          return;
        }
        if (event.target.closest('[data-kg-ai-settings]')) {
          app.openAISettings({
            onSaved: () => toast('AI 设置已保存，可以生成图谱了。', 'success'),
          });
        }
      },
      { signal: controller.signal },
    );
  }

  function render(root) {
    controller?.abort();
    controller = new AbortController();
    rootEl = root;
    mindMap?.destroy();
    mindMap = null;
    loading = false;
    loadError = '';
    loadWarning = '';
    generateError = '';
    mapData = null;
    displayRoot = null;
    selectedNodeId = 'root';
    searchQuery = '';

    if (OFFLINE_MODE) {
      renderOffline(root);
      return;
    }

    const groups = bankGroups();
    if (!groups.length) {
      renderNoBanks(root);
      return;
    }
    activeBankId = defaultBankId(groups);
    lastBankId = activeBankId;
    root.innerHTML = shellHTML(groups, activeBankId);
    bindShellEvents(root);
    if (generating) renderAll();
    else loadBankMap(activeBankId);
  }

  return { render };
}
