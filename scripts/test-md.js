#!/usr/bin/env node
const assert = require('assert');
const { render, sanitize } = require('../src/renderer/md.js');
let failed = 0, passed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error('FAIL', name, '\n ', e.message); }
}

check('bold works', () => {
  const h = render('**привет**');
  assert.ok(/<strong>привет<\/strong>/.test(h), h);
});
check('raw script escaped/stripped', () => {
  const h = render('hello <script>alert(1)</script>');
  assert.ok(!h.includes('<script>'), h);
  assert.ok(!h.includes('alert(1)') || h.includes('&lt;script') || !/<script/i.test(h), h);
});
check('javascript url stripped or neutralized', () => {
  const h = render('[x](javascript:alert(1))');
  assert.ok(!/href="javascript:/i.test(h), h);
});
check('https link has noopener', () => {
  const h = render('[x](https://example.com/page)');
  assert.ok(/noopener/.test(h), h);
  assert.ok(/href="https:\/\/example.com\/page"/.test(h), h);
});
check('http link not made clickable as http (https only)', () => {
  const h = render('[x](http://example.com/)');
  assert.ok(!/href="http:\/\//.test(h), h);
});
check('data svg image rejected', () => {
  const h = render('![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+)');
  assert.ok(!/<img\b[^>]*src=["']data:image\/svg/i.test(h), h);
});
check('code fence escaped', () => {
  const h = render('```\n<script>alert(1)</script>\n```');
  assert.ok(!h.includes('<script>'), h);
  assert.ok(h.includes('&lt;script&gt;') || h.includes('&lt;script'), h);
});
check('sanitize helper strips onerror', () => {
  const h = sanitize('<img src=x onerror="alert(1)">');
  assert.ok(!/onerror/i.test(h), h);
});

console.log(`md tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
