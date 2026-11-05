import { getAIConfig, interactWithAI } from './api.js';
import { renderAssistantText } from './chat-text.js';
import { escapeHTML, icon } from './ui.js';

const TUTOR_ACTIONS = {
  tutor_hint: {
    label: '给我一点提示',
    description: '先提示解题方向，不直接公布答案',
  },
  tutor_explain: {
    label: '讲解这道题',
    description: '说明考点、步骤和正确答案',
  },
  tutor_diagnose: {
    label: '分析我的错因',
    description: '结合当前作答分析错误原因',
  },
  tutor_similar: {
    label: '再来一道同类题',
    description: '生成一道同知识点练习，不会自动加入题库',
  },
  tutor_simpler: {
    label: '讲得更简单',
    description: '换一种更基础的方式解释',
  },
};

function readChatConfig(getConfig) {
  try {
    const config = getConfig?.();
    return config && typeof config === 'object' ? config : null;
  } catch (error) {
    console.error('构建练习 AI 上下文失败', error);
    return null;
  }
}

function contextSignature(config) {
  if (!config) return '';
  const session = config.context?.session || {};
  return [
    config.contextLabel || '',
    session.index ?? '',
    session.total ?? '',
    session.submitted ? '1' : '0',
    session.answeredCorrectly === true ? '1' : session.answeredCorrectly === false ? '0' : '',
    session.pendingSelfGrade ? '1' : '0',
    session.revealed ? '1' : '0',
    session.deferred ? '1' : '0',
  ].join('|');
}

function questionState(config) {
  const session = config?.context?.session || {};
  if (!session.submitted) return { label: '未作答', tone: 'idle' };
  if (session.pendingSelfGrade) return { label: '待自评', tone: 'answered' };
  if (session.deferred) return { label: '已作答', tone: 'answered' };
  if (session.revealed) return { label: '已看答案', tone: 'answered' };
  if (session.answeredCorrectly) return { label: '已答对', tone: 'correct' };
  return { label: '已答错', tone: 'wrong' };
}

/**
 * 练习页右侧常驻的 AI 对话面板。
 * 只有用户发送问题或点击快捷选项时才会调用 AI。
 */
