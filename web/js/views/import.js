import {
  MAX_UPLOAD_BYTES,
  analyzeTextWithAI,
  getAIConfig,
  recognizeImage,
} from '../api.js';
import { parseQuestions } from '../parser.js';
import { QuestionForm } from '../question-form.js';
import {
  createQuestion,
  makeEmptyDraft,
  questionDuplicateKey,
  QUESTION_TYPES,
} from '../store.js';
import {
  autoGrowTextarea,
  confirmAction,
  escapeHTML,
  icon,
  openDialog,
  toast,
  typeClass,
} from '../ui.js';

const MAX_FILES = 100;
const ACCEPTED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/bmp',
  'image/gif',
]);

function uid() {
  return globalThis.crypto?.randomUUID?.() || `f_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileStatusLabel(file) {
  if (file.status === 'recognizing') return '正在识别…';
  if (file.status === 'queued') return '排队中';
  if (file.status === 'done') {
    return `已识别${file.elapsed ? ` · ${file.elapsed}s` : ''}`;
  }
  if (file.status === 'error') return '识别失败';
  return '';
}

function fileStatusIcon(file) {
  if (file.status === 'done') return icon('check-circle', 18);
  if (file.status === 'error') return icon('alert', 18);
  return '<span class="mini-spinner" aria-hidden="true"></span>';
}

function fileAIStatusLabel(file) {
  if (file.aiStatus === 'analyzing') return 'AI 分析中…';
  if (file.aiStatus === 'queued') return 'AI 排队中';
  if (file.aiStatus === 'done') return 'AI 已分析';
  if (file.aiStatus === 'error') return 'AI 分析失败';
  if (file.aiStatus === 'skipped') return '无文字可分析';
  return '';
}

function fileCardHTML(file) {
  const canRemove = file.status !== 'recognizing';
  const canRetry = file.status === 'error';
  const aiStatusLabel = fileAIStatusLabel(file);
  const detail = file.error || file.aiError || '';
  return `
    <div class="file-card is-${file.status}" data-file-id="${escapeHTML(file.id)}">
      <div class="file-thumb">
        <img src="${escapeHTML(file.url)}" alt="">
      </div>
      <div class="file-copy">
        <strong title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</strong>
        <span class="file-meta">${formatFileSize(file.size)} · <em>${fileStatusLabel(file)}</em>${
          aiStatusLabel
            ? ` · <em class="file-ai-state is-${file.aiStatus}">${aiStatusLabel}</em>`
            : ''
        }</span>
        ${detail ? `<span class="file-error" title="${escapeHTML(file.hint || detail)}">${escapeHTML(detail)}</span>` : ''}
      </div>
      <span class="file-state" aria-hidden="true">${fileStatusIcon(file)}</span>
      <div class="file-actions">
        ${canRetry ? `<button type="button" class="icon-btn" data-file-action="retry" data-file-id="${escapeHTML(file.id)}" title="重新识别" aria-label="重新识别这张图片">${icon('refresh', 16)}</button>` : ''}
        <button type="button" class="icon-btn" data-file-action="remove" data-file-id="${escapeHTML(file.id)}"
          title="${canRemove ? '移除图片' : '识别中，暂时不能移除'}" aria-label="移除图片" ${canRemove ? '' : 'disabled'}>
          ${icon('x', 16)}
        </button>
      </div>
    </div>
  `;
}

function refreshFileCards(root, state) {
  if (!root?.isConnected) return;
  const list = root.querySelector('[data-file-list]');
  if (list) list.innerHTML = state.files.map(fileCardHTML).join('');
}

function ocrSummaryHTML(state) {
  if (!state.files.length) return '';
  const total = state.files.length;
  const done = state.files.filter((file) => file.status === 'done').length;
  const failed = state.files.filter((file) => file.status === 'error').length;
  const completed = done + failed;
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const currently = state.files.find((file) => file.status === 'recognizing');

  let label = '';
  if (state.busy) {
    label = currently
      ? `正在识别「${currently.name}」`
      : '正在准备识别…';
    label += ` · ${completed} / ${total}`;
  } else if (failed) {
    label = `识别结束 · ${done} 张成功，${failed} 张失败`;
  } else {
    label = `已识别 ${done} / ${total} 张图片`;
  }

  return `
    <div class="ocr-summary" data-ocr-summary role="status">
      <div class="ocr-summary-top">
        <span class="ocr-summary-label">
          <span class="status-dot ${state.busy ? 'is-busy' : failed ? 'is-warning' : 'is-ok'}"></span>
          ${escapeHTML(label)}
        </span>
        <span class="ocr-summary-pct">${progress}%</span>
      </div>
      <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
        <span style="width:${progress}%"></span>
      </div>
    </div>
  `;
}

function pageTemplate(state, destinationMarkup = '') {
  const hasActivity = Boolean(state.files.length || state.text || state.previewQuestions.length);
  const doneFiles = state.files.filter((file) => file.status === 'done').length;
  const stepIndex = state.previewQuestions.length ? 3 : doneFiles ? 2 : 1;

  return `
    <div class="page import-page">
      <header class="page-header">
        <div class="page-heading">
          <p class="eyebrow">IMPORT · 图片转题库</p>
          <h1>导入题目</h1>
          <p class="page-sub">上传截图或拍照，逐张本地 OCR 提取文字，再交给 AI 分别识别和拆题。</p>
        </div>
        <div class="header-actions">
          <button type="button" class="btn subtle" data-action="manual">${icon('edit', 17)} 手动录入</button>
          <button type="button" class="btn ghost" data-action="reset" ${hasActivity ? '' : 'disabled'}>
            ${icon('rotate', 16)} 清空本次
          </button>
        </div>
      </header>

      ${destinationMarkup}

      <ol class="flow-strip" aria-label="导入流程">
        <li class="${stepIndex === 1 ? 'is-active' : stepIndex > 1 ? 'is-done' : ''}">
          <span>01</span>上传图片
        </li>
        <li class="${stepIndex === 2 ? 'is-active' : stepIndex > 2 ? 'is-done' : ''}">
          <span>02</span>识别校对
        </li>
        <li class="${stepIndex === 3 ? 'is-active' : ''}">
          <span>03</span>确认入库
        </li>
      </ol>

      <div class="import-top">
        <section class="panel upload-panel">
          <div class="dropzone" data-dropzone tabindex="0" role="button" aria-label="选择或拖入题目图片">
            <div class="dropzone-glow" aria-hidden="true"></div>
            <span class="dropzone-icon">${icon('scan', 26)}</span>
            <h2>把题目图片放到这里</h2>
            <p>拖入、点选，或直接按 <kbd>Ctrl</kbd> + <kbd>V</kbd> 粘贴截图</p>
            <div class="dropzone-actions">
              <button type="button" class="btn primary" data-action="choose-files">${icon('image', 17)} 选择图片</button>
              <button type="button" class="btn subtle" data-action="choose-camera">${icon('camera', 17)} 拍照导入</button>
            </div>
            <span class="dropzone-note">PNG / JPG / WebP · 单张不超过 25MB · 可多选 · 单批最多 100 张</span>
          </div>
          <input type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/bmp,image/gif"
            data-role="file-input">
          <input type="file" hidden accept="image/*" capture="environment" data-role="file-input">
          <div class="file-list" data-file-list>${state.files.map(fileCardHTML).join('')}</div>
          <div data-ocr-status>${ocrSummaryHTML(state)}</div>
        </section>

        <aside class="panel import-tips">
          <div class="tips-mark">${icon('sparkles', 20)}</div>
          <h2>拍得清楚，拆得整齐</h2>
          <ul class="tip-list">
            <li><b>尽量正对题目</b><span>减少倾斜和阴影，识别率更高。</span></li>
            <li><b>选项分行更清晰</b><span>即使挤在一行，也会尝试自动拆分。</span></li>
            <li><b>识别后先校对</b><span>公式、下划线等易错处可以手动修正。</span></li>
          </ul>
          <div class="local-badge">
            <span class="status-dot is-ok"></span>
            <div><b>图片不出本机</b><span>AI 只接收每张图单独提取出的文字，不接收图片</span></div>
          </div>
        </aside>
      </div>

      <div class="workbench" data-workbench ${hasActivity ? '' : 'hidden'}>
        <section class="panel ocr-editor-panel">
          <header class="panel-head">
            <div>
              <h2>识别文本</h2>
              <p>识别有误时先改文字，再重新拆题。</p>
            </div>
            <span class="char-count" data-char-count>${state.text.length} 字</span>
          </header>
          <textarea class="ocr-textarea" data-role="ocr-text" data-autogrow spellcheck="false"
            placeholder="图片识别出的文字会出现在这里…" ${state.busy ? 'readonly' : ''}>${escapeHTML(state.text)}</textarea>
          <div class="editor-foot">
            <span class="editor-hint">${state.busy ? '识别完成后即可编辑' : state.textDirty ? '文本已修改，记得重新拆题' : '自动拆题结果可在右侧校对'}</span>
            <button type="button" class="btn primary" data-action="parse" ${state.busy || !state.text.trim() ? 'disabled' : ''}>
              ${icon('sparkles', 16)} ${state.previewQuestions.length ? '重新拆题' : '智能拆题'}
            </button>
          </div>
        </section>

        <section class="panel preview-panel">
          <header class="panel-head preview-head">
            <div>
              <h2>题目预览</h2>
              <p data-preview-summary></p>
            </div>
            <div class="preview-actions">
              <span class="missing-answers" data-missing-warning hidden></span>
              <button type="button" class="btn subtle" data-action="retry-ai-failed" hidden>
                ${icon('refresh', 16)} <span data-ai-retry-label>重试失败项</span>
              </button>
              <button type="button" class="btn subtle ai-review-button" data-action="ai-review">
                ${icon('sparkles', 16)} <span data-ai-review-label>AI 逐图分析</span>
              </button>
              <button type="button" class="btn primary" data-action="save">
                ${icon('check', 16)} 保存 <span data-save-count>${state.previewQuestions.length}</span> 道
              </button>
            </div>
          </header>
          <div class="ai-review-banner" data-ai-review-status hidden></div>
          <div class="preview-list" data-preview-list></div>
          <button type="button" class="add-preview-card" data-action="add-preview">
            ${icon('plus', 16)} 再增加一道空白题
          </button>
          <div class="preview-save-footer">
            <span data-footer-hint>校对无误后保存到题库</span>
            <button type="button" class="btn primary" data-action="save">
              ${icon('check', 16)} 保存 <span data-save-count>${state.previewQuestions.length}</span> 道
            </button>
          </div>
        </section>
      </div>
    </div>
  `;
}

export function createImportView(app) {
  const state = {
    files: [],
    text: '',
    textDirty: false,
    previewQuestions: [],
    previewDirty: false,
    busy: false,
    processing: false,
    aiBusy: false,
    aiProgress: '',
    aiOnlyFailed: false,
    aiPendingResults: null,
    aiLastResults: null,
    targetSubjectId: '',
    targetBankId: '',
    token: 0,
  };

  let rootRef = null;
  let eventController = null;
  let forms = [];

  const isConnected = () => Boolean(rootRef && rootRef.isConnected);
  const hasActivity = () => Boolean(state.files.length || state.text || state.previewQuestions.length);

  function ensureTarget() {
    let subject = app.subjectById(state.targetSubjectId);
    if (!subject) {
      const fallback = app.getDefaultTarget();
      state.targetSubjectId = fallback.subjectId;
      state.targetBankId = fallback.bankId;
      return;
    }
    const bank = app.bankById(state.targetBankId);
    if (!bank || bank.subjectId !== subject.id) {
      const fallback = app.getDefaultTarget(subject.id);
      state.targetBankId = fallback.bankId;
    }
  }

  function destinationHTML() {
    const subject = app.subjectById(state.targetSubjectId);
    const banks = subject ? app.banksForSubject(subject.id) : [];
    const bank = app.bankById(state.targetBankId);
    const targetLabel =
      subject && bank ? `${subject.name} / ${bank.name}` : subject ? `${subject.name} / 未选子题库` : '未选科目';
    return `
      <section class="panel import-destination" data-import-destination>
        <div class="import-destination-copy">
          <span class="import-destination-icon">${icon('layers', 18)}</span>
          <div>
            <strong>保存到</strong>
            <span>${escapeHTML(targetLabel)}</span>
          </div>
        </div>
        <div class="import-destination-controls">
          <label class="import-destination-field">
            <span>科目</span>
            <div class="select-wrap">
              <select data-role="import-subject" aria-label="选择题库科目">
                ${
                  app.state.subjects.length
                    ? app.state.subjects
                        .map(
                          (item) =>
                            `<option value="${escapeHTML(item.id)}" ${item.id === state.targetSubjectId ? 'selected' : ''}>${escapeHTML(item.name)}</option>`,
                        )
                        .join('')
                    : '<option value="">尚未创建科目</option>'
                }
              </select>
              ${icon('chevron-down', 14)}
            </div>
          </label>
          <label class="import-destination-field">
            <span>子题库</span>
            <div class="select-wrap">
              <select data-role="import-bank" aria-label="选择题库子题库" ${banks.length ? '' : 'disabled'}>
                ${
                  banks.length
                    ? banks
                        .map(
                          (item) =>
                            `<option value="${escapeHTML(item.id)}" ${item.id === state.targetBankId ? 'selected' : ''}>${escapeHTML(item.name)}</option>`,
                        )
                        .join('')
                    : '<option value="">暂无子题库</option>'
                }
              </select>
              ${icon('chevron-down', 14)}
            </div>
          </label>
          <div class="import-destination-actions">
            <button type="button" class="btn subtle" data-action="create-import-subject">
              ${icon('plus', 14)} 新建科目
            </button>
            <button type="button" class="btn subtle" data-action="create-import-bank" ${subject ? '' : 'disabled'}>
              ${icon('plus', 14)} 新建子题库
            </button>
          </div>
        </div>
        ${
          subject && bank
            ? `<p class="import-destination-note">${icon('check-circle', 13)} 保存后题目会归入这个子题库并写入 Markdown，可在题库页单独练习。</p>`
            : `<p class="import-destination-note is-warning">${icon('alert', 13)} 请先创建并选择科目和子题库，然后才能保存。</p>`
        }
      </section>
    `;
  }

  function refreshDestinationUi({ highlight = false } = {}) {
    if (!isConnected()) return;
    const host = rootRef.querySelector('[data-import-destination]');
    if (!host) return;
    host.outerHTML = destinationHTML();
    if (highlight) {
      const next = rootRef.querySelector('[data-import-destination]');
      next?.classList.add('needs-attention');
      next?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => next?.classList.remove('needs-attention'), 1800);
    }
  }

  function syncPreviewFromForms() {
    forms.forEach((form, index) => {
      state.previewQuestions[index] = form.getQuestion();
    });
  }

  function mountForms() {
    if (!isConnected()) return;
    const list = rootRef.querySelector('[data-preview-list]');
    if (!list) return;

    const hadPreviews = forms.length > 0;
    if (hadPreviews) syncPreviewFromForms();
    forms = [];
    list.innerHTML = '';

    if (!state.previewQuestions.length) {
      list.innerHTML = `
        <div class="preview-empty">
          <span>${icon('file-text', 24)}</span>
          <h3>还没有可校对的题目</h3>
          <p>识别完成后会自动拆分；也可以修改左侧文字后点击「智能拆题」。</p>
        </div>
      `;
      updatePreviewMeta();
      return;
    }

    state.previewQuestions.forEach((question, index) => {
      const card = document.createElement('article');
      card.className = 'preview-card';
      card.dataset.previewIndex = String(index);

      const header = document.createElement('header');
      header.className = 'preview-card-head';
      header.innerHTML = `
        <span class="preview-number">${String(index + 1).padStart(2, '0')}</span>
        <span class="preview-caption">题目草稿</span>
        <button type="button" class="icon-btn preview-remove" data-action="remove-preview"
          data-index="${index}" aria-label="删除第 ${index + 1} 题" title="删除这道题">
          ${icon('trash', 16)}
        </button>
      `;
      card.appendChild(header);

      const mount = document.createElement('div');
      card.appendChild(mount);
      list.appendChild(card);

      let form;
      form = new QuestionForm(question, {
        compact: true,
        onChange: () => {
          state.previewQuestions[index] = form.getQuestion();
          state.previewDirty = true;
          updatePreviewMeta();
        },
      });
      mount.appendChild(form.element);
      forms.push(form);
    });

    updatePreviewMeta();
  }

  function updatePreviewMeta() {
    if (!isConnected()) return;
    const count = state.previewQuestions.length;
    const missing = state.previewQuestions.filter(
      (question) => question.type !== 'short' && !String(question.answer || '').trim(),
    ).length;
    const shortCount = state.previewQuestions.filter((question) => question.type === 'short').length;
    const summary = rootRef.querySelector('[data-preview-summary]');
    const warning = rootRef.querySelector('[data-missing-warning]');
    const footerHint = rootRef.querySelector('[data-footer-hint]');
    const saveButtons = rootRef.querySelectorAll('[data-action="save"]');
    const parseButton = rootRef.querySelector('[data-action="parse"]');

    if (summary) {
      summary.textContent = count
        ? `已拆出 ${count} 道题，可直接修改题干、选项和答案。`
        : '自动拆题后，可在这里逐题校对。';
    }
    rootRef.querySelectorAll('[data-save-count]').forEach((node) => {
      node.textContent = String(count);
    });
    saveButtons.forEach((button) => {
      button.disabled = count === 0 || state.busy || state.aiBusy;
    });
    if (warning) {
      warning.hidden = missing === 0;
      warning.textContent = missing ? `${missing} 道缺答案` : '';
    }
    if (footerHint) {
      footerHint.textContent = missing
        ? `${missing} 道题还没设置答案，仍可先保存`
        : shortCount
          ? '简答题的参考答案仅供参考，可留空；校对后保存'
          : '校对无误后保存到题库';
    }
    if (parseButton) {
      parseButton.disabled = state.busy || state.aiBusy || !state.text.trim();
      parseButton.innerHTML = `${icon('sparkles', 16)} ${count ? '重新拆题' : '智能拆题'}`;
    }
    updateAIUi();
  }

  function updateAIUi() {
    if (!isConnected()) return;
    const button = rootRef.querySelector('[data-action="ai-review"]');
    const label = rootRef.querySelector('[data-ai-review-label]');
    const retryButton = rootRef.querySelector('[data-action="retry-ai-failed"]');
    const retryLabel = rootRef.querySelector('[data-ai-retry-label]');
    const banner = rootRef.querySelector('[data-ai-review-status]');
    const failedAI = state.files.filter((file) => file.aiStatus === 'error').length;

    if (button) {
      button.disabled = state.busy || state.aiBusy || !state.files.length;
      button.classList.toggle('is-busy', state.aiBusy);
      button.title = state.files.length
        ? '逐张把每张图片单独 OCR 出的文字交给 AI 分析，不发送图片'
        : '先添加图片再进行 AI 分析';
    }
    if (retryButton) {
      retryButton.hidden =
        state.aiBusy || failedAI === 0 || !Array.isArray(state.aiLastResults);
      retryButton.disabled = state.busy || state.aiBusy;
      retryButton.title = failedAI
        ? `只重新发送 ${failedAI} 张 AI 分析失败的图片文字`
        : '';
    }
    if (retryLabel) {
      retryLabel.textContent = failedAI ? `重试失败项 (${failedAI})` : '重试失败项';
    }
    if (label) {
      label.textContent = state.aiBusy
        ? `${state.aiOnlyFailed ? '重试失败项' : 'AI 分析'} ${state.aiProgress || ''}`.trim()
        : 'AI 逐图分析';
    }
    if (banner) {
      banner.hidden = !state.aiBusy;
      if (state.aiBusy) {
        const current = state.files.find((file) => file.aiStatus === 'analyzing');
        banner.innerHTML = `
          <span class="mini-spinner" aria-hidden="true"></span>
          <div>
            <strong>${
              state.aiOnlyFailed ? 'AI 正在重试失败图片' : 'AI 正在逐图分析'
            }${state.aiProgress ? ` · 第 ${state.aiProgress} 张` : ''}${
              current ? `「${escapeHTML(current.name)}」` : ''
            }</strong>
            <p>${
              state.aiOnlyFailed
                ? '只重新发送失败图片单独提取出的 OCR 文字，图片本身不会发送。'
                : '每张图片单独 OCR，再单独发送这段文字给 AI；图片本身不会发送。正在按顺序循环处理。'
            }</p>
          </div>
        `;
      }
    }
  }

  function refreshFileUi() {
    if (!isConnected()) return;
    const list = rootRef.querySelector('[data-file-list]');
    const status = rootRef.querySelector('[data-ocr-status]');
    const textarea = rootRef.querySelector('[data-role="ocr-text"]');
    const charCount = rootRef.querySelector('[data-char-count]');
    const parseButton = rootRef.querySelector('[data-action="parse"]');

    if (list) list.innerHTML = state.files.map(fileCardHTML).join('');
    if (status) status.innerHTML = ocrSummaryHTML(state);
    if (textarea) {
      textarea.readOnly = state.busy;
      if (document.activeElement !== textarea) textarea.value = state.text;
    }
    if (charCount) charCount.textContent = `${state.text.length} 字`;
    if (parseButton) parseButton.disabled = state.busy || !state.text.trim();

    const editorHint = rootRef.querySelector('.editor-hint');
    if (editorHint) {
      editorHint.textContent = state.busy
        ? '识别完成后即可编辑'
        : state.textDirty
          ? '文本已修改，记得重新拆题'
          : '自动拆题结果可在右侧校对';
    }

    updatePreviewMeta();
    updateFlowStrip();
  }

  function updateFlowStrip() {
    if (!isConnected()) return;
    const steps = rootRef.querySelectorAll('.flow-strip li');
    if (!steps.length) return;
    const doneFiles = state.files.filter((file) => file.status === 'done').length;
    const stepIndex = state.previewQuestions.length ? 3 : doneFiles ? 2 : 1;
    steps.forEach((step, index) => {
      step.classList.toggle('is-active', index + 1 === stepIndex);
      step.classList.toggle('is-done', index + 1 < stepIndex);
    });
  }

  function aiQuestionCardHTML(question, index) {
    const confidence = Number(question.confidence);
    const percent = Number.isFinite(confidence) ? Math.round(confidence * 100) : null;
    const tone = percent === null ? 'mid' : percent >= 85 ? 'high' : percent >= 65 ? 'mid' : 'low';
    const warningList = Array.isArray(question.warnings) ? question.warnings : [];
    const needsReview = tone === 'low' || warningList.length > 0;
    const answer = String(question.answer || '').trim();
    const type = QUESTION_TYPES[question.type] ? question.type : 'fill';
    const sourceLabel = question.sourceNumber ? `原题号 ${question.sourceNumber}` : 'AI 分析';
    const options = Array.isArray(question.options) ? question.options : [];
    return `
      <div class="ai-question-card ${needsReview ? 'needs-review' : ''}">
        <label class="ai-question-pick">
          <input type="checkbox" data-ai-pick data-ai-index="${index}"
            aria-label="采用第 ${index + 1} 道 AI 识别题目" checked>
        </label>
        <div class="ai-question-main">
          <div class="ai-question-head">
            <span class="ai-question-number">${escapeHTML(sourceLabel)}</span>
            <span class="type-badge type-${typeClass(type)}">${QUESTION_TYPES[type]}</span>
            ${
              percent === null
                ? ''
                : `<span class="ai-confidence confidence-${tone}">AI 置信度 ${percent}%</span>`
            }
          </div>
          <p class="ai-question-stem">${escapeHTML(question.stem || '')}</p>
          <div class="ai-question-meta">
            <span>${
              answer
                ? `${type === 'short' ? '参考答案' : '答案'}：${escapeHTML(answer)}`
                : type === 'short'
                  ? '未提供参考答案（可留空）'
                  : '未识别到答案'
            }</span>
            <span>${options.length} 个选项</span>
          </div>
          ${
            warningList.length
              ? `<div class="ai-question-warnings">${warningList
                  .map((warning) => `<span>${icon('alert', 12)} ${escapeHTML(warning)}</span>`)
                  .join('')}</div>`
              : ''
          }
          <details class="ai-question-more">
            <summary>查看完整题目</summary>
            <div class="ai-question-detail-body">
              <p class="ai-full-stem">${escapeHTML(question.stem || '')}</p>
              ${
                options.length
                  ? `<div class="ai-option-preview">${options
                      .map(
                        (option) =>
                          `<span><b>${escapeHTML(option.key || '')}</b>${escapeHTML(option.text || '')}</span>`,
                      )
                      .join('')}</div>`
                  : '<p class="ai-detail-empty">无选项</p>'
              }
              ${
                question.explanation
                  ? `<div class="ai-detail-explanation"><span>解析</span><p>${escapeHTML(
                      question.explanation,
                    )}</p></div>`
                  : ''
              }
            </div>
          </details>
        </div>
      </div>
    `;
  }

  function showAIReviewDialog(results) {
    const flat = [];
    const currentCount = state.previewQuestions.length;

    const pagesHtml = results
      .map((page, pageIndex) => {
        const pageQuestions = Array.isArray(page.questions) ? page.questions : [];
        const warnings = Array.isArray(page.pageWarnings) ? page.pageWarnings : [];
        const pageNumber = page.pageNumber || pageIndex + 1;
        const filename = page.filename || `第 ${pageIndex + 1} 张`;
        const questionsHtml = pageQuestions
          .map((question) => {
            const index = flat.length;
            const questionWarnings = Array.isArray(question.warnings)
              ? question.warnings
              : [];
            const confidence = Number(question.confidence);
            const reviewWarnings = [
              ...new Set(
                [...questionWarnings, ...warnings]
                  .map((warning) => String(warning || '').trim())
                  .filter(Boolean),
              ),
            ];
            const lowConfidence = Number.isFinite(confidence) && confidence < 0.7;
            const aiReview =
              reviewWarnings.length || lowConfidence
                ? {
                    flagged: true,
                    confidence: Number.isFinite(confidence) ? confidence : null,
                    warnings: reviewWarnings,
                    sourceFilename: filename,
                    pageNumber,
                  }
                : null;
            flat.push({
              ...question,
              pageNumber,
              filename,
              aiReview,
            });
            return aiQuestionCardHTML(question, index);
          })
          .join('');
        return `
          <section class="ai-page-block">
            <header class="ai-page-head">
              <div>
                <span class="ai-page-index">PAGE ${String(pageIndex + 1).padStart(2, '0')}</span>
                <strong>${escapeHTML(page.filename || `第 ${pageIndex + 1} 张图片`)}</strong>
              </div>
              <span>${pageQuestions.length} 道</span>
            </header>
            ${
              warnings.length
                ? `<div class="ai-page-warning">${warnings
                    .map((warning) => `<span>${icon('alert', 13)} ${escapeHTML(warning)}</span>`)
                    .join('')}</div>`
                : ''
            }
            ${
              questionsHtml ||
              `<div class="ai-page-empty">${icon('info', 15)} ${
                page.error ? '这张图片的 AI 分析失败。' : 'AI 没有从这段文字中拆出题目。'
              }</div>`
            }
          </section>
        `;
      })
      .join('');

    if (!flat.length) {
      toast('AI 没有从逐图文字中拆出可应用的题目。', 'error', 4200);
      return;
    }

    const countMismatch = currentCount !== flat.length;
    const failedPages = results.filter((page) => page.error).length;
    const lowCount = flat.filter((question) => {
      const confidence = Number(question.confidence);
      return (Number.isFinite(confidence) && confidence < 0.7) || question.warnings?.length;
    }).length;

    openDialog({
      title: 'AI 分析结果',
      eyebrow: 'AI ANALYSIS BEFORE APPLYING',
      description: 'AI 只分析每张图 OCR 出的文字，不接收图片。勾选要采用的题目，应用后仍可编辑再保存。',
      size: 'lg',
      content: `
        <div class="ai-result">
          <div class="ai-result-summary">
            <span class="ai-result-icon">${icon('sparkles', 22)}</span>
            <div>
              <h3>共分析 ${results.length} 张图片的文字，拆出 ${flat.length} 道题</h3>
              <p>当前预览 ${currentCount} 道题${lowCount ? ` · ${lowCount} 道带有低置信度提示` : ''}${
                failedPages ? ` · ${failedPages} 张分析失败` : ''
              }</p>
            </div>
            <span class="ai-seal">AI 建议</span>
          </div>

          ${
            countMismatch
              ? `<div class="ai-count-warning">${icon('alert', 16)}
                  <p>题目数量不一致：当前预览 ${currentCount} 道，AI 从文字中拆出 ${flat.length} 道。请逐项检查后勾选需要采用的题目。</p>
                </div>`
              : ''
          }

          ${
            failedPages
              ? `<div class="ai-count-warning">${icon('alert', 16)}
                  <p>有 ${failedPages} 张图片的文字分析失败或被跳过，应用结果不会包含这些图片的题目。</p>
                </div>`
              : ''
          }

          <div class="ai-apply-note">
            ${icon('info', 15)}
            <p>${
              currentCount
                ? '应用后会替换右侧当前预览，包含你已手动修改的内容；左侧识别文本不会改变。'
                : '应用后会把 AI 拆出的题目放入右侧预览，保存前仍可逐题修改。'
            }OCR 文字中没有的答案会保持为空。</p>
          </div>

          <div class="ai-select-row">
            <label class="ai-select-all">
              <input type="checkbox" data-ai-select-all checked>
              <span>全选</span>
            </label>
            <span>勾选要应用到预览的题目</span>
          </div>

          <div class="ai-pages">${pagesHtml}</div>
        </div>
      `,
      footer: `
        <button type="button" class="text-button ai-decision-link" data-ai-ask-decision>
          ${icon('sparkles', 14)} 让 AI 帮我决定
        </button>
        <button type="button" class="btn subtle" data-ai-dialog-cancel>取消</button>
        <button type="button" class="btn primary" data-ai-dialog-apply>
          ${icon('check', 16)} 应用选中 <span data-ai-selected-count>${flat.length}</span> 道
        </button>
      `,
      onMount: ({ dialog, close }) => {
        const checkboxes = [...dialog.querySelectorAll('[data-ai-pick]')];
        const selectAll = dialog.querySelector('[data-ai-select-all]');
        const applyButton = dialog.querySelector('[data-ai-dialog-apply]');
        const selectedCount = dialog.querySelector('[data-ai-selected-count]');

        const updateSelection = () => {
          const count = checkboxes.filter((checkbox) => checkbox.checked).length;
          if (selectedCount) selectedCount.textContent = String(count);
          if (applyButton) applyButton.disabled = count === 0;
          if (selectAll) {
            selectAll.checked = count === checkboxes.length;
            selectAll.indeterminate = count > 0 && count < checkboxes.length;
          }
        };

        checkboxes.forEach((checkbox) => checkbox.addEventListener('change', updateSelection));
        selectAll?.addEventListener('change', () => {
          checkboxes.forEach((checkbox) => {
            checkbox.checked = selectAll.checked;
          });
          updateSelection();
        });

        dialog.querySelector('[data-ai-dialog-cancel]')?.addEventListener('click', close);
        dialog.querySelector('[data-ai-ask-decision]')?.addEventListener('click', () => {
          close();
          window.setTimeout(() => app.openContextAIAssistant(), 60);
        });
        applyButton?.addEventListener('click', () => {
          const selected = flat.filter((_, index) => checkboxes[index]?.checked);
          if (!selected.length) return;
          const questions = selected.map((question) => ({
            type: QUESTION_TYPES[question.type] ? question.type : 'fill',
            stem: question.stem,
            options: Array.isArray(question.options)
              ? question.options.map((option, index) => ({
                  key: 'ABCDEFGH'[index] || option.key,
                  text: option.text,
                }))
              : [],
            answer: question.answer || '',
            explanation: question.explanation || '',
            aiReview: question.aiReview || null,
          }));

          // 先让 forms 失效，避免 render() 把旧的题目表单数据写回 state。
          forms = [];
          state.previewQuestions = questions;
          state.previewDirty = true;
          close();
          render();
          toast(`已应用 ${questions.length} 道 AI 分析结果，请继续校对后保存。`, 'success', 4000);
        });

        updateSelection();
      },
    });
  }

  async function runAIReview({ onlyFailed = false } = {}) {
    if (state.aiBusy) return;
    if (state.busy) {
      toast('本地识别完成后才能进行 AI 文字分析。', 'info');
      return;
    }
    if (!state.files.length) {
      toast('请先添加题目图片。', 'info');
      return;
    }
    if (onlyFailed && !Array.isArray(state.aiLastResults)) {
      toast('上一轮 AI 结果已失效，请重新分析全部图片。', 'info', 4200);
      return;
    }

    let config;
    try {
      config = await getAIConfig();
    } catch (error) {
      toast(`读取 AI 设置失败：${error.message || '未知错误'}`, 'error', 4200);
      return;
    }
    if (!isConnected()) return;
    if (!config.configured) {
      toast('先配置 AI 服务，然后就可以逐图分析 OCR 文字。', 'info', 3800);
      app.openAISettings();
      return;
    }

    let host = '';
    try {
      host = new URL(config.endpoint).host;
    } catch {
      host = '';
    }

    const allFiles = state.files.slice();
    const targets = allFiles
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => !onlyFailed || file.aiStatus === 'error');
    if (!targets.length) {
      toast(
        onlyFailed ? '没有需要重试的 AI 失败项。' : '请先添加题目图片。',
        'info',
      );
      return;
    }
    const targetFiles = targets.map(({ file }) => file);
    const textCount = targetFiles.filter((file) => String(file.text || '').trim()).length;
    if (!textCount) {
      toast('本地 OCR 还没有提取到可分析的文字，请先完成识别或校对文字。', 'info', 4200);
      return;
    }

    const proceed = await confirmAction({
      title: onlyFailed ? '重试失败的 AI 分析？' : '逐图发送文字给 AI 分析？',
      message: onlyFailed
        ? `只重新发送 ${targets.length} 张 AI 分析失败图片的 OCR 文字，不发送图片。将发送到「${host || '你配置的 AI 服务'}」（模型：${config.model}）。调用可能产生费用。`
        : `将按图片循环处理：每张图只发送它单独提取出的 OCR 文字，不发送图片。当前有 ${textCount} / ${targets.length} 张包含文字，将发送到「${host || '你配置的 AI 服务'}」（模型：${config.model}）。AI 结果必须由你确认后才会替换预览，调用可能产生费用。`,
      confirmText: onlyFailed ? '开始重试' : '开始逐图分析',
    });
    if (!proceed || !isConnected()) return;

    const token = state.token;
    state.aiBusy = true;
    state.aiOnlyFailed = onlyFailed;
    state.aiProgress = `0/${targets.length}`;
    if (!onlyFailed) state.aiLastResults = null;
    if (onlyFailed) {
      targets.forEach(({ file }) => {
        file.aiStatus = 'queued';
        file.aiError = '';
      });
    } else {
      allFiles.forEach((file) => {
        file.aiStatus = 'queued';
        file.aiError = '';
      });
    }
    refreshFileCards(rootRef, state);
    updatePreviewMeta();

    const previousByPage = new Map();
    if (onlyFailed && Array.isArray(state.aiLastResults)) {
      state.aiLastResults.forEach((page, index) => {
        previousByPage.set(page.pageNumber || index + 1, page);
      });
    }

    const retriedResults = [];
    for (let position = 0; position < targets.length; position += 1) {
      if (token !== state.token) return;
      const { file, index } = targets[position];
      const pageNumber = index + 1;
      state.aiProgress = `${position + 1}/${targets.length}`;
      updateAIUi();

      const text = String(file.text || '').trim();
      if (!text) {
        file.aiStatus = 'skipped';
        file.aiError = '本地 OCR 没有提取到文字。';
        refreshFileCards(rootRef, state);
        retriedResults.push({
          pageNumber,
          filename: file.name,
          questions: [],
          pageWarnings: ['本地 OCR 没有提取到文字，已跳过这一张的 AI 分析。'],
          error: '本地 OCR 没有提取到文字。',
        });
      } else {
        file.aiStatus = 'analyzing';
        refreshFileCards(rootRef, state);
        try {
          const response = await analyzeTextWithAI({
            ocrText: text,
            filename: file.name,
            pageNumber,
            pageCount: allFiles.length,
          });
          if (token !== state.token) return;
          file.aiStatus = 'done';
          file.aiError = '';
          refreshFileCards(rootRef, state);
          retriedResults.push({ ...response, filename: file.name, pageNumber });
        } catch (error) {
          if (token !== state.token) return;
          file.aiStatus = 'error';
          const detail = `${error.message || '未知错误'}${error.hint ? ` ${error.hint}` : ''}`;
          file.aiError = detail;
          refreshFileCards(rootRef, state);
          retriedResults.push({
            pageNumber,
            filename: file.name,
            questions: [],
            pageWarnings: [`这一张的 AI 文字分析失败：${detail}`],
            error: detail,
          });
        }
      }

      if (position < targets.length - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
    }

    if (token !== state.token) return;
    state.aiBusy = false;
    state.aiOnlyFailed = false;
    state.aiProgress = '';

    let results;
    if (onlyFailed) {
      retriedResults.forEach((page) => previousByPage.set(page.pageNumber, page));
      results = allFiles.map((file, index) => {
        return (
          previousByPage.get(index + 1) || {
            pageNumber: index + 1,
            filename: file.name,
            questions: [],
            pageWarnings: ['这一页还没有 AI 分析结果。'],
            error: '尚未分析',
          }
        );
      });
    } else {
      results = retriedResults;
    }

    state.aiLastResults = results;
    updatePreviewMeta();

    const flat = flattenAIResults(results);
    const failedPages = results.filter((page) => page.error).length;
    if (!flat.length) {
      toast(
        `AI 逐图分析结束，但没有从文字中拆出题目${failedPages ? `；${failedPages} 张分析失败` : ''}。`,
        'error',
        5200,
      );
      return;
    }

    if (!isConnected()) {
      state.aiPendingResults = results;
      toast('AI 逐图分析已完成，返回「导入题目」查看结果。', 'success', 4600);
      return;
    }
    showAIReviewDialog(results);
  }

  function flattenAIResults(results) {
    const flat = [];
    results.forEach((page, pageIndex) => {
      (Array.isArray(page.questions) ? page.questions : []).forEach((question) => {
        flat.push({
          ...question,
          pageNumber: page.pageNumber || pageIndex + 1,
          filename: page.filename || `第 ${pageIndex + 1} 张图片`,
        });
      });
    });
    return flat;
  }

  function aiQuestionsToPreview(questions) {
    return questions.map((question) => ({
      type: QUESTION_TYPES[question.type] ? question.type : 'fill',
      stem: question.stem,
      options: Array.isArray(question.options)
        ? question.options.map((option, index) => ({
            key: 'ABCDEFGH'[index] || option.key,
            text: option.text,
          }))
        : [],
      answer: question.answer || '',
      explanation: question.explanation || '',
    }));
  }

  function replacePreviewWithAI(questions, message) {
    if (!questions.length) {
      toast('没有符合条件的 AI 题目可应用。', 'info');
      return false;
    }
    forms = [];
    state.previewQuestions = aiQuestionsToPreview(questions);
    state.previewDirty = true;
    render();
    toast(message || `已应用 ${questions.length} 道 AI 分析结果。`, 'success', 4000);
    return true;
  }

  function applyCachedAIResults({ minConfidence = 0, requireNoWarnings = false } = {}) {
    if (!state.aiLastResults) {
      toast('还没有可应用的 AI 分析结果，请先运行「AI 逐图分析」。', 'info', 3800);
      return false;
    }
    const flat = flattenAIResults(state.aiLastResults);
    const selected = flat.filter((question) => {
      const confidence = Number(question.confidence);
      const hasWarnings = Array.isArray(question.warnings) && question.warnings.length > 0;
      return confidence >= minConfidence && (!requireNoWarnings || !hasWarnings);
    });
    if (!selected.length) {
      toast(
        requireNoWarnings
          ? '没有符合高置信度条件的 AI 题目，请逐题查看 AI 结果。'
          : '没有可应用的 AI 题目。',
        'info',
        3800,
      );
      return false;
    }
    return replacePreviewWithAI(
      selected,
      `已应用 ${selected.length} 道${requireNoWarnings ? '高置信度' : ''} AI 结果，请继续校对。`,
    );
  }

  function getAssistantConfig() {
    const flat = state.aiLastResults ? flattenAIResults(state.aiLastResults) : [];
    const actions = [];
    if (state.files.length && !state.busy && !state.aiBusy) actions.push('import_run_text_analysis');
    if (flat.length) actions.push('import_open_picker', 'import_apply_high', 'import_apply_all');

    const warnings = state.aiLastResults
      ? state.aiLastResults.flatMap((page) => (Array.isArray(page.pageWarnings) ? page.pageWarnings : []))
      : [];

    return {
      mode: 'import',
      contextLabel: `导入 · 本地 ${state.previewQuestions.length} 道${
        flat.length ? ` · AI ${flat.length} 道` : ''
      }`,
      context: {
        page: 'import',
        localOcrBusy: state.busy,
        aiBusy: state.aiBusy,
        files: state.files.map((file) => ({
          name: file.name,
          status: file.status,
          aiStatus: file.aiStatus || 'idle',
          ocrCharacters: String(file.text || '').length,
          error: file.error || '',
        })),
        ocrCharacters: state.text.length,
        localPreviewCount: state.previewQuestions.length,
        missingAnswers: state.previewQuestions.filter(
          (question) => question.type !== 'short' && !question.answer,
        ).length,
        previewQuestions: state.previewQuestions.slice(0, 10).map((question) => ({
          type: question.type,
          stem: question.stem.slice(0, 260),
          optionsCount: question.options.length,
          answer: question.answer,
        })),
        lastAIReview: state.aiLastResults
          ? {
              pages: state.aiLastResults.length,
              questionCount: flat.length,
              failedPages: state.aiLastResults.filter((page) => page.error).length,
              lowConfidenceCount: flat.filter(
                (question) => Number(question.confidence) < 0.8 || question.warnings?.length,
              ).length,
              pageWarnings: warnings.slice(0, 8),
              questions: flat.slice(0, 10).map((question) => ({
                stem: question.stem.slice(0, 260),
                type: question.type,
                confidence: question.confidence,
                warnings: question.warnings || [],
              })),
            }
          : null,
      },
      availableActions: actions,
    };
  }

  async function handleAssistantAction(action) {
    if (action === 'import_run_text_analysis') {
      await runAIReview();
      return;
    }
    if (action === 'import_open_picker') {
      if (state.aiLastResults) showAIReviewDialog(state.aiLastResults);
      else toast('还没有缓存的 AI 分析结果。', 'info');
      return;
    }
    if (action === 'import_apply_high') {
      applyCachedAIResults({ minConfidence: 0.8, requireNoWarnings: true });
      return;
    }
    if (action === 'import_apply_all') {
      applyCachedAIResults();
      return;
    }
    toast('这个导入 AI 操作当前不可用。', 'info');
  }

  function render(options = {}) {
    if (!isConnected()) return;
    eventController?.abort();
    eventController = new AbortController();
    syncPreviewFromForms();
    if (Object.prototype.hasOwnProperty.call(options, 'subjectId')) {
      state.targetSubjectId = app.subjectById(options.subjectId)?.id || '';
      state.targetBankId = '';
    }
    if (Object.prototype.hasOwnProperty.call(options, 'bankId')) {
      const bank = app.bankById(options.bankId);
      state.targetBankId = bank ? bank.id : '';
      if (bank) state.targetSubjectId = bank.subjectId;
    }
    ensureTarget();
    rootRef.innerHTML = pageTemplate(state, destinationHTML());
    bindEvents();
    mountForms();
    refreshFileUi();

    if (state.aiPendingResults && !state.aiBusy) {
      const pending = state.aiPendingResults;
      state.aiPendingResults = null;
      window.setTimeout(() => {
        if (isConnected() && !document.querySelector('dialog[open]')) {
          showAIReviewDialog(pending);
        } else if (isConnected()) {
          state.aiPendingResults = pending;
        }
      }, 100);
    }
  }

  function appendRecognizedText(text) {
    const chunk = String(text || '').trim();
    if (!chunk) return;
    if (!state.text.trim()) {
      state.text = chunk;
    } else {
      state.text = `${state.text.replace(/\s+$/, '')}\n\n${chunk}`;
    }
    state.textDirty = true;
  }

  function addFiles(fileList) {
    if (state.aiBusy) {
      toast('AI 逐图分析正在进行，完成后再添加图片。', 'info');
      return;
    }
    const all = Array.from(fileList || []);
    if (!all.length) return;

    const rejected = [];
    const accepted = [];
    let limitSkipped = 0;

    for (let index = 0; index < all.length; index += 1) {
      const file = all[index];
      if (state.files.length + accepted.length >= MAX_FILES) {
        limitSkipped = all.length - index;
        break;
      }
      const mime = String(file.type || '').toLowerCase();
      const ext = String(file.name || '').split('.').pop()?.toLowerCase();
      const extensionAllowed = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext);
      if (!ACCEPTED_MIME.has(mime) && !(mime === '' && extensionAllowed)) {
        rejected.push(`${file.name}：暂不支持这种图片格式，请转换为 JPG/PNG。`);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        rejected.push(`${file.name}：超过 25MB，请压缩后再试。`);
        continue;
      }
      accepted.push(file);
    }

    if (limitSkipped) {
      toast(
        `单批最多处理 ${MAX_FILES} 张图片，本次有 ${limitSkipped} 张未加入，请分批导入。`,
        'error',
        5200,
      );
    } else if (rejected.length) {
      toast(rejected[0], 'error', 4200);
    }
    if (!accepted.length) return;

    const hadActivity = hasActivity();
    state.aiLastResults = null;
    for (const file of accepted) {
      state.files.push({
        id: uid(),
        file,
        name: file.name || '粘贴的图片',
        size: file.size,
        url: URL.createObjectURL(file),
        status: 'queued',
        text: '',
        error: '',
        hint: '',
        aiError: '',
        elapsed: 0,
        aiStatus: 'idle',
      });
    }
    state.files.forEach((file) => {
      file.aiStatus = 'idle';
      file.aiError = '';
    });

    if (!hadActivity) render();
    else refreshFileUi();
    processQueue();
  }

  function retryFile(fileId) {
    if (state.aiBusy) {
      toast('AI 逐图分析正在进行，请稍候。', 'info');
      return;
    }
    const file = state.files.find((item) => item.id === fileId);
    if (!file || file.status === 'recognizing') return;
    file.status = 'queued';
    file.error = '';
    file.hint = '';
    file.aiStatus = 'idle';
    file.aiError = '';
    state.aiLastResults = null;
    refreshFileUi();
    processQueue();
  }

  function removeFile(fileId) {
    if (state.aiBusy) {
      toast('AI 逐图分析正在进行，请稍候。', 'info');
      return;
    }
    const index = state.files.findIndex((item) => item.id === fileId);
    if (index < 0) return;
    const file = state.files[index];
    if (file.status === 'recognizing') {
      toast('这张图片正在识别，请稍等几秒。', 'info');
      return;
    }

    if (file.url) URL.revokeObjectURL(file.url);
    const recognizedChunk = file.status === 'done' ? String(file.text || '').trim() : '';
    state.files.splice(index, 1);
    state.aiLastResults = null;
    state.files.forEach((item) => {
      item.aiStatus = 'idle';
      item.aiError = '';
    });

    if (recognizedChunk) {
      const position = state.text.indexOf(recognizedChunk);
      if (position >= 0) {
        state.text = `${state.text.slice(0, position)}${state.text.slice(position + recognizedChunk.length)}`
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        state.textDirty = true;
      } else if (state.text.trim()) {
        toast('图片已移除；识别文本可能仍有它的内容，请手动清理。', 'info', 4200);
      }
      if (state.previewQuestions.length) state.previewDirty = true;
    }

    if (!hasActivity()) render();
    else {
      refreshFileUi();
      updatePreviewMeta();
    }
  }

  async function processQueue() {
    if (state.processing) return;
    const nextQueued = state.files.find((file) => file.status === 'queued');
    if (!nextQueued) return;

    state.processing = true;
    state.busy = true;
    const token = state.token;
    refreshFileUi();

    try {
      while (state.files.some((file) => file.status === 'queued')) {
        if (token !== state.token) return;
        const file = state.files.find((item) => item.status === 'queued');
        if (!file) break;
        file.status = 'recognizing';
        refreshFileUi();

        try {
          const result = await recognizeImage(file.file);
          if (token !== state.token) return;
          file.status = 'done';
          file.text = String(result.text || '');
          file.elapsed = Number(result.elapsed || 0).toFixed(1);
          appendRecognizedText(file.text);
        } catch (error) {
          if (token !== state.token) return;
          file.status = 'error';
          file.error = error?.message || '识别失败，请重试。';
          file.hint = error?.hint || '';
        }
        refreshFileUi();
      }
    } finally {
      if (token === state.token) {
        state.processing = false;
        state.busy = false;
        refreshFileUi();
        const hasSuccess = state.files.some((file) => file.status === 'done');
        if (!state.previewQuestions.length && hasSuccess && state.text.trim()) {
          autoParse();
        } else if (state.previewQuestions.length && hasSuccess) {
          toast('新图片已识别。点击「重新拆题」可更新右侧预览。', 'info', 3800);
        }
      }
    }
  }

  function autoParse() {
    const parsed = parseQuestions(state.text);
    if (!parsed.length) {
      toast('识别完成，但没有自动拆出题目。可修改左侧文字后重试。', 'error', 4500);
      refreshFileUi();
      return;
    }
    state.previewQuestions = parsed.map((question) => ({ ...question }));
    state.previewDirty = false;
    state.textDirty = false;
    render();
    toast(`已自动拆出 ${parsed.length} 道题，请校对答案。`, 'success');
  }

  async function parseNow() {
    if (state.busy) {
      toast('识别完成后才能拆题。', 'info');
      return;
    }
    if (state.aiBusy) {
      toast('AI 逐图分析正在进行，请稍候。', 'info');
      return;
    }
    if (!state.text.trim()) {
      toast('还没有可拆分的识别文本。', 'info');
      return;
    }
    if (state.previewQuestions.length && state.previewDirty) {
      const proceed = await confirmAction({
        title: '重新拆题？',
        message: '右侧预览中的手动修改会被新的拆分结果替换。',
        confirmText: '重新拆题',
      });
      if (!proceed) return;
    }

    const parsed = parseQuestions(state.text);
    if (!parsed.length) {
      toast('没有拆出题目，请检查题号、选项和答案的格式。', 'error', 4200);
      return;
    }
    state.previewQuestions = parsed.map((question) => ({ ...question }));
    state.previewDirty = false;
    state.textDirty = false;
    render();
    toast(`已拆出 ${parsed.length} 道题。`, 'success');
  }

  function addBlankPreview() {
    if (state.aiBusy) {
      toast('AI 逐图分析正在进行，请稍候。', 'info');
      return;
    }
    syncPreviewFromForms();
    state.previewQuestions.push(makeEmptyDraft());
    state.previewDirty = true;
    mountForms();
    const last = rootRef?.querySelector('.preview-card:last-child');
    last?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => {
      forms[forms.length - 1]?.focusStem();
    }, 220);
  }

  function removePreview(index) {
    if (state.aiBusy) {
      toast('AI 逐图分析正在进行，请稍候。', 'info');
      return;
    }
    syncPreviewFromForms();
    if (!Number.isInteger(index) || index < 0 || index >= state.previewQuestions.length) return;
    state.previewQuestions.splice(index, 1);
    state.previewDirty = true;
    mountForms();
  }

  function duplicateSourceLabel(match) {
    if (match?.kind === 'batch') return `与本批第 ${match.number} 题重复`;
    const question = match?.question;
    const subject = question ? app.subjectById(question.subjectId) : null;
    const bank = question ? app.bankById(question.bankId) : null;
    const path = [subject?.name, bank?.name].filter(Boolean).join(' / ');
    return path ? `与已保存题目重复（${path}）` : '与已保存题目重复';
  }

  function findImportDuplicates(created) {
    const existingByKey = new Map();
    for (const question of app.state.questions) {
      const key = questionDuplicateKey(question);
      if (key && !existingByKey.has(key)) existingByKey.set(key, question);
    }

    const batchByKey = new Map();
    const duplicates = [];
    created.forEach((question, index) => {
      const key = questionDuplicateKey(question);
      if (!key) return;
      const existing = existingByKey.get(key);
      const batchNumber = batchByKey.get(key);
      if (existing) {
        duplicates.push({
          index,
          question,
          match: { kind: 'existing', question: existing },
        });
      } else if (batchNumber) {
        duplicates.push({
          index,
          question,
          match: { kind: 'batch', number: batchNumber },
        });
      }
      if (!batchByKey.has(key)) batchByKey.set(key, index + 1);
    });
    return duplicates;
  }

  function reviewImportDuplicates(created, duplicates) {
    return new Promise((resolve) => {
      let settled = false;
      let dialogRef = null;
      let control = null;
      const baseCount = created.length - duplicates.length;

      const finish = (proceed) => {
        if (settled) return;
        settled = true;
        let skipIndexes = null;
        if (proceed) {
          skipIndexes = new Set();
          dialogRef
            ?.querySelectorAll('[data-keep-duplicate]')
            .forEach((checkbox) => {
              if (!checkbox.checked) skipIndexes.add(Number(checkbox.dataset.index));
            });
        }
        control?.close();
        resolve(skipIndexes);
      };

      const content = `
        <div class="duplicate-review">
          <p class="duplicate-review-note">
            检测到 ${duplicates.length} 道重复题。勾选表示忽略重复并加入题库；取消勾选后本次保存会跳过该题，题库中已有的原题不会被删除。
          </p>
          <div class="duplicate-review-toolbar">
            <label class="duplicate-toggle-all">
              <input type="checkbox" data-keep-all checked>
              <span>全部加入题库</span>
            </label>
            <button type="button" class="text-button" data-skip-all>全部跳过重复题</button>
          </div>
          <div class="duplicate-review-list">
            ${duplicates
              .map(
                ({ index, question, match }) => `
                <label class="duplicate-choice">
                  <input type="checkbox" data-keep-duplicate data-index="${index}" checked>
                  <span class="duplicate-choice-copy">
                    <b>第 ${index + 1} 题 · ${escapeHTML(QUESTION_TYPES[question.type] || '题目')}</b>
                    <span>${escapeHTML(String(question.stem || '').replace(/\s+/g, ' '))}</span>
                    <small>${escapeHTML(duplicateSourceLabel(match))}</small>
                  </span>
                </label>
              `,
              )
              .join('')}
          </div>
        </div>
      `;

      control = openDialog({
        title: '发现重复题目',
        eyebrow: 'DUPLICATE CHECK',
        description: '可以逐题决定是否加入题库；取消勾选的重复题不会写入题库。',
        size: 'md',
        content,
        footer: `
          <button type="button" class="btn subtle" data-duplicate-cancel>取消保存</button>
          <button type="button" class="btn primary" data-duplicate-confirm>保存 ${created.length} 道题</button>
        `,
        onMount: ({ dialog, close }) => {
          dialogRef = dialog;
          const boxes = () => [...dialog.querySelectorAll('[data-keep-duplicate]')];
          const keepAll = dialog.querySelector('[data-keep-all]');
          const confirm = dialog.querySelector('[data-duplicate-confirm]');
          const update = () => {
            const checked = boxes().filter((checkbox) => checkbox.checked).length;
            const total = baseCount + checked;
            if (keepAll) {
              keepAll.checked = checked === boxes().length;
              keepAll.indeterminate = checked > 0 && checked < boxes().length;
            }
            if (confirm) {
              confirm.disabled = total === 0;
              confirm.textContent = total ? `保存 ${total} 道题` : '没有可保存的题目';
            }
          };

          dialog.addEventListener('change', (event) => {
            if (event.target === keepAll) {
              boxes().forEach((checkbox) => {
                checkbox.checked = keepAll.checked;
              });
            }
            update();
          });
          dialog.querySelector('[data-skip-all]')?.addEventListener('click', () => {
            boxes().forEach((checkbox) => {
              checkbox.checked = false;
            });
            update();
          });
          dialog.querySelector('[data-duplicate-cancel]')?.addEventListener('click', () => finish(false));
          dialog.querySelector('[data-duplicate-confirm]')?.addEventListener('click', () => finish(true));
          dialog.addEventListener('close', () => {
            if (!settled) {
              settled = true;
              resolve(null);
            }
            close();
          });
          update();
        },
      });
    });
  }

  async function savePreviews() {
    if (state.busy) {
      toast('识别完成后才能保存。', 'info');
      return;
    }
    if (state.aiBusy) {
      toast('AI 逐图分析正在进行，请稍候。', 'info');
      return;
    }
    syncPreviewFromForms();
    if (!forms.length) {
      toast('还没有可保存的题目。', 'info');
      return;
    }

    for (const form of forms) {
      const error = form.validate();
      if (error) {
        form.element.closest('.preview-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast(error, 'error', 3600);
        return;
      }
    }

    ensureTarget();
    const targetSubject = app.subjectById(state.targetSubjectId);
    const targetBank = app.bankById(state.targetBankId);
    if (!targetSubject || !targetBank || targetBank.subjectId !== targetSubject.id) {
      refreshDestinationUi({ highlight: true });
      toast('先选择科目和子题库，再保存题目。', 'error', 4200);
      return;
    }

    const drafts = forms.map((form) => form.getQuestion());
    const created = drafts.map((draft) => createQuestion(draft));
    const duplicates = findImportDuplicates(created);
    let skipIndexes = new Set();
    if (duplicates.length) {
      const choice = await reviewImportDuplicates(created, duplicates);
      if (choice === null) return;
      skipIndexes = choice;
    }

    const questionsToSave = created.filter((_, index) => !skipIndexes.has(index));
    if (!questionsToSave.length) {
      toast('没有保留任何重复题，本次未保存。', 'info', 4200);
      return;
    }
    const missing = questionsToSave.filter((question) => question.type !== 'short' && !question.answer).length;
    const skippedDuplicates = created.length - questionsToSave.length;
    const keptDuplicates = duplicates.length - skippedDuplicates;

    await app.addQuestions(questionsToSave, { subjectId: targetSubject.id, bankId: targetBank.id });

    resetImport({ rerender: false });
    await app.navigate('library', { subjectId: targetSubject.id, bankId: targetBank.id });
    const notes = [];
    if (missing) notes.push(`其中 ${missing} 道尚未设置答案`);
    if (keptDuplicates) notes.push(`保留了 ${keptDuplicates} 道重复题`);
    if (skippedDuplicates) notes.push(`跳过了 ${skippedDuplicates} 道重复题`);
    toast(
      `已保存 ${questionsToSave.length} 道题到「${targetSubject.name} / ${targetBank.name}」${
        notes.length ? `，${notes.join('，')}` : '，可以开始练习了'
      }。`,
      'success',
      4800,
    );
  }

  function resetImport({ rerender = true } = {}) {
    state.token += 1;
    state.processing = false;
    state.busy = false;
    state.aiBusy = false;
    state.aiProgress = '';
    state.aiOnlyFailed = false;
    state.aiPendingResults = null;
    state.aiLastResults = null;
    state.files.forEach((file) => {
      if (file.url) URL.revokeObjectURL(file.url);
    });
    state.files = [];
    state.text = '';
    state.textDirty = false;
    state.previewQuestions = [];
    state.previewDirty = false;
    forms = [];
    if (rerender && isConnected()) render();
  }

  async function requestReset() {
    if (!hasActivity()) return;
    const proceed = await confirmAction({
      title: '清空本次导入？',
      message: '图片、识别文本和尚未保存的校对内容都会清除，题库中已保存的题目不受影响。',
      confirmText: '清空',
      danger: true,
    });
    if (!proceed) return;
    resetImport();
    toast('本次导入已清空。', 'info');
  }

  function bindEvents() {
    if (!rootRef || !eventController) return;
    const { signal } = eventController;

    rootRef.addEventListener(
      'click',
      async (event) => {
        const fileAction = event.target.closest('[data-file-action]');
        if (fileAction) {
          const fileId = fileAction.dataset.fileId;
          if (fileAction.dataset.fileAction === 'retry') retryFile(fileId);
          else if (fileAction.dataset.fileAction === 'remove') removeFile(fileId);
          return;
        }

        const actionElement = event.target.closest('[data-action]');
        if (actionElement) {
          const action = actionElement.dataset.action;
          if (action === 'choose-files') {
            rootRef.querySelector('input[data-role="file-input"]:not([capture])')?.click();
            return;
          }
          if (action === 'choose-camera') {
            rootRef.querySelector('input[data-role="file-input"][capture]')?.click();
            return;
          }
          if (action === 'create-import-subject') {
            const subject = await app.createSubject();
            if (subject) {
              state.targetSubjectId = subject.id;
              state.targetBankId = '';
              ensureTarget();
              refreshDestinationUi();
              if (!app.banksForSubject(subject.id).length) {
                toast('科目已创建，再建立一个子题库就能保存题目。', 'info', 3600);
              }
            }
            return;
          }
          if (action === 'create-import-bank') {
            const subject = app.subjectById(state.targetSubjectId);
            if (!subject) {
              toast('先创建科目，再创建子题库。', 'info');
              return;
            }
            const bank = await app.createBank(subject.id);
            if (bank) {
              state.targetSubjectId = bank.subjectId;
              state.targetBankId = bank.id;
              refreshDestinationUi();
            }
            return;
          }
          if (action === 'manual') {
            app.openManualQuestion({
              subjectId: state.targetSubjectId,
              bankId: state.targetBankId,
            });
            return;
          }
          if (action === 'reset') {
            requestReset();
            return;
          }
          if (action === 'parse') {
            parseNow();
            return;
          }
          if (action === 'ai-review') {
            runAIReview();
            return;
          }
          if (action === 'retry-ai-failed') {
            runAIReview({ onlyFailed: true });
            return;
          }
          if (action === 'add-preview') {
            addBlankPreview();
            return;
          }
          if (action === 'remove-preview') {
            removePreview(Number(actionElement.dataset.index));
            return;
          }
          if (action === 'save') {
            savePreviews();
            return;
          }
        }

        const dropzone = event.target.closest('[data-dropzone]');
        if (dropzone && !event.target.closest('button, input, label, a')) {
          rootRef.querySelector('input[data-role="file-input"]:not([capture])')?.click();
        }
      },
      { signal },
    );

    rootRef.addEventListener(
      'change',
      (event) => {
        if (event.target.matches('[data-role="import-subject"]')) {
          state.targetSubjectId = event.target.value;
          state.targetBankId = '';
          ensureTarget();
          refreshDestinationUi();
          return;
        }
        if (event.target.matches('[data-role="import-bank"]')) {
          state.targetBankId = event.target.value;
          refreshDestinationUi();
          return;
        }
        const input = event.target.closest('input[data-role="file-input"]');
        if (!input) return;
        const files = [...(input.files || [])];
        input.value = '';
        addFiles(files);
      },
      { signal },
    );

    rootRef.addEventListener(
      'input',
      (event) => {
        if (event.target.matches('[data-role="ocr-text"]')) {
          state.text = event.target.value;
          state.textDirty = true;
          const charCount = rootRef.querySelector('[data-char-count]');
          if (charCount) charCount.textContent = `${state.text.length} 字`;
          const parseButton = rootRef.querySelector('[data-action="parse"]');
          if (parseButton) parseButton.disabled = state.busy || !state.text.trim();
          const hint = rootRef.querySelector('.editor-hint');
          if (hint) hint.textContent = '文本已修改，记得重新拆题';
          autoGrowTextarea(event.target);
        }
      },
      { signal },
    );

    rootRef.addEventListener(
      'keydown',
      (event) => {
        if (
          (event.key === 'Enter' || event.key === ' ') &&
          event.target.closest('[data-dropzone]') &&
          !event.target.closest('button, input, label, a')
        ) {
          event.preventDefault();
          rootRef.querySelector('input[data-role="file-input"]:not([capture])')?.click();
        }
      },
      { signal },
    );

    rootRef.addEventListener(
      'dragover',
      (event) => {
        const dropzone = event.target.closest('[data-dropzone]');
        if (!dropzone) return;
        event.preventDefault();
        dropzone.classList.add('is-dragging');
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      },
      { signal },
    );

    rootRef.addEventListener(
      'dragleave',
      (event) => {
        const dropzone = event.target.closest('[data-dropzone]');
        if (!dropzone) return;
        if (event.relatedTarget && dropzone.contains(event.relatedTarget)) return;
        dropzone.classList.remove('is-dragging');
      },
      { signal },
    );

    rootRef.addEventListener(
      'drop',
      (event) => {
        const dropzone = event.target.closest('[data-dropzone]');
        if (!dropzone) return;
        event.preventDefault();
        dropzone.classList.remove('is-dragging');
        addFiles(event.dataTransfer?.files);
      },
      { signal },
    );
  }

  return {
    render(root, options = {}) {
      rootRef = root;
      render(options);
    },
    addFiles(fileList) {
      addFiles(fileList);
    },
    reset() {
      resetImport();
    },
    focusDropzone() {
      rootRef?.querySelector('[data-dropzone]')?.focus();
    },
    getAssistantConfig,
    handleAssistantAction,
  };
}
