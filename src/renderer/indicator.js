(function () {
  const q = new URLSearchParams(location.search);
  const hot = q.get('hot');
  const el = document.getElementById('hot');
  if (el && hot) el.textContent = '· ' + hot;
  document.getElementById('stop').addEventListener('click', () => { location.hash = 'stop'; });
})();
