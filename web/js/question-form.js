import {
  QUESTION_TYPES,
  isChoiceType,
  isWrittenAnswerType,
  normalizeAnswer,
} from './store.js';
import { autoGrowAll, escapeHTML, icon, toast } from './ui.js';

const LETTERS = 'ABCDEFGH';

function makeOptions(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    key: LETTERS[index],
    text: '',
  }));
}

function judgeOptions() {
  return [
    { key: 'A', text: '正确' },
    { key: 'B', text: '错误' },
  ];
}

function cloneOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option, index) => ({
    key: LETTERS[index],
    text: String(option?.text ?? ''),
  }));
}

function letterSet(answer) {
  return new Set(String(answer || '').toUpperCase().replace(/[^A-H]/g, '').split(''));
}

function renderAnswerArea(state) {
  if (isWrittenAnswerType(state.type)) {
    const shortAnswer = state.type === 'short';
    return `
      <div class="answer-editor">
        <div class="field-title-row">
          <span class="field-title">${shortAnswer ? '参考答案（仅供参考）' : '参考答案'}</span>
          <span class="field-hint">${
            shortAnswer ? '可留空，练习时自行对照评分' : '多个可接受的答案用 | 分隔'
          }</span>
        </div>
        <textarea class="input answer-input ${shortAnswer ? 'short-reference-input' : ''}"
          rows="${shortAnswer ? 3 : 1}" data-autogrow data-field="answer-text"
          placeholder="${
            shortAnswer
              ? '写下参考答案或评分要点；仅供参考，可留空'
              : '录入答案后，这道题才能进入练习'
          }">${escapeHTML(state.answer)}</textarea>
      </div>
    `;
  }

  const active = letterSet(state.answer);
  const options = state.options.length
    ? state.options
    : [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];
  const hint =
    state.type === 'multiple'
      ? '多选题：可同时选中多个答案'
      : state.type === 'judge'
        ? '判断题：选择正确或错误'
        : '单选题：选择唯一答案';

  return `
    <div class="answer-editor">
      <div class="field-title-row">
        <span class="field-title">正确答案</span>
        <span class="field-hint">${hint}</span>
      </div>
      <div class="answer-chips" role="group" aria-label="选择正确答案">
        ${options
          .map(
            (option) => `
            <button type="button" class="answer-chip ${active.has(option.key) ? 'is-active' : ''}"
              data-answer-key="${option.key}" aria-pressed="${active.has(option.key)}">
              <span>${option.key}</span>
              <em>${escapeHTML(option.text || '未填写')}</em>
            </button>
          `,
          )
          .join('')}
      </div>
      ${
        active.size === 0
          ? '<p class="inline-warning">' + icon('alert', 14) + ' 还没设置答案，保存后不会进入练习。</p>'
          : ''
      }
    </div>
  `;
}

function typeDescription(type) {
  if (type === 'multiple') return '可多选';
  if (type === 'judge') return '正确 / 错误';
  if (type === 'fill') return '手动输入';
  if (type === 'short') return '自由作答 · 参考答案仅供参考';
  return '单选';
}

export class QuestionForm {
  constructor(question = {}, { compact = false, onChange = null } = {}) {
    this.compact = compact;
    this.onChange = onChange;

    const type = QUESTION_TYPES[question.type] ? question.type : 'single';
    let options = cloneOptions(question.options);
    if (!isChoiceType(type)) {
      options = options.length ? options : makeOptions(4);
    } else if (options.length < 2) {
      options = type === 'judge' ? judgeOptions() : makeOptions(4);
    } else if (type === 'judge' && options.length !== 2) {
      options = judgeOptions();
    }

    this.state = {
      type,
      stem: String(question.stem || ''),
      options,
      answer: String(question.answer || ''),
      explanation: String(question.explanation || ''),
    };
    this.aiReview =
      question.aiReview && typeof question.aiReview === 'object'
        ? {
            ...question.aiReview,
            warnings: Array.isArray(question.aiReview.warnings)
              ? [...question.aiReview.warnings]
              : [],
          }
        : null;

    if (isChoiceType(this.state.type)) {
      this.state.answer = normalizeAnswer(this.state.answer, this.state.type, this.state.options);
    }

    this.element = document.createElement('div');
    this.element.className = `qform ${compact ? 'is-compact' : ''}`;
    this._bindEvents();
    this.render();
    window.setTimeout(() => autoGrowAll(this.element), 0);
  }

