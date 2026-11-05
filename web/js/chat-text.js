import { escapeHTML } from './ui.js';

export function renderAssistantText(text) {
  return escapeHTML(text || '')
    .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
