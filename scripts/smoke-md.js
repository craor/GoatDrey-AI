// Markdown-рендер не пропускает HTML: node scripts/smoke-md.js
const { render } = require('../src/renderer/md.js');
const out = render('**ok** <script>alert(1)</script> `x<y`\n\n```js\n<b>\n```');
if (out.includes('<script>') || out.includes('<b>')) { console.error('FAIL: HTML прошёл', out); process.exit(1); }
console.log('Markdown OK');