  _notifyChange() {
    this.element.classList.remove('has-error');
    this.onChange?.();
  }

  _bindEvents() {
    this.element.addEventListener('input', (event) => {
      const target = event.target;
      if (target.matches('[data-field="stem"]')) {
        this.state.stem = target.value;
        this._autoGrow(target);
        this._notifyChange();
      } else if (target.matches('[data-option-index]')) {
        const index = Number(target.dataset.optionIndex);
        if (this.state.options[index]) this.state.options[index].text = target.value;
        const optionKey = LETTERS[index];
        const chipText = this.element.querySelector(`[data-answer-key="${optionKey}"] em`);
        if (chipText) chipText.textContent = target.value || '未填写';
        this._notifyChange();
      } else if (target.matches('[data-field="answer-text"]')) {
        this.state.answer = target.value;
        this._autoGrow(target);
        this._notifyChange();
      } else if (target.matches('[data-field="explanation"]')) {
        this.state.explanation = target.value;
        this._autoGrow(target);
        this._notifyChange();
      }
    });

    this.element.addEventListener('change', (event) => {
      if (event.target.matches('[data-field="type"]')) {
        this.changeType(event.target.value);
      }
    });

    this.element.addEventListener('click', (event) => {
      const actionButton = event.target.closest('[data-action]');
      if (actionButton) {
        const action = actionButton.dataset.action;
        if (action === 'add-option') {
          this.addOption();
          return;
        }
        if (action === 'remove-option') {
          this.removeOption(Number(actionButton.dataset.optionIndex));
          return;
        }
        if (action === 'clear-ai-review') {
          this.aiReview = null;
          this.render();
          this._notifyChange();
          return;
        }
      }

      const answerChip = event.target.closest('[data-answer-key]');
      if (answerChip) {
        this.toggleAnswer(answerChip.dataset.answerKey);
      }
    });
  }

  _autoGrow(target) {
    target.style.height = 'auto';
    target.style.height = `${Math.min(Math.max(target.scrollHeight, 42), 300)}px`;
  }

  _resetOptionKeys() {
    this.state.options.forEach((option, index) => {
      option.key = LETTERS[index];
    });
  }

  addOption() {
    if (!isChoiceType(this.state.type) || this.state.type === 'judge') return;
    if (this.state.options.length >= LETTERS.length) {
      toast('最多支持 8 个选项。', 'info');
      return;
    }
    const nextKey = LETTERS[this.state.options.length];
    this.state.options.push({ key: nextKey, text: '' });
    this.render();
    this._notifyChange();
    const inputs = this.element.querySelectorAll('[data-option-index]');
    inputs[inputs.length - 1]?.focus();
  }

  removeOption(index) {
    if (this.state.type === 'judge') return;
    if (!Number.isInteger(index) || index < 0 || index >= this.state.options.length) return;
    if (this.state.options.length <= 2) {
      toast('选择题至少保留两个选项。', 'info');
      return;
    }

    const removedKey = LETTERS[index];
    const answer = this.state.answer.toUpperCase().replace(/[^A-H]/g, '');
    const remapped = [...new Set(answer.split(''))]
      .filter((key) => key !== removedKey)
      .map((key) => {
        const code = key.charCodeAt(0);
        const removedCode = removedKey.charCodeAt(0);
        return code > removedCode ? String.fromCharCode(code - 1) : key;
      })
      .sort()
      .join('');

    this.state.options.splice(index, 1);
    this._resetOptionKeys();
    this.state.answer = remapped;
    this.render();
    this._notifyChange();
  }