export function createPracticeAIChat({ getConfig, onConfigure, onHide } = {}) {
  const element = document.createElement('section');
  element.className = 'panel practice-ai-panel';
  element.id = 'practice-ai-panel';
  element.setAttribute('aria-label', 'AI 辅导聊天');
  element.innerHTML = `
    <header class="practice-ai-head">
      <div class="practice-ai-heading">
        <span class="practice-ai-mark">${icon('sparkles', 17)}</span>
        <div>
          <p class="eyebrow">PRACTICE COPILOT</p>
          <h2>AI 辅导</h2>
        </div>
      </div>
      <span class="practice-ai-state is-loading" data-ai-chat-state role="status">
        <span class="status-dot is-busy"></span>
        <span data-ai-chat-state-text>读取设置</span>
      </span>
      ${
        typeof onHide === 'function'
          ? `<button type="button" class="icon-btn practice-ai-hide" data-ai-chat-hide
               aria-label="隐藏 AI 辅导侧栏" title="隐藏 AI 辅导侧栏">${icon('x', 15)}</button>`
          : ''
      }
    </header>
    <div class="practice-ai-context">
      <span class="practice-ai-context-label" data-ai-chat-context>当前题目</span>
      <span class="practice-ai-context-separator">·</span>
      <span class="practice-ai-question-state" data-ai-chat-question-state>未作答</span>
      <span class="practice-ai-private">仅文字</span>
    </div>
    <div class="ai-chat-log practice-ai-log" data-ai-chat-log aria-live="polite"></div>
    <div class="ai-chat-options practice-ai-options" data-ai-chat-options></div>
    <div class="ai-chat-composer practice-ai-composer">
      <div class="ai-chat-composer-row">
        <textarea rows="1" data-ai-chat-input maxlength="1200" aria-label="向 AI 提问"
          placeholder="针对这道题问点什么…"></textarea>
        <button type="button" class="btn primary ai-chat-send" data-ai-chat-send aria-label="发送问题">
          ${icon('arrow-right', 17)}
        </button>
      </div>
      <span class="ai-chat-composer-note">
        ${icon('info', 12)} AI 可能出错 · 不发送图片 · 调用可能产生费用
      </span>
    </div>
  `;

  const statusEl = element.querySelector('[data-ai-chat-state]');
  const statusText = element.querySelector('[data-ai-chat-state-text]');
  const contextEl = element.querySelector('[data-ai-chat-context]');
  const questionStateEl = element.querySelector('[data-ai-chat-question-state]');
  const log = element.querySelector('[data-ai-chat-log]');
  const optionsHost = element.querySelector('[data-ai-chat-options]');
  const input = element.querySelector('[data-ai-chat-input]');
  const sendButton = element.querySelector('[data-ai-chat-send]');
  const hideButton = element.querySelector('[data-ai-chat-hide]');

  let ready = false;
  let sending = false;
  let disposed = false;
  let introShown = false;
  let setupCard = null;
  let history = [];
  let lastSignature = '';
  let lastQuestionIndex = null;
  let configRequestId = 0;

  const getChatConfig = () => readChatConfig(getConfig);

  function scrollToBottom() {
    window.requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
  }

  function appendMessage(role, text) {
    const message = document.createElement('div');
    message.className = `ai-chat-msg is-${role}`;
    message.innerHTML =
      role === 'assistant'
        ? `<span class="ai-chat-avatar">${icon('sparkles', 15)}</span>
           <div class="ai-chat-bubble">${renderAssistantText(text)}</div>`
        : `<div class="ai-chat-bubble">${renderAssistantText(text)}</div>`;
    log.appendChild(message);
    scrollToBottom();
    return message;
  }

  function appendTyping() {
    const typing = document.createElement('div');
    typing.className = 'ai-chat-msg is-assistant is-typing';
    typing.dataset.aiChatTyping = '';
    typing.innerHTML = `<span class="ai-chat-avatar">${icon('sparkles', 15)}</span>
      <div class="ai-chat-bubble"><span class="mini-spinner"></span> 正在结合当前题目思考…</div>`;
    log.appendChild(typing);
    scrollToBottom();
    return typing;
  }

  function appendContextNote(text) {
    const note = document.createElement('div');
    note.className = 'practice-ai-context-note';
    note.textContent = text;
    log.appendChild(note);
    scrollToBottom();
  }

  function appendIntro() {
    if (introShown) return;
    introShown = true;
    appendMessage(
      'assistant',
      '我会结合当前题目和你的作答来回答。可以直接提问，也可以点下面的快捷问题。',
    );
  }

  function setStatus(kind, text, title = '') {
    statusEl.classList.remove('is-loading', 'is-ready', 'is-missing', 'is-error');
    statusEl.classList.add(`is-${kind}`);
    statusEl.title = title;
    statusText.textContent = text;
    const dot = statusEl.querySelector('.status-dot');
    dot.className = 'status-dot';
    if (kind === 'ready') dot.classList.add('is-ok');
    else if (kind === 'loading') dot.classList.add('is-busy');
    else if (kind === 'error') dot.classList.add('is-warning');
  }

  function updateComposer() {
    const canSend = ready && !sending;
    input.disabled = !canSend;
    input.placeholder = !ready
      ? '配置 AI 后即可提问…'
      : sending
        ? 'AI 正在回答…'
        : '针对这道题问点什么…';
    sendButton.disabled = !canSend || !input.value.trim();
  }

  function setSending(value) {
    sending = value;
    log.setAttribute('aria-busy', value ? 'true' : 'false');
    updateComposer();
    optionsHost.querySelectorAll('button').forEach((button) => {
      button.disabled = value;
    });
  }

  function clearOptions() {
    optionsHost.innerHTML = '';
  }

  function buildOptionButtons(items, label) {
    clearOptions();
    const usable = (Array.isArray(items) ? items : [])
      .filter((item) => item && item.action && item.label)
      .slice(0, 4);
    if (!usable.length) return;

    const block = document.createElement('div');
    block.className = 'practice-ai-option-block';
    if (label) {
      const caption = document.createElement('span');
      caption.className = 'practice-ai-options-label';
      caption.textContent = label;
      block.appendChild(caption);
    }

    const row = document.createElement('div');
    row.className = 'practice-ai-chips';
    usable.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'practice-ai-chip';
      button.textContent = item.label;
      button.title = item.description || item.label;
      button.dataset.aiAction = item.action;
      button.disabled = sending;
      button.addEventListener('click', () => chooseOption(item));
      row.appendChild(button);
    });
    block.appendChild(row);
    optionsHost.appendChild(block);
    scrollToBottom();
  }

  function quickOptionItems(config) {
    const actions = Array.isArray(config?.availableActions) ? config.availableActions : [];
    return actions
      .map((action) => {
        const meta = TUTOR_ACTIONS[action];
        return meta ? { action, label: meta.label, description: meta.description, kind: 'chat' } : null;
      })
      .filter(Boolean);
  }

  function renderQuickActions(config, label = '快捷提问') {
    if (!ready || sending) return;
    const items = quickOptionItems(config);
    if (!items.length) {
      clearOptions();
      return;
    }
    buildOptionButtons(items, label);
  }

  function renderModelOptions(options, snapshotSignature) {
    const current = getChatConfig();
    if (!current || contextSignature(current) !== snapshotSignature) {
      if (ready && !sending) renderQuickActions(current, '继续提问');
      return;
    }
    const allowed = new Set(Array.isArray(current.availableActions) ? current.availableActions : []);
    const items = (Array.isArray(options) ? options : [])
      .filter(
        (option) =>
          option &&
          option.kind === 'chat' &&
          allowed.has(option.action) &&
          typeof option.label === 'string' &&
          option.label.trim(),
      )
      .map((option) => ({
        action: option.action,
        label: option.label.trim(),
        description: option.description || '',
        kind: 'chat',
      }));
    if (!items.length) {
      renderQuickActions(current, '继续提问');
      return;
    }
    buildOptionButtons(items, 'AI 建议');
  }

  function failRequest(error, retry) {
    const box = document.createElement('div');
    box.className = 'ai-chat-msg is-assistant is-error';
    box.innerHTML = `<span class="ai-chat-avatar">${icon('alert', 15)}</span>
      <div class="ai-chat-bubble">
        <strong>这次提问没有完成。</strong>
        <p>${escapeHTML(error.message || '未知错误')}${error.hint ? ` ${escapeHTML(error.hint)}` : ''}</p>
      </div>`;
    log.appendChild(box);

    clearOptions();
    const actions = document.createElement('div');
    actions.className = 'practice-ai-error-actions';
    if (retry) {
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.className = 'btn subtle practice-ai-retry';
      retryButton.textContent = '重试';
      retryButton.addEventListener('click', retry);
      actions.appendChild(retryButton);
    }
    if (typeof onConfigure === 'function') {
      const settingsButton = document.createElement('button');
      settingsButton.type = 'button';
      settingsButton.className = 'text-button';
      settingsButton.textContent = '检查 AI 设置';
      settingsButton.addEventListener('click', () => onConfigure());
      actions.appendChild(settingsButton);
    }
    optionsHost.appendChild(actions);
    scrollToBottom();
  }

  async function requestAI({ message = '', selection = null, userTurn = null } = {}) {
    if (!ready || sending || disposed) return;
    const config = getChatConfig();
    if (!config) return;

    const snapshot = contextSignature(config);
    const turnText = userTurn || selection?.label || message || '';
    setSending(true);
    clearOptions();
    const typing = appendTyping();

    try {
      const response = await interactWithAI({
        mode: 'tutor',
        context: config.context,
        history: history.slice(-16),
        message,
        selection,
        availableActions: Array.isArray(config.availableActions) ? config.availableActions : [],
      });
      if (disposed) return;
      typing.remove();
      const text = response?.message || '这次没有收到可显示的回答，请再问一次。';
      appendMessage('assistant', text);
      if (turnText) history.push({ role: 'user', content: turnText });
      history.push({ role: 'assistant', content: text });
      if (history.length > 16) history.splice(0, history.length - 16);

      const current = getChatConfig();
      if (contextSignature(current) === snapshot) {
        renderModelOptions(response?.options, snapshot);
      } else if (ready) {
        renderQuickActions(current, '继续提问');
      }
    } catch (error) {
      if (disposed) return;
      typing.remove();
      const current = getChatConfig();
      const sameQuestion = Boolean(current) && contextSignature(current) === snapshot;
      failRequest(
        error,
        sameQuestion ? () => requestAI({ message, selection, userTurn }) : null,
      );
      if (!sameQuestion) renderQuickActions(current, '继续提问');
    } finally {
      if (!disposed) setSending(false);
    }
  }

  function chooseOption(option) {
    if (!ready || sending || disposed) return;
    const label = option.label || option.action || '继续';
    appendMessage('user', label);
    clearOptions();
    requestAI({
      selection: { action: option.action, label },
      userTurn: label,
    });
  }

  function sendFreeText() {
    if (!ready || sending || disposed) return;
    const message = input.value.trim();
    if (!message) return;
    appendMessage('user', message);
    input.value = '';
    input.style.height = 'auto';
    updateComposer();
    requestAI({ message, userTurn: message });
  }

  function buildSetupCard(error) {
    setupCard?.remove();
    setupCard = document.createElement('div');
    setupCard.className = 'practice-ai-setup';
    const title = error ? '暂时无法连接 AI 设置' : 'AI 还没有配置';
    const message = error
      ? error.message || '无法读取本机的 AI 设置。'
      : '配置一个 OpenAI 兼容模型后，就可以在练习中随时提问。刷题、OCR 和题目解析仍然完全可用。';
    setupCard.innerHTML = `
      <span class="practice-ai-setup-icon">${icon(error ? 'alert' : 'sparkles', 17)}</span>
      <div class="practice-ai-setup-copy">
        <strong>${escapeHTML(title)}</strong>
        <p>${escapeHTML(message)}</p>
        <div class="practice-ai-setup-actions">
          ${
            error
              ? `<button type="button" class="text-button" data-ai-chat-retry>重新读取</button>`
              : ''
          }
          <button type="button" class="btn primary" data-ai-chat-configure>配置 AI</button>
        </div>
      </div>
    `;
    setupCard.querySelector('[data-ai-chat-configure]')?.addEventListener('click', () => {
      if (typeof onConfigure === 'function') onConfigure();
    });
    setupCard.querySelector('[data-ai-chat-retry]')?.addEventListener('click', () => {
      void refreshConfig();
    });
    log.appendChild(setupCard);
    scrollToBottom();
  }

  function applySetupState(error = null) {
    clearOptions();
    buildSetupCard(error);
    updateComposer();
  }

  function applyReadyState() {
    setupCard?.remove();
    setupCard = null;
    appendIntro();
    updateComposer();
    renderQuickActions(getChatConfig(), history.length ? '继续提问' : '快捷提问');
  }

  async function refreshConfig() {
    if (disposed) return;
    const requestId = ++configRequestId;
    setStatus('loading', '读取设置', '正在读取本机 AI 配置');
    try {
      const config = await getAIConfig();
      if (disposed || requestId !== configRequestId) return;
      ready = Boolean(config?.configured);
      if (ready) {
        setStatus(
          'ready',
          '可用',
          `${config.model || '已配置模型'} · AI 只接收文字，不接收图片`,
        );
        applyReadyState();
      } else {
        setStatus('missing', '未配置', '配置 AI 后即可在练习中提问');
        applySetupState();
      }
    } catch (error) {
      if (disposed || requestId !== configRequestId) return;
      ready = false;
      setStatus('error', '读取失败', error.message || '无法读取 AI 设置');
      applySetupState(error);
    }
  }

  function updateContextStrip(config) {
    contextEl.textContent = config?.contextLabel || '当前题目';
    const state = questionState(config);
    questionStateEl.textContent = state.label;
    questionStateEl.className = `practice-ai-question-state is-${state.tone}`;
  }

  function syncContext() {
    const config = getChatConfig();
    if (!config) {
      contextEl.textContent = '当前题目';
      questionStateEl.textContent = '';
      questionStateEl.className = 'practice-ai-question-state';
      return;
    }
    updateContextStrip(config);

    const signature = contextSignature(config);
    if (signature === lastSignature) return;

    const session = config.context?.session || {};
    const nextIndex = Number.isInteger(session.index) ? session.index : null;
    const previousIndex = lastQuestionIndex;
    lastSignature = signature;
    lastQuestionIndex = nextIndex;

    if (
      previousIndex !== null &&
      nextIndex !== null &&
      previousIndex !== nextIndex &&
      history.length
    ) {
      appendContextNote(`已切换到第 ${nextIndex} 题，后续回答会使用新题目的上下文。`);
    } else if (
      previousIndex === nextIndex &&
      history.length &&
      session.submitted &&
      !sending
    ) {
      appendContextNote('本题已提交，AI 已看到最新作答。');
    }

    clearOptions();
    if (ready && !sending) {
      renderQuickActions(config, history.length ? '继续提问' : '快捷提问');
    }
  }

  function mount(host) {
    if (!host || disposed) return;
    host.replaceChildren(element);
    syncContext();
  }

  function focus() {
    if (disposed || !element.isConnected) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    window.setTimeout(() => {
      if (ready) input.focus({ preventScroll: true });
      else setupCard?.querySelector('button')?.focus({ preventScroll: true });
    }, 220);
  }

  function destroy() {
    disposed = true;
    element.remove();
  }

  sendButton.addEventListener('click', sendFreeText);
  hideButton?.addEventListener('click', () => {
    if (typeof onHide === 'function') onHide();
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
    updateComposer();
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendFreeText();
    } else if (event.key === 'Escape') {
      input.blur();
    }
  });

  updateComposer();
  void refreshConfig();

  return {
    mount,
    focus,
    refreshConfig,
    destroy,
  };
}
