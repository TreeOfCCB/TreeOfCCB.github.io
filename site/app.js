'use strict';
// ============ 通用 ============
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATE_NAME = { gray: '未开放', white: '待认领', yellow: '写作中', green: '已完成', red: '已终止' };
const depthOf = id => Math.floor(Math.log2(id));
const fmtTime = t => {
  if (!t) return '';
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
let me = null;

// ---- Supabase 接口：所有规则都在数据库函数里执行（见 supabase/schema.sql）----
const CFG = window.RELAY_CONFIG || {};
const CONFIGURED = /^https?:\/\//.test(CFG.supabaseUrl || '') && !/YOUR-/.test(CFG.supabaseUrl + CFG.supabaseKey);

let memToken = null;
const tokenStore = {
  get() { try { return localStorage.getItem('relay_token') || memToken; } catch { return memToken; } },
  set(t) { memToken = t; try { t ? localStorage.setItem('relay_token', t) : localStorage.removeItem('relay_token'); } catch {} },
};

async function rpc(fn, args = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: CFG.supabaseKey };
  // 旧版 anon key 是 JWT，需要同时放进 Authorization；新版 publishable key 只放 apikey
  if (/^eyJ/.test(CFG.supabaseKey)) headers.Authorization = 'Bearer ' + CFG.supabaseKey;
  let r;
  try {
    // 只取协议+域名，容错用户粘贴了 .../rest/v1/ 之类的完整地址
    const base = (CFG.supabaseUrl.trim().match(/^https?:\/\/[^/]+/) || [''])[0];
    r = await fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  } catch { throw new Error('无法连接数据库，请检查网络'); }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = data?.message || `请求失败（${r.status}）`;
    if (/登录/.test(msg) && tokenStore.get()) { tokenStore.set(null); if (me) { me = null; renderNav(); } }
    if (r.status === 404 && /function/i.test(msg)) throw new Error('数据库还没有初始化：请先在 Supabase 运行 supabase/schema.sql');
    throw new Error(msg);
  }
  if (data && typeof data === 'object' && data.error) throw new Error(data.error);
  return data;
}
const tk = () => tokenStore.get();
const API = {
  me: () => tk() ? rpc('relay_me', { p_token: tk() }) : null,
  login: (u, p) => rpc('relay_login', { p_username: u, p_password: p }),
  register: (u, p) => rpc('relay_register', { p_username: u, p_password: p }),
  logout: () => rpc('relay_logout', { p_token: tk() }),
  password: (o, n) => rpc('relay_change_password', { p_token: tk(), p_old: o, p_new: n }),
  tree: () => rpc('relay_get_tree'),
  node: id => rpc('relay_get_node', { p_id: id }),
  chain: id => rpc('relay_get_chain', { p_id: id }),
  claim: id => rpc('relay_claim_node', { p_token: tk(), p_id: id }),
  save: (id, title, content) => rpc('relay_save_node', { p_token: tk(), p_id: id, p_title: title, p_content: content }),
  finish: (id, result, title, content) => rpc('relay_finish_node', { p_token: tk(), p_id: id, p_result: result, p_title: title, p_content: content }),
  release: id => rpc('relay_release_node', { p_token: tk(), p_id: id }),
  users: () => rpc('relay_admin_list_users', { p_token: tk() }),
  updateUser: (name, patch) => rpc('relay_admin_update_user', { p_token: tk(), p_name: name, ...patch }),
  exportAll: () => rpc('relay_admin_export', { p_token: tk() }),
};

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

function confirmBox(title, text, okText, okClass = 'primary') {
  return new Promise(resolve => {
    const m = $('#modal');
    $('#modal-box').innerHTML = `<h3>${esc(title)}</h3><p>${text}</p>
      <div class="actions"><button class="btn" data-v="0">取消</button><button class="btn ${okClass}" data-v="1">${esc(okText)}</button></div>`;
    m.hidden = false;
    const done = v => { m.hidden = true; m.onclick = null; resolve(v); };
    m.onclick = e => { if (e.target === m) done(false); const b = e.target.closest('button[data-v]'); if (b) done(b.dataset.v === '1'); };
  });
}

