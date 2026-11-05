/**
 * 把 OCR 得到的纯文本拆成结构化题目。
 * 不依赖 DOM，方便在 Node 中单独测试。
 */

const QUESTION_START =
  /^[ \t]*(?:(?:第\s*)?(\d{1,3})\s*(?:题)?\s*[.．、)）]|第\s*(\d{1,3})\s*题)\s*/;

const ANSWER_LABEL =
  /^[ \t]*(?:【\s*(?:参考|正确|标准)?\s*答\s*案\s*】\s*[:：]?|(?:参考|正确|标准)\s*答\s*案\s*[:：]?|答\s*案\s*(?=[:：]|[A-Ha-h](?:[，,、]?[A-H])?(?:\s|$)|正确|错误|对|错)\s*[:：]?)\s*/;
const ANSWER_LABEL_ANY =
  /【\s*(?:参考|正确|标准)?\s*答\s*案\s*】\s*[:：]?|(?:参考|正确|标准)\s*答\s*案\s*[:：]?|答\s*案\s*[:：]/;
const MY_ANSWER_LABEL = /(?:我的|学生|用户|你的)\s*(?:答案|作答|选择)\s*[:：]?/;

const EXPLANATION_LABEL = /^[ \t]*(【\s*(?:答案)?\s*(?:解析|分析|详解|说明)\s*】\s*[:：]?|(?:答案)?\s*(?:解析|分析|详解|说明)\s*[:：])\s*/;
const EXPLANATION_LABEL_ANY = /【\s*(?:答案)?\s*(?:解析|分析|详解|说明)\s*】\s*[:：]?|(?:答案)?\s*(?:解析|分析|详解|说明)\s*[:：]/;

const OPTION_MARKER = /(^|[\s，,；;、。:：）)】])([A-Ha-h])\s*[.．、:：)）]\s*/gm;

const JUDGE_OPTION_WORDS = new Set([
  '正确', '错误', '对', '错', '是', '否', '√', '×', '✓', '✗', 't', 'f', 'true', 'false',
]);

function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function toHalfWidth(value) {
  return String(value || '')
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

function stripNoiseLines(lines) {
  return lines.filter((line) => {
    const t = line.trim();
    if (!t) return true;
    if (/^第\s*\d+\s*页\s*(?:[，,]\s*)?(?:共\s*\d+\s*页)?$/.test(t)) return false;
    if (/^共\s*\d+\s*页/.test(t)) return false;
    if (/^(?:作业详情|教师批阅)$/.test(t)) return false;
    if (/^\d{1,2}:\d{2}(?:\s|$)/.test(t)) return false;
    if (/^(?:\d{1,3}\s+){2,}\d{1,3}$/.test(t)) return false;
    if (/^[一二三四五六七八九十百]+\s*[、.．]\s*.{0,28}(?:选择题|填空题|判断题|简答题|计算题|阅读题|材料题|作文题|综合题)/.test(t)) return false;
    return true;
  });
}

function findQuestionStarts(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = QUESTION_START.exec(lines[index]);
    if (match) starts.push({ index, match });
  }
  return starts;
}

