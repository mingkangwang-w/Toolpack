/**
 * UI 回归测试共用的磁盘题库隔离检查。
 * 测试会清空服务端的受管 Markdown 题库，因此必须连接专用的临时题库目录。
 */
export async function resetTestLibrary(baseUrl) {
  const healthResponse = await fetch(new URL('/api/health', baseUrl));
  const health = await healthResponse.json();
  if (!health.ok) throw new Error('本地服务未就绪，无法运行 UI 测试。');
  if (!health.libraryRoot || health.libraryRoot === '题库保存') {
    throw new Error(
      '拒绝在真实「题库保存」目录上运行会清空数据的 UI 测试。请用 --library-dir 指定临时目录启动测试服务。',
    );
  }

  const response = await fetch(new URL('/api/library/sync', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subjects: [], banks: [], questions: [] }),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.ok) {
    throw new Error(`重置测试题库失败：${payload?.error || `HTTP ${response.status}`}`);
  }
  console.log('test library reset', payload.root);
}