function renderNav() {
  const n = $('#nav');
  let h = `<a href="#/">树</a>`;
  if (me) {
    if (me.admin) h += `<a href="#/admin">管理</a>`;
    h += `<span><span class="who">${esc(me.name)}</span> ${me.admin ? '<span class="tag">管理员</span>' : me.verified ? '<span class="tag ok">已认证</span>' : '<span class="tag warn">待认证</span>'}</span>`;
    h += `<a href="#/password">改密码</a><button class="linkbtn" id="logout">退出</button>`;
  } else {
    h += `<a href="#/login">登录</a><a href="#/register">注册</a>`;
  }
  n.innerHTML = h;
  const lo = $('#logout');
  if (lo) lo.onclick = async () => { try { await API.logout(); } catch {} tokenStore.set(null); me = null; renderNav(); route(); };
}

// ============ 路由 ============
let cleanup = null;
let leaveGuard = null;   // 返回 true 时允许离开
window.addEventListener('hashchange', () => route());
window.addEventListener('beforeunload', e => { if (leaveGuard && !leaveGuard()) { e.preventDefault(); e.returnValue = ''; } });

let lastHash = location.hash;
async function route() {
  if (leaveGuard && !leaveGuard()) {
    if (!confirm('有未保存的修改，确定离开吗？')) { history.replaceState(null, '', lastHash); return; }
  }
  leaveGuard = null;
  lastHash = location.hash;
  if (cleanup) { cleanup(); cleanup = null; }
  const h = location.hash.replace(/^#/, '') || '/';
  let m;
  try {
    if (h === '/') return await showTree();
    if ((m = /^\/node\/(\d+)$/.exec(h))) return await showNode(Number(m[1]));
    if ((m = /^\/read\/(\d+)$/.exec(h))) return await showChain(Number(m[1]));
    if (h === '/login' || h === '/register') return showAuth(h.slice(1));
    if (h === '/password') return showPassword();
    if (h === '/admin') return await showAdmin();
    location.hash = '#/';
  } catch (e) {
    view.innerHTML = `<div class="page"><p class="notice">${esc(e.message)}</p><a href="#/">← 回到树</a></div>`;
  }
}

// ============ 树 ============
const CARD_W = 148, CARD_H = 54, GHOST_R = 9, GAP = 18, LEVEL_H = 108;
const PAD_LEVELS = 3;   // 始终把前几层画成完整二叉树
let treeTransform = null; // 在页面间保留视角

function visibleTree(nodes) {
  const st = id => nodes[id]?.state || 'gray';
  // 节点 id 可见：非灰；或其父节点可见且不是红色、且（父非灰 或 在前几层）
  const vis = new Set();
  (function walk(id) {
    vis.add(id);
    const s = st(id);
    if (s === 'red') return;
    const d = depthOf(id);
    const childrenVisible = s !== 'gray' || d < PAD_LEVELS;
    if (!childrenVisible || d >= 29) return;
    for (const c of [2 * id, 2 * id + 1]) {
      // 灰色节点的灰色孩子只在前几层显示
      if (st(c) !== 'gray' || s !== 'gray' || d < PAD_LEVELS) walk(c);
    }
  })(1);
  return vis;
}

function layout(nodes, vis) {
  const pos = {};
  const st = id => nodes[id]?.state || 'gray';
  let cursor = 0;
  let maxDepth = 0;
  (function place(id) {
    const d = depthOf(id); maxDepth = Math.max(maxDepth, d);
    const kids = [2 * id, 2 * id + 1].filter(c => vis.has(c));
    const w = st(id) === 'gray' ? GHOST_R * 2 + 26 : CARD_W + GAP;
    if (!kids.length) { pos[id] = { x: cursor + w / 2, y: d * LEVEL_H }; cursor += w; return; }
    const start = cursor;
    kids.forEach(place);
    let x = kids.reduce((a, c) => a + pos[c].x, 0) / kids.length;
    // 若子树比自身窄，补齐宽度
    if (cursor - start < w) { const shift = (w - (cursor - start)) / 2; shiftTree(id, shift, pos, vis); x += shift; cursor = start + w; }
    pos[id] = { x, y: d * LEVEL_H };
  })(1);
  return { pos, width: cursor, maxDepth };
}
function shiftTree(id, dx, pos, vis) {
  for (const c of [2 * id, 2 * id + 1]) if (vis.has(c) && pos[c]) { pos[c].x += dx; shiftTree(c, dx, pos, vis); }
}

function truncate(s, n) { const a = [...s]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : s; }

async function showTree() {
  view.innerHTML = `<div class="tree-wrap" id="tw">
      <svg id="svg"><g id="vp"></g></svg>
      <div class="tree-hint" id="hint"></div>
      <div class="legend">
        <span><i style="background:#fff;border-style:dashed"></i>待认领（点击认领）</span>
        <span><i style="background:var(--yellow)"></i>写作中</span>
        <span><i style="background:var(--green)"></i>已完成 · 开放下一棒</span>
        <span><i style="background:var(--red)"></i>已终止 · 此支结束</span>
        <span><i style="background:var(--gray);border-radius:50%"></i>未开放</span>
      </div>
      <div class="tree-tools"><button class="btn" id="zin" title="放大">＋</button><button class="btn" id="zout" title="缩小">－</button><button class="btn" id="zfit" title="适应窗口">⤢</button></div>
    </div>`;
  const wrap = $('#tw'), svg = $('#svg'), vp = $('#vp');
  let data = { nodes: await API.tree() };
  let geo;

  function draw() {
    const nodes = data.nodes;
    const vis = visibleTree(nodes);
    geo = layout(nodes, vis);
    const { pos } = geo;
    const st = id => nodes[id]?.state || 'gray';
    let edges = '', cards = '', labels = '';
    for (let d = 0; d <= geo.maxDepth; d++) labels += `<text class="level-label" x="-70" y="${d * LEVEL_H + 4}">第 ${d + 1} 棒</text>`;
    for (const id of vis) {
      if (id > 1) {
        const p = pos[id >> 1], c = pos[id];
        const py = p.y + (st(id >> 1) === 'gray' ? GHOST_R : CARD_H / 2), cy = c.y - (st(id) === 'gray' ? GHOST_R : CARD_H / 2);
        const my = (py + cy) / 2;
        edges += `<path class="edge ${st(id) === 'gray' ? 'dim' : ''}" d="M${p.x},${py} C${p.x},${my} ${c.x},${my} ${c.x},${cy}"/>`;
      }
      const { x, y } = pos[id];
      const s = st(id), n = nodes[id] || {};
      if (s === 'gray') { cards += `<circle class="ghost" cx="${x}" cy="${y}" r="${GHOST_R}"><title>未开放</title></circle>`; continue; }
      const mine = me && n.owner === me.name;
      const openForMe = s === 'white' && me?.verified;
      const title = s === 'white' ? '待认领' : (n.title || '（无标题）');
      const sub = s === 'white' ? (openForMe ? '点击认领 →' : '空位') : '@' + n.owner;
      cards += `<g class="node ${s} ${mine ? 'mine' : ''} ${openForMe ? 'open-for-me' : ''}" data-id="${id}" transform="translate(${x - CARD_W / 2},${y - CARD_H / 2})">
        <title>${esc(STATE_NAME[s])}${n.title ? ' · ' + esc(n.title) : ''}${n.owner ? ' · @' + esc(n.owner) : ''}</title>
        <rect width="${CARD_W}" height="${CARD_H}" rx="10"/>
        <text class="t" x="12" y="23">${esc(truncate(title, 9))}</text>
        <text class="o" x="12" y="42">${esc(truncate(sub, 16))}</text>
      </g>`;
    }
    vp.innerHTML = labels + edges + cards;
    const open = Object.values(nodes).filter(n => n.state === 'white').length;
    const writing = Object.values(nodes).filter(n => n.state === 'yellow').length;
    $('#hint').textContent = `${open} 个空位待认领 · ${writing} 人正在写作` + (me ? (me.verified ? '' : ' · 你的账号等待管理员认证') : ' · 登录后可参与');
  }

  // ---- 平移 / 缩放 ----
  let t = treeTransform || null;
  const apply = () => { vp.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`); treeTransform = t; };
  function fit() {
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const bw = geo.width + 100, bh = (geo.maxDepth) * LEVEL_H + CARD_H + 60;
    const k = Math.min(1.2, Math.max(0.15, Math.min((W - 40) / bw, (H - 110) / bh)));
    t = { k, x: (W - geo.width * k) / 2 + 30 * k, y: 60 + CARD_H / 2 * k };
    // 太小看不清时，保持可读的缩放并以根节点居中（可拖动查看其余部分）
    if (k < 0.55) { const k2 = 0.55; t = { k: k2, x: W / 2 - geo.pos[1].x * k2, y: 60 + CARD_H / 2 * k2 }; }
    apply();
  }
  function zoomAt(f, cx, cy) {
    const k = Math.min(3, Math.max(0.1, t.k * f));
    t = { k, x: cx - (cx - t.x) * (k / t.k), y: cy - (cy - t.y) * (k / t.k) };
    apply();
  }
  draw();
  if (t) apply(); else fit();

  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  $('#zin').onclick = () => zoomAt(1.25, wrap.clientWidth / 2, wrap.clientHeight / 2);
  $('#zout').onclick = () => zoomAt(0.8, wrap.clientWidth / 2, wrap.clientHeight / 2);
  $('#zfit').onclick = fit;

  const pts = new Map(); let moved = 0, pinch = null;
  svg.addEventListener('pointerdown', e => {
    svg.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    wrap.classList.add('dragging');
  });
  svg.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 1) { t.x += dx; t.y += dy; moved += Math.abs(dx) + Math.abs(dy); apply(); }
    else if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = wrap.getBoundingClientRect();
      zoomAt(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); pinch = d; moved = 99;
    }
  });
  const up = e => {
    const wasClick = pts.size === 1 && moved < 6;
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    if (!pts.size) wrap.classList.remove('dragging');
    if (wasClick && e.type === 'pointerup') {
      const g = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
      if (g) location.hash = `#/node/${g.dataset.id}`;
    }
  };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
  const onResize = () => {}; window.addEventListener('resize', onResize);

  // 定时刷新
  const timer = setInterval(async () => {
    if (document.hidden) return;
    try { data = { nodes: await API.tree() }; draw(); } catch {}
  }, 15000);
  cleanup = () => { clearInterval(timer); window.removeEventListener('resize', onResize); };
}