function splitIntoBlocks(rawText) {
  const lines = stripNoiseLines(cleanText(rawText).split('\n'));
  const starts = findQuestionStarts(lines);
  if (starts.length === 0) {
    return [lines.join('\n').trim()].filter(Boolean);
  }

  const blocks = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index : lines.length;
    const blockLines = lines.slice(start.index, end);
    blockLines[0] = blockLines[0].replace(QUESTION_START, '');
    const block = blockLines.join('\n').trim();
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * 把每道题末尾的「答案 / 解析」拆出来。
 * 标签只认行首，避免题目正文中的「填写答案：」被误判。
 */
function extractMeta(block) {
  const lines = block.split('\n');
  const contentLines = [];
  const explanationLines = [];
  let answer = '';
  let mode = 'content';
  let awaitingAnswer = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      if (mode === 'explanation') explanationLines.push('');
      else if (!awaitingAnswer) contentLines.push('');
      continue;
    }

    if (mode === 'explanation') {
      explanationLines.push(line);
      continue;
    }

    const answerMatch = line.match(ANSWER_LABEL);
    if (answerMatch) {
      let rest = line.slice(answerMatch[0].length).trim();
      const myAnswerAt = rest.search(MY_ANSWER_LABEL);
      if (myAnswerAt >= 0) rest = rest.slice(0, myAnswerAt).trim();
      const explanationInAnswer = rest.match(EXPLANATION_LABEL_ANY);
      if (explanationInAnswer) {
        const answerPart = rest.slice(0, explanationInAnswer.index).trim();
        const explanationPart = rest
          .slice(explanationInAnswer.index + explanationInAnswer[0].length)
          .trim();
        if (answerPart) answer = answerPart;
        if (explanationPart) explanationLines.push(explanationPart);
        mode = 'explanation';
      } else if (rest) {
        answer = rest;
        mode = 'explanation';
      } else {
        awaitingAnswer = true;
      }
      continue;
    }

    const explanationMatch = line.match(EXPLANATION_LABEL);
    if (explanationMatch) {
      const rest = line.slice(explanationMatch[0].length).trim();
      if (rest) explanationLines.push(rest);
      mode = 'explanation';
      continue;
    }

    if (awaitingAnswer) {
      answer = line;
      awaitingAnswer = false;
      mode = 'explanation';
      continue;
    }

    contentLines.push(line);
  }

  return {
    content: contentLines.join('\n').trim(),
    answer: answer.trim(),
    explanation: explanationLines.join('\n').trim(),
  };
}

function markerCandidates(text) {
  const candidates = [];
  OPTION_MARKER.lastIndex = 0;
  let match;
  while ((match = OPTION_MARKER.exec(text)) !== null) {
    candidates.push({
      key: match[2].toUpperCase(),
      markerStart: match.index + match[1].length,
      contentStart: match.index + match[0].length,
    });
    // 避免零长度匹配导致死循环（正常不会发生）
    if (match[0].length === 0) OPTION_MARKER.lastIndex += 1;
  }
  return candidates;
}

/** 严格模式：必须从 A 开始，按 A/B/C… 连续排列，且每个选项都有内容。 */
function strictOptionSequence(text) {
  const markers = markerCandidates(text);
  let best = [];

  for (let i = 0; i < markers.length; i += 1) {
    if (markers[i].key !== 'A') continue;
    const sequence = [markers[i]];
    let expected = 1;

    for (let j = i + 1; j < markers.length; j += 1) {
      const marker = markers[j];
      const expectedKey = String.fromCharCode(65 + expected);
      if (marker.key === expectedKey) {
        const previous = sequence[sequence.length - 1];
        const segment = text.slice(previous.contentStart, marker.markerStart).trim();
        if (!segment) break;
        sequence.push(marker);
        expected += 1;
      } else if (marker.key === 'A') {
        break;
      }
    }

    if (sequence.length > best.length) best = sequence;
  }

  if (best.length < 2) return null;
  const last = best[best.length - 1];
  if (!text.slice(last.contentStart).trim()) return null;

  return {
    stem: text.slice(0, best[0].markerStart).trim(),
    options: best.map((marker, index) => ({
      key: marker.key,
      text: text
        .slice(marker.contentStart, index + 1 < best.length ? best[index + 1].markerStart : text.length)
        .trim(),
    })),
  };
}

/**
 * 兼容 OCR 把选项写成「A 选项」而没有标点的情况。
 * 只接受独占一行、并且从 A 开始连续出现的选项。
 */
