import {
  banksForSubject,
  getLocalKnowledgeMap,
  isMastered,
  isQuestionAnswerable,
  questionAccuracy,
  questionFingerprint,
  removeLocalKnowledgeMap,
  saveLocalKnowledgeMap,
  subjectById,
  QUESTION_TYPES,
} from '../store.js';
import {
  confirmAction,
  escapeHTML,
  icon,
  toast,
  typeClass,
} from '../ui.js';

function bankQuestions(state, bankId) {
  return state.questions.filter((question) => question.bankId === bankId);
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function createMobileKnowledgeView(app) {
  let rootEl = null;
  let controller = null;
  let activeBankId = '';
  let lastBankId = '';
  let selectedNodeId = 'root';
  let displayRoot = null;
  let mapData = null;

  function getBank(bankId) {
    const bank = app.state.banks.find((item) => item.id === bankId) || null;
    const subject = bank ? subjectById(app.state, bank.subjectId) : null;
    return { bank, subject };
  }

  function bankGroups() {
    const groups = [];
    for (const subject of app.state.subjects) {
      const banks = banksForSubject(app.state, subject.id).filter(
        (bank) => bankQuestions(app.state, bank.id).length > 0,
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
              .map(
                (bank) =>
                  `<option value="${escapeHTML(bank.id)}" ${
                    bank.id === selectedId ? 'selected' : ''
                  }>${escapeHTML(bank.name)} · ${bankQuestions(app.state, bank.id).length} 题</option>`,
              )
              .join('')}
          </optgroup>
        `,
      )
      .join('');
  }

  function buildDisplayTree(bank, map) {
    const questions = bankQuestions(app.state, bank.id);
    const questionsById = new Map(questions.map((question) => [question.id, question]));
    const nodes = new Map();

    for (const raw of Array.isArray(map?.nodes) ? map.nodes : []) {
      const id = String(raw?.id || '');
      if (!id || id === 'root' || id === 'unclassified' || nodes.has(id)) continue;
      const questionIds = [
        ...new Set(
          (Array.isArray(raw.questionIds) ? raw.questionIds : [])
            .map(String)
            .filter((questionId) => questionsById.has(questionId)),
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
      if (parent === node) {
        root.children.push(node);
        continue;
      }
      parent.children.push(node);
    }

    function enrich(node, ancestors) {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(node.id);
      node.children = node.children.filter((child) => !nextAncestors.has(child.id));
      const subtreeIds = new Set(node.questionIds);
      for (const child of node.children) {
        enrich(child, nextAncestors);
        for (const questionId of child.subtreeQuestionIds) subtreeIds.add(questionId);
      }
      const ownQuestions = node.questionIds
        .map((questionId) => questionsById.get(questionId))
        .filter(Boolean);
      const subtreeQuestions = [...subtreeIds]
        .map((questionId) => questionsById.get(questionId))
        .filter(Boolean);
      const stats = summarizeQuestions(subtreeQuestions);
      Object.assign(node, {
        ownStats: summarizeQuestions(ownQuestions),
        stats,
        questionCount: subtreeQuestions.length,
        ownCount: ownQuestions.length,
        tone: toneFor(stats),
        subtreeQuestionIds: [...subtreeIds],
        ownQuestionIds: [...node.questionIds],
      });
      return node;
    }

    enrich(root, new Set());

    const classified = new Set();
    for (const node of nodes.values()) {
      for (const questionId of node.questionIds) classified.add(questionId);
    }
    const unclassifiedIds = questions
      .map((question) => question.id)
      .filter((questionId) => !classified.has(questionId));
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
        summary: '这些题没有出现在导入的知识树中，可以单独练习。',
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

    const rootStats = summarizeQuestions(questions);
    Object.assign(root, {
      ownStats: rootStats,
      stats: rootStats,
      questionCount: questions.length,
      ownCount: questions.length,
      tone: toneFor(rootStats),
      subtreeQuestionIds: questions.map((question) => question.id),
      ownQuestionIds: questions.map((question) => question.id),
    });
    return root;
  }

  function prepareDisplay() {
    const { bank } = getBank(activeBankId);
    if (!bank || !mapData) {
      displayRoot = null;
      return;
    }
    displayRoot = buildDisplayTree(bank, mapData);
  }

  function renderNoBanks(root) {
    root.innerHTML = `
      <div class="page mobile-knowledge-page">
        <header class="page-header">
          <div class="page-heading">
            <p class="eyebrow">KNOWLEDGE TREE · 知识树</p>
            <h1>先导入题库，<br>再导入知识树。</h1>
            <p class="page-sub">知识树需要和题目一起使用。先在设备上准备至少一个有题目的子题库。</p>
          </div>
        </header>
        <section class="panel mkg-empty-panel">
          <span class="mkg-empty-icon">${icon('graph', 28)}</span>
          <h2>还没有可导入知识树的子题库</h2>
          <p>先在「我的题库 → 导入题库」中导入电脑端导出的题库 JSON，再回到这里导入知识树。</p>
          <div class="mkg-empty-actions">
            <button type="button" class="btn primary" data-mkg-go-library>${icon('book', 16)} 打开我的题库</button>
          </div>
        </section>
      </div>
    `;
    root.addEventListener(
      'click',
      (event) => {
        if (event.target.closest('[data-mkg-go-library]')) app.navigate('library');
      },
      { signal: controller.signal },
    );
  }

  function shellHTML(groups, selectedId) {
    const { bank } = getBank(selectedId);
    return `
      <div class="page mobile-knowledge-page">
        <header class="page-header">
          <div class="page-heading">
            <p class="eyebrow">KNOWLEDGE TREE · 知识树</p>
            <h1>把电脑端的知识树，<br>带到这台设备。</h1>
            <p class="page-sub">在电脑端「知识图谱」中导出 JSON，然后在这里选择文件导入。知识树只关联本题库，不会上传题目或调用 AI。</p>
          </div>
          <div class="header-actions">
            <button type="button" class="btn primary" data-mkg-import>
              ${icon('upload', 16)} 导入知识树
            </button>
            <input type="file" accept=".json,application/json" data-mkg-file hidden>
          </div>
        </header>

        <section class="panel mkg-toolbar">
          <label class="mkg-field">
            <span>子题库</span>
            <span class="select-wrap">
              <select data-mkg-bank aria-label="选择要查看知识树的子题库">
                ${bankSelectHTML(groups, selectedId)}
              </select>
              ${icon('chevron-down', 14)}
            </span>
          </label>
          <div class="mkg-toolbar-side">
            <span class="mkg-meta" data-mkg-meta></span>
            ${mapData ? '<button type="button" class="text-button" data-mkg-remove>移除当前知识树</button>' : ''}
          </div>
        </section>

        <div class="mkg-layout">
          <section class="panel mkg-map-panel">
            <header class="mkg-panel-head">
              <div>
                <span class="eyebrow">TREE</span>
                <h2 data-mkg-title>${escapeHTML(bank?.name || '知识树')}</h2>
              </div>
              <span class="mkg-count" data-mkg-count></span>
            </header>
            <div class="mkg-tree-body" data-mkg-tree-body></div>
          </section>
          <section class="panel mkg-detail" data-mkg-detail></section>
        </div>
      </div>
    `;
  }

  function nodeRowHTML(node, depth = 0) {
    const hasChildren = node.children.length > 0;
    const accuracy = node.stats?.accuracy == null ? '未练习' : `${node.stats.accuracy}%`;
    return `
      <li class="mkg-item">
        <div class="mkg-row" style="--mkg-depth:${depth}">
          <button type="button" class="mkg-node tone-${node.tone || 'none'} ${
            node.id === selectedNodeId ? 'is-selected' : ''
          }" data-mkg-node="${escapeHTML(node.id)}">
            <span class="mkg-node-label">${escapeHTML(node.label)}</span>
            <span class="mkg-node-meta">${node.questionCount} 题 · ${accuracy}</span>
          </button>
          ${
            hasChildren
              ? `<button type="button" class="mkg-toggle" data-mkg-toggle="${escapeHTML(
                  node.id,
                )}" aria-label="展开或收起" aria-expanded="false">${icon('chevron-down', 15)}</button>`
              : ''
          }
        </div>
        ${
          hasChildren
            ? `<div class="mkg-subtree" data-mkg-subtree="${escapeHTML(node.id)}" hidden>
                <ul class="mkg-children">
                  ${node.children.map((child) => nodeRowHTML(child, depth + 1)).join('')}
                </ul>
              </div>`
            : ''
        }
      </li>
    `;
  }

  function treeBodyHTML() {
    if (!displayRoot) {
      return `
        <div class="mkg-empty-state">
          <span class="mkg-empty-icon">${icon('graph', 26)}</span>
          <h3>还没有导入「${escapeHTML(getBank(activeBankId).bank?.name || '当前子题库')}」的知识树</h3>
          <p>先在电脑端打开「知识图谱 → 导出知识图谱」，再把导出的 JSON 文件导入到这台设备。</p>
          <button type="button" class="btn primary" data-mkg-import>${icon('upload', 16)} 导入知识树</button>
        </div>
      `;
    }
    const rootStats = displayRoot.stats || summarizeQuestions([]);
    return `
      <button type="button" class="mkg-root-row ${
        selectedNodeId === 'root' ? 'is-selected' : ''
      }" data-mkg-node="root">
        <span>
          <strong>整个子题库</strong>
          <small>${displayRoot.questionCount} 道题</small>
        </span>
        <span>${rootStats.accuracy == null ? '未练习' : `${rootStats.accuracy}%`}</span>
      </button>
      ${
        displayRoot.children.length
          ? `<ul class="mkg-tree">${displayRoot.children
              .map((node) => nodeRowHTML(node))
              .join('')}</ul>`
          : '<p class="mkg-note">这个知识树还没有知识点，或所有题目都已归入未分类。</p>'
      }
    `;
  }

  function renderMeta() {
    if (!rootEl) return;
    const meta = rootEl.querySelector('[data-mkg-meta]');
    const count = rootEl.querySelector('[data-mkg-count]');
    if (!meta) return;
    if (!mapData) {
      meta.textContent = '尚未导入知识树';
      if (count) count.textContent = '';
      return;
    }
    const total = bankQuestions(app.state, activeBankId).length;
    const mapped = new Set();
    for (const node of mapData.nodes || []) {
      for (const questionId of node.questionIds || []) mapped.add(questionId);
    }
    meta.textContent = `导入于 ${formatDate(
      mapData.importedAt || mapData.generatedAt,
    )} · 覆盖 ${mapped.size}/${total} 题 · ${mapData.nodes?.length || 0} 个知识点`;
    if (count) count.textContent = `${mapData.nodes?.length || 0} 个知识点`;
  }

  function renderDetail(node = null) {
    if (!rootEl) return;
    const detail = rootEl.querySelector('[data-mkg-detail]');
    if (!detail) return;
    const activeNode = node || findNode(displayRoot, selectedNodeId) || displayRoot;
    if (!activeNode) {
      detail.innerHTML = `
        <div class="mkg-detail-empty">
          <p class="eyebrow">DETAIL</p>
          <p>导入知识树后，点击左侧知识点查看摘要、掌握度和相关题目。</p>
        </div>
      `;
      return;
    }
    const stats = activeNode.stats || summarizeQuestions([]);
    const accuracy = stats.accuracy == null ? '—' : `${stats.accuracy}%`;
    const questions = (activeNode.subtreeQuestionIds || [])
      .map((questionId) => app.state.questions.find((question) => question.id === questionId))
      .filter(Boolean);
    const shown = questions.slice(0, 12);
    const keywords = (activeNode.keywords || [])
      .map((keyword) => `<span class="mkg-keyword">${escapeHTML(keyword)}</span>`)
      .join('');
    const isRoot = activeNode.kind === 'root';
    const questionItems = shown
      .map((question) => {
        const value = questionAccuracy(question);
        return `
          <button type="button" class="mkg-question" data-mkg-question="${escapeHTML(question.id)}">
            <span class="type-badge type-${typeClass(question.type)}">${
              QUESTION_TYPES[question.type] || '题目'
            }</span>
            <span class="mkg-question-stem">${escapeHTML(question.stem.slice(0, 100))}</span>
            <small>${value == null ? '未练习' : `${value}%`}</small>
          </button>
        `;
      })
      .join('');

    detail.innerHTML = `
      <div class="mkg-detail-head">
        <p class="eyebrow">${isRoot ? 'KNOWLEDGE TREE' : 'KNOWLEDGE POINT'}</p>
        <h2>${escapeHTML(activeNode.label)}</h2>
        <p class="mkg-detail-sub">${
          activeNode.isUnclassified
            ? '未归入知识点的题目'
            : isRoot
              ? '整个子题库'
              : '知识点'
        }</p>
      </div>
      ${
        activeNode.summary
          ? `<p class="mkg-detail-summary">${escapeHTML(activeNode.summary)}</p>`
          : '<p class="mkg-detail-summary is-muted">这个节点还没有摘要。</p>'
      }
      ${keywords ? `<div class="mkg-keywords">${keywords}</div>` : ''}
      <div class="mkg-stat-grid">
        <div><span>题目</span><strong>${stats.total}</strong></div>
        <div><span>正确率</span><strong>${accuracy}</strong></div>
        <div><span>已掌握</span><strong>${stats.mastered}</strong></div>
        <div><span>错题</span><strong>${stats.wrong}</strong></div>
      </div>
      <button type="button" class="btn primary full-width mkg-practice" data-mkg-practice ${
        stats.answerable ? '' : 'disabled'
      }>
        ${icon('play', 16)} ${isRoot ? '练习整个子题库' : '练习这个知识点'}
      </button>
      ${
        questions.length
          ? `<div class="mkg-question-block">
              <div class="mkg-question-title"><span>相关题目</span><small>${questions.length} 道</small></div>
              <div class="mkg-question-list">${questionItems}</div>
              ${
                questions.length > shown.length
                  ? `<p class="mkg-note">还有 ${questions.length - shown.length} 道题，练习时会全部包含。</p>`
                  : ''
              }
            </div>`
          : '<p class="mkg-note">这个知识点暂时没有关联题目。</p>'
      }
    `;
  }

  function selectNode(nodeId) {
    if (!rootEl) return;
    selectedNodeId = nodeId;
    rootEl.querySelectorAll('[data-mkg-node]').forEach((node) => {
      node.classList.toggle('is-selected', node.dataset.mkgNode === nodeId);
    });
    renderDetail(findNode(displayRoot, nodeId) || displayRoot);
  }

  function resolveBank(payload, map) {
    const candidates = app.state.banks.filter(
      (bank) => bankQuestions(app.state, bank.id).length > 0,
    );
    const sourceBankId = String(map?.bankId || payload?.bank?.id || '');
    if (sourceBankId) {
      const exact = candidates.find((bank) => bank.id === sourceBankId);
      if (exact) return exact;
    }
    const bankName = normalizeName(map?.bankName || payload?.bank?.name);
    if (!bankName) return null;
    const subjectName = normalizeName(map?.subjectName || payload?.bank?.subjectName);
    let matches = candidates.filter((bank) => normalizeName(bank.name) === bankName);
    if (matches.length > 1 && subjectName) {
      matches = matches.filter(
        (bank) => normalizeName(subjectById(app.state, bank.subjectId)?.name) === subjectName,
      );
    }
    if (matches.length === 1) return matches[0];

    // 子题库改名后仍可按题目指纹找到对应题库。
    const refs = Array.isArray(payload?.questionRefs) ? payload.questionRefs : [];
    const fingerprints = [
      ...new Set(refs.map((ref) => String(ref?.fingerprint || '')).filter(Boolean)),
    ];
    if (!fingerprints.length) return null;
    let best = null;
    let bestCount = 0;
    let tied = false;
    for (const candidate of candidates) {
      const local = new Set(
        bankQuestions(app.state, candidate.id).map((question) => questionFingerprint(question)),
      );
      const count = fingerprints.reduce(
        (sum, fingerprint) => sum + (local.has(fingerprint) ? 1 : 0),
        0,
      );
      if (count > bestCount) {
        best = candidate;
        bestCount = count;
        tied = false;
      } else if (count === bestCount && count > 0) {
        tied = true;
      }
    }
    return best && !tied ? best : null;
  }

  function remapQuestionIds(map, bank, payload) {
    const questions = bankQuestions(app.state, bank.id);
    const localIds = new Set(questions.map((question) => question.id));
    const byFingerprint = new Map();
    for (const question of questions) {
      const fingerprint = questionFingerprint(question);
      if (fingerprint && !byFingerprint.has(fingerprint)) {
        byFingerprint.set(fingerprint, question.id);
      }
    }
    const refs = Array.isArray(payload?.questionRefs) ? payload.questionRefs : [];
    const fingerprintById = new Map(
      refs
        .map((ref) => [String(ref?.id || ''), String(ref?.fingerprint || '')])
        .filter(([id, fingerprint]) => id && fingerprint),
    );

    let total = 0;
    let mapped = 0;
    let unmapped = 0;
    const nodes = (Array.isArray(map?.nodes) ? map.nodes : []).map((node) => {
      const questionIds = [];
      for (const rawId of Array.isArray(node.questionIds) ? node.questionIds : []) {
        total += 1;
        const sourceId = String(rawId);
        if (localIds.has(sourceId)) {
          questionIds.push(sourceId);
          mapped += 1;
          continue;
        }
        const fingerprint = fingerprintById.get(sourceId);
        const localId = fingerprint ? byFingerprint.get(fingerprint) : '';
        if (localId) {
          questionIds.push(localId);
          mapped += 1;
        } else {
          unmapped += 1;
        }
      }
      return { ...node, questionIds: [...new Set(questionIds)] };
    });
    return { nodes, total, mapped, unmapped };
  }

  async function importKnowledgeFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('知识树文件过大，无法导入。', 'error');
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      toast('知识树文件不是有效的 JSON。', 'error');
      return;
    }
    const sourceMap = payload?.map && Array.isArray(payload.map.nodes) ? payload.map : payload;
    if (!sourceMap || !Array.isArray(sourceMap.nodes) || !sourceMap.nodes.length) {
      toast('这个文件里没有可导入的知识树。', 'error');
      return;
    }
    const map = {
      ...sourceMap,
      nodes: sourceMap.nodes.filter((node) => node && typeof node === 'object'),
    };
    if (!map.nodes.length) {
      toast('这个文件里没有可导入的知识树。', 'error');
      return;
    }
    const bank = resolveBank(payload, map);
    if (!bank) {
      toast(
        `没有找到知识树对应的子题库「${
          map.bankName || payload?.bank?.name || '未知'
        }」。请先导入配套题库，或检查子题库名称。`,
        'error',
        6200,
      );
      return;
    }
    const remapped = remapQuestionIds(map, bank, payload);
    if (remapped.total > 0 && remapped.mapped === 0) {
      toast(
        '知识树里的题目与本地题库没有匹配。请确认先在设备上导入了同一份题库 JSON。',
        'error',
        6200,
      );
      return;
    }
    const subject = subjectById(app.state, bank.subjectId);
    const stored = saveLocalKnowledgeMap(app.state, bank.id, {
      ...map,
      bankId: bank.id,
      subjectId: bank.subjectId,
      subjectName: subject?.name || map.subjectName || '',
      bankName: bank.name,
      sourceBankId: map.bankId || payload?.bank?.id || '',
      importedAt: new Date().toISOString(),
      unmappedCount: remapped.unmapped,
      nodes: remapped.nodes,
    });
    if (!stored) {
      toast('知识树格式不正确，无法保存。', 'error');
      return;
    }
    app.persist();
    activeBankId = bank.id;
    lastBankId = bank.id;
    selectedNodeId = 'root';
    mapData = stored;
    prepareDisplay();
    if (rootEl) render(rootEl);
    toast(
      `已导入「${bank.name}」知识树，共 ${stored.nodes.length} 个知识点。`,
      'success',
      4600,
    );
    if (remapped.unmapped) {
      toast(
        `有 ${remapped.unmapped} 个题目引用没有匹配到当前题库，已忽略。`,
        'info',
        5600,
      );
    }
  }

  function startPracticeForNode(node) {
    const questionIds = node?.subtreeQuestionIds || [];
    if (!questionIds.length) {
      toast('这个知识点还没有关联题目。', 'info');
      return;
    }
    const label =
      node.kind === 'root'
        ? `知识树 · ${getBank(activeBankId).bank?.name || '子题库'}`
        : `知识树 · ${node.label}`;
    app.startPractice({ questionIds, label, shuffle: true });
  }

  function bindEvents(root) {
    root.addEventListener(
      'click',
      async (event) => {
        if (event.target.closest('[data-mkg-import]')) {
          root.querySelector('[data-mkg-file]')?.click();
          return;
        }
        const removeButton = event.target.closest('[data-mkg-remove]');
        if (removeButton) {
          const { bank } = getBank(activeBankId);
          if (!bank) return;
          const proceed = await confirmAction({
            title: '移除当前知识树？',
            message: `将从本机移除「${bank.name}」的知识树，题目和练习记录不受影响。`,
            confirmText: '移除知识树',
            danger: true,
          });
          if (!proceed) return;
          removeLocalKnowledgeMap(app.state, activeBankId);
          app.persist();
          mapData = null;
          displayRoot = null;
          selectedNodeId = 'root';
          if (rootEl) render(rootEl);
          toast('已移除本机保存的知识树。', 'info');
          return;
        }
        const toggle = event.target.closest('[data-mkg-toggle]');
        if (toggle) {
          const nodeId = toggle.dataset.mkgToggle;
          const subtree = [...root.querySelectorAll('[data-mkg-subtree]')].find(
            (element) => element.dataset.mkgSubtree === nodeId,
          );
          if (!subtree) return;
          const open = subtree.hidden;
          subtree.hidden = !open;
          toggle.classList.toggle('is-open', open);
          toggle.setAttribute('aria-expanded', String(open));
          return;
        }
        const nodeButton = event.target.closest('[data-mkg-node]');
        if (nodeButton) {
          selectNode(nodeButton.dataset.mkgNode);
          return;
        }
        if (event.target.closest('[data-mkg-practice]')) {
          startPracticeForNode(findNode(displayRoot, selectedNodeId) || displayRoot);
          return;
        }
        const questionButton = event.target.closest('[data-mkg-question]');
        if (questionButton) {
          const question = app.state.questions.find(
            (item) => item.id === questionButton.dataset.mkgQuestion,
          );
          if (question) app.openQuestionEditor(question);
        }
      },
      { signal: controller.signal },
    );

    root.addEventListener(
      'change',
      (event) => {
        if (event.target.matches('[data-mkg-bank]')) {
          activeBankId = event.target.value;
          lastBankId = activeBankId;
          selectedNodeId = 'root';
          mapData = getLocalKnowledgeMap(app.state, activeBankId);
          prepareDisplay();
          if (rootEl) render(rootEl);
          return;
        }
        const fileInput = event.target.closest('[data-mkg-file]');
        if (fileInput) {
          const file = fileInput.files?.[0];
          fileInput.value = '';
          importKnowledgeFile(file);
        }
      },
      { signal: controller.signal },
    );
  }

  function render(root) {
    controller?.abort();
    controller = new AbortController();
    rootEl = root;
    selectedNodeId = 'root';

    const groups = bankGroups();
    if (!groups.length) {
      renderNoBanks(root);
      return;
    }
    activeBankId = defaultBankId(groups);
    lastBankId = activeBankId;
    mapData = getLocalKnowledgeMap(app.state, activeBankId);
    prepareDisplay();
    root.innerHTML = shellHTML(groups, activeBankId);
    bindEvents(root);
    renderMeta();
    const treeBody = root.querySelector('[data-mkg-tree-body]');
    if (treeBody) treeBody.innerHTML = treeBodyHTML();
    renderDetail(findNode(displayRoot, selectedNodeId) || displayRoot);
  }

  return { render };
}