// ============ 节点 ============
async function showNode(id) {
  const n = await API.node(id);
  const depth = depthOf(id) + 1;
  const isOwner = me && n.owner === me.name;
  const editable = isOwner && n.state === 'yellow';
  document.title = `${n.title || '第' + depth + '棒'} · 接龙之树`;

  let actions = '';
  let notice = '';
  if (n.state === 'white') {
    if (!me) notice = `这一棒还空着。<a href="#/login">登录</a>后即可认领。`;
    else if (!me.verified) notice = `这一棒还空着。你的账号需要管理员认证后才能认领。`;
    else actions += `<button class="btn primary" id="claim">认领这一棒</button>`;
  }
  if (n.state === 'yellow' && !isOwner) notice = `@${esc(n.owner)} 正在写这一棒，完成前内容可能还会变动。`;
  if (n.state === 'yellow' && me?.admin && !isOwner) actions += `<button class="btn red small" id="release">强制释放</button>`;
  if (n.state === 'green') notice = `这一棒已完成，下一棒已开放。`;
  if (n.state === 'red') notice = `此分支在这一棒终止。`;

  const crumbs = `<a href="#/">树</a> › 第 ${depth} 棒 <span style="color:#b0a796">#${id}</span>` +
    (n.parent ? ` · 接自 <a href="#/node/${n.parent.id}">${esc(n.parent.title || '第' + (depth - 1) + '棒')}</a>` : '');

  view.innerHTML = `<div class="page">
    <div class="crumbs">${crumbs}</div>
    <div class="node-head">
      <div>
        <span class="chip ${n.state}">${STATE_NAME[n.state]}</span>
        <h1 id="h-title">${editable ? '' : esc(n.title || (n.state === 'white' ? '待认领' : '（无标题）'))}</h1>
        <div class="meta">${n.owner ? `@${esc(n.owner)} · 认领于 ${fmtTime(n.claimedAt)}` : ''}${n.finishedAt ? ` · 完成于 ${fmtTime(n.finishedAt)}` : ''}</div>
      </div>
      <div class="actions">${actions}${id > 1 && n.state !== 'white' ? `<a class="btn" href="#/read/${id}">从头读到这里</a>` : ''}</div>
    </div>
    ${notice ? `<div class="notice">${notice}</div>` : ''}
    <div id="body"></div>
    <div id="kids"></div>
  </div>`;

  $('#claim') && ($('#claim').onclick = async () => {
    try { await API.claim(id); toast('认领成功，开始写吧'); route(); } catch (e) { toast(e.message); }
  });
  $('#release') && ($('#release').onclick = async () => {
    if (!await confirmBox('强制释放', `将撤销 @${esc(n.owner)} 的认领，并<b>清空</b>这一棒已写的内容，节点重新变为待认领。`, '释放', 'red')) return;
    try { await API.release(id); toast('已释放'); route(); } catch (e) { toast(e.message); }
  });

  if (editable) renderEditor(n);
  else if (n.state !== 'white') $('#body').innerHTML = `<article class="prose">${n.content.trim() ? renderMarkdown(n.content) : '<p class="empty">（还没有内容）</p>'}</article>`;

  if (n.state === 'green') {
    $('#kids').innerHTML = `<div class="kids"><h3>下一棒</h3><div class="kid-grid">${n.children.map((c, i) => `
      <a class="kid ${c.state}" href="#/node/${c.id}">
        <span class="chip ${c.state}">${STATE_NAME[c.state]}</span>
        <div style="margin-top:6px;font-family:var(--serif);font-weight:600">${esc(c.title || (c.state === 'white' ? `空位 ${i ? 'B' : 'A'}` : '（无标题）'))}</div>
        <small>${c.owner ? '@' + esc(c.owner) : '等待认领'}</small>
      </a>`).join('')}</div></div>`;
  }
}