  toggleAnswer(key) {
    if (!isChoiceType(this.state.type)) return;
    const active = letterSet(this.state.answer);

    if (this.state.type === 'single' || this.state.type === 'judge') {
      this.state.answer = active.has(key) && active.size === 1 ? '' : key;
    } else {
      if (active.has(key)) active.delete(key);
      else active.add(key);
      this.state.answer = [...active].sort().join('');
    }

    this.render();
    this._notifyChange();
  }

  changeType(nextType) {
    if (!QUESTION_TYPES[nextType] || nextType === this.state.type) return;
    const previousType = this.state.type;

    if (nextType === 'judge') {
      const previousOptions = this.state.options;
      const answerTruth = this.state.answer;
      this.state.options = judgeOptions();
      this.state.answer = normalizeAnswer(answerTruth, 'judge', this.state.options);
      if (!this.state.answer) {
        const priorTruth = previousOptions.find((option) => {
          const normalized = option.text.replace(/\s/g, '');
          return ['正确', '对', '是', '√', '错误', '错', '否', '×'].includes(normalized);
        });
        if (priorTruth) {
          this.state.answer = normalizeAnswer(priorTruth.text, 'judge', this.state.options);
        }
      }
    } else if (isWrittenAnswerType(nextType)) {
      if (isChoiceType(previousType)) this.state.answer = '';
    } else {
      if (this.state.options.length < 2) {
        this.state.options = makeOptions(4);
      }
      this.state.answer = normalizeAnswer(this.state.answer, nextType, this.state.options);
      if (isWrittenAnswerType(previousType)) {
        const optionKeys = new Set(this.state.options.map((option) => option.key));
        const letters = this.state.answer.toUpperCase().replace(/[^A-H]/g, '');
        if (!letters || ![...letters].every((key) => optionKeys.has(key))) {
          this.state.answer = '';
        }
      }
      if (nextType === 'single' && this.state.answer.length > 1) {
        this.state.answer = this.state.answer[0];
      }
      if (nextType === 'multiple') {
        this.state.answer = [...new Set(this.state.answer.split(''))].sort().join('');
      }
    }

    this.state.type = nextType;
    this.render();
    this._notifyChange();
  }

  validate() {
    const stem = this.state.stem.trim();
    if (!stem) {
      this.element.classList.add('has-error');
      this.element.querySelector('[data-field="stem"]')?.focus();
      return '请填写题干。';
    }

    if (isChoiceType(this.state.type)) {
      if (this.state.options.length < 2) {
        this.element.classList.add('has-error');
        return '选择题至少需要两个选项。';
      }
      const emptyIndex = this.state.options.findIndex((option) => !option.text.trim());
      if (emptyIndex >= 0) {
        this.element.classList.add('has-error');
        this.element.querySelector(`[data-option-index="${emptyIndex}"]`)?.focus();
        return `选项 ${LETTERS[emptyIndex]} 还没有内容，请补充或删除该选项。`;
      }
    }

    return '';
  }

  getQuestion() {
    const options = isChoiceType(this.state.type)
      ? this.state.options.map((option, index) => ({
          key: LETTERS[index],
          text: option.text.trim(),
        }))
      : [];
    const answer = isChoiceType(this.state.type)
      ? normalizeAnswer(this.state.answer, this.state.type, options)
      : this.state.answer.trim();

    return {
      type: this.state.type,
      stem: this.state.stem.trim(),
      options,
      answer,
      explanation: this.state.explanation.trim(),
      aiReview: this.aiReview
        ? {
            ...this.aiReview,
            warnings: Array.isArray(this.aiReview.warnings)
              ? [...this.aiReview.warnings]
              : [],
          }
        : null,
    };
  }

