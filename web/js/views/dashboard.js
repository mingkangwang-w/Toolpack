import {
  banksForSubject,
  getRecentAccuracySeries,
  getStats,
  historySummary,
  isQuestionAnswerable,
  isMastered,
  QUESTION_TYPES,
} from '../store.js';
import {
  escapeHTML,
  greeting,
  icon,
  relativeDate,
  todayChinese,
  typeClass,
} from '../ui.js';
import { OFFLINE_MODE } from '../runtime.js';

function heroArtHTML() {
  return `
    <div class="hero-art" aria-hidden="true">
      <div class="art-photo">
        <div class="art-photo-bar"><span></span><span></span><span></span></div>
        <div class="art-photo-body">
          <i class="art-line is-strong"></i>
          <i class="art-line"></i>
          <i class="art-line is-short"></i>
          <div class="art-option-dashes"><span>A</span><span>B</span><span>C</span></div>
        </div>
        <div class="art-scan-line"></div>
        <span class="art-ocr-tag">${icon('scan', 13)} 正在识别</span>
      </div>
      <div class="art-question">
        <div class="art-question-head">
          <span class="mini-badge">单选题</span>
          <span class="art-dots">•••</span>
        </div>
        <i class="art-line is-strong"></i>
        <i class="art-line"></i>
        <div class="art-answer-list">
          <div><span>A</span><i></i></div>
          <div class="is-picked"><span>B</span><i></i><b>${icon('check', 12)}</b></div>
          <div><span>C</span><i></i></div>
        </div>
      </div>
      <span class="art-float-chip">${icon('sparkles', 13)} 自动拆分</span>
    </div>
  `;
}

function statCard(label, value, unit, meta, iconName, tone) {
  return `
    <article class="stat-card">
      <div class="stat-card-top">
        <span>${label}</span>
        <span class="stat-icon tone-${tone}">${icon(iconName, 17)}</span>
      </div>
      <div class="stat-value"><strong>${value}</strong><em>${unit}</em></div>
      <p>${meta}</p>
    </article>
  `;
}

function formatStudyDuration(milliseconds) {
  const value = Math.max(0, Number(milliseconds) || 0);
  const minutes = Math.round(value / 60_000);
  if (minutes <= 0) return value > 0 ? '不足 1 分钟' : '0 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function chartAttemptTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${hours}:${minutes}`;
}

function normalizeTrendSelection(state, selection) {
  if (!state.subjects.some((subject) => subject.id === selection.subjectId)) {
    selection.subjectId = '';
  }
  if (
    !selection.subjectId ||
    !state.banks.some(
      (bank) => bank.id === selection.bankId && bank.subjectId === selection.subjectId,
    )
  ) {
    selection.bankId = '';
  }
}

function trendScope(state, selection) {
  const subject = state.subjects.find((item) => item.id === selection.subjectId) || null;
  const bank =
    subject && state.banks.find(
      (item) => item.id === selection.bankId && item.subjectId === subject.id,
    );
  return { subject, bank: bank || null };
}

function trendScopeLabel(state, selection) {
  const { subject, bank } = trendScope(state, selection);
  if (bank && subject) return `${subject.name} / ${bank.name}`;
  if (subject) return `${subject.name} · 科目总题库`;
  return '全部科目';
}

function trendSubjectOptionsHTML(state, selection) {
  return `
    <option value="">全部科目</option>
    ${state.subjects
      .map(
        (subject) =>
          `<option value="${escapeHTML(subject.id)}" ${
            selection.subjectId === subject.id ? 'selected' : ''
          }>${escapeHTML(subject.name)}</option>`,
      )
      .join('')}
  `;
}

function trendBankOptionsHTML(state, selection) {
  const { subject } = trendScope(state, selection);
  if (!subject) return '<option value="">先选择科目</option>';
  return `
    <option value="">科目总题库</option>
    ${banksForSubject(state, subject.id)
      .map(
        (bank) =>
          `<option value="${escapeHTML(bank.id)}" ${
            selection.bankId === bank.id ? 'selected' : ''
          }>${escapeHTML(bank.name)}</option>`,
      )
      .join('')}
  `;
}