function renderEditor(n) {
  const id = n.id;
  $('#h-title').outerHTML = `<input class="input title-input" id="title" maxlength="60" placeholder="给这一棒起个标题" value="${esc(n.title)}" style="margin:6px 0 8px;min-width:min(480px,80vw)">`;
  $('#body').innerHTML = `<div class="editor">
    <div class="tabs"><button class="btn small" id="t-edit">编辑</button><button class="btn small" id="t-prev">预览</button></div>
    <div class="split" id="split">
      <textarea id="content" placeholder="在这里用 Markdown 写这一棒……&#10;&#10;# 标题  **粗体**  *斜体*  > 引用  - 列表">${esc(n.content)}</textarea>
      <div class="preview"><div class="prose" id="preview"></div></div>
    </div>
    <div class="editor-foot">
      <span class="save-state" id="ss">已保存 ${fmtTime(n.updatedAt)}</span>
      <div class="actions"><button class="btn" id="giveup">放弃认领</button><button class="btn primary" id="save">保存（Ctrl+S）</button></div>
    </div>
    <div class="finish">
      <h3>写完了？</h3>
      <p>完成后这一棒将永久锁定，任何人都不能再修改。</p>
      <div class="actions">
        <button class="btn green" id="go-green">标绿 · 完成并开放下一棒（两个空位）</button>
        <button class="btn red" id="go-red">标红 · 此支到此为止</button>
      </div>
    </div>
  </div>`;
  const ta = $('#content'), ti = $('#title'), pv = $('#preview'), ss = $('#ss');
  let saved = { title: n.title, content: n.content };
  const dirty = () => ta.value !== saved.content || ti.value !== saved.title;
  const refresh = () => {
    pv.innerHTML = ta.value.trim() ? renderMarkdown(ta.value) : '<p class="empty">预览</p>';
    ss.className = 'save-state' + (dirty() ? ' dirty' : '');
    if (dirty()) ss.textContent = '有未保存的修改';
  };
  refresh();

  let timer = null, saving = false;
  async function save(quiet) {
    if (saving || !dirty()) return true;
    saving = true;
    const body = { title: ti.value, content: ta.value };
    try {
      const r = await API.save(id, body.title, body.content);
      saved = body; ss.textContent = '已保存 ' + fmtTime(r.updatedAt); refresh();
      if (!quiet) toast('已保存');
      return true;
    } catch (e) { toast('保存失败：' + e.message); return false; }
    finally { saving = false; }
  }
  const onInput = () => { refresh(); clearTimeout(timer); timer = setTimeout(() => save(true), 2500); };
  ta.addEventListener('input', onInput); ti.addEventListener('input', onInput);
  const onKey = e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } };
  document.addEventListener('keydown', onKey);
  $('#save').onclick = () => save();
  $('#t-edit').onclick = () => $('#split').classList.remove('show-preview');
  $('#t-prev').onclick = () => $('#split').classList.add('show-preview');

  leaveGuard = () => !dirty();
  cleanup = () => { clearTimeout(timer); document.removeEventListener('keydown', onKey); };

  $('#giveup').onclick = async () => {
    if (!await confirmBox('放弃认领', '这一棒会变回<b>待认领</b>，你写的内容将被<b>清空</b>，其他人可以认领。', '放弃', 'red')) return;
    try { await API.release(id); saved ={ title: ti.value, content: ta.value }; toast('已放弃认领'); route(); } catch (e) { toast(e.message); }
  };
  const finish = async result => {
    const g = result === 'green';
    if (!ta.value.trim() && g && !await confirmBox('正文为空', '这一棒还没有内容，确定要以空白完成吗？', '仍然继续')) return;
    const ok = await confirmBox(g ? '完成这一棒' : '终止此分支',
      g ? '这一棒将<b>永久锁定</b>，并在其下开放<b>两个</b>新的空位供他人接续。此操作不可撤销。'
        : '这一棒将<b>永久锁定</b>，此分支<b>不再有后续</b>。此操作不可撤销。',
      g ? '标绿完成' : '标红终止', g ? 'green' : 'red');
    if (!ok) return;
    try {
      await API.finish(id, result, ti.value, ta.value);
      saved = { title: ti.value, content: ta.value };
      toast(g ? '已完成，下一棒已开放' : '此分支已终止');
      route();
    } catch (e) { toast(e.message); }
  };
  $('#go-green').onclick = () => finish('green');
  $('#go-red').onclick = () => finish('red');
}

