/** 通用 DOM、图标和弹层工具。 */

const ICON_PATHS = {
  dashboard:
    '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  scan:
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  book:
    '<path d="M12 6.5A5 5 0 0 0 8.5 5H3v14h6a4 4 0 0 1 3 1.5"/><path d="M12 6.5A5 5 0 0 1 15.5 5H21v14h-6a4 4 0 0 0-3 1.5V6.5Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 4.5-4 3.2 2.8L15 12l5 5"/>',
  camera:
    '<path d="M14.5 5 16 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-2h5Z"/><circle cx="12" cy="13" r="3.2"/>',
  upload:
    '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  'arrow-right': '<path d="M4 12h16"/><path d="m14 6 6 6-6 6"/>',
  'arrow-left': '<path d="M20 12H4"/><path d="m10 18-6-6 6-6"/>',
  trash:
    '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
  edit:
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  star:
    '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  refresh: '<path d="M20 7v5h-5"/><path d="M4.7 17.3A8 8 0 0 1 4 12a8 8 0 0 1 13.4-5.9L20 8.5"/><path d="M4 17v-5h5"/><path d="M19.3 6.7A8 8 0 0 1 20 12a8 8 0 0 1-13.4 5.9L4 15.5"/>',
  sparkles:
    '<path d="m12 3 1.4 3.6L17 8l-3.6 1.4L12 13l-1.4-3.6L7 8l3.6-1.4Z"/><path d="m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z"/><path d="m5 13 .8 2.2L8 16l-2.2.8L5 19l-.8-2.2L2 16l2.2-.8Z"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shuffle:
    '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  keyboard:
    '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 17h8"/>',
  'file-text':
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/>',
  'chart-line':
    '<path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 15 4-5 3 3 5-7"/>',
  'grip-vertical':
    '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16.5 9"/>',
  'x-circle': '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  tablet: '<rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M11 18h2"/>',
  'arrow-up-right': '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
  'more-horizontal': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  book2: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  graph:
    '<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="18" r="2.4"/><path d="M10.7 7.1 6.3 15.9M13.3 7.1l4.4 8.8M7.4 18h9.2"/>',
  flag: '<path d="M5 21V4c5-3 9 3 14 0v10c-5 3-9-3-14 0"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};

export function icon(name, size = 18, className = '') {
  const path = ICON_PATHS[name] || ICON_PATHS.info;
  return `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function typeClass(type) {
  return ['single', 'multiple', 'judge', 'fill', 'short'].includes(type) ? type : 'fill';
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${seconds} 秒`;
}

export function relativeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startOfToday - startOfDate) / 86_400_000);
  if (days <= 0) {
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `今天 ${String(hours).padStart(2, '0')}:${minutes}`;
  }
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function todayChinese() {
  const date = new Date();
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${weekdays[date.getDay()]}`;
}

export function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function autoGrowTextarea(textarea) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 42), 520)}px`;
}

export function autoGrowAll(root) {
  root?.querySelectorAll('textarea[data-autogrow]').forEach(autoGrowTextarea);
}

let toastHost = null;

export function toast(message, type = 'info', duration = 3000) {
  let host = toastHost;
  if (activeDialog?.open) {
    host = activeDialog.querySelector('.dialog-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host dialog-toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      activeDialog.appendChild(host);
    }
  } else {
    if (!toastHost) toastHost = document.getElementById('toast-host');
    host = toastHost;
  }
  if (!host) return;

  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  const iconName = type === 'success' ? 'check-circle' : type === 'error' ? 'alert' : 'info';
  item.innerHTML = `<span class="toast-icon">${icon(iconName, 18)}</span><span class="toast-message"></span>`;
  item.querySelector('.toast-message').textContent = message;
  host.appendChild(item);

  window.requestAnimationFrame(() => item.classList.add('is-visible'));
  window.setTimeout(() => {
    item.classList.remove('is-visible');
    window.setTimeout(() => item.remove(), 250);
  }, Math.max(1800, duration));
}

let activeDialog = null;

/**
 * 创建一个原生 <dialog>。
 * @returns {{dialog: HTMLDialogElement, body: HTMLElement, footer: HTMLElement | null, close: Function}}
 */
export function openDialog({
  title,
  eyebrow = '',
  description = '',
  content = '',
  footer = '',
  size = 'md',
  bodyClass = '',
  onMount = null,
} = {}) {
  if (activeDialog) {
    const previous = activeDialog;
    activeDialog = null;
    previous.close();
  }

  const dialog = document.createElement('dialog');
  dialog.className = `app-dialog dialog-${size}`;
  dialog.innerHTML = `
    <div class="dialog-shell">
      <header class="dialog-head">
        <div>
          ${eyebrow ? `<p class="eyebrow">${escapeHTML(eyebrow)}</p>` : ''}
          <h2>${escapeHTML(title || '')}</h2>
          ${description ? `<p class="dialog-description">${escapeHTML(description)}</p>` : ''}
        </div>
        <button type="button" class="icon-btn dialog-close" aria-label="关闭">${icon('x', 19)}</button>
      </header>
      <div class="dialog-body ${bodyClass}">${content}</div>
      ${footer ? `<footer class="dialog-footer">${footer}</footer>` : ''}
    </div>
  `;

  document.body.appendChild(dialog);
  activeDialog = dialog;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (activeDialog === dialog) activeDialog = null;
    if (dialog.open) dialog.close();
    dialog.remove();
  };

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.querySelector('.dialog-close')?.addEventListener('click', close);

  dialog.showModal();
  const body = dialog.querySelector('.dialog-body');
  const footerElement = dialog.querySelector('.dialog-footer');
  if (onMount) onMount({ dialog, body, footer: footerElement, close });
  window.requestAnimationFrame(() => {
    const focusTarget = dialog.querySelector('[autofocus], textarea, input, select, button.primary');
    focusTarget?.focus({ preventScroll: true });
  });

  return { dialog, body, footer: footerElement, close };
}

export function confirmAction({
  title = '确认操作',
  message = '',
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let control = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      control?.close();
    };

    control = openDialog({
      title,
      size: 'sm',
      content: `<p class="confirm-message">${escapeHTML(message)}</p>`,
      footer: `
        <button type="button" class="btn subtle" data-cancel>${escapeHTML(cancelText)}</button>
        <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${escapeHTML(confirmText)}</button>
      `,
      onMount: ({ dialog, close }) => {
        dialog.querySelector('[data-cancel]')?.addEventListener('click', () => finish(false));
        dialog.querySelector('[data-confirm]')?.addEventListener('click', () => finish(true));
        dialog.addEventListener('close', () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
          close();
        });
      },
    });
  });
}

export function downloadJSON(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
