import {
  bankById,
  banksForSubject,
  filterQuestionsByBank,
  getStats,
  gradeQuestion,
  isChoiceType,
  isMastered,
  isQuestionAnswerable,
  isWrittenAnswerType,
  QUESTION_TYPES,
  recordAttempt,
  recordCompletedSession,
  recordStudyDuration,
  scopeCount,
  shuffleQuestionOptions,
  selectPracticeQuestions,
  subjectById,
} from '../store.js';
import {
  confirmAction,
  escapeHTML,
  formatDuration,
  icon,
  toast,
  typeClass,
} from '../ui.js';
import { createPracticeAIChat } from '../practice-ai.js';
import { OFFLINE_MODE } from '../runtime.js';

const SCOPE_META = {
  all: { label: '全部题目', desc: '所有已录入答案的题', icon: 'layers' },
  wrong: { label: '错题复习', desc: '上次做错的题目', icon: 'refresh' },
  unmastered: { label: '未掌握', desc: '还没连续答对两次', icon: 'target' },
  favorites: { label: '收藏题目', desc: '标星留意的题目', icon: 'star' },
};

const COUNT_OPTIONS = [5, 10, 20, 'all'];

const FEEDBACK_MODE_META = {
  immediate: {
    label: '每题查看答案',
    desc: '提交一道就看答案和解析',
    icon: 'eye',
  },
  afterAll: {
    label: '全部做完后查看',
    desc: '连续作答，结束后看正确率',
    icon: 'flag',
  },
};

function normalizeFeedbackMode(value) {
  return value === 'afterAll' ? 'afterAll' : 'immediate';
}

function lettersOf(answer) {
  return new Set(String(answer || '').toUpperCase().match(/[A-H]/g) || []);
}