// ============ 连读 ============
async function showChain(id) {
  const chain = await API.chain(id);
  view.innerHTML = `<div class="page">
    <div class="crumbs"><a href="#/">树</a> › <a href="#/node/${id}">返回第 ${depthOf(id) + 1} 棒</a> › 从头连读</div>
    ${chain.map((c, i) => `<section class="chain-part">
      <h2><a href="#/node/${c.id}" style="color:inherit;text-decoration:none">第 ${i + 1} 棒 · ${esc(c.title || '（无标题）')}</a></h2>
      <div class="meta">${c.owner ? '@' + esc(c.owner) : ''} <span class="chip ${c.state}" style="margin-left:6px">${STATE_NAME[c.state]}</span></div>
      <div class="prose">${c.content.trim() ? renderMarkdown(c.content) : '<p class="empty">（空）</p>'}</div>
    </section>${i < chain.length - 1 ? '<hr style="border:0;border-top:1px solid var(--line);margin:0 0 30px">' : ''}`).join('')}
  </div>`;
}

// ============ 登录 / 注册 / 改密码 ============
function showAuth(mode) {
  if (me) { location.hash = '#/'; return; }
  const reg = mode === 'register';
  view.innerHTML = `<div class="auth">
    <h1>${reg ? '注册' : '登录'}</h1>
    <form id="f">
      <input class="input" name="username" placeholder="用户名" autocomplete="username" required>
      <input class="input" name="password" type="password" placeholder="密码${reg ? '（至少 6 位）' : ''}" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
      ${reg ? '<input class="input" name="password2" type="password" placeholder="再输一次密码" autocomplete="new-password" required>' : ''}
      <button class="btn primary">${reg ? '注册' : '登录'}</button>
    </form>
    <div class="switch">${reg ? '已有账号？<a href="#/login">登录</a>' : '还没有账号？<a href="#/register">注册</a>'}</div>
    ${reg ? '<p class="notice" style="font-size:14px">注册后需由管理员认证，认证通过即可认领空位参与接龙。未认证时可以浏览全部内容。</p>' : ''}
  </div>`;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (reg && f.password !== f.password2) return toast('两次输入的密码不一致');
    try {
      const r = await (reg ? API.register : API.login)(f.username, f.password);
      tokenStore.set(r.token); me = r.user; renderNav();
      toast(reg ? '注册成功，等待管理员认证' : `欢迎回来，${me.name}`);
      location.hash = '#/';
    } catch (err) { toast(err.message); }
  };
}

