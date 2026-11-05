(() => {
  try {
    const raw = window.localStorage.getItem('shuati-helper:data:v1');
    const parsed = raw ? JSON.parse(raw) : null;
    const saved = parsed?.settings?.theme;
    const theme =
      saved === 'dark' || saved === 'light'
        ? saved
        : window.matchMedia?.('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    document.documentElement.dataset.theme = theme;
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