  focusStem() {
    this.element.querySelector('[data-field="stem"]')?.focus();
  }

  render() {
    const state = this.state;
    const choice = isChoiceType(state.type);
    const reviewWarnings = Array.isArray(this.aiReview?.warnings)
      ? this.aiReview.warnings.filter(Boolean).slice(0, 4)
      : [];
    const reviewConfidence = Number(this.aiReview?.confidence);
    const reviewSource = this.aiReview
      ? [this.aiReview.sourceFilename, this.aiReview.pageNumber ? `第 ${this.aiReview.pageNumber} 页` : '']
          .filter(Boolean)
          .join(' · ')
      : '';
    const reviewSummary = reviewWarnings.length
      ? reviewWarnings.join('；')
      : Number.isFinite(reviewConfidence)
        ? `AI 置信度 ${Math.round(reviewConfidence * 100)}%，建议核对题干、选项和答案。`
        : 'AI 标记这道题需要人工复核。';
    const typeOptions = Object.entries(QUESTION_TYPES)
      .map(
        ([value, label]) =>
          `<option value="${value}" ${state.type === value ? 'selected' : ''}>${label}</option>`,
      )
      .join('');

    const optionsMarkup =
      choice && state.type !== 'judge'
        ? `
        <div class="options-editor">
          <div class="field-title-row">
            <span class="field-title">选项</span>
            <button type="button" class="text-button" data-action="add-option"
              ${state.options.length >= LETTERS.length ? 'disabled' : ''}>
              ${icon('plus', 14)} 添加选项
            </button>
          </div>
          <div class="option-list">
            ${state.options
              .map(
                (option, index) => `
                <div class="option-row">
                  <span class="option-letter">${LETTERS[index]}</span>
                  <input class="input" type="text" data-option-index="${index}"
                    value="${escapeHTML(option.text)}" placeholder="选项内容"
                    aria-label="选项 ${LETTERS[index]}">
                  <button type="button" class="icon-btn option-remove" data-action="remove-option"
                    data-option-index="${index}" aria-label="删除选项 ${LETTERS[index]}"
                    ${state.options.length <= 2 ? 'disabled' : ''}>
                    ${icon('x', 15)}
                  </button>
                </div>
              `,
              )
              .join('')}
          </div>
        </div>
      `
        : '';

    this.element.innerHTML = `
      ${
        this.aiReview
          ? `<div class="qform-ai-review" role="note">
              <span class="qform-ai-review-icon">${icon('alert', 16)}</span>
              <div class="qform-ai-review-copy">
                <strong>AI 识别需复核</strong>
                <p>${escapeHTML(reviewSummary)}</p>
                ${reviewSource ? `<small>${escapeHTML(reviewSource)}</small>` : ''}
              </div>
              <button type="button" class="text-button" data-action="clear-ai-review">已核对，清除</button>
            </div>`
          : ''
      }
      <div class="qform-top">
        <label class="type-field">
          <span>${icon('layers', 15)} 题型</span>
          <select class="type-select" data-field="type" aria-label="题型">${typeOptions}</select>
        </label>
        <span class="type-caption">${typeDescription(state.type)}</span>
      </div>

      <label class="field-block">
        <span class="field-title">题干 <b>*</b></span>
        <textarea class="input stem-input" data-autogrow data-field="stem" rows="2"
          placeholder="输入题目内容，选项会单独列出">${escapeHTML(state.stem)}</textarea>
      </label>

      ${optionsMarkup}

      ${renderAnswerArea(state)}

      <details class="explanation-editor" ${state.explanation ? 'open' : ''}>
        <summary>${icon('file-text', 15)} 解析 / 笔记 <span>选填</span></summary>
        <textarea class="input" data-autogrow data-field="explanation" rows="2"
          placeholder="记录解题思路，练习时会在作答后显示">${escapeHTML(state.explanation)}</textarea>
      </details>
    `;

    autoGrowAll(this.element);
  }
}
