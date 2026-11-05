import { getAIConfig, interactWithAI } from './api.js';
import { renderAssistantText } from './chat-text.js';
import { escapeHTML, icon, openDialog, toast } from './ui.js';

const MODE_META = {
  tutor: {
    title: 'AI 辅导',
    eyebrow: 'PRACTICE COACH',
    description: 'AI 会根据当前题目给出可点击的辅导选项，也可以直接追问。',
  },
  import: {
    title: 'AI 导入决策',
    eyebrow: 'IMPORT COPILOT',
    description: '结合逐图 OCR 文字和 AI 分析情况，帮你决定下一步怎么处理。',
  },
  library: {
    title: 'AI 题库巡检',
    eyebrow: 'LIBRARY COPILOT',
    description: 'AI 会根据题库问题摘要给出清理入口，不会直接修改题目。',
  },
  assistant: {
    title: 'AI 助手',
    eyebrow: 'STUDY COPILOT',
    description: '根据当前页面和题库状态给出下一步选项，也可以直接提问。',
  },
};

function modeMeta(mode) {
  return MODE_META[mode] || MODE_META.assistant;
}

/**
 * 打开统一的 AI 选项对话。
 * config: { mode, context, contextLabel, availableActions, onAction }
 */
export async function openAIAssistant(app, config = {}) {
  const mode = ['tutor', 'import', 'library', 'assistant'].includes(config.mode)
    ? config.mode
    : 'assistant';
  const meta = modeMeta(mode);

  let aiConfig;
  try {
    aiConfig = await getAIConfig();
  } catch (error) {
    toast(`读取 AI 设置失败：${error.message || '未知错误'}`, 'error', 4200);
    return null;
  }

  if (!aiConfig.configured) {
    toast('先配置 AI 服务，才能使用互动助手。', 'info', 3800);
    app.openAISettings({
      onSaved: () => {
        openAIAssistant(app, config);
      },
    });
    return null;
  }

  const allowedActions = new Set(Array.isArray(config.availableActions) ? config.availableActions : []);
  const context = config.context && typeof config.context === 'object' ? config.context : {};
  const contextLabel = config.contextLabel || '当前页面';
  const onAction = typeof config.onAction === 'function' ? config.onAction : null;
  const history = [];
  let sending = false;
  let closed = false;
  let currentOptions = [];

  const control = openDialog({
    title: config.title || meta.title,
    eyebrow: config.eyebrow || meta.eyebrow,
    description: config.description || meta.description,
    size: 'lg',
    bodyClass: 'ai-chat-dialog-body',
    content: `
      <div class="ai-chat">
        <div class="ai-chat-context">
          <span class="ai-chat-context-icon">${icon(mode === 'tutor' ? 'target' : 'sparkles', 17)}</span>
          <div>
            <strong>${escapeHTML(contextLabel)}</strong>
            <small>${escapeHTML(aiConfig.model || '已配置模型')} · 仅发送文字上下文，不发送图片</small>
          </div>
        </div>
        <div class="ai-chat-log" data-ai-chat-log aria-live="polite"></div>
        <div class="ai-chat-options" data-ai-chat-options></div>
      </div>
    `,
    footer: `
      <div class="ai-chat-composer">
        <div class="ai-chat-composer-row">
          <textarea rows="1" data-ai-chat-input maxlength="1200"
            placeholder="继续追问，或描述你想做什么…"></textarea>
          <button type="button" class="btn primary ai-chat-send" data-ai-chat-send aria-label="发送">
            ${icon('arrow-right', 17)}
          </button>
        </div>
        <span class="ai-chat-composer-note">
          ${icon('info', 12)} AI 会出错；选择操作后由应用执行，可能产生模型调用费用。
        </span>
      </div>
    `,
    onMount: ({ dialog, body, close }) => {
      const log = dialog.querySelector('[data-ai-chat-log]');
      const optionsHost = dialog.querySelector('[data-ai-chat-options]');
      const input = dialog.querySelector('[data-ai-chat-input]');
      const sendButton = dialog.querySelector('[data-ai-chat-send]');

      const scrollToBottom = () => {
        window.requestAnimationFrame(() => {
          body.scrollTop = body.scrollHeight;
        });
      };

      const appendMessage = (role, text) => {
        const message = document.createElement('div');
        message.className = `ai-chat-msg is-${role}`;
        message.innerHTML =
          role === 'assistant'
            ? `<span class="ai-chat-avatar">${icon('sparkles', 15)}</span>
               <div class="ai-chat-bubble">${renderAssistantText(text)}</div>`
            : `<div class="ai-chat-bubble">${renderAssistantText(text)}</div>`;
        log.appendChild(message);
        scrollToBottom();
      };

      const appendTyping = () => {
        const typing = document.createElement('div');
        typing.className = 'ai-chat-msg is-assistant is-typing';
        typing.dataset.aiChatTyping = '';
        typing.innerHTML = `<span class="ai-chat-avatar">${icon('sparkles', 15)}</span>
          <div class="ai-chat-bubble"><span class="mini-spinner"></span> 正在结合当前页面思考…</div>`;
        log.appendChild(typing);
        scrollToBottom();
        return typing;
      };

      const setSending = (value) => {
        sending = value;
        input.disabled = value;
        sendButton.disabled = value;
        dialog.querySelectorAll('[data-ai-option-index]').forEach((button) => {
          button.disabled = value;
        });
      };

      const clearOptions = () => {
        currentOptions = [];
        optionsHost.innerHTML = '';
      };

      const finishAssistantTurn = (response, userTurn = null) => {
        appendMessage('assistant', response.message);
        if (userTurn) history.push({ role: 'user', content: userTurn });
        history.push({ role: 'assistant', content: response.message });
        if (history.length > 16) history.splice(0, history.length - 16);
        renderOptions(response.options || []);
      };

      const renderOptions = (options) => {
        currentOptions = (Array.isArray(options) ? options : []).filter(
          (option) => option && (!allowedActions.size || allowedActions.has(option.action)),
        );
        optionsHost.innerHTML = '';
        if (!currentOptions.length) {
          optionsHost.innerHTML =
            '<p class="ai-chat-no-options">继续输入你的问题，或关闭面板返回题目。</p>';
          scrollToBottom();
          return;
        }
        currentOptions.forEach((option, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `ai-chat-option ${option.kind === 'action' ? 'is-action' : 'is-chat'}`;
          button.dataset.aiOptionIndex = String(index);
          button.innerHTML = `
            <span class="ai-option-number">${index + 1}</span>
            <span class="ai-option-copy">
              <strong>${escapeHTML(option.label || '')}</strong>
              <small>${escapeHTML(option.description || '')}</small>
            </span>
            <span class="ai-option-kind">${option.kind === 'action' ? '执行' : '继续对话'}</span>
          `;
          button.addEventListener('click', () => chooseOption(option));
          optionsHost.appendChild(button);
        });
        scrollToBottom();
      };

      const failRequest = (error, retry) => {
        const box = document.createElement('div');
        box.className = 'ai-chat-msg is-assistant is-error';
        box.innerHTML = `<span class="ai-chat-avatar">${icon('alert', 15)}</span>
          <div class="ai-chat-bubble">
            <strong>这次的 AI 请求没有完成。</strong>
            <p>${escapeHTML(error.message || '未知错误')}${error.hint ? ` ${escapeHTML(error.hint)}` : ''}</p>
          </div>`;
        log.appendChild(box);
        clearOptions();
        if (retry) {
          const retryButton = document.createElement('button');
          retryButton.type = 'button';
          retryButton.className = 'btn subtle ai-chat-retry';
          retryButton.textContent = '重试';
          retryButton.addEventListener('click', retry);
          optionsHost.appendChild(retryButton);
        }
        scrollToBottom();
      };

      const requestAI = async ({ message = '', selection = null, userTurn = null, initial = false }) => {
        if (sending || closed) return;
        setSending(true);
        clearOptions();
        const typing = appendTyping();
        try {
          const response = await interactWithAI({
            mode,
            context,
            history: history.slice(-16),
            message,
            selection,
            availableActions: [...allowedActions],
          });
          if (closed) return;
          typing.remove();
          finishAssistantTurn(response, userTurn);
          input.focus();
        } catch (error) {
          if (closed) return;
          typing.remove();
          failRequest(error, initial ? () => requestAI({ initial: true }) : null);
        } finally {
          if (!closed) setSending(false);
        }
      };

      const chooseOption = (option) => {
        if (sending || closed) return;
        if (option.kind === 'action') {
          closed = true;
          close();
          if (onAction) {
            Promise.resolve(onAction(option.action, option)).catch((error) => {
              console.error(error);
              toast(`执行 AI 选项失败：${error.message || '未知错误'}`, 'error', 4200);
            });
          } else {
            toast('这个 AI 选项当前没有可执行的操作。', 'info');
          }
          return;
        }

        const userLabel = option.label || '继续';
        appendMessage('user', userLabel);
        clearOptions();
        requestAI({
          selection: { action: option.action, label: userLabel },
          userTurn: userLabel,
        });
      };

      const sendFreeText = () => {
        if (sending || closed) return;
        const message = input.value.trim();
        if (!message) return;
        appendMessage('user', message);
        input.value = '';
        input.style.height = 'auto';
        requestAI({ message, userTurn: message });
      };

      sendButton.addEventListener('click', sendFreeText);
      input.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendFreeText();
        }
      });
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
      });

      dialog.addEventListener('keydown', (event) => {
        if (
          event.target instanceof HTMLElement &&
          (event.target.matches('input, textarea') || event.target.isContentEditable)
        ) {
          return;
        }
        if (/^[1-4]$/.test(event.key)) {
          const option = currentOptions[Number(event.key) - 1];
          if (option) {
            event.preventDefault();
            chooseOption(option);
          }
        }
      });

      dialog.addEventListener('close', () => {
        closed = true;
      });

      window.setTimeout(() => input.focus(), 100);
      requestAI({ initial: true });
    },
  });

  return control;
}
