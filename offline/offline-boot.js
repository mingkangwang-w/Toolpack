window.__SHUATI_OFFLINE__ = true;
document.documentElement.classList.add('offline-mode');

const isNativeApp = Boolean(window.Capacitor?.isNativePlatform?.());
if (!isNativeApp && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.error('离线缓存注册失败', error);
    });
  });
}

// 尽量让浏览器保留本地题库和练习记录，降低被清理的概率。
if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {});
}