function trendToolbarHTML(state, selection) {
  const { subject } = trendScope(state, selection);
  return `
    <div class="trend-controls">
      <label class="trend-field">
        <span>科目</span>
        <div class="select-wrap">
          <select data-role="trend-subject" aria-label="按科目查看正确率">
            ${trendSubjectOptionsHTML(state, selection)}
          </select>
          ${icon('chevron-down', 14)}
        </div>
      </label>
      <label class="trend-field">
        <span>子题库</span>
        <div class="select-wrap">
          <select data-role="trend-bank" aria-label="按子题库查看正确率" ${
            subject ? '' : 'disabled'
          }>
            ${trendBankOptionsHTML(state, selection)}
          </select>
          ${icon('chevron-down', 14)}
        </div>
      </label>
    </div>
    <span class="trend-filter-note">${icon('info', 12)} 一次只显示当前选择</span>
  `;
}

function trendSeriesSummary(series) {
  const latest = series[series.length - 1];
  return {
    answered: series.length,
    correct: latest?.correct || 0,
    accuracy: latest?.accuracy ?? null,
  };
}

function accuracyChartSVG(series, scopeLabel) {
  const width = 720;
  const height = 224;
  const left = 40;
  const right = 18;
  const top = 18;
  const bottom = 30;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const count = series.length;
  const step = count > 1 ? plotWidth / (count - 1) : 0;
  const points = series.map((point, index) => ({
    ...point,
    index,
    x: count > 1 ? left + index * step : left + plotWidth / 2,
    y: point.accuracy === null ? null : top + (1 - point.accuracy / 100) * plotHeight,
  }));
  const valid = points.filter((point) => point.y !== null);

  const path = valid
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    )
    .join('');

  const gridLines = [0, 25, 50, 75, 100]
    .map((value) => {
      const y = top + (1 - value / 100) * plotHeight;
      return `
        <line class="trend-grid-line" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line>
        <text class="trend-axis-label" x="${left - 9}" y="${y + 3}" text-anchor="end">${value}%</text>
      `;
    })
    .join('');

  const labelIndexes = [
    0,
    Math.round((count - 1) * 0.25),
    Math.round((count - 1) * 0.5),
    Math.round((count - 1) * 0.75),
    count - 1,
  ].filter((value, index, list) => list.indexOf(value) === index);
  const xLabels = labelIndexes
    .map((index) => {
      const point = points[index];
      if (!point) return '';
      const anchor = index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';
      return `<text class="trend-axis-label" x="${point.x}" y="${height - 8}" text-anchor="${anchor}">第 ${point.attemptNumber} 次</text>`;
    })
    .join('');

  const circles = valid
    .map((point) => {
      const label = `第 ${point.attemptNumber} 次，本次${point.attemptCorrect ? '答对' : '答错'}，累计正确率 ${point.accuracy}%`;
      return `
        <circle class="trend-point" cx="${point.x}" cy="${point.y}" r="4"
          data-trend-index="${point.index}" tabindex="0" role="img"
          aria-label="${escapeHTML(label)}"><title>${escapeHTML(label)}</title></circle>
      `;
    })
    .join('');

  const lastPoint = valid[valid.length - 1];
  const endAnchor = lastPoint.x > width - right - 46 ? 'end' : 'start';
  const endLabel = `
    <text class="trend-end-label" x="${lastPoint.x + (endAnchor === 'end' ? -8 : 8)}"
      y="${Math.max(top + 10, lastPoint.y - 10)}" text-anchor="${endAnchor}">${lastPoint.accuracy}%</text>
  `;

  const hoverData = encodeURIComponent(
    JSON.stringify(
      series.map(
        ({ at, attemptNumber, attemptCorrect, answered, correct, accuracy }) => ({
          at,
          attemptNumber,
          attemptCorrect,
          answered,
          correct,
          accuracy,
        }),
      ),
    ),
  );

  return `
    <svg class="trend-chart-svg" data-accuracy-chart viewBox="0 0 ${width} ${height}"
      data-chart-left="${left}" data-chart-top="${top}"
      data-chart-width="${plotWidth}" data-chart-height="${plotHeight}"
      data-chart-count="${count}" data-series="${hoverData}"
      role="img" aria-label="${escapeHTML(scopeLabel)}最近 30 次正确率折线图">
      <title>${escapeHTML(scopeLabel)}最近 30 次正确率折线图</title>
      ${gridLines}
      ${xLabels}
      <line class="trend-crosshair" data-trend-crosshair
        x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" visibility="hidden"></line>
      <path class="trend-line" d="${path}"></path>
      ${circles}
      ${endLabel}
      <rect class="trend-hover-area" x="${left}" y="${top}"
        width="${plotWidth}" height="${plotHeight}" fill="transparent"></rect>
    </svg>
  `;
}