function shuffleCopy(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function correctAnswerMarkup(question) {
  if (isWrittenAnswerType(question.type)) {
    const answer =
      question.answer || (question.type === 'short' ? '未提供参考答案（可自行作答后自评）' : '未设置');
    return `<span class="answer-value ${question.type === 'short' ? 'is-multiline' : ''}">${escapeHTML(answer)}</span>`;
  }
  const keys = lettersOf(question.answer);
  const matches = question.options.filter((option) => keys.has(option.key));
  if (!matches.length) {
    return `<span class="answer-value">${escapeHTML(question.answer || '未设置')}</span>`;
  }
  return matches
    .map(
      (option) => `
        <span class="correct-option">
          <b>${option.key}</b>
          <span>${escapeHTML(option.text)}</span>
        </span>
      `,
    )
    .join('');
}

function practiceTargetOptions(setup) {
  return { subjectId: setup.subjectId || '', bankId: setup.bankId || '' };
}

function normalizeSetupTarget(state, setup) {
  if (setup.bankId) {
    const bank = bankById(state, setup.bankId);
    if (bank) {
      setup.subjectId = bank.subjectId;
      return;
    }
    setup.bankId = '';
  }
  if (setup.subjectId && !subjectById(state, setup.subjectId)) setup.subjectId = '';
}

function practiceTargetLabel(state, setup) {
  const bank = setup.bankId ? bankById(state, setup.bankId) : null;
  const subject = setup.subjectId ? subjectById(state, setup.subjectId) : null;
  if (bank && subject) return `${subject.name} / ${bank.name}`;
  if (subject) return `${subject.name} · 科目总题库`;
  return '总题库';
}

function targetPickerHTML(state, setup) {
  const subject = setup.subjectId ? subjectById(state, setup.subjectId) : null;
  const banks = subject ? banksForSubject(state, subject.id) : [];
  return `
    <div class="practice-target-picker">
      <label class="practice-target-field">
        <span>科目</span>
        <div class="select-wrap">
          <select data-role="practice-subject" aria-label="选择科目">
            <option value="">全部科目</option>
            ${state.subjects
              .map(
                (item) =>
                  `<option value="${escapeHTML(item.id)}" ${item.id === setup.subjectId ? 'selected' : ''}>${escapeHTML(item.name)}</option>`,
              )
              .join('')}
          </select>
          ${icon('chevron-down', 14)}
        </div>
      </label>
      <label class="practice-target-field">
        <span>子题库</span>
        <div class="select-wrap">
          <select data-role="practice-bank" aria-label="选择子题库" ${subject ? '' : 'disabled'}>
            <option value="">${subject ? '科目总题库' : '先选择科目'}</option>
            ${banks
              .map(
                (bank) =>
                  `<option value="${escapeHTML(bank.id)}" ${bank.id === setup.bankId ? 'selected' : ''}>${escapeHTML(bank.name)}</option>`,
              )
              .join('')}
          </select>
          ${icon('chevron-down', 14)}
        </div>
      </label>
      <p class="practice-target-note">
        ${icon('layers', 14)} 当前范围：<strong>${escapeHTML(practiceTargetLabel(state, setup))}</strong>
      </p>
    </div>
  `;
}

function setupTemplate(state, setup) {
  const target = practiceTargetOptions(setup);
  const scopedQuestions = filterQuestionsByBank(state.questions, target);
  const scopedAnswerable = scopedQuestions.filter(isQuestionAnswerable);
  const scopedMastered = scopedAnswerable.filter(isMastered).length;
  const scopedWrong = scopedAnswerable.filter(
    (question) => question.stats.lastResult === 'wrong',
  ).length;
  const scopedMissing = scopedQuestions.length - scopedAnswerable.length;
  const available = scopeCount(state, setup.scope, target);
  const effective = setup.count === 'all' ? available : Math.min(Number(setup.count), available);
  const customCount = !setup.infinite && setup.count !== 'all' && !COUNT_OPTIONS.includes(setup.count);
  const scopeCards = Object.entries(SCOPE_META)
    .map(([key, meta]) => {
      const count = scopeCount(state, key, target);
      const active = setup.scope === key;
      return `
        <button type="button" class="scope-card ${active ? 'is-selected' : ''}" data-scope="${key}"
          aria-pressed="${active}" ${count === 0 ? 'data-empty="true"' : ''}>
          <span class="scope-card-icon">${icon(meta.icon, 19)}</span>
          <span class="scope-card-copy">
            <b>${meta.label}</b>
            <small>${meta.desc}</small>
          </span>
          <span class="scope-count">${count}</span>
        </button>
      `;
    })
    .join('');

  const masteryRate = scopedAnswerable.length
    ? Math.round((scopedMastered / scopedAnswerable.length) * 100)
    : 0;

  return `
    <div class="page practice-setup-page">
      <header class="page-header">
        <div class="page-heading">
          <p class="eyebrow">PRACTICE · 专注练习</p>
          <h1>开始一组练习</h1>
          <p class="page-sub">可以刷全部科目、某个科目总题库，或单独刷一个子题库。</p>
        </div>
        <div class="header-actions">
          <button type="button" class="btn primary" data-action="start" ${available === 0 ? 'disabled' : ''}>
            ${icon('play', 16)} 开始练习
          </button>
        </div>
      </header>

      <div class="practice-setup-grid">
        <section class="panel setup-panel">
          <div class="setup-section">
            <div class="setup-section-head">
              <span class="setup-index">01</span>
              <div><h2>题库范围</h2><p>选科目，或继续细分到子题库。</p></div>
            </div>
            ${targetPickerHTML(state, setup)}
          </div>

          <div class="setup-section">
            <div class="setup-section-head">
              <span class="setup-index">02</span>
              <div><h2>作答范围</h2><p>从当前题库范围里挑哪一批题？</p></div>
            </div>
            <div class="scope-grid">${scopeCards}</div>
            <p class="scope-empty-note" data-scope-empty ${available === 0 ? '' : 'hidden'}>
              ${icon('alert', 15)} 当前范围还没有可练习的题目，换一个范围试试。
            </p>
          </div>

          <div class="setup-section">
            <div class="setup-section-head">
              <span class="setup-index">03</span>
              <div><h2>题目数量</h2><p>固定题数、全部刷完，或者进入没有尽头的无限模式。</p></div>
            </div>
            <div class="choice-chips">
              ${COUNT_OPTIONS.map(
                (count) => `
                  <button type="button" class="choice-chip ${!setup.infinite && setup.count === count ? 'is-selected' : ''}"
                    data-count="${count}" aria-pressed="${!setup.infinite && setup.count === count}">
                    ${count === 'all' ? '全部' : `${count} 题`}
                  </button>
                `,
              ).join('')}
              <label class="custom-count ${customCount ? 'is-selected' : ''} ${setup.infinite ? 'is-disabled' : ''}">
                <span>自定义</span>
                <input type="number" min="1" max="${Math.max(available, 1)}" step="1"
                  data-role="custom-count" value="${setup.count === 'all' ? '' : setup.count}"
                  placeholder="题数" aria-label="自定义题目数量" ${setup.infinite ? 'disabled' : ''}>
              </label>
              <button type="button" class="choice-chip choice-chip-infinite ${setup.infinite ? 'is-selected' : ''}"
                data-infinite-mode aria-pressed="${setup.infinite}">
                <span class="infinity-mark">∞</span> 无限
              </button>
            </div>
            <p class="count-note" data-count-note>${
              setup.infinite
                ? `无限模式会打乱当前范围的 ${available} 道题循环出题，没有固定终点；点击「退出练习」手动结束。`
                : `当前范围共有 ${available} 道可练习题，选「全部」会一次刷完。`
            }</p>
          </div>

          <div class="setup-section">
            <div class="setup-section-head">
              <span class="setup-index">04</span>
              <div><h2>出题顺序</h2><p>随机更能检验真实掌握度。</p></div>
            </div>
            <div class="segmented-control">
              <button type="button" class="${!setup.shuffle ? 'is-selected' : ''}" data-order="ordered"
                aria-pressed="${!setup.shuffle}" ${setup.infinite ? 'disabled' : ''}>${icon('list', 15)} 顺序</button>
              <button type="button" class="${setup.shuffle ? 'is-selected' : ''}" data-order="shuffle"
                aria-pressed="${setup.shuffle}" ${setup.infinite ? 'disabled' : ''}>${icon('shuffle', 15)} 随机</button>
            </div>
            <p class="count-note" data-order-note ${setup.infinite ? '' : 'hidden'}>无限模式固定使用随机顺序。</p>
          </div>

          <div class="setup-section">
            <div class="setup-section-head">
              <span class="setup-index">05</span>
              <div><h2>答题方式</h2><p>决定什么时候查看答案和正确率。</p></div>
            </div>
            <div class="feedback-mode-grid">
              ${Object.entries(FEEDBACK_MODE_META)
                .map(
                  ([mode, meta]) => `
                    <button type="button" class="feedback-mode-card ${setup.feedbackMode === mode ? 'is-selected' : ''}"
                      data-feedback-mode="${mode}" aria-pressed="${setup.feedbackMode === mode}"
                      ${setup.infinite && mode === 'afterAll' ? 'disabled' : ''}>
                      <span class="feedback-mode-icon">${icon(meta.icon, 18)}</span>
                      <span class="feedback-mode-copy">
                        <b>${meta.label}</b>
                        <small>${meta.desc}</small>
                      </span>
                    </button>
                  `,
                )
                .join('')}
            </div>
            <p class="count-note" data-feedback-note>${
              setup.infinite
                ? '无限模式固定使用「每题查看答案」；单选/判断题提交后自动进入下一题，多选、填空和简答确认提交。简答题提交后会显示参考答案，需自行评分。'
                : '单选/判断题选择后自动提交；选择「全部做完后查看」时会直接进入下一题。多选、填空和简答仍需确认提交；简答题提交后需自评。'
            }</p>
          </div>

          ${
            OFFLINE_MODE
              ? ''
              : `<div class="setup-section">
                  <div class="setup-section-head">
                    <span class="setup-index">06</span>
                    <div><h2>AI 辅导</h2><p>不需要时可以关闭侧栏，换成更专注的界面。</p></div>
                  </div>
                  <label class="setting-toggle">
                    <span class="setting-toggle-copy">
                      <b>显示 AI 辅导侧栏</b>
                      <small>练习中随时向 AI 提问；关闭后仍可从题目右上角临时打开。</small>
                    </span>
                    <span class="switch-control">
                      <input type="checkbox" data-role="practice-show-ai" ${setup.showAI ? 'checked' : ''}>
                      <span class="switch-track" aria-hidden="true"><span></span></span>
                    </span>
                  </label>
                </div>`
          }

          <div class="setup-start-row">
            <div class="setup-start-copy">
              <span><b data-start-count>${setup.infinite ? '∞' : effective}</b>
                <span data-start-unit>${setup.infinite ? '无限出题' : '道题'}</span></span>
              <small data-start-estimate>${
                setup.infinite
                  ? `无限模式 · 随机顺序 · ${escapeHTML(practiceTargetLabel(state, setup))} · 随时手动退出`
                  : `${setup.shuffle ? '随机顺序' : '按题库顺序'} · ${escapeHTML(
                      practiceTargetLabel(state, setup),
                    )} · 预计 ${Math.max(1, Math.ceil(effective * 0.6))} 分钟`
              }</small>
            </div>
            <button type="button" class="btn primary btn-lg" data-action="start" ${available === 0 ? 'disabled' : ''}>
              开始练习 ${icon('arrow-right', 17)}
            </button>
          </div>
        </section>

        <aside class="practice-aside">
          <article class="panel practice-motto">
            <span class="motto-icon">${icon('target', 22)}</span>
            <p class="eyebrow">A SMALL SESSION</p>
            <h2>一次只专注<br>眼前这一道题。</h2>
            <p>不做无意义的重复。答对后连续两次，才会被标记为掌握。</p>
            <div class="motto-list">
              <span>${icon('check', 14)} 即时判分与解析</span>
              <span>${icon('refresh', 14)} 错题自动归档</span>
              <span>${icon('keyboard', 14)} 支持键盘作答</span>
            </div>
          </article>

          <article class="panel readiness-panel">
            <div class="readiness-head">
              <h3>当前范围准备度</h3>
              <span>${masteryRate}%</span>
            </div>
            <div class="readiness-bar"><span style="width:${masteryRate}%"></span></div>
            <div class="readiness-stats">
              <div><strong>${scopedMastered}</strong><span>已掌握</span></div>
              <div><strong>${scopedAnswerable.length - scopedMastered}</strong><span>待掌握</span></div>
              <div><strong>${scopedWrong}</strong><span>错题</span></div>
            </div>
            ${
              scopedMissing
                ? `<button type="button" class="readiness-link" data-action="go-library">
                    ${icon('alert', 14)} ${scopedMissing} 道题缺答案，去补齐 ${icon('chevron-right', 13)}
                  </button>`
                : ''
            }
          </article>
        </aside>
      </div>
    </div>
  `;
}

function blockedTemplate(state) {
  const hasQuestions = state.questions.length > 0;
  const hasSubjects = state.subjects.length > 0;
  const hasBanks = state.banks.length > 0;
  const title = hasQuestions
    ? '题目还缺答案'
    : !hasSubjects
      ? '先创建科目和子题库'
      : !hasBanks
        ? '先创建子题库'
        : '题库还是空的';
  const copy = hasQuestions
    ? '导入的题目需要录入正确答案后才能进入练习。可以先到题库里逐题补充。'
    : !hasSubjects
      ? '题库按「科目 → 子题库」组织。先建一个科目，再建子题库，然后导入题目。'
      : !hasBanks
        ? '科目已经创建好了，接下来在科目里新建一个子题库。'
        : '先导入几张题目图片，识别校对并保存后，就能开始刷题。';
  return `
    <div class="page practice-setup-page">
      <header class="page-header">
        <div class="page-heading">
          <p class="eyebrow">PRACTICE · 专注练习</p>
          <h1>开始一组练习</h1>
          <p class="page-sub">只练有答案的题。作答后即时判分，错题自动进入错题本。</p>
        </div>
      </header>
      <section class="panel practice-empty">
        <span class="empty-illustration">${icon(hasQuestions ? 'alert' : hasBanks ? 'layers' : 'book', 28)}</span>
        <h2>${title}</h2>
        <p>${copy}</p>
        <div class="empty-actions">
          ${
            hasQuestions
              ? `<button type="button" class="btn primary" data-action="go-library">${icon('edit', 16)} 去题库补答案</button>`
              : `<button type="button" class="btn primary" data-action="go-library">${icon(hasBanks ? 'image' : 'plus', 16)} ${
                  hasBanks ? '去题库导入题目' : '去创建科目与子题库'
                }</button>`
          }
          ${
            hasBanks
              ? `<button type="button" class="btn subtle" data-action="go-import">${icon('plus', 16)} 继续导入</button>`
              : ''
          }
        </div>
      </section>
    </div>
  `;
}

function userAnswerMarkup(question, result) {
  if (question.type !== 'short' || !String(result.given || '').trim()) return '';
  return `
    <div class="correct-answer-line self-response-line">
      <span>你的作答</span>
      <div><span class="answer-value is-multiline">${escapeHTML(result.given)}</span></div>
    </div>
  `;
}

function feedbackTemplate(question, result, explanation) {
  const isCorrect = result.correct === true;
  const shortAnswer = question.type === 'short';
  return `
    <section class="feedback ${isCorrect ? 'is-correct' : 'is-wrong'}" data-feedback>
      <div class="feedback-head">
        <span class="feedback-icon">${icon(isCorrect ? 'check' : 'x', 18)}</span>
        <div>
          <h3>${
            shortAnswer
              ? result.revealed
                ? '这题先记下来。'
                : isCorrect
                  ? '自评为答对，已记录。'
                  : '已标记为需复习。'
              : isCorrect
                ? '答对了，保持住。'
                : result.revealed
                  ? '这题先记下来。'
                  : '差一点，再看看。'
          }</h3>
          <p>${
            shortAnswer
              ? result.revealed
                ? '本题已按未掌握记入错题本。'
                : question.answer
                  ? '参考答案仅供参考，可对照解析继续整理自己的答案。'
                  : '这道题没有录入参考答案，可结合解析整理自己的答案。'
              : isCorrect
                ? '答案已记入掌握进度。'
                : result.revealed
                  ? '本题已按未掌握记入错题本。'
                  : '已自动加入错题本，下次会优先出现。'
          }</p>
        </div>
      </div>
      ${userAnswerMarkup(question, result)}
      <div class="correct-answer-line">
        <span>${shortAnswer ? '参考答案（仅供参考）' : '正确答案'}</span>
        <div>${correctAnswerMarkup(question)}</div>
      </div>
      ${
        explanation
          ? `<div class="feedback-explanation">
              <span>${icon('file-text', 14)} 解析</span>
              <p>${escapeHTML(explanation)}</p>
            </div>`
          : ''
      }
    </section>
  `;
}

function selfGradeTemplate(question, result, explanation) {
  return `
    <section class="feedback self-grade" data-feedback>
      <div class="feedback-head">
        <span class="feedback-icon">${icon('edit', 18)}</span>
        <div>
          <h3>${question.answer ? '对照参考答案，给自己评分。' : '回顾你的作答，给自己评分。'}</h3>
          <p>${
            question.answer
              ? '简答题没有唯一答案，参考答案仅供参考。请根据作答完整度选择「答对了」或「还需复习」，结果会立即计入本次统计。'
              : '这道题没有录入参考答案。请根据作答完整度选择「答对了」或「还需复习」，结果会立即计入本次统计。'
          }</p>
        </div>
      </div>
      ${userAnswerMarkup(question, result)}
      <div class="correct-answer-line">
        <span>参考答案（仅供参考）</span>
        <div>${correctAnswerMarkup(question)}</div>
      </div>
      ${
        explanation
          ? `<div class="feedback-explanation">
              <span>${icon('file-text', 14)} 解析</span>
              <p>${escapeHTML(explanation)}</p>
            </div>`
          : ''
      }
      <div class="self-grade-actions">
        <button type="button" class="btn primary" data-action="self-grade" data-correct="true">
          ${icon('check', 16)} 答对了
        </button>
        <button type="button" class="btn subtle" data-action="self-grade" data-correct="false">
          ${icon('refresh', 16)} 还需复习
        </button>
      </div>
    </section>
  `;
}

export function createPracticeView(app) {
  let rootRef = null;
  let controller = null;
  let screen = 'setup';
  let session = null;
  let practiceAI = null;
  let setup = {
    scope: 'all',
    count: app.state.settings.practiceCount || 10,
    shuffle: app.state.settings.practiceShuffle !== false,
    infinite: app.state.settings.practiceInfinite === true,
    showAI: OFFLINE_MODE ? false : app.state.settings.practiceShowAI !== false,
    feedbackMode: normalizeFeedbackMode(app.state.settings.practiceFeedbackMode),
    subjectId: '',
    bankId: '',
  };
  if (setup.infinite) {
    setup.shuffle = true;
    setup.feedbackMode = 'immediate';
  }
  let keyHandlerInstalled = false;
  let studyClockInstalled = false;
  let studyIdleTimer = null;
  const STUDY_IDLE_MS = 90_000;

  function currentQuestion() {
    return session?.questions[session.index] || null;
  }

  function ensurePracticeAI() {
    if (OFFLINE_MODE) return null;
    if (!practiceAI) {
      practiceAI = createPracticeAIChat({
        getConfig: getAssistantConfig,
        onConfigure: () => {
          app.openAISettings({
            onSaved: () => practiceAI?.refreshConfig(),
          });
        },
        onHide: () => hidePracticeAI(),
      });
    }
    return practiceAI;
  }

  function disposePracticeAI() {
    practiceAI?.destroy();
    practiceAI = null;
  }

  function hidePracticeAI() {
    setup.showAI = false;
    persistSetup();
    if (screen === 'session') {
      renderCurrent();
      toast('已隐藏 AI 辅导侧栏，可从题目右上角重新打开。', 'info', 3200);
    }
  }

  function showPracticeAI() {
    if (OFFLINE_MODE) return;
    setup.showAI = true;
    persistSetup();
    if (screen === 'session') {
      renderCurrent();
      ensurePracticeAI().focus();
    }
  }

  function resetSession() {
    stopStudyClock();
    disposePracticeAI();
    session = null;
    screen = 'setup';
  }

  function effectiveCount(scope = setup.scope, count = setup.count) {
    const available = scopeCount(app.state, scope, practiceTargetOptions(setup));
    if (count === 'all') return available;
    return Math.min(Number(count) || 0, available);
  }

  function persistSetup() {
    app.state.settings.practiceCount = setup.count;
    app.state.settings.practiceShuffle = setup.shuffle;
    app.state.settings.practiceFeedbackMode = setup.feedbackMode;
    app.state.settings.practiceInfinite = setup.infinite;
    app.state.settings.practiceShowAI = setup.showAI;
    app.persist();
  }

  function start(options = {}) {
    let questions = [];
    let label = '';
    let infinitePool = [];
    let infiniteMode = false;
    let sessionScope = 'custom';
    let targetSubjectId = '';
    let targetBankId = '';
    if (options.feedbackMode) {
      setup.feedbackMode = normalizeFeedbackMode(options.feedbackMode);
    }

    if (Array.isArray(options.questionIds) && options.questionIds.length) {
      const ids = new Set(options.questionIds);
      questions = app.state.questions.filter((question) => ids.has(question.id) && isQuestionAnswerable(question));
      label = options.label || '指定题目';
    } else {
      if (
        Object.prototype.hasOwnProperty.call(options, 'subjectId') ||
        Object.prototype.hasOwnProperty.call(options, 'bankId')
      ) {
        setup.subjectId = options.subjectId || '';
        setup.bankId = options.bankId || '';
      }
      setup.scope = options.scope || setup.scope;
      setup.count = options.count ?? setup.count;
      setup.shuffle = options.shuffle ?? setup.shuffle;
      if (
        setup.count !== 'all' &&
        (!Number.isInteger(Number(setup.count)) || Number(setup.count) < 1 || Number(setup.count) > 1000)
      ) {
        setup.count = 10;
      } else if (setup.count !== 'all') {
        setup.count = Number(setup.count);
      }
      normalizeSetupTarget(app.state, setup);
      infiniteMode =
        setup.infinite === true &&
        !Object.prototype.hasOwnProperty.call(options, 'count');
      sessionScope = setup.scope;
      targetSubjectId = setup.subjectId;
      targetBankId = setup.bankId;
      const meta = SCOPE_META[setup.scope] || SCOPE_META.all;
      if (infiniteMode) {
        setup.shuffle = true;
        setup.feedbackMode = 'immediate';
        infinitePool = selectPracticeQuestions(app.state, {
          scope: setup.scope,
          count: 'all',
          shuffle: true,
          ...practiceTargetOptions(setup),
        });
        questions = infinitePool.slice(0, 1);
        label = `${practiceTargetLabel(app.state, setup)} · ${meta.label} · 无限随机`;
      } else {
        questions = selectPracticeQuestions(app.state, {
          scope: setup.scope,
          count: setup.count,
          shuffle: setup.shuffle,
          ...practiceTargetOptions(setup),
        });
        label = `${practiceTargetLabel(app.state, setup)} · ${meta.label} · ${
          setup.shuffle ? '随机' : '顺序'
        }`;
      }
      persistSetup();
    }

    if (!questions.length) {
      toast('当前范围没有可练习的题目。', 'info');
      screen = 'setup';
      renderCurrent();
      return;
    }

    const shuffleOptionsForSession =
      options.shuffle !== undefined ? Boolean(options.shuffle) : setup.shuffle;
    if (shuffleOptionsForSession) {
      // 只改本次练习中的展示副本，题库原题保持不变。
      questions = questions.map((question) => shuffleQuestionOptions(question));
    }

    session = {
      questions,
      index: 0,
      selected: new Set(),
      fillValue: '',
      submitted: false,
      result: null,
      given: '',
      records: [],
      scope: sessionScope,
      targetSubjectId,
      targetBankId,
      accuracyEligible:
        !infiniteMode && (sessionScope === 'all' || sessionScope === 'unmastered'),
      accuracyCommitted: false,
      outcomes: Array(questions.length).fill(null),
      answers: Array(questions.length).fill(null),
      skipped: 0,
      startedAt: Date.now(),
      finishedAt: null,
      answering: true,
      lastTickAt: null,
      lastActivityAt: Date.now(),
      pendingDurationMs: 0,
      activeDurationMs: 0,
      shuffleOptions: shuffleOptionsForSession,
      label,
      feedbackMode: setup.feedbackMode,
      total: questions.length,
      infinite: infiniteMode,
      infinitePool,
      infiniteQueue: infinitePool.slice(1),
    };
    screen = 'session';
    ensurePracticeAI();
    renderCurrent();
    resumeStudyClock();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function sessionStats() {
    const correct = session.records.filter((record) => record.correct).length;
    const wrong = session.records.length - correct;
    return { correct, wrong, answered: session.records.length };
  }

  function isStudyClockAllowed() {
    return (
      screen === 'session' &&
      Boolean(session) &&
      session.answering === true &&
      document.visibilityState === 'visible' &&
      !document.querySelector('dialog[open]')
    );
  }

  function clearStudyIdleTimer() {
    if (studyIdleTimer) {
      window.clearTimeout(studyIdleTimer);
      studyIdleTimer = null;
    }
  }

  function scheduleStudyIdle() {
    clearStudyIdleTimer();
    if (!isStudyClockAllowed()) return;
    studyIdleTimer = window.setTimeout(() => {
      studyIdleTimer = null;
      if (!session || screen !== 'session') return;
      // 允许一段阅读时间，但把超过空置阈值的时间排除在计时之外。
      const now = Date.now();
      const idleEnd = Math.min(now, (session.lastActivityAt || now) + STUDY_IDLE_MS);
      pauseStudyClock(idleEnd);
    }, STUDY_IDLE_MS);
  }

  function pauseStudyClock(endAt = Date.now()) {
    if (!session) return;
    const end = Math.max(0, Math.min(endAt, Date.now()));
    const active = session.lastTickAt ? Math.max(0, end - session.lastTickAt) : 0;
    const duration = (session.pendingDurationMs || 0) + active;
    session.pendingDurationMs = 0;
    session.lastTickAt = null;
    clearStudyIdleTimer();
    if (duration >= 1000) {
      session.activeDurationMs = (session.activeDurationMs || 0) + duration;
      recordStudyDuration(app.state, duration);
      app.persist();
    }
  }

  function resumeStudyClock() {
    if (!session || !isStudyClockAllowed()) return;
    const now = Date.now();
    if (!session.lastTickAt) session.lastTickAt = now;
    session.lastActivityAt = now;
    scheduleStudyIdle();
  }

  function stopStudyClock() {
    clearStudyIdleTimer();
    if (session) {
      session.answering = false;
      session.pendingDurationMs = 0;
      session.lastTickAt = null;
    }
  }

  function markStudyActivity() {
    if (!session || screen !== 'session') return;
    if (!isStudyClockAllowed()) {
      if (session.lastTickAt) pauseStudyClock();
      return;
    }
    const now = Date.now();
    session.lastActivityAt = now;
    if (!session.lastTickAt) session.lastTickAt = now;
    scheduleStudyIdle();
  }

  function consumeStudyDuration({ stop = false } = {}) {
    if (!session) return 0;
    const now = Date.now();
    const active = session.lastTickAt ? Math.max(0, now - session.lastTickAt) : 0;
    const duration = (session.pendingDurationMs || 0) + active;
    session.pendingDurationMs = 0;
    session.lastActivityAt = now;
    if (stop) {
      session.lastTickAt = null;
      clearStudyIdleTimer();
    } else {
      session.lastTickAt = isStudyClockAllowed() ? now : null;
      if (session.lastTickAt) scheduleStudyIdle();
      else clearStudyIdleTimer();
    }
    return duration;
  }

  /** 结束当前题目的作答计时，返回本次作答题目的有效时长。 */
  function stopAnswerClock() {
    if (!session) return 0;
    session.answering = false;
    return consumeStudyDuration({ stop: true });
  }

  function recordActiveStudyDuration(durationMs) {
    if (durationMs < 1000) return;
    if (session) {
      session.activeDurationMs = (session.activeDurationMs || 0) + durationMs;
    }
    recordStudyDuration(app.state, durationMs);
    app.persist();
  }

  function flushStudyDuration() {
    if (!session) return;
    session.answering = false;
    recordActiveStudyDuration(consumeStudyDuration({ stop: true }));
  }

  function saveCurrentAnswerState() {
    if (!session || !currentQuestion()) return;
    session.answers[session.index] = {
      selected: [...session.selected],
      fillValue: session.fillValue,
      submitted: session.submitted,
      result: session.result,
      given: session.given,
      skipped: session.outcomes[session.index] === 'skipped' && !session.submitted,
    };
  }

  function restoreAnswerState(index) {
    const saved = session.answers[index];
    session.selected = new Set(saved?.selected || []);
    session.fillValue = saved?.fillValue || '';
    session.submitted = Boolean(saved?.submitted);
    session.result = saved?.result || null;
    session.given = saved?.given || '';
  }

  function goToQuestion(index, { scroll = 'smooth' } = {}) {
    if (!session || index < 0 || index >= session.total) return;
    saveCurrentAnswerState();
    const wasAnswering = Boolean(session.answering && session.lastTickAt);
    session.index = index;
    restoreAnswerState(index);
    if (session.submitted) {
      // 回到已提交的题目时只显示解析，不计学习时长。
      session.answering = false;
      if (wasAnswering) {
        recordActiveStudyDuration(stopAnswerClock());
      } else {
        clearStudyIdleTimer();
        session.lastTickAt = null;
      }
    } else {
      // 只有停在未提交的题目上才继续计时。
      session.answering = true;
      resumeStudyClock();
    }
    renderCurrent();
    window.scrollTo({ top: 0, behavior: scroll });
  }

  /**
   * 只有整组题目全部作答、且不是错题复习/收藏练习/指定题目/无限模式时，
   * 才把这一组练习作为一个整体写入正确率记录。暂存数据不会逐题进入统计。
   */
  function commitCompletedSessionAccuracy() {
    if (
      !session ||
      !session.accuracyEligible ||
      session.accuracyCommitted ||
      session.infinite ||
      !session.total ||
      session.records.length < session.total
    ) {
      return false;
    }
    const correct = session.records.filter((record) => record.correct).length;
    const recorded = recordCompletedSession(app.state, {
      at: new Date().toISOString(),
      scope: session.scope,
      subjectId: session.targetSubjectId,
      bankId: session.targetBankId,
      label: session.label,
      total: session.total,
      answered: session.records.length,
      correct,
    });
    if (!recorded) return false;
    session.accuracyCommitted = true;
    app.persist();
    return true;
  }

  function finishSession({ manual = false } = {}) {
    if (!session) return;
    flushStudyDuration();
    stopStudyClock();
    saveCurrentAnswerState();
    // 完整做完才记录；跳过题目或中途退出都不会写入正确率。
    commitCompletedSessionAccuracy();
    disposePracticeAI();
    session.finishedAt = Date.now();
    session.endedManually = manual;
    screen = 'summary';
    renderCurrent();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateSelectionUi() {
    if (!rootRef || !session) return;
    const question = currentQuestion();
    if (!question) return;
    const buttons = rootRef.querySelectorAll('[data-answer-key]');
    buttons.forEach((button) => {
      const active = session.selected.has(button.dataset.answerKey);
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const submitButton = rootRef.querySelector('[data-action="submit-answer"]');
    if (submitButton) {
      submitButton.disabled = isWrittenAnswerType(question.type)
        ? !session.fillValue.trim()
        : session.selected.size === 0;
    }
  }

  function toggleOption(key) {
    if (!session || session.submitted) return;
    const question = currentQuestion();
    if (!question || !isChoiceType(question.type)) return;
    if (!question.options.some((option) => option.key === key)) return;

    if (question.type === 'single' || question.type === 'judge') {
      if (session.selected.has(key) && session.selected.size === 1) session.selected.clear();
      else session.selected = new Set([key]);
    } else if (session.selected.has(key)) {
      session.selected.delete(key);
    } else {
      session.selected.add(key);
    }
    updateSelectionUi();

    if (
      (question.type === 'single' || question.type === 'judge') &&
      session.selected.size === 1
    ) {
      submitAnswer();
    }
  }

  function appendInfiniteQuestion() {
    if (!session?.infinite) return null;
    const pool = Array.isArray(session.infinitePool) ? session.infinitePool : [];
    if (!pool.length) return null;

    if (!session.infiniteQueue?.length) {
      const cycle = shuffleCopy(pool);
      const previous = session.questions[session.questions.length - 1];
      if (cycle.length > 1 && previous && cycle[0].id === previous.id) {
        const swapIndex = cycle.findIndex((question) => question.id !== previous.id);
        if (swapIndex > 0) {
          [cycle[0], cycle[swapIndex]] = [cycle[swapIndex], cycle[0]];
        }
      }
      session.infiniteQueue = cycle;
    }

    const next = session.infiniteQueue.shift();
    if (!next) return null;
    session.questions.push(
      session.shuffleOptions ? shuffleQuestionOptions(next) : next,
    );
    session.answers.push(null);
    session.outcomes.push(null);
    session.total = session.questions.length;
    return session.questions.length - 1;
  }

  function nextQuestion() {
    if (!session) return;
    saveCurrentAnswerState();
    if (session.infinite) {
      if (session.index + 1 >= session.total) appendInfiniteQuestion();
      if (session.index + 1 < session.total) goToQuestion(session.index + 1);
      return;
    }
    if (session.index + 1 >= session.total) {
      finishSession();
      return;
    }
    goToQuestion(session.index + 1);
  }

  function previousQuestion() {
    if (!session || session.index <= 0) return;
    goToQuestion(session.index - 1);
  }

  function skipQuestion() {
    if (!session || session.submitted) return;
    const wasSkipped = session.outcomes[session.index] === 'skipped';
    session.outcomes[session.index] = 'skipped';
    if (!wasSkipped) session.skipped += 1;
    recordActiveStudyDuration(stopAnswerClock());
    saveCurrentAnswerState();
    nextQuestion();
  }

  function scrollToFeedback() {
    window.setTimeout(() => {
      rootRef?.querySelector('[data-feedback]')?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }, 60);
  }

  function submitAnswer({ reveal = false } = {}) {
    if (!session || session.submitted) return;
    const question = currentQuestion();
    if (!question) return;

    const written = isWrittenAnswerType(question.type);
    const given = written ? session.fillValue.trim() : [...session.selected].sort().join('');
    if (!reveal && !given) {
      toast(
        question.type === 'short'
          ? '先写下你的作答。'
          : written
            ? '先写下你的答案。'
            : '请选择一个选项。',
        'info',
      );
      return;
    }

    if (session.outcomes[session.index] === 'skipped') {
      session.skipped = Math.max(0, session.skipped - 1);
    }

    // 简答题没有唯一文本答案：提交后先请用户对照参考答案自评，再计入统计。
    if (question.type === 'short' && !reveal) {
      session.pendingDurationMs = stopAnswerClock();
      session.given = given;
      session.submitted = true;
      session.result = {
        correct: null,
        given,
        expected: question.answer,
        pendingSelfGrade: true,
        revealed: false,
      };
      saveCurrentAnswerState();
      renderCurrent();
      scrollToFeedback();
      return;
    }

    const durationMs = stopAnswerClock();
    session.activeDurationMs = (session.activeDurationMs || 0) + durationMs;
    const graded =
      question.type === 'short'
        ? { correct: false, given, expected: question.answer }
        : gradeQuestion(question, given);
    const correct = reveal ? false : graded.correct;

    session.given = given;
    session.submitted = true;
    session.result = { ...graded, correct, revealed: reveal, pendingSelfGrade: false };
    session.outcomes[session.index] = correct ? 'correct' : 'wrong';
    session.records.push({
      questionId: question.id,
      given,
      correct,
      revealed: reveal,
      index: session.index,
    });
    saveCurrentAnswerState();

    recordAttempt(app.state, question, correct, { durationMs });
    app.persist();

    if (session.feedbackMode === 'afterAll') {
      nextQuestion();
      return;
    }

    renderCurrent();
    scrollToFeedback();
  }

  function selfGradeShortAnswer(correct) {
    if (!session || !session.submitted || !session.result?.pendingSelfGrade) return;
    const question = currentQuestion();
    if (!question || question.type !== 'short') return;

    const gradedCorrect = Boolean(correct);
    const durationMs = consumeStudyDuration({ stop: true });
    session.activeDurationMs = (session.activeDurationMs || 0) + durationMs;
    session.result = {
      ...session.result,
      correct: gradedCorrect,
      pendingSelfGrade: false,
      selfGraded: true,
    };
    session.outcomes[session.index] = gradedCorrect ? 'correct' : 'wrong';
    session.records.push({
      questionId: question.id,
      given: session.given,
      correct: gradedCorrect,
      revealed: false,
      selfGraded: true,
      index: session.index,
    });
    saveCurrentAnswerState();

    recordAttempt(app.state, question, gradedCorrect, { durationMs });
    app.persist();

    if (session.feedbackMode === 'afterAll') {
      nextQuestion();
      return;
    }

    renderCurrent();
    scrollToFeedback();
  }

  function sessionTemplate() {
    const question = currentQuestion();
    const stats = sessionStats();
    const infinite = Boolean(session.infinite);
    const showAI = Boolean(setup.showAI);
    const deferred = session.feedbackMode === 'afterAll';
    const pendingSelfGrade = session.result?.pendingSelfGrade === true;
    const showSelfGrade = session.submitted && pendingSelfGrade;
    const showFeedback = session.submitted && !deferred && !pendingSelfGrade;
    const expectedKeys = lettersOf(question.answer);
    const progress = infinite
      ? 0
      : Math.round(((session.index + (showFeedback ? 1 : 0)) / session.total) * 100);
    const dotIndexes = infinite
      ? session.questions.map((_, index) => index).slice(-24)
      : session.questions.map((_, index) => index);
    const isWritten = isWrittenAnswerType(question.type);
    const isShort = question.type === 'short';
    const optionOrderNote = session.shuffleOptions ? ' · 选项顺序已打乱' : '';
    const answerTone = showFeedback ? (session.result.correct ? 'is-correct' : 'is-wrong') : '';

    const optionsHTML = isShort
      ? `
        <div class="fill-answer short-answer ${answerTone}">
          <label for="fill-answer-input">你的作答 <span>提交后自行评分</span></label>
          <textarea id="fill-answer-input" class="fill-input short-answer-input" rows="5"
            data-role="fill-answer" placeholder="写下答案要点；Ctrl + Enter 提交"
            ${session.submitted ? 'disabled' : ''}>${escapeHTML(session.given || session.fillValue)}</textarea>
        </div>
      `
      : isWritten
        ? `
        <div class="fill-answer ${answerTone}">
          <label for="fill-answer-input">你的答案</label>
          <input id="fill-answer-input" class="fill-input" type="text" data-role="fill-answer"
            placeholder="输入答案后按 Enter 提交" autocomplete="off"
            value="${escapeHTML(session.given || session.fillValue)}" ${session.submitted ? 'disabled' : ''}>
        </div>
      `
        : `
        <div class="answer-options" role="group" aria-label="作答选项">
          ${question.options
            .map((option) => {
              const selected = session.selected.has(option.key);
              const isExpected = showFeedback && expectedKeys.has(option.key);
              const isWrongChoice = showFeedback && selected && !expectedKeys.has(option.key);
              const classes = [
                'answer-option',
                selected ? 'is-selected' : '',
                isExpected ? 'is-correct' : '',
                isWrongChoice ? 'is-wrong' : '',
              ]
                .filter(Boolean)
                .join(' ');
              const mark = isExpected
                ? icon('check', 17)
                : isWrongChoice
                  ? icon('x', 17)
                  : selected
                    ? '<span class="selection-dot"></span>'
                    : '';
              return `
                <button type="button" class="${classes}" data-answer-key="${option.key}"
                  aria-pressed="${selected}" ${session.submitted ? 'disabled' : ''}>
                  <span class="option-key">${option.key}</span>
                  <span class="option-body">${escapeHTML(option.text)}</span>
                  <span class="option-mark">${mark}</span>
                </button>
              `;
            })
            .join('')}
        </div>
        <p class="answer-guide">${
          question.type === 'multiple'
            ? `多选题 · 选择所有正确选项后提交${optionOrderNote}`
            : question.type === 'judge'
              ? `判断题 · 选择后自动提交${deferred ? '并进入下一题' : ''}${optionOrderNote}`
              : `单选题 · 选择后自动提交${deferred ? '并进入下一题' : ''}${optionOrderNote}`
        }</p>
      `;

    const canSubmit = isWritten ? Boolean(session.fillValue.trim()) : session.selected.size > 0;
    const modeMeta = FEEDBACK_MODE_META[deferred ? 'afterAll' : 'immediate'];

    return `
      <div class="page session-page">
        <header class="session-topbar">
          <button type="button" class="session-exit" data-action="exit-session">
            ${icon('arrow-left', 17)} <span>退出练习</span>
          </button>
          <div class="session-progress">
            <div class="session-progress-copy">
              <span>第 <b>${session.index + 1}</b> 题${
                infinite ? '<em class="session-infinite-tag">∞ 无限</em>' : ` / ${session.total} 题`
              }</span>
              <span>${session.label}</span>
            </div>
            ${
              infinite
                ? '<div class="progress-track progress-track-infinite" aria-hidden="true"><span></span></div>'
                : `<div class="progress-track"><span style="width:${progress}%"></span></div>`
            }
          </div>
          ${
            deferred
              ? `<div class="session-score is-neutral">
                  <span class="score-pending">${icon('flag', 13)} 已答 ${stats.answered}</span>
                </div>`
              : `<div class="session-score">
                  <span class="score-correct">${icon('check', 13)} ${stats.correct}</span>
                  <span class="score-wrong">${icon('x', 13)} ${stats.wrong}</span>
                </div>`
          }
        </header>

        <div class="session-layout ${showAI ? 'has-ai' : ''}">
          <main class="question-stage panel">
            <div class="stage-head">
              <div class="stage-meta">
                <span class="type-badge type-${typeClass(question.type)}">${QUESTION_TYPES[question.type] || '题目'}</span>
                <span>已练习 ${question.stats.attempts} 次</span>
                <span class="feedback-mode-badge ${deferred ? 'is-deferred' : ''}">
                  ${icon(modeMeta.icon, 12)} ${modeMeta.label}
                </span>
                ${isMastered(question) ? `<span class="mastered-tag">${icon('check', 12)} 已掌握</span>` : ''}
              </div>
              <div class="stage-head-actions">
                <button type="button" class="ai-coach-trigger ${showAI ? '' : 'is-off'}"
                  data-action="${showAI ? 'focus-ai-chat' : 'show-ai-chat'}"
                  aria-controls="practice-ai-panel" aria-expanded="${showAI}"
                  title="${showAI ? '在 AI 面板中提问' : '显示 AI 辅导侧栏'}">
                  ${icon('sparkles', 15)} ${showAI ? 'AI 辅导' : '显示 AI 辅导'}
                </button>
                <button type="button" class="icon-btn favorite-button ${question.favorite ? 'is-favorite' : ''}"
                  data-action="toggle-favorite" aria-label="${question.favorite ? '取消收藏' : '收藏这道题'}"
                  aria-pressed="${question.favorite}">
                  ${icon('star', 18)}
                </button>
              </div>
            </div>

            <h1 class="question-stem">${escapeHTML(question.stem)}</h1>
            ${optionsHTML}
            ${
              session.submitted && deferred && !showSelfGrade
                ? `<p class="deferred-review-note">${icon('check-circle', 14)} 本题已作答。答案会在全部完成后统一显示。</p>`
                : ''
            }

            ${
              showSelfGrade
                ? selfGradeTemplate(question, session.result, question.explanation)
                : showFeedback
                  ? feedbackTemplate(question, session.result, question.explanation)
                  : ''
            }

            <footer class="stage-actions">
              <div class="secondary-actions">
                <button type="button" class="text-button stage-prev" data-action="prev-question"
                  ${session.index === 0 ? 'disabled' : ''}>
                  ${icon('arrow-left', 15)} 上一题
                </button>
                ${
                  session.submitted
                    ? ''
                    : `<button type="button" class="text-button" data-action="skip-question">跳过</button>
                       ${
                         deferred
                           ? ''
                           : `<button type="button" class="text-button" data-action="reveal-answer">
                               ${icon('eye', 15)} 不会，查看答案
                             </button>`
                       }`
                }
              </div>
              <div class="stage-primary-actions">
                ${
                  session.submitted
                    ? pendingSelfGrade
                      ? `
                        <span class="stage-hint self-grade-hint">
                          ${icon('edit', 14)} ${
                            question.answer ? '请先对照参考答案完成自评' : '请先完成本题自评'
                          }
                        </span>
                      `
                      : `
                        <span class="stage-hint">
                          ${showFeedback ? `${icon('keyboard', 14)} 按 Enter 继续` : '已作答，可继续下一题'}
                        </span>
                        <button type="button" class="btn primary btn-lg" data-action="next-question">
                          ${infinite ? '下一题' : session.index + 1 >= session.total ? '查看结果' : '下一题'} ${icon('arrow-right', 17)}
                        </button>
                      `
                    : question.type === 'single' || question.type === 'judge'
                      ? `
                        <span class="stage-hint auto-submit-hint">
                          ${icon('check', 14)}
                          选择选项后自动提交${deferred ? '并进入下一题' : ''}
                        </span>
                      `
                      : `
                        <button type="button" class="btn primary btn-lg" data-action="submit-answer" ${canSubmit ? '' : 'disabled'}>
                          ${
                            isShort
                              ? '提交并自评'
                              : deferred
                                ? session.index + 1 >= session.total
                                  ? '提交并交卷'
                                  : '提交并下一题'
                                : '提交答案'
                          } ${icon('arrow-right', 17)}
                        </button>
                      `
                }
              </div>
            </footer>
          </main>

          <aside class="practice-rail ${showAI ? '' : 'is-summary-only'}">
            ${showAI ? '<div class="practice-ai-host" data-practice-ai-host></div>' : ''}

            <section class="panel session-summary session-summary-compact">
              <div class="session-summary-head">
                <span class="eyebrow">THIS ROUND</span>
                <span class="session-total">${infinite ? '∞ 无限' : `${session.total} 题`}</span>
              </div>
              <div class="session-metrics">
                ${
                  deferred
                    ? `<div><strong>${stats.answered}</strong><span>已答</span></div>
                       <div><strong>${Math.max(0, session.total - stats.answered - session.skipped)}</strong><span>未答</span></div>
                       <div><strong>${session.skipped}</strong><span>跳过</span></div>`
                    : `<div><strong>${stats.correct}</strong><span>答对</span></div>
                       <div><strong>${stats.wrong}</strong><span>答错</span></div>
                       <div><strong>${session.skipped}</strong><span>跳过</span></div>`
                }
              </div>
              <div class="question-dots ${infinite ? 'is-windowed' : ''}" aria-label="作答进度">
                ${dotIndexes
                  .map((index) => {
                    const outcome = session.outcomes[index];
                    const shownOutcome =
                      deferred && (outcome === 'correct' || outcome === 'wrong')
                        ? 'answered'
                        : outcome;
                    const current = index === session.index;
                    return `<span class="question-dot ${shownOutcome ? `is-${shownOutcome}` : ''} ${current ? 'is-current' : ''}"
                      title="第 ${index + 1} 题${outcome ? ' · 已处理' : ''}"></span>`;
                  })
                  .join('')}
              </div>
              <p class="session-rail-hint">
                ${icon(infinite ? 'refresh' : 'keyboard', 13)}
                <span>${
                  infinite
                    ? '无限模式 · 只显示最近 24 题进度 · 随时退出'
                    : isShort
                      ? deferred
                        ? '简答题 · 提交后自评，完成后自动进入下一题'
                        : '简答题 · 提交后对照参考答案自评'
                      : deferred
                        ? 'A–D 选择 · 单选/判断自动进入下一题'
                        : 'A–D 选择 · 单选/判断自动提交'
                }</span>
              </p>
            </section>
          </aside>
        </div>
      </div>
    `;
  }

  function summaryTemplate() {
    const stats = sessionStats();
    const accuracy = stats.answered ? Math.round((stats.correct / stats.answered) * 100) : 0;
    const duration = Math.max(0, session.activeDurationMs || 0);
    const wrongRecords = session.records.filter((record) => !record.correct);
    const latestQuestions = session.questions;
    const wrongQuestions = [
      ...new Map(
        wrongRecords
          .map((record) => {
            const question = latestQuestions.find((item) => item.id === record.questionId);
            return question ? [record.questionId, question] : null;
          })
          .filter(Boolean),
      ).values(),
    ];
    const allSkipped = stats.answered === 0 && session.skipped > 0;
    const manualInfinite = Boolean(session.infinite && session.endedManually);

    return `
      <div class="page summary-page">
        <div class="summary-wrap">
          <section class="summary-hero panel">
            <div class="summary-copy">
              <p class="eyebrow">${manualInfinite ? 'INFINITE SESSION ENDED' : 'SESSION COMPLETE'}</p>
              <h1>${
                manualInfinite
                  ? allSkipped
                    ? '这次先看了看题。'
                    : accuracy >= 80
                      ? '这一轮，状态不错。'
                      : stats.answered
                        ? '这一轮，先到这里。'
                        : '这次先热了热身。'
                  : allSkipped
                    ? '这次先看了看题。'
                    : accuracy >= 80
                      ? '这一组，手感很好。'
                      : stats.answered
                        ? '每道错题，都是下一次的起点。'
                        : '这次先热了热身。'
              }</h1>
              <p>${
                manualInfinite
                  ? allSkipped
                    ? '你结束了无限练习，没有产生作答记录。'
                    : stats.answered
                      ? `你手动结束了无限练习，共作答 ${stats.answered} 道题，用时 ${formatDuration(duration)}。`
                      : '没有作答记录，下次可以先从会的题开始。'
                  : allSkipped
                    ? '全部题目都跳过了，没有产生作答记录。'
                    : stats.answered
                      ? `你用 ${formatDuration(duration)} 完成了 ${stats.answered} 道题。`
                      : '没有作答记录，下次可以先从会的题开始。'
              }</p>
              <div class="summary-actions">
                ${wrongQuestions.length ? `<button type="button" class="btn primary" data-action="retry-wrong">${icon('refresh', 16)} 重练错题</button>` : ''}
                <button type="button" class="btn subtle" data-action="new-session">${icon('plus', 16)} 再练一组</button>
                <button type="button" class="text-button" data-action="go-dashboard">返回概览 ${icon('arrow-right', 14)}</button>
              </div>
            </div>
            <div class="summary-score">
              <div class="score-ring" style="--score:${accuracy}">
                <div><strong>${accuracy}</strong><span>%</span></div>
              </div>
              <span>${session.accuracyCommitted ? '本次正确率' : '仅本组查看 · 不计入统计'}</span>
            </div>
            <div class="summary-metrics">
              <div><strong>${stats.correct}</strong><span>答对</span></div>
              <div><strong>${stats.wrong}</strong><span>答错</span></div>
              <div><strong>${session.skipped}</strong><span>跳过</span></div>
              <div><strong>${formatDuration(duration)}</strong><span>用时</span></div>
            </div>
          </section>

          ${
            wrongQuestions.length
              ? `<section class="panel summary-wrong">
                  <header class="panel-head">
                    <div><h2>需要再看一眼</h2><p>这些题已加入错题复习。</p></div>
                    <span class="type-badge type-wrong">${wrongQuestions.length} 道</span>
                  </header>
                  <div class="wrong-review-list">
                    ${wrongQuestions
                      .map(
                        (question, index) => `
                        <div class="wrong-review-row">
                          <span class="wrong-index">${String(index + 1).padStart(2, '0')}</span>
                          <div>
                            <p>${escapeHTML(question.stem)}</p>
                            <span>${question.type === 'short' ? '参考答案' : '正确答案'}：${escapeHTML(
                              isWrittenAnswerType(question.type)
                                ? question.answer ||
                                  (question.type === 'short' ? '未提供参考答案' : '')
                                : `${question.answer}${question.options
                                    .filter((option) => lettersOf(question.answer).has(option.key))
                                    .map((option) => ` · ${option.text}`)
                                    .join('')}`,
                            )}</span>
                          </div>
                        </div>
                      `,
                      )
                      .join('')}
                  </div>
                </section>`
              : `<section class="panel all-clear">
                  ${icon(allSkipped ? 'flag' : 'check-circle', 24)}
                  <div>
                    <h2>${allSkipped ? '全部跳过了' : '没有错题'}</h2>
                    <p>${allSkipped ? '下一次可以先从一道有把握的题开始。' : '这一组都答对了，可以去挑战未掌握的题目。'}</p>
                  </div>
                </section>`
          }
        </div>
      </div>
    `;
  }

  function renderCurrent() {
    if (!rootRef) return;
    controller?.abort();
    controller = new AbortController();

    if (!app.state.questions.length || !getStats(app.state).answerable) {
      if (screen !== 'session' && screen !== 'summary') screen = 'setup';
    }

    if (screen === 'session' && session) {
      rootRef.innerHTML = sessionTemplate();
      const aiHost = rootRef.querySelector('[data-practice-ai-host]');
      if (aiHost) ensurePracticeAI().mount(aiHost);
    } else if (screen === 'summary' && session) {
      rootRef.innerHTML = summaryTemplate();
    } else if (!getStats(app.state).answerable) {
      rootRef.innerHTML = blockedTemplate(app.state);
    } else {
      rootRef.innerHTML = setupTemplate(app.state, setup);
    }

    bindEvents(rootRef);
  }

  function applySetupUi() {
    if (!rootRef) return;
    if (screen !== 'setup') return;
    rootRef.querySelectorAll('[data-scope]').forEach((button) => {
      const active = button.dataset.scope === setup.scope;
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
    });
    rootRef.querySelectorAll('[data-count]').forEach((button) => {
      const value = button.dataset.count === 'all' ? 'all' : Number(button.dataset.count);
      const active = !setup.infinite && value === setup.count;
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const infiniteButton = rootRef.querySelector('[data-infinite-mode]');
    if (infiniteButton) {
      infiniteButton.classList.toggle('is-selected', setup.infinite);
      infiniteButton.setAttribute('aria-pressed', String(setup.infinite));
    }
    rootRef.querySelectorAll('[data-order]').forEach((button) => {
      const isShuffle = button.dataset.order === 'shuffle';
      const active = isShuffle === setup.shuffle;
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = setup.infinite;
    });
    rootRef.querySelectorAll('[data-feedback-mode]').forEach((button) => {
      const active = button.dataset.feedbackMode === setup.feedbackMode;
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = setup.infinite && button.dataset.feedbackMode === 'afterAll';
    });

    const available = scopeCount(app.state, setup.scope, practiceTargetOptions(setup));
    const effective = effectiveCount();
    rootRef.querySelectorAll('[data-start-count]').forEach((node) => {
      node.textContent = setup.infinite ? '∞' : String(effective);
    });
    rootRef.querySelectorAll('[data-start-unit]').forEach((node) => {
      node.textContent = setup.infinite ? '无限出题' : '道题';
    });
    rootRef.querySelectorAll('[data-action="start"]').forEach((button) => {
      button.disabled = available === 0;
    });
    const emptyNote = rootRef.querySelector('[data-scope-empty]');
    if (emptyNote) emptyNote.hidden = available !== 0;
    const estimate = rootRef.querySelector('[data-start-estimate]');
    if (estimate) {
      estimate.textContent = setup.infinite
        ? `无限模式 · 随机顺序 · ${practiceTargetLabel(app.state, setup)} · 随时手动退出`
        : `${setup.shuffle ? '随机顺序' : '按题库顺序'} · ${practiceTargetLabel(
            app.state,
            setup,
          )} · 预计 ${Math.max(1, Math.ceil(effective * 0.6))} 分钟`;
    }
    const countNote = rootRef.querySelector('[data-count-note]');
    if (countNote) {
      countNote.textContent = setup.infinite
        ? `无限模式会打乱当前范围的 ${available} 道题循环出题，没有固定终点；点击「退出练习」手动结束。`
        : `当前范围共有 ${available} 道可练习题，选「全部」会一次刷完。`;
    }
    const orderNote = rootRef.querySelector('[data-order-note]');
    if (orderNote) orderNote.hidden = !setup.infinite;
    const feedbackNote = rootRef.querySelector('[data-feedback-note]');
    if (feedbackNote) {
      feedbackNote.textContent = setup.infinite
        ? '无限模式固定使用「每题查看答案」；单选/判断题提交后自动进入下一题，多选、填空和简答确认提交。简答题提交后会显示参考答案，需自行评分。'
        : '单选/判断题选择后自动提交；选择「全部做完后查看」时会直接进入下一题。多选、填空和简答仍需确认提交；简答题提交后需自评。';
    }
    const customLabel = rootRef.querySelector('.custom-count');
    if (customLabel) {
      customLabel.classList.toggle(
        'is-selected',
        !setup.infinite && setup.count !== 'all' && !COUNT_OPTIONS.includes(setup.count),
      );
      customLabel.classList.toggle('is-disabled', setup.infinite);
      const input = customLabel.querySelector('[data-role="custom-count"]');
      if (input) {
        input.max = String(Math.max(available, 1));
        input.disabled = setup.infinite;
        if (document.activeElement !== input) {
          input.value = setup.count === 'all' ? '' : String(setup.count);
        }
      }
    }
  }

  function bindEvents(root) {
    const { signal } = controller;

    root.addEventListener(
      'click',
      (event) => {
        const scopeButton = event.target.closest('[data-scope]');
        if (scopeButton) {
          setup.scope = scopeButton.dataset.scope;
          applySetupUi();
          return;
        }

        const infiniteButton = event.target.closest('[data-infinite-mode]');
        if (infiniteButton) {
          setup.infinite = true;
          setup.shuffle = true;
          setup.feedbackMode = 'immediate';
          persistSetup();
          applySetupUi();
          return;
        }

        const countButton = event.target.closest('[data-count]');
        if (countButton) {
          setup.infinite = false;
          setup.count = countButton.dataset.count === 'all' ? 'all' : Number(countButton.dataset.count);
          persistSetup();
          applySetupUi();
          return;
        }

        const orderButton = event.target.closest('[data-order]');
        if (orderButton && !setup.infinite) {
          setup.shuffle = orderButton.dataset.order === 'shuffle';
          persistSetup();
          applySetupUi();
          return;
        }

        const feedbackModeButton = event.target.closest('[data-feedback-mode]');
        if (feedbackModeButton && !(setup.infinite && feedbackModeButton.dataset.feedbackMode === 'afterAll')) {
          setup.feedbackMode = normalizeFeedbackMode(feedbackModeButton.dataset.feedbackMode);
          persistSetup();
          applySetupUi();
          return;
        }

        const answerButton = event.target.closest('[data-answer-key]');
        if (answerButton && !answerButton.disabled) {
          toggleOption(answerButton.dataset.answerKey);
          return;
        }

        const actionElement = event.target.closest('[data-action]');
        if (!actionElement) return;
        const action = actionElement.dataset.action;

        if (action === 'start') {
          start();
        } else if (action === 'go-library') {
          app.navigate('library');
        } else if (action === 'go-import') {
          app.navigate('import');
        } else if (action === 'go-dashboard') {
          resetSession();
          app.navigate('dashboard');
        } else if (action === 'toggle-favorite') {
          const question = currentQuestion();
          if (!question) return;
          const favorite = app.toggleFavorite(question.id);
          question.favorite = favorite;
          answerActivityFavorite(actionElement, favorite);
        } else if (action === 'focus-ai-chat') {
          ensurePracticeAI().focus();
        } else if (action === 'show-ai-chat') {
          showPracticeAI();
        } else if (action === 'submit-answer') {
          submitAnswer();
        } else if (action === 'reveal-answer') {
          submitAnswer({ reveal: true });
        } else if (action === 'self-grade') {
          selfGradeShortAnswer(actionElement.dataset.correct === 'true');
        } else if (action === 'skip-question') {
          skipQuestion();
        } else if (action === 'next-question') {
          nextQuestion();
        } else if (action === 'prev-question') {
          previousQuestion();
        } else if (action === 'exit-session') {
          exitSession();
        } else if (action === 'retry-wrong') {
          const questionIds = session.records
            .filter((record) => !record.correct)
            .map((record) => record.questionId);
          start({
            questionIds,
            shuffle: false,
            label: '错题重练',
            feedbackMode: session.feedbackMode,
          });
        } else if (action === 'new-session') {
          resetSession();
          renderCurrent();
        }
      },
      { signal },
    );

    root.addEventListener(
      'change',
      (event) => {
        if (event.target.matches('[data-role="practice-subject"]')) {
          setup.subjectId = event.target.value;
          setup.bankId = '';
          normalizeSetupTarget(app.state, setup);
          renderCurrent();
        } else if (event.target.matches('[data-role="practice-bank"]')) {
          setup.bankId = event.target.value;
          normalizeSetupTarget(app.state, setup);
          renderCurrent();
        } else if (event.target.matches('[data-role="practice-show-ai"]')) {
          setup.showAI = event.target.checked;
          persistSetup();
        }
      },
      { signal },
    );

    root.addEventListener(
      'input',
      (event) => {
        if (event.target.matches('[data-role="fill-answer"]') && session && !session.submitted) {
          session.fillValue = event.target.value;
          updateSelectionUi();
        } else if (event.target.matches('[data-role="custom-count"]')) {
          const raw = event.target.value.trim();
          if (!raw) return;
          const next = Math.min(1000, Math.max(1, Number.parseInt(raw, 10) || 1));
          setup.infinite = false;
          setup.count = next;
          persistSetup();
          applySetupUi();
        }
      },
      { signal },
    );

    root.addEventListener(
      'keydown',
      (event) => {
        if (
          event.target.matches('[data-role="fill-answer"]') &&
          event.key === 'Enter' &&
          !event.isComposing &&
          event.keyCode !== 229
        ) {
          const multiline = event.target.matches('textarea');
          if (multiline && !(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          submitAnswer();
        }
      },
      { signal },
    );
  }

  function answerActivityFavorite(button, favorite) {
    button.classList.toggle('is-favorite', favorite);
    button.setAttribute('aria-pressed', String(favorite));
    button.setAttribute('aria-label', favorite ? '取消收藏' : '收藏这道题');
  }

  async function exitSession() {
    if (!session) return;
    const hasActivity = session.records.length || session.skipped;
    if (session.infinite && hasActivity) {
      const proceed = await confirmAction({
        title: '结束无限练习？',
        message: `本轮已作答 ${sessionStats().answered} 道题，结束后会显示本轮统计。未作答的进度不会保留。`,
        confirmText: '结束并查看统计',
      });
      if (!proceed) return;
      finishSession({ manual: true });
      return;
    }
    if (hasActivity) {
      const proceed = await confirmAction({
        title: '结束这组练习？',
        message: '已经作答的题目会保留在练习记录中，未作答的进度将失去。',
        confirmText: '结束练习',
      });
      if (!proceed) return;
    }
    // 全部题目都已作答时，这一组仍算完整练习。
    commitCompletedSessionAccuracy();
    flushStudyDuration();
    resetSession();
    renderCurrent();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function installStudyClock() {
    if (studyClockInstalled) return;
    studyClockInstalled = true;
    let dialogOpen = false;

    ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((type) => {
      document.addEventListener(type, markStudyActivity, { capture: true, passive: true });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (session && screen === 'session') pauseStudyClock();
        else clearStudyIdleTimer();
      } else {
        resumeStudyClock();
      }
    });

    window.addEventListener('pagehide', () => {
      if (session && screen === 'session') pauseStudyClock();
    });

    const observer = new MutationObserver(() => {
      const open = Boolean(document.querySelector('dialog[open]'));
      if (open === dialogOpen) return;
      dialogOpen = open;
      if (!session || screen !== 'session') return;
      if (open) pauseStudyClock();
      else resumeStudyClock();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    });
  }

  function installKeyboard() {
    if (keyHandlerInstalled) return;
    keyHandlerInstalled = true;
    document.addEventListener('keydown', (event) => {
      if (
        screen !== 'session' ||
        !session ||
        !rootRef?.isConnected ||
        document.querySelector('dialog[open]')
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select') || target.isContentEditable)
      ) {
        return;
      }
      if (event.isComposing || event.keyCode === 229) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (
        target instanceof HTMLElement &&
        target.closest('.answer-option') &&
        event.key === 'Enter' &&
        !session.submitted &&
        session.selected.size > 0
      ) {
        event.preventDefault();
        submitAnswer();
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('button, a') &&
        (event.key === 'Enter' || event.key === ' ')
      ) {
        return;
      }

      if (session.submitted) {
        if (session.result?.pendingSelfGrade) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          nextQuestion();
        }
        return;
      }

      const question = currentQuestion();
      if (!question) return;

      if (event.key === 'Enter') {
        if (isWrittenAnswerType(question.type)) return;
        if (session.selected.size) {
          event.preventDefault();
          submitAnswer();
        }
        return;
      }

      if (isWrittenAnswerType(question.type)) return;

      const key = event.key.toUpperCase();
      let optionKey = '';
      if (/^[A-H]$/.test(key)) {
        optionKey = key;
      } else if (/^[1-8]$/.test(event.key)) {
        const option = question.options[Number(event.key) - 1];
        if (option) optionKey = option.key;
      }

      if (optionKey) {
        event.preventDefault();
        toggleOption(optionKey);
      }
    });
  }

  installKeyboard();
  installStudyClock();

  function getAssistantConfig() {
    if (screen !== 'session' || !session) return null;
    const question = currentQuestion();
    if (!question) return null;
    const submitted = Boolean(session.submitted);
    const pendingSelfGrade = session.result?.pendingSelfGrade === true;
    const correct = session.result?.correct === true;
    const given = session.given || session.fillValue || '';
    const actions = [];

    if (!submitted) {
      actions.push('tutor_hint', 'tutor_explain', 'tutor_similar');
    } else if (pendingSelfGrade) {
      actions.push('tutor_explain', 'tutor_similar', 'tutor_simpler');
    } else if (correct) {
      actions.push('tutor_explain', 'tutor_similar', 'tutor_simpler');
    } else {
      actions.push('tutor_diagnose', 'tutor_explain', 'tutor_similar', 'tutor_simpler');
    }

    return {
      mode: 'tutor',
      contextLabel: session.infinite
        ? `第 ${session.index + 1} 题 · 无限模式`
        : `第 ${session.index + 1} / ${session.total} 题`,
      context: {
        page: 'practice',
        session: {
          index: session.index + 1,
          total: session.infinite ? null : session.total,
          generated: session.infinite ? session.total : undefined,
          infinite: Boolean(session.infinite),
          correct: sessionStats().correct,
          wrong: sessionStats().wrong,
          submitted,
          pendingSelfGrade,
          answeredCorrectly: submitted && !pendingSelfGrade ? correct : null,
          revealed: Boolean(session.result?.revealed),
          deferred: session.feedbackMode === 'afterAll',
        },
        question: {
          type: question.type,
          typeLabel: QUESTION_TYPES[question.type],
          stem: question.stem,
          options: question.options,
          answer: question.answer,
          explanation: question.explanation,
        },
        userAnswer: given,
        hint: submitted
          ? pendingSelfGrade
            ? '用户已提交简答题，正在对照参考答案自评。可帮助梳理答案要点，但不要替用户决定得分。'
            : correct
              ? '用户已答对，可以拓展讲解或出同类题。'
              : '用户已答错并看到正确答案，请针对其答案分析错因。'
          : '用户尚未提交答案，不要直接泄露正确答案。',
      },
      availableActions: actions,
    };
  }

  return {
    render(root, options = {}) {
      if (
        Object.prototype.hasOwnProperty.call(options, 'subjectId') ||
        Object.prototype.hasOwnProperty.call(options, 'bankId')
      ) {
        setup.subjectId = options.subjectId || '';
        setup.bankId = options.bankId || '';
        normalizeSetupTarget(app.state, setup);
      }
      normalizeSetupTarget(app.state, setup);
      rootRef = root;
      renderCurrent();
    },
    start,
    getAssistantConfig,
    hasActiveSession() {
      return screen === 'session' && Boolean(session);
    },
    abandonSession() {
      if (screen === 'session' && session) {
        commitCompletedSessionAccuracy();
        flushStudyDuration();
      }
      resetSession();
    },
    resetOnLeave() {
      if (screen === 'session' && session) {
        commitCompletedSessionAccuracy();
        flushStudyDuration();
      }
      resetSession();
    },
  };
}