function showPassword() {
  if (!me) { location.hash = '#/login'; return; }
  view.innerHTML = `<div class="auth"><h1>修改密码</h1><form id="f">
    <input class="input" name="old" type="password" placeholder="原密码" autocomplete="current-password" required>
    <input class="input" name="password" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" required>
    <button class="btn primary">保存</button></form></div>`;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await API.password(f.old, f.password); toast('密码已修改'); location.hash = '#/'; }
    catch (err) { toast(err.message); }
  };
}

// ============ 管理 ============
async function showAdmin() {
  if (!me?.admin) { location.hash = '#/'; return; }
  const users = await API.users();
  users.sort((a, b) => (b.admin - a.admin) || (a.verified - b.verified) || (b.createdAt - a.createdAt));
  const pending = users.filter(u => !u.verified).length;
  view.innerHTML = `<div class="page">
    <div class="node-head"><div><h1 style="font-family:var(--serif);margin:0 0 4px">账号管理</h1>
      <div class="meta">${users.length} 个账号 · ${pending} 个待认证</div></div>
      <div class="actions"><button class="btn" id="export">导出全部内容（JSON）</button></div></div>
    <table style="margin-top:20px"><thead><tr><th>用户名</th><th>注册时间</th><th>认领数</th><th>状态</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr>
      <td><b>${esc(u.name)}</b></td><td class="meta">${fmtTime(u.createdAt)}</td><td>${u.claims}</td>
      <td>${u.admin ? '<span class="tag">管理员</span>' : u.verified ? '<span class="tag ok">已认证</span>' : '<span class="tag warn">待认证</span>'}</td>
      <td style="text-align:right">${u.admin ? '' : `
        <button class="btn small ${u.verified ? '' : 'primary'}" data-verify="${esc(u.name)}" data-v="${!u.verified}">${u.verified ? '取消认证' : '认证'}</button>
        <button class="btn small" data-reset="${esc(u.name)}">重置密码</button>`}</td>
    </tr>`).join('')}
    </tbody></table>
    <p class="notice" style="font-size:14px">取消认证不会影响该用户已认领的节点，只是不能再认领新的空位。若需收回某个写作中的节点，进入该节点点“强制释放”。</p>
  </div>`;
  view.onclick = async e => {
    const v = e.target.closest('[data-verify]'), r = e.target.closest('[data-reset]'), x = e.target.closest('#export');
    try {
      if (v) { await API.updateUser(v.dataset.verify, { p_verified: v.dataset.v === 'true' }); toast('已更新'); route(); }
      if (r) {
        const pw = prompt(`为 ${r.dataset.reset} 设置新密码（至少 6 位）：`);
        if (pw) { await API.updateUser(r.dataset.reset, { p_password: pw }); toast('密码已重置'); }
      }
      if (x) {
        const data = await API.exportAll();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        a.download = `relay-tree-export-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
    } catch (err) { toast(err.message); }
  };
  cleanup = () => { view.onclick = null; };
}

// ============ 启动 ============
(async () => {
  if (!CONFIGURED) {
    renderNav();
    view.innerHTML = `<div class="page"><h1 style="font-family:var(--serif)">还差一步：连接数据库</h1>
      <p class="notice">网站已经部署成功，但还没有填写 Supabase 配置。<br>
      请编辑仓库里的 <code>site/config.js</code>，或在 GitHub 仓库的 Settings → Secrets and variables → Actions → Variables
      中添加 <code>SUPABASE_URL</code> 和 <code>SUPABASE_KEY</code>，然后重新部署。详见仓库 README。</p></div>`;
    return;
  }
  try { me = await API.me(); } catch { me = null; }
  renderNav();
  route();
})();