function looseLineOptions(text) {
  const lines = text.split('\n');
  const lineMatches = [];

  lines.forEach((line, index) => {
    const match = line.trim().match(/^(?:[(（]?)([A-H])(?:[)）])?(?:[.．、:：)）]\s*|\s+)(.+)$/);
    if (match) {
      lineMatches.push({ index, key: match[1], text: match[2].trim() });
    }
  });

  for (let start = 0; start < lineMatches.length; start += 1) {
    if (lineMatches[start].key !== 'A') continue;
    const seq = [lineMatches[start]];
    let expected = 1;

    for (let i = start + 1; i < lineMatches.length; i += 1) {
      if (lineMatches[i].key === String.fromCharCode(65 + expected)) {
        seq.push(lineMatches[i]);
        expected += 1;
      } else if (lineMatches[i].key === 'A') {
        break;
      }
    }

    if (seq.length < 2) continue;
    const firstLine = seq[0].index;
    const stem = lines.slice(0, firstLine).join('\n').trim();
    if (!stem) continue;

    const options = seq.map((item, index) => {
      const nextLine = index + 1 < seq.length ? seq[index + 1].index : lines.length;
      const body = [item.text, ...lines.slice(item.index + 1, nextLine)]
        .join('\n')
        .trim();
      return { key: item.key, text: body };
    });
    return { stem, options };
  }

  return null;
}

function extractOptionsAndStem(content) {
  const found = strictOptionSequence(content) || looseLineOptions(content);
  if (!found || !found.stem) {
    return { stem: content.trim(), options: [] };
  }

  const seen = new Set();
  const options = found.options
    .filter((option) => option.key && option.text)
    .filter((option) => {
      if (seen.has(option.key)) return false;
      seen.add(option.key);
      return true;
    })
    .map((option) => ({ key: option.key, text: tidyParagraph(option.text) }));

  if (options.length < 2) return { stem: content.trim(), options: [] };
  return { stem: tidyParagraph(found.stem), options };
}

function joinLinePair(left, right) {
  if (/[㐀-鿿]$/.test(left) || /^[㐀-鿿]/.test(right)) return left + right;
  return `${left} ${right}`;
}

/** 合并 OCR 的自动换行；带句末标点或新段编号时保留换行。 */
function tidyParagraph(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, array) => !(line === '' && index === array.length - 1));

  const output = [];
  for (const line of lines) {
    if (!line) {
      if (output.length && output[output.length - 1] !== '') output.push('');
      continue;
    }

    const previous = output[output.length - 1];
    const startsNewPart = /^(?:[(（]?\d+[)）.、]|[①②③④⑤⑥⑦⑧⑨⑩]|[A-H][.．、)]|注[:：]|提示[:：])/.test(line);
    const endsSentence = /[。！？!?]$/.test(previous || '');

    if (previous && previous !== '' && !startsNewPart && !endsSentence) {
      output[output.length - 1] = joinLinePair(previous, line);
    } else {
      output.push(line);
    }
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeTruthWord(value) {
  const token = String(value || '')
    .trim()
    .replace(/[\s。.!！,，:：;；]/g, '')
    .toLowerCase();
  if (['正确', '对', '是', '√', '✓', 't', 'true'].includes(token)) return '正确';
  if (['错误', '错', '否', '×', '✗', 'f', 'false'].includes(token)) return '错误';
  return null;
}

function isJudgeOptions(options) {
  if (options.length !== 2) return false;
  return options.every((option) => {
    const text = option.text.replace(/[。.!！\s]/g, '');
    return JUDGE_OPTION_WORDS.has(text.toLowerCase()) || normalizeTruthWord(option.text) !== null;
  });
}

function judgeOptions() {
  return [
    { key: 'A', text: '正确' },
    { key: 'B', text: '错误' },
  ];
}

