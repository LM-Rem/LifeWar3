// Run before styles are painted so a saved theme never flashes the other palette.
(() => {
  const key = 'lifewar.settings';
  const normalize = value => value === 'cartoon' ? 'cartoon' : 'nexus';
  const read = () => { try { const value = JSON.parse(localStorage.getItem(key)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } };
  function apply(value) {
    const theme = normalize(value), changed = document.documentElement.dataset.theme !== theme;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'cartoon' ? '#faf7ef' : '#080e13');
    if (changed) window.dispatchEvent(new CustomEvent('lifewar:theme', { detail: theme }));
    return theme;
  }
  window.lifeWarTheme = {
    apply,
    set(value) {
      const theme = apply(value);
      try { localStorage.setItem(key, JSON.stringify({ ...read(), theme })); } catch { /* The current tab still works without storage. */ }
      return theme;
    },
  };
  apply(read().theme);
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) apply(read().theme); });
})();
