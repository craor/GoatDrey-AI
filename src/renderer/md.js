// Небольшой безопасный Markdown → HTML. Сначала экранируем всё, потом размечаем.
(function (root) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\((https:[^)\s]+|data:image\/(?:png|jpe?g|gif|webp)[^)\s]*)\)/g, '<img alt="$1" src="$2">');
    s = s.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\[(\d{1,2})\]/g, '<sup class="cite">$1</sup>');
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${esc(codes[+i])}</code>`);
  }
  function render(src) {
    const lines = (src || '').replace(/[\u202F\u2007\u2009\u00A0]/g, ' ').replace(/\r\n/g, '\n').split('\n');
    let out = [], i = 0;
    while (i < lines.length) {
      let l = lines[i];
      const fence = l.match(/^\s*```\s*([\w+-]*)/);
      if (fence) {
        const buf = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<div class="code"><div class="code-head"><span>${esc(fence[1] || 'код')}</span><button class="copy" data-copy>Копировать</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const row = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
        const head = row(l); i += 2; const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
        out.push(`<div class="table"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const h = l.match(/^(#{1,4})\s+(.*)/);
      if (h) { const n = Math.min(h[1].length + 1, 5); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(l)) { const b = []; while (i < lines.length && /^\s*>/.test(lines[i])) b.push(lines[i++].replace(/^\s*>\s?/, '')); out.push(`<blockquote>${render(b.join('\n'))}</blockquote>`); continue; }
      const li = l.match(/^\s*([-*+]|\d+[.)])\s+(.*)/);
      if (li) {
        const ordered = /\d/.test(li[1]); const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)/);
          if (m) { items.push(m[2]); i++; }
          else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; }
          else break;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map(t => `<li>${inline(t.replace(/^\[( |x)\]\s*/i, (m, c) => c.trim() ? '☑ ' : '☐ '))}</li>`).join('')}</${tag}>`);
        continue;
      }
      if (!l.trim()) { i++; continue; }
      const p = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) p.push(lines[i++]);
      if (!p.length) p.push(lines[i++]);
      out.push(`<p>${p.map(inline).join(' ')}</p>`);
    }
    return sanitize(out.join('\n'));
  }

  const PURIFY_CFG = {
    ALLOWED_TAGS: ['p','br','hr','h2','h3','h4','h5','strong','em','del','code','pre','div','span','a','img','ul','ol','li','blockquote','table','thead','tbody','tr','th','td','sup','button','details','summary'],
    ALLOWED_ATTR: ['href','src','alt','title','class','target','rel','data-copy'],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script','iframe','object','embed','form','input','link','meta','base','svg','math','style','video','audio'],
    FORBID_ATTR: ['style']
  };

  function hookLinks(html) {
    return String(html || '').replace(/<a\b([^>]*)>/gi, (m, attrs) => {
      let a = attrs;
      a = a.replace(/\brel\s*=\s*(['"][^'"]*['"]|[^\s>]+)/i, '').replace(/\btarget\s*=\s*(['"][^'"]*['"]|[^\s>]+)/i, '');
      // только https
      const href = (a.match(/\bhref\s*=\s*(['"])([^'"]*)\1/i) || [])[2] || '';
      if (href && !/^https:\/\//i.test(href)) a = a.replace(/\bhref\s*=\s*(['"])[^'"]*\1/i, 'href="#"');
      return `<a${a} target="_blank" rel="noopener noreferrer">`;
    });
  }

  function fallbackSanitize(html) {
    let s = String(html || '');
    s = s.replace(/<\s*(script|iframe|object|embed|link|meta|base|form|svg|math|video|audio)(\s[^>]*)?>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    s = s.replace(/<\s*(script|iframe|object|embed|link|meta|base|form|svg|math)(\s[^>]*)?>/gi, '');
    s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    s = s.replace(/(href|src)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, '$1=$2#$2');
    s = s.replace(/src\s*=\s*(['"])\s*data:image\/svg\+xml[^'"]*\1/gi, '');
    return hookLinks(s);
  }

  function sanitize(html) {
    if (typeof DOMPurify !== 'undefined') {
      try {
        const out = DOMPurify.sanitize(html, PURIFY_CFG);
        return hookLinks(out);
      } catch (e) { /* fallback */ }
    }
    return fallbackSanitize(html);
  }

  root.MD = { render, esc, sanitize };

  if (typeof module !== 'undefined') module.exports = { render, esc, sanitize };
})(typeof window !== 'undefined' ? window : globalThis);