function trendDataTableHTML(series, scopeLabel) {
  if (!series.length) return '';
  return `
    <details class="trend-data-table">
      <summary>查看数据表</summary>
      <div class="trend-table-scroll">
        <table aria-label="${escapeHTML(scopeLabel)}最近 30 次正确率数据">
          <thead><tr><th>次数</th><th>时间</th><th>本次</th><th>累计</th><th>正确率</th></tr></thead>
          <tbody>
            ${series
              .map(
                (point) => `
                <tr>
                  <td>第 ${point.attemptNumber} 次</td>
                  <td>${chartAttemptTime(point.at)}</td>
                  <td>${point.attemptCorrect ? '答对' : '答错'}</td>
                  <td>${point.correct}/${point.answered}</td>
                  <td>${point.accuracy}%</td>
                </tr>
              `,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </details>
  `;
}

function trendChartBodyHTML(state, selection) {
  const series = getRecentAccuracySeries(state, {
    subjectId: selection.subjectId,
    bankId: selection.bankId,
    limit: 30,
  });
  const summary = trendSeriesSummary(series);
  const scopeLabel = trendScopeLabel(state, selection);
  const hasData = series.length > 0;
  return `
    <div class="trend-chart-heading">
      <div>
        <span class="eyebrow">ACCURACY · 最近 30 次</span>
        <h3>最近 30 次正确率</h3>
        <p>${escapeHTML(scopeLabel)} · 仅统计完整结束的练习，中途退出不计入</p>
      </div>
      <div class="trend-kpi">
        <strong>${summary.accuracy === null ? '—' : `${summary.accuracy}%`}</strong>
        <span>最近 ${summary.answered} 次作答 · ${summary.correct} 次正确</span>
      </div>
    </div>
    ${
      hasData
        ? `<div class="trend-canvas" data-trend-canvas>
            ${accuracyChartSVG(series, scopeLabel)}
            <div class="trend-tooltip" data-trend-tooltip hidden role="status">
              <strong data-trend-tooltip-value></strong>
              <span data-trend-tooltip-label></span>
            </div>
          </div>
          ${trendDataTableHTML(series, scopeLabel)}`
        : `<div class="trend-empty">
            <span>${icon('chart-line', 26)}</span>
            <div>
              <strong>最近还没有作答记录</strong>
              <p>按作答次数统计从本次更新后开始记录；完整结束一组练习后，这里会显示最近 30 次提交的正确率变化，中途退出不会计入。</p>
            </div>
          </div>`
    }
  `;
}

function learningInsightsHTML(state, monthly, selection) {
  return `
    <section class="panel insights-panel">
      <header class="panel-head insights-head">
        <div>
          <h2>学习统计</h2>
          <p>学习时长与刷题量按近 30 天统计；正确率折线按最近 30 次作答，仅统计完整结束的练习，一次只显示一个范围。</p>
        </div>
        <span class="insights-window">${icon('clock', 13)} 近 30 天</span>
      </header>
      <div class="insight-metrics">
        <article class="insight-metric">
          <span class="insight-metric-icon">${icon('clock', 18)}</span>
          <div>
            <span>学习时长</span>
            <strong>${formatStudyDuration(monthly.durationMs)}</strong>
            <small>近 30 天累计</small>
          </div>
        </article>
        <article class="insight-metric">
          <span class="insight-metric-icon">${icon('check-circle', 18)}</span>
          <div>
            <span>刷题数量</span>
            <strong>${monthly.answered}<em>道</em></strong>
            <small>近 30 天共 ${monthly.activeDays} 天有练习</small>
          </div>
        </article>
        <article class="insight-metric">
          <span class="insight-metric-icon">${icon('target', 18)}</span>
          <div>
            <span>正确率</span>
            <strong>${monthly.accuracy === null ? '—' : `${monthly.accuracy}<em>%</em>`}</strong>
            <small>近 30 天加权</small>
          </div>
        </article>
      </div>
      ${
        monthly.durationMs === 0
          ? '<p class="insights-note">学习时长从本次更新后开始自动累计；刷题数量会包含已有历史。</p>'
          : ''
      }
      <div class="trend-card">
        <div class="trend-toolbar" data-trend-toolbar>
          ${trendToolbarHTML(state, selection)}
        </div>
        <div class="trend-chart" data-trend-chart>
          ${trendChartBodyHTML(state, selection)}
        </div>
      </div>
    </section>
  `;
}

