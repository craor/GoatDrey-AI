// Проверка запасных поисковиков: node scripts/smoke-search.js
const { search } = require('../src/main/search');
(async () => {
  const r = await search('Electron framework');
  console.log('Провайдер:', r.provider, '| ошибки:', r.errors.join('; ') || 'нет');
  r.results.slice(0, 3).forEach((x, i) => console.log(`[${i + 1}] ${x.title} — ${x.url}`));
  if (!r.results.length) process.exit(1);
})();
