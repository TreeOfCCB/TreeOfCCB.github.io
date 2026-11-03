// 轻量 Markdown 渲染器：先整体转义 HTML，再解析常用语法，杜绝脚本注入。
// 支持：标题、段落（保留换行）、粗体/斜体/删除线、行内代码、代码块、引用、有序/无序列表、分割线、链接、图片。
(function () {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeUrl = u => /^(https?:|mailto:|#|\/|\.\/)/i.test(u) ? u : '#';

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img alt="${a}" src="${safeUrl(u)}">`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener">${t}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>').replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  function render(src) {
    const lines = esc(String(src || '').replace(/\r\n?/g, '\n')).split('\n');
    const out = [];
    let i = 0;
    const isBlockStart = l => /^(#{1,6}\s|```|&gt;|\s*([-*+]|\d+\.)\s|\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(l);
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) { i++; continue; }
      let m;
      if (l.startsWith('```')) {
        const buf = []; i++;
        while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
        i++; out.push(`<pre><code>${buf.join('\n')}</code></pre>`); continue;
      }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (l.startsWith('&gt;')) {
        const buf = [];
        while (i < lines.length && lines[i].startsWith('&gt;')) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
        out.push(`<blockquote>${render.fromEscaped(buf.join('\n'))}</blockquote>`); continue;
      }
      if ((m = /^\s*([-*+]|\d+\.)\s+/.exec(l))) {
        const ordered = /\d/.test(m[1]);
        const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        const items = [];
        while (i < lines.length && re.test(lines[i])) items.push(`<li>${inline(re.exec(lines[i++])[1])}</li>`);
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
      }
      const buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !(buf.length && isBlockStart(lines[i]))) buf.push(inline(lines[i++]));
      out.push(`<p>${buf.join('<br>')}</p>`);
    }
    return out.join('\n');
  }
  // 引用块内部内容已转义，避免二次转义
  render.fromEscaped = s => {
    const un = s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    return render(un);
  };
  window.renderMarkdown = render;
})();