function offlineOnboardingHTML() {
  return `
    <section class="onboarding-panel panel">
      <div class="onboarding-head">
        <div>
          <p class="eyebrow">OFFLINE PRACTICE</p>
          <h2>三步，开始离线刷题。</h2>
        </div>
        <button type="button" class="btn primary" data-action="offline-guide">
          ${icon('list', 17)} 开始配置题库
        </button>
      </div>
      <div class="onboarding-steps">
        <article>
          <span class="step-number">01</span>
          <span class="onboarding-icon">${icon('download', 22)}</span>
          <h3>电脑端导出</h3>
          <p>在电脑的「我的题库 → 导出题库」中勾选科目或子题库，导出一个 JSON 文件。</p>
        </article>
        <article>
          <span class="step-number">02</span>
          <span class="onboarding-icon">${icon('upload', 22)}</span>
          <h3>平板导入</h3>
          <p>打开「我的题库 → 导入题库」，选择 JSON 文件，题目会保存在这台平板上。</p>
        </article>
        <article>
          <span class="step-number">03</span>
          <span class="onboarding-icon">${icon('play', 22)}</span>
          <h3>离线刷题</h3>
          <p>之后不需要电脑和网络，练习、统计和错题都会保存在本地。</p>
        </article>
      </div>
    </section>
  `;
}

function onboardingHTML() {
  return `
    <section class="onboarding-panel panel">
      <div class="onboarding-head">
        <div>
          <p class="eyebrow">HOW IT WORKS</p>
          <h2>三步，把图片变成能刷的题。</h2>
        </div>
        <button type="button" class="btn primary" data-action="import">
          ${icon('image', 17)} 导入第一张图片
        </button>
      </div>
      <div class="onboarding-steps">
        <article>
          <span class="step-number">01</span>
          <span class="onboarding-icon">${icon('camera', 22)}</span>
          <h3>上传题目</h3>
          <p>截图、拍照都行。可一次选择多张，也能直接粘贴剪贴板截图。</p>
        </article>
        <article>
          <span class="step-number">02</span>
          <span class="onboarding-icon">${icon('sparkles', 22)}</span>
          <h3>校对拆分</h3>
          <p>自动识别中文、选项和答案。识别错字可在入库前直接修改。</p>
        </article>
        <article>
          <span class="step-number">03</span>
          <span class="onboarding-icon">${icon('play', 22)}</span>
          <h3>开始刷题</h3>
          <p>按单选、多选、判断、填空练习，自动积累错题和掌握度。</p>
        </article>
      </div>
    </section>
  `;
}

function quickPracticeHTML(stats) {
  const modes = [
    {
      scope: 'all',
      icon: 'shuffle',
      title: '随机一组',
      text: '从全部可练习题目中抽 10 道',
      count: stats.answerable,
    },
    {
      scope: 'wrong',
      icon: 'refresh',
      title: '错题复习',
      text: '把上次做错的题再过一遍',
      count: stats.wrong,
    },
    {
      scope: 'unmastered',
      icon: 'target',
      title: '未掌握',
      text: '优先练习还没连续答对的题',
      count: stats.unmastered,
    },
  ];

  return `
    <article class="panel quick-panel">
      <header class="panel-head">
        <div>
          <h2>今天练什么？</h2>
          <p>选一个范围，直接开始 10 道题。</p>
        </div>
        <button type="button" class="text-button" data-action="practice">
          自定义 ${icon('arrow-right', 14)}
        </button>
      </header>
      <div class="quick-list">
        ${modes
          .map(
            (mode) => `
            <button type="button" class="quick-row" data-quick-scope="${mode.scope}"
              ${mode.count === 0 ? 'disabled' : ''}>
              <span class="quick-icon">${icon(mode.icon, 19)}</span>
              <span class="quick-copy">
                <b>${mode.title}</b>
                <small>${mode.text}</small>
              </span>
              <span class="quick-count">${mode.count}<em>道</em></span>
              ${icon('chevron-right', 17, 'quick-arrow')}
            </button>
          `,
          )
          .join('')}
      </div>
      ${
        stats.missingAnswers
          ? `<div class="panel-note">${icon('alert', 15)} 还有 ${stats.missingAnswers} 道题缺少答案，补齐后才会进入练习。</div>`
          : ''
      }
    </article>
  `;
}

