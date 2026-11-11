(async function () {
  const pin = document.getElementById('pin');
  const err = document.getElementById('err');
  const go = document.getElementById('go');
  const preferDark = () => { try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; } };
  try {
    if (window.gd?.theme) {
      const dark = await gd.theme.isDark();
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    } else document.documentElement.dataset.theme = preferDark() ? 'dark' : 'light';
  } catch { document.documentElement.dataset.theme = preferDark() ? 'dark' : 'light'; }

  async function submit() {
    err.textContent = '';
    const v = pin.value;
    if (!v) { err.textContent = 'Введите пароль.'; pin.focus(); return; }
    go.disabled = true;
    try {
      await gd.lock.unlock(v);
      // main загрузит основной интерфейс.
    } catch (e) {
      err.textContent = (e && e.message) ? String(e.message).replace(/^Error:\s*/, '') : 'Неверный пароль.';
      pin.select();
    } finally { go.disabled = false; }
  }
  go.addEventListener('click', submit);
  pin.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  pin.focus();
})();
