export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('无法读取这张图片，请重试。'));
    reader.readAsDataURL(file);
  });
}

function timeoutSignal(milliseconds) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), milliseconds);
  return { signal: controller.signal, clear: () => window.clearTimeout(timer) };
}

export async function recognizeImage(file) {
  if (!file) throw new Error('没有选择图片。');
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('图片超过 25MB，请先压缩后再上传。');
  }

  const image = await fileToDataURL(file);
  const timeout = timeoutSignal(180_000);

  try {
    const response = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, filename: file.name }),
      signal: timeout.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error || `识别失败（HTTP ${response.status}）`);
      error.hint = payload?.hint || '';
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('识别超时，请换一张更小的图片后重试。');
    }
    if (error instanceof TypeError) {
      throw new Error('无法连接本地识别服务，请确认启动窗口仍然打开。');
    }
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function loadLibraryFromDisk() {
  const timeout = timeoutSignal(15_000);
  try {
    const response = await fetch('/api/library', { signal: timeout.signal });
    return await readApiResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('读取本地 Markdown 题库超时。');
    if (error instanceof TypeError) throw new Error('无法连接本地题库服务，请确认启动窗口仍然打开。');
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function syncLibraryToDisk({ subjects, banks, questions }) {
  const timeout = timeoutSignal(45_000);
  try {
    const response = await fetch('/api/library/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjects, banks, questions }),
      signal: timeout.signal,
    });
    return await readApiResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('写入本地 Markdown 题库超时。');
    if (error instanceof TypeError) throw new Error('无法连接本地题库服务，请确认启动窗口仍然打开。');
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function getShareStatus() {
  const timeout = timeoutSignal(10_000);
  try {
    const response = await fetch('/api/share/status', { signal: timeout.signal });
    return await readApiResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('读取分享状态超时。');
    if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认启动窗口仍然打开。');
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function startShare() {
  const timeout = timeoutSignal(10_000);
  try {
    const response = await fetch('/api/share/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: timeout.signal,
    });
    return await readApiResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('启动分享超时。');
    if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认启动窗口仍然打开。');
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function stopShare() {
  const timeout = timeoutSignal(10_000);
  try {
    const response = await fetch('/api/share/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: timeout.signal,
    });
    return await readApiResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('停止分享超时。');
    if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认启动窗口仍然打开。');
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function parseMarkdownBanks(files) {
  const timeout = timeoutSignal(120_000);
  try {
    const response = await fetch('/api/library/parse-md', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
      signal: timeout.signal,
    });
    return await readApiResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('解析 Markdown 题库超时，请减少文件数量后重试。');
    if (error instanceof TypeError) throw new Error('无法连接本地题库服务，请确认启动窗口仍然打开。');
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function checkHealth() {
  const timeout = timeoutSignal(4_000);
  try {
    const response = await fetch('/api/health', { signal: timeout.signal });
    if (!response.ok) return { ok: false };
    return await response.json();
  } catch {
    return { ok: false };
  } finally {
    timeout.clear();
  }
}

async function readApiResponse(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
    error.hint = payload?.hint || '';
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function getAIConfig() {
  const timeout = timeoutSignal(10_000);
  try {
    const response = await fetch('/api/ai/config', { signal: timeout.signal });
    return await readApiResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('读取 AI 设置超时。');
    if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认启动窗口仍然打开。');
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function saveAIConfig({
  endpoint,
  model,
  apiKey,
  customInstructions = '',
  clearKey = false,
}) {
  const timeout = timeoutSignal(15_000);
  try {
    const response = await fetch('/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, model, apiKey, customInstructions, clearKey }),
      signal: timeout.signal,
    });
    return await readApiResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('保存 AI 设置超时。');
    if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认启动窗口仍然打开。');
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function testAIConnection({ endpoint, model, apiKey, clearKey = false }) {
  const timeout = timeoutSignal(120_000);
  try {
    const response = await fetch('/api/ai/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, model, apiKey, clearKey }),
      signal: timeout.signal,
    });
    return await readApiResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('AI 连接测试超时，请检查接口地址和网络。');
    }
    if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认启动窗口仍然打开。');
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function interactWithAI({
  mode,
  context,
  history = [],
  message = '',
  selection = null,
  availableActions = [],
}) {
  const timeout = timeoutSignal(120_000);
  try {
    const response = await fetch('/api/ai/interact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, context, history, message, selection, availableActions }),
      signal: timeout.signal,
    });
    return await readApiResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('AI 响应超时，请稍后重试。');
    if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认启动窗口仍然打开。');
    throw error;
  } finally {
    timeout.clear();
  }
}

export async function analyzeTextWithAI({ ocrText, filename, pageNumber, pageCount }) {
  if (!String(ocrText || '').trim()) throw new Error('这张图片没有可分析的 OCR 文字。');
  const timeout = timeoutSignal(300_000);
  try {
    const response = await fetch('/api/ai/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ocrText, filename, pageNumber, pageCount }),
      signal: timeout.signal,
    });
    return await readApiResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('AI 文字分析超时，请稍后重试或换一个响应更快的模型。');
    }
    if (error instanceof TypeError) {
      throw new Error('无法连接本地服务，请确认启动窗口仍然打开。');
    }
    throw error;
  } finally {
    timeout.clear();
  }
}