function recentQuestionsHTML(state) {
  const recent = [...state.questions]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 4);

  return `
    <article class="panel recent-panel">
      <header class="panel-head">
        <div>
          <h2>最近入库</h2>
          <p>刚刚整理的题目。</p>
        </div>
        <button type="button" class="text-button" data-action="library">
          全部题库 ${icon('arrow-right', 14)}
        </button>
      </header>
      ${
        recent.length
          ? `<div class="recent-list">
              ${recent
                .map(
                  (question) => `
                  <button type="button" class="recent-row" data-open-question="${escapeHTML(question.id)}">
                    <span class="type-badge type-${typeClass(question.type)}">${QUESTION_TYPES[question.type] || '题目'}</span>
                    <span class="recent-copy">
                      <b>${escapeHTML(question.stem).replace(/\n/g, ' ')}</b>
                      <small>${relativeDate(question.createdAt)} · ${
                        isQuestionAnswerable(question)
                          ? isMastered(question)
                            ? '已掌握'
                            : question.stats.attempts
                              ? '练习中'
                              : '未练习'
                          : '缺答案'
                      }</small>
                    </span>
                    ${icon('chevron-right', 16, 'recent-arrow')}
                  </button>
                `,
                )
                .join('')}
            </div>`
          : `<div class="mini-empty">${icon('file-text', 22)}<span>还没有题目，先导入一张图片吧。</span></div>`
      }
    </article>
  `;
}