function normalizeLoose(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[，,。.；;、：:！!？?“”"'‘’（）()【】[\]]/g, '')
    .toLowerCase();
}

function choiceLetters(rawAnswer, options) {
  const compact = String(rawAnswer || '')
    .replace(/\s+/g, '')
    .replace(/[.．、,，;；/／和及。]/g, '')
    .toUpperCase();
  if (!/^[A-H]+$/.test(compact)) return [];
  const keys = new Set(options.map((option) => option.key));
  const letters = [...new Set(compact.split(''))];
  if (!letters.every((letter) => keys.has(letter))) return [];
  return letters.sort();
}

function matchAnswerToOptionText(rawAnswer, options) {
  const target = normalizeLoose(rawAnswer);
  if (!target) return '';
  const matches = options.filter((option) => normalizeLoose(option.text) === target);
  return matches.length === 1 ? matches[0].key : '';
}

function normalizeJudgeAnswer(rawAnswer, options) {
  const letters = choiceLetters(rawAnswer, options);
  if (letters.length) return letters.join('');

  const truth = normalizeTruthWord(rawAnswer);
  if (truth) {
    const matched = options.find((option) => normalizeTruthWord(option.text) === truth);
    if (matched) return matched.key;
  }
  return String(rawAnswer || '').trim();
}

function detectType(stem, options, rawAnswer) {
  const explicitMultiple = /(?:多选|多项选择|不定项选择|不定项)/.test(stem);
  const explicitSingle = /(?:单选|单项选择)/.test(stem);
  const explicitJudge = /(?:判断|是非题)/.test(stem);
  const explicitShort = /(?:简答|问答|论述|名词解释|解答题|分析题|简述)/.test(stem);
  const judge = isJudgeOptions(options);

  if (judge) return 'judge';
  if (options.length >= 2) {
    const letters = choiceLetters(rawAnswer, options);
    if (letters.length > 1) return 'multiple';
    if (explicitMultiple) return 'multiple';
    if (explicitSingle) return 'single';
    return 'single';
  }
  if (explicitJudge && normalizeTruthWord(rawAnswer)) return 'judge';
  if (explicitShort) return 'short';
  return 'fill';
}

function normalizeChoiceAnswer(rawAnswer, options, type) {
  const letters = choiceLetters(rawAnswer, options);
  if (letters.length) {
    return type === 'single' ? letters[0] : letters.join('');
  }

  const byText = matchAnswerToOptionText(rawAnswer, options);
  if (byText) return byText;

  return String(rawAnswer || '').replace(/^[：:\s]+|[：:\s]+$/g, '');
}

function parseBlock(block) {
  const meta = extractMeta(block);
  if (!meta.content) return null;

  const extracted = extractOptionsAndStem(meta.content);
  let { stem, options } = extracted;
  stem = tidyParagraph(stem);

  let type = detectType(stem, options, meta.answer);
  stem = tidyParagraph(
    stem.replace(
      /^[（(\[【]\s*(?:单选题|多选题|判断题|填空题|简答题|解答题|问答题|论述题)\s*[）)\]】]\s*/,
      '',
    ),
  );
  let answer = toHalfWidth(meta.answer).trim();

  if (type === 'judge') {
    if (options.length !== 2) options = judgeOptions();
    answer = normalizeJudgeAnswer(answer, options);
    if (!answer) answer = '';
  } else if (options.length >= 2) {
    answer = normalizeChoiceAnswer(answer, options, type);
    if (type === 'multiple' && answer.length > 1) {
      answer = [...new Set(answer.split(''))].sort().join('');
    }
  } else {
    if (type !== 'short') type = 'fill';
    options = [];
    answer = String(answer || '').trim();
  }

  if (!stem) return null;

  return {
    type,
    stem,
    options,
    answer,
    explanation: tidyParagraph(meta.explanation),
  };
}

/**
 * @param {string} rawText OCR 文本框中的文本
 * @returns {Array<{type: string, stem: string, options: Array<{key: string, text: string}>, answer: string, explanation: string}>}
 */
export function parseQuestions(rawText) {
  try {
    return splitIntoBlocks(rawText)
      .map(parseBlock)
      .filter((question) => question && question.stem.length >= 2);
  } catch (error) {
    console.error('拆题失败', error);
    return [];
  }
}

export const __test__ = {
  extractMeta,
  extractOptionsAndStem,
  strictOptionSequence,
  looseLineOptions,
  normalizeTruthWord,
  choiceLetters,
};
