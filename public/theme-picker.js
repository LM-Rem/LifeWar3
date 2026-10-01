export function mountThemePicker(container, onChange = () => {}) {
  container.innerHTML = `<fieldset class="theme-picker"><legend>界面风格</legend><div class="theme-options"><button type="button" class="theme-option" data-theme-option="nexus" aria-pressed="false"><span class="theme-swatch nexus" aria-hidden="true"><i></i><i></i><i></i></span><strong>深空战术</strong><small>原版 · 深色科幻</small></button><button type="button" class="theme-option" data-theme-option="cartoon" aria-pressed="false"><span class="theme-swatch cartoon" aria-hidden="true"><i></i><i></i><i></i></span><strong>生命花园</strong><small>浅色 · 圆角卡通</small></button></div></fieldset>`;
  const sync = () => container.querySelectorAll('[data-theme-option]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeOption === document.documentElement.dataset.theme)));
  container.querySelectorAll('[data-theme-option]').forEach(button => button.addEventListener('click', () => {
    const theme = window.lifeWarTheme.set(button.dataset.themeOption); sync(); onChange(theme);
  }));
  window.addEventListener('lifewar:theme', sync); sync();
}