export function createDashboardView(app) {
  let rootRef = null;
  let controller = null;
  const trendSelection = { subjectId: '', bankId: '' };

  function render(root) {
    controller?.abort();
    controller = new AbortController();
    rootRef = root;

    const state = app.state;
    const stats = getStats(state);
    stats.unmastered = state.questions.filter(
      (question) => isQuestionAnswerable(question) && !isMastered(question),
    ).length;
    normalizeTrendSelection(state, trendSelection);
    const monthly = historySummary(state, 30);

    const hasQuestions = stats.total > 0;
    const canPractice = stats.answerable > 0;
    const todayAccuracy =
      stats.today.answered > 0 ? Math.round((stats.today.correct / stats.today.answered) * 100) : null;
    const goal = 10;
    const todayProgress = Math.min(100, Math.round((stats.today.answered / goal) * 100));

    root.innerHTML = `
      <div class="page dashboard-page">
        <header class="page-header dashboard-header">
          <div class="page-heading">
            <p class="eyebrow">${escapeHTML(todayChinese())}</p>
            <h1>${
              hasQuestions
                ? '今天，练几道？'
                : OFFLINE_MODE
                  ? '导入题库，<br>开始离线刷题。'
                  : '把第一道题，<br>收进你的题库。'
            }</h1>
            <p class="page-sub">${
              hasQuestions
                ? `${greeting()}。题库里还有 ${stats.unmastered} 道题等待掌握，按自己的节奏来。`
                : OFFLINE_MODE
                  ? '在电脑端导出 JSON 题库文件，然后在「我的题库」中导入；之后不需要电脑和网络。'
                  : '上传题目图片，识别文字、拆好选项，然后开始专注练习。'
            }</p>
          </div>
          <div class="header-actions">
            ${
              OFFLINE_MODE
                ? `<button type="button" class="btn subtle" data-action="offline-guide">${icon('list', 17)} 配置题库</button>`
                : `<button type="button" class="btn subtle" data-action="import">${icon('image', 17)} 导入图片</button>`
            }
            <button type="button" class="btn primary" data-action="practice" ${canPractice ? '' : 'disabled'}>
              ${icon('play', 16)} 开始刷题
            </button>
          </div>
        </header>

        <section class="hero-grid">
          <article class="hero-card">
            <div class="hero-copy">
              <span class="hero-kicker">IMAGE → QUESTION BANK</span>
              <h2>把散落的题目，<br><span>收进自己的题库。</span></h2>
              <p>截图和照片里的中文题目，识别、拆分、核对，一步到位。图片只在本机处理。</p>
              <div class="hero-actions">
                <button type="button" class="btn light" data-action="import">
                  导入题目 ${icon('arrow-right', 16)}
                </button>
                <button type="button" class="hero-text-link" data-action="manual">
                  ${icon('edit', 14)} 手动录入
                </button>
              </div>
            </div>
            ${heroArtHTML()}
          </article>

          <aside class="today-card">
            <div class="today-head">
              <span class="eyebrow">TODAY</span>
              <span class="local-pill"><i></i> 本地</span>
            </div>
            <div class="today-ring" style="--progress:${todayProgress}">
              <div class="today-ring-inner">
                <strong>${stats.today.answered}</strong>
                <span>道</span>
              </div>
            </div>
            <div class="today-copy">
              <h2>${stats.today.answered ? '手感正在回来' : '今天还没开张'}</h2>
              <p>${
                stats.today.answered
                  ? `今日正确率 ${todayAccuracy ?? 0}%，目标 ${goal} 道。`
                  : hasQuestions
                    ? '做几道题，让今天留下一点进度。'
                    : '导入题目后，这里会记录每天的练习。'
              }</p>
            </div>
            <button type="button" class="btn subtle full-width" data-action="practice" ${canPractice ? '' : 'disabled'}>
              ${stats.today.answered ? '继续练习' : '开始第一组'} ${icon('arrow-right', 15)}
            </button>
            <div class="today-foot">
              <span>${stats.streakDays > 0 ? `连续 ${stats.streakDays} 天` : '持续积累'}</span>
              <span>${stats.answerable} 道可练</span>
            </div>
          </aside>
        </section>

        ${
          hasQuestions
            ? `
              <section class="stat-grid">
                ${statCard('题库总量', stats.total, '道', `${stats.answerable} 道可进入练习`, 'book', 'green')}
                ${statCard('已掌握', stats.mastered, '道', '连续答对 2 次即掌握', 'target', 'blue')}
                ${statCard('总正确率', stats.accuracy === null ? '—' : stats.accuracy, stats.accuracy === null ? '' : '%', `累计练习 ${stats.attempts} 次`, 'sparkles', 'amber')}
                ${statCard('待复习', stats.wrong, '道', stats.wrong ? '上次答错的题目' : '暂时没有错题', 'refresh', 'coral')}
              </section>
              ${learningInsightsHTML(state, monthly, trendSelection)}
              <section class="dashboard-bottom">
                ${quickPracticeHTML(stats)}
                ${recentQuestionsHTML(state)}
              </section>
            `
            : OFFLINE_MODE
              ? offlineOnboardingHTML()
              : onboardingHTML()
        }
      </div>
    `;

    root.addEventListener(
      'click',
      (event) => {
        const quickButton = event.target.closest('[data-quick-scope]');
        if (quickButton && !quickButton.disabled) {
          app.startPractice({
            scope: quickButton.dataset.quickScope,
            count: 10,
            shuffle: true,
            subjectId: '',
            bankId: '',
          });
          return;
        }

        const openQuestion = event.target.closest('[data-open-question]');
        if (openQuestion) {
          const question = app.state.questions.find((item) => item.id === openQuestion.dataset.openQuestion);
          if (question) app.openQuestionEditor(question);
          return;
        }

        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'import') app.navigate('import');
        else if (action === 'offline-guide') app.openOfflineSetupGuide();
        else if (action === 'practice') app.navigate('practice');
        else if (action === 'library') app.navigate('library');
        else if (action === 'manual') app.openManualQuestion();
        else if (action === 'start-practice' && canPractice) app.navigate('practice');
      },
      { signal: controller.signal },
    );

    root.addEventListener(
      'change',
      (event) => {
        if (event.target.matches('[data-role="trend-subject"]')) {
          trendSelection.subjectId = event.target.value;
          trendSelection.bankId = '';
          normalizeTrendSelection(app.state, trendSelection);
          updateTrendPanel();
        } else if (event.target.matches('[data-role="trend-bank"]')) {
          trendSelection.bankId = event.target.value;
          normalizeTrendSelection(app.state, trendSelection);
          updateTrendPanel();
        }
      },
      { signal: controller.signal },
    );

    bindTrendChart(root);
  }

  function updateTrendPanel() {
    if (!rootRef) return;
    normalizeTrendSelection(app.state, trendSelection);
    const subjectSelect = rootRef.querySelector('[data-role="trend-subject"]');
    if (subjectSelect) subjectSelect.value = trendSelection.subjectId;
    const bankSelect = rootRef.querySelector('[data-role="trend-bank"]');
    if (bankSelect) {
      bankSelect.innerHTML = trendBankOptionsHTML(app.state, trendSelection);
      bankSelect.disabled = !trendSelection.subjectId;
      bankSelect.value = trendSelection.bankId;
    }
    const chartHost = rootRef.querySelector('[data-trend-chart]');
    if (chartHost) chartHost.innerHTML = trendChartBodyHTML(app.state, trendSelection);
  }

  function bindTrendChart(root) {
    const host = root.querySelector('[data-trend-chart]');
    if (!host) return;

    const hide = () => {
      const tooltip = host.querySelector('[data-trend-tooltip]');
      if (tooltip) tooltip.hidden = true;
      host.querySelectorAll('.trend-point.is-active').forEach((node) => {
        node.classList.remove('is-active');
      });
      const crosshair = host.querySelector('[data-trend-crosshair]');
      if (crosshair) crosshair.setAttribute('visibility', 'hidden');
    };

    const show = (svg, index) => {
      const count = Number(svg.dataset.chartCount) || 0;
      if (index < 0 || index >= count) {
        hide();
        return;
      }
      let series = [];
      try {
        series = JSON.parse(decodeURIComponent(svg.dataset.series || ''));
      } catch {
        return;
      }
      const point = series[index];
      if (!point) return;

      const left = Number(svg.dataset.chartLeft) || 0;
      const plotWidth = Number(svg.dataset.chartWidth) || 0;
      const step = count > 1 ? plotWidth / (count - 1) : 0;
      const x = count > 1 ? left + index * step : left + plotWidth / 2;

      const crosshair = svg.querySelector('[data-trend-crosshair]');
      if (crosshair) {
        crosshair.setAttribute('x1', x);
        crosshair.setAttribute('x2', x);
        crosshair.setAttribute('visibility', 'visible');
      }
      host.querySelectorAll('.trend-point.is-active').forEach((node) => {
        node.classList.remove('is-active');
      });
      svg.querySelector(`circle[data-trend-index="${index}"]`)?.classList.add('is-active');

      const canvas = svg.closest('[data-trend-canvas]');
      const tooltip = host.querySelector('[data-trend-tooltip]');
      if (!canvas || !tooltip) return;
      const value = tooltip.querySelector('[data-trend-tooltip-value]');
      const label = tooltip.querySelector('[data-trend-tooltip-label]');
      if (value) value.textContent = `${point.accuracy}%`;
      if (label) {
        label.textContent = `第 ${point.attemptNumber} 次 · 本次${
          point.attemptCorrect ? '答对' : '答错'
        } · 累计 ${point.correct}/${point.answered}`;
      }
      tooltip.hidden = false;

      const svgRect = svg.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      if (!svgRect.width || !canvasRect.width) return;
      const pointX = (x / 720) * svgRect.width + (svgRect.left - canvasRect.left);
      const margin = 68;
      tooltip.style.left = `${Math.max(margin, Math.min(canvasRect.width - margin, pointX))}px`;
      tooltip.style.top = '5px';
    };

    host.addEventListener('pointermove', (event) => {
      const canvas = event.target.closest?.('[data-trend-canvas]');
      if (!canvas) {
        hide();
        return;
      }
      const svg = canvas.querySelector('svg[data-accuracy-chart]');
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = ((event.clientX - rect.left) / rect.width) * 720;
      const y = ((event.clientY - rect.top) / rect.height) * 224;
      const left = Number(svg.dataset.chartLeft) || 0;
      const top = Number(svg.dataset.chartTop) || 0;
      const plotWidth = Number(svg.dataset.chartWidth) || 0;
      const plotHeight = Number(svg.dataset.chartHeight) || 0;
      if (x < left || x > left + plotWidth || y < top || y > top + plotHeight) {
        hide();
        return;
      }
      const count = Number(svg.dataset.chartCount) || 0;
      if (!count) return;
      const step = count > 1 ? plotWidth / (count - 1) : 0;
      const index = count > 1 ? Math.round((x - left) / step) : 0;
      show(svg, Math.max(0, Math.min(count - 1, index)));
    });

    host.addEventListener('pointerleave', hide);
    host.addEventListener('focusin', (event) => {
      const point = event.target.closest?.('.trend-point[data-trend-index]');
      if (!point) return;
      const svg = point.closest('svg[data-accuracy-chart]');
      if (svg) show(svg, Number(point.dataset.trendIndex));
    });
    host.addEventListener('focusout', (event) => {
      if (!host.contains(event.relatedTarget)) hide();
    });
  }

  return { render };
}
