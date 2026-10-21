/* 生词本页：把 /api/marks 的结果按「学习中 / 已掌握」两摞渲染，
   每摞内按日期倒序分组，一天一段，段与段之间是一条 2px 长横线。
   另有一个「网状」视图：同一天收藏的词连成一张网，点词弹出完整词条。 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = { marks: [], view: 'list', hasKey: false };

const toastEl = $('#toast');
let toastTimer = 0;
function toast(text, isError) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.toggle('error', !!isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2600);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------- 日期 ---------- */
const pad = (n) => String(n).padStart(2, '0');

/** ISO 时间串 → 本地 yyyy-mm-dd（按本地时区切，不直接用 toISOString，它是 UTC） */
function dayKey(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = dayKey(new Date().toISOString());
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  let tag = '';
  if (key === today) tag = '<i class="day-tag">今天</i>';
  else if (key === dayKey(yest.toISOString())) tag = '<i class="day-tag">昨天</i>';
  return `${y} 年 ${m} 月 ${d} 日 <span class="day-week">${WEEK[date.getDay()]}</span>${tag}`;
}

/** 按天分组：同一天内按时间倒序，天与天之间按日期倒序 */
function groupByDay(list, timeOf) {
  const buckets = new Map();
  for (const item of list) {
    const key = dayKey(timeOf(item));
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, items]) => ({
      key,
      items: items.sort((a, b) => String(timeOf(b)).localeCompare(String(timeOf(a)))),
    }));
}

/* ---------- 词条字段 ---------- */
/** 例句：新模式给 examples 数组，老数据只有一条 example */
const examplesOf = (m) => {
  const list = Array.isArray(m.examples) ? m.examples.filter(Boolean) : [];
  return list.length ? list : m.example ? [m.example] : [];
};

/** 音标、释义、记忆法、例句缺一不可，缺了就可以让模型补 */
const isThin = (m) => !m.phonetic || !m.cn || !m.mnemonic || !examplesOf(m).length;

/* ---------- 列表渲染 ---------- */
function rowHTML(m, mastered, groupKey) {
  const ex = examplesOf(m);
  const extras = [
    m.examSense ? `<p class="row-extra"><i>考研常考</i>${esc(m.examSense)}</p>` : '',
    m.collocation ? `<p class="row-extra"><i>搭配</i>${esc(m.collocation)}</p>` : '',
    m.mnemonic ? `<p class="row-memo"><i>记忆法</i>${esc(m.mnemonic)}</p>` : '',
    ex.length ? `<ul class="row-ex" aria-label="例句">${ex.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '',
    m.note ? `<p class="row-note">${esc(m.note)}</p>` : '',
    // 和分组日期同一天就不必再说一遍「来自哪天那篇」
    m.articleDate && m.articleDate !== groupKey
      ? `<p class="row-from">来自 ${esc(m.articleDate)} 那篇</p>`
      : '',
  ].join('');

  return `<li class="mark-row${mastered ? ' is-mastered' : ''}" data-word="${esc(m.word)}">
    <div class="row-main">
      <div class="row-top">
        <span class="w">${esc(m.word)}</span>
        ${m.phonetic ? `<span class="ph">${esc(m.phonetic)}</span>` : ''}
        ${m.pos ? `<span class="pos">${esc(m.pos)}</span>` : ''}
      </div>
      ${m.cn ? `<p class="row-cn">${esc(m.cn)}</p>` : ''}
      ${extras}
    </div>
    <div class="row-actions">
      <button class="btn tiny" type="button" data-act="say" title="朗读">朗读</button>
      <button class="btn tiny" type="button" data-act="master" data-next="${mastered ? '0' : '1'}">${mastered ? '退回学习' : '已掌握'}</button>
      <button class="btn tiny danger" type="button" data-act="remove" title="从生词本删掉">删除</button>
    </div>
  </li>`;
}

function groupsHTML(groups, mastered) {
  return groups
    .map(
      (g) => `<section class="day-group">
        <div class="day-head">
          <h4>${dayLabel(g.key)}</h4>
          <span class="day-count">${g.items.length} 个</span>
        </div>
        <div class="day-rule" aria-hidden="true"></div>
        <ul class="mark-rows">${g.items.map((m) => rowHTML(m, mastered, g.key)).join('')}</ul>
      </section>`
    )
    .join('');
}

/* ---------- 网状视图：一张词一张卡片，三列排开（和剪藏台的卡片墙一个路数） ---------- */
const ACCENTS = ['blue', 'red', 'yellow'];

function examplesShort(m) {
  return examplesOf(m)[0] || '';
}

function tileHTML(m, index, mastered) {
  const accent = ACCENTS[index % ACCENTS.length];
  return `<article class="word-tile" data-word="${esc(m.word)}" data-accent="${accent}" tabindex="0" role="button" aria-label="${esc(m.word)} 词条">
    <header class="tile-spine">
      <span class="tile-no">NO. ${String(index + 1).padStart(2, '0')}</span>
      <span class="tile-acts">
        <button class="tile-act" type="button" data-act="say">朗读</button>
        <button class="tile-act" type="button" data-act="master" data-next="${mastered ? '0' : '1'}">${mastered ? '退回学习' : '已掌握'}</button>
        <button class="tile-act" type="button" data-act="remove">删除</button>
      </span>
    </header>
    <div class="tile-body">
      <p class="tile-overline"><span class="ipa">${esc(m.phonetic || '—')}</span>${m.pos ? `<span class="tile-pos">${esc(m.pos)}</span>` : ''}</p>
      <h4 class="tile-word">${esc(m.word)}</h4>
      <p class="tile-desc">${esc(m.cn || '还没有释义')}</p>
      <p class="tile-memo">${m.mnemonic ? `<i>记忆法</i>${esc(m.mnemonic)}` : '<i>记忆法</i>—'}</p>
      <p class="tile-ex">${esc(examplesShort(m) || '还没有例句')}</p>
    </div>
  </article>`;
}
/** 卡片墙也按天分堆：一天一段，段头样式和列表共用 */
function tilesHTML(items, mastered) {
  const groups = groupByDay(items, (m) => m.addedAt);
  return groups
    .map(
      (g) => `<section class="day-group tile-day">
        <div class="day-head">
          <h4>${dayLabel(g.key)}</h4>
          <span class="day-count">${g.items.length} 个</span>
        </div>
        <div class="day-rule" aria-hidden="true"></div>
        <div class="word-grid">${g.items.map((m, i) => tileHTML(m, i, mastered)).join('')}</div>
      </section>`
    )
    .join('');
}

/* 视图选择记在本地：下次打开（或刷新）还停在上次那个看法 */
const VIEW_KEY = 'daily-reading:marks-view';
function savedView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'graph' ? 'graph' : 'list';
  } catch {
    return 'list';
  }
}

function applyView(view, persist = true) {
  state.view = view === 'graph' ? 'graph' : 'list';
  document.body.dataset.view = state.view;
  $$('.view-switch button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  });
  if (persist) {
    try {
      localStorage.setItem(VIEW_KEY, state.view);
    } catch {
      /* 隐私模式写不进去也不影响当前页面 */
    }
  }
  render();
}
/* ---------- 词条卡片：网状视图里点一个词，右侧弹出完整词条 ---------- */
function cardHTML(m) {
  const ex = examplesOf(m);
  const missing = !m.mnemonic || !ex.length;
  return `<p class="card-eyebrow">Word / 词条</p>
    <h3 class="card-word">${esc(m.word)}</h3>
    <p class="card-top">
      ${m.phonetic ? `<span class="ph">${esc(m.phonetic)}</span>` : '<span class="ph">— 缺音标</span>'}
      ${m.pos ? `<span class="pos">${esc(m.pos)}</span>` : ''}
    </p>
    <p class="card-cn">${m.cn ? esc(m.cn) : '— 缺释义'}</p>
    ${m.examSense ? `<p class="row-extra"><i>考研常考</i>${esc(m.examSense)}</p>` : ''}
    ${m.collocation ? `<p class="row-extra"><i>搭配</i>${esc(m.collocation)}</p>` : ''}
    <div class="card-block">
      <p class="card-label">记忆法</p>
      <p class="card-memo">${m.mnemonic ? esc(m.mnemonic) : '还没有记忆法。'}</p>
    </div>
    <div class="card-block">
      <p class="card-label">例句</p>
      ${ex.length ? `<ul class="card-ex">${ex.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p class="card-memo">还没有例句。</p>'}
    </div>
    ${m.note ? `<p class="row-note">${esc(m.note)}</p>` : ''}
    <div class="card-actions">
      <button class="btn tiny" type="button" data-act="say">朗读</button>
      ${missing ? '<button class="btn tiny" type="button" data-act="enrich">补全这个词</button>' : ''}
      <button class="btn tiny" type="button" data-act="master" data-next="${m.mastered ? '0' : '1'}">${m.mastered ? '退回学习' : '已掌握'}</button>
      <button class="btn tiny danger" type="button" data-act="remove">删除</button>
    </div>`;
}

/** 词条卡片贴在按下那张卡片的旁边：右边放不下就翻到左边，纵向夹在视口里 */
function placeCardNearCard(card, word) {
  card.classList.remove('is-sheet');
  card.style.left = '';
  card.style.top = '';
  card.style.right = '24px';
  const tile = Array.from(document.querySelectorAll('.word-tile')).find((t) => t.dataset.word === word);
  if (!tile) return;
  if (window.innerWidth < 720) {
    // 窄屏三列只有一百多像素，卡片挤在旁边看不清，改成从底部升起来的一张纸
    card.classList.add('is-sheet');
    return;
  }
  const box = tile.getBoundingClientRect();
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const gap = 14;
  const margin = 16;
  let left = box.right + gap;
  if (left + width > window.innerWidth - margin) left = box.left - width - gap;
  if (left < margin) left = Math.max(margin, window.innerWidth - width - margin);
  let top = box.top - 8;
  top = Math.min(top, window.innerHeight - height - margin);
  top = Math.max(margin, top);
  card.style.right = 'auto';
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function openCard(word) {
  const m = state.marks.find((x) => x.word === word);
  const card = $('#wordCard');
  if (!m || !card) return;
  card.dataset.word = word;
  $('#wordCardBody').innerHTML = cardHTML(m);
  card.hidden = false;
  placeCardNearCard(card, word);
}

function closeCard() {
  const card = $('#wordCard');
  if (card) {
    card.hidden = true;
    card.classList.remove('is-sheet');
    card.style.left = '';
    card.style.top = '';
    card.style.right = '';
  }
}

/* ---------- 补全音标、释义、记忆法、例句（模型补一次，写回 marks.json） ---------- */
function updateEnrichBar() {
  const status = $('#enrichStatus');
  const btn = $('#btnEnrich');
  if (!status || !btn) return;
  const thin = state.marks.filter(isThin).length;
  btn.hidden = true;
  if (!state.marks.length) {
    status.textContent = '';
    return;
  }
  if (!thin) {
    status.textContent = '音标 · 释义 · 记忆法 · 例句 都齐了';
    return;
  }
  if (!state.hasKey) {
    status.textContent = `还有 ${thin} 个词缺音标 / 释义 / 记忆法 / 例句：先去「设置」填 API Key，再用模型补全。`;
    return;
  }
  status.textContent = `还有 ${thin} 个词缺音标 / 释义 / 记忆法 / 例句`;
  btn.hidden = false;
}

async function enrichBatch(limit) {
  const res = await fetch('/api/marks/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  state.marks = body.marks || state.marks;
  render();
  return body;
}

async function enrichAll() {
  const status = $('#enrichStatus');
  const btn = $('#btnEnrich');
  if (btn) btn.disabled = true;
  try {
    let thin = state.marks.filter(isThin).length;
    let guard = 0;
    while (thin > 0 && guard < 40) {
      guard += 1;
      if (status) status.textContent = `正在补全……还剩 ${thin} 个`;
      const body = await enrichBatch(3);
      if (body.needKey) {
        if (status) status.textContent = '配置 API Key 后才能补全音标与例句';
        return;
      }
      if (!body.enriched) break;
      thin = body.remaining == null ? state.marks.filter(isThin).length : body.remaining;
    }
  } catch (err) {
    if (status) status.textContent = '补全失败：' + (err.message || err);
  } finally {
    if (btn) btn.disabled = false;
    updateEnrichBar();
  }
}

/* ---------- 总渲染 ---------- */
function render() {
  const learning = state.marks.filter((m) => !m.mastered);
  const mastered = state.marks.filter((m) => m.mastered);

  const learningGroups = groupByDay(learning, (m) => m.addedAt);
  const masteredGroups = groupByDay(mastered, (m) => m.masteredAt || m.addedAt);

  $('#learningList').innerHTML = groupsHTML(learningGroups, false);
  $('#masteredList').innerHTML = groupsHTML(masteredGroups, true);

  const text = (sel, v) => {
    const el = $(sel);
    if (el) el.textContent = v;
  };
  text('#statLearning', learning.length);
  text('#statMastered', mastered.length);
  // 收藏天数按「收藏日期」算，已掌握的词也算它当初被收藏的那天
  text('#statDays', new Set(state.marks.map((m) => dayKey(m.addedAt)).filter(Boolean)).size);
  text('#countLearning', learning.length);
  text('#countMastered', mastered.length);
  text('#subCountLearning', learning.length);
  text('#subCountMastered', mastered.length);
  text('#navCount', learning.length);

  $('#learningGrid').innerHTML = tilesHTML(learning, false);
  $('#masteredGrid').innerHTML = tilesHTML(mastered, true);

  const grid = state.view === 'graph';
  $('#learningEmpty').hidden = learning.length > 0;
  $('#masteredEmpty').hidden = mastered.length > 0;
  // 有内容时列表自己撑开，空态文案不要和分组叠在一起；网状视图下列表整个让位给卡片墙
  $('#learningList').hidden = learning.length === 0 || grid;
  $('#masteredList').hidden = mastered.length === 0 || grid;
  $('#learningGrid').hidden = !grid || learning.length === 0;
  $('#masteredGrid').hidden = !grid || mastered.length === 0;

  updateEnrichBar();
}

/* ---------- 交互 ---------- */
function speak(word) {
  if (!window.speechSynthesis) return toast('当前浏览器不支持朗读', true);
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  u.rate = 0.92;
  window.speechSynthesis.speak(u);
}

async function setMastered(word, next) {
  const res = await fetch('/api/marks/mastered', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word, mastered: next }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  state.marks = body.marks || state.marks;
  render();
}

async function removeMark(word) {
  const res = await fetch(`/api/marks?word=${encodeURIComponent(word)}`, { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  state.marks = body.marks || state.marks;
  render();
}

document.addEventListener('click', async (e) => {
  const viewBtn = e.target.closest('.view-switch [data-view]');
  if (viewBtn) return applyView(viewBtn.dataset.view);

  if (e.target.closest('#wordCardClose')) return closeCard();

  // 卡片色带上的按钮先接住，不然会被整卡点击抢去开词条
  const btn = e.target.closest('[data-act]');
  if (!btn) {
    const tile = e.target.closest('.word-tile');
    if (tile) {
      // 再点同一张卡就收起词条，不用去够右上角的 ×
      const open = !$('#wordCard').hidden && $('#wordCard').dataset.word === tile.dataset.word;
      return open ? closeCard() : openCard(tile.dataset.word);
    }
    // 点网格本身（卡片之间的空白）也收起词条
    if (e.target.closest('.word-grid')) return closeCard();
    return;
  }
  const row = btn.closest('[data-word]');
  if (!row) return;
  const word = row.dataset.word;
  const cardOpen = !$('#wordCard').hidden && $('#wordCard').dataset.word === word;

  try {
    if (btn.dataset.act === 'say') return speak(word);
    if (btn.dataset.act === 'enrich') {
      toast(`正在补全「${word}」……`);
      const body = await enrichBatch(1);
      if (body.needKey) return toast('配置 API Key 后才能补全', true);
      openCard(word);
      return toast(`「${word}」补全好了`);
    }
    if (btn.dataset.act === 'master') {
      const next = btn.dataset.next === '1';
      await setMastered(word, next);
      // 置为已掌握（或退回学习）后这个词就换了一摞，词条卡片跟着收起，别让旧卡片留在屏幕上
      if (cardOpen) closeCard();
      return toast(next ? `「${word}」挪到已掌握` : `「${word}」回到学习中`);
    }
    if (btn.dataset.act === 'remove') {
      await removeMark(word);
      closeCard();
      return toast(`已从生词本删掉「${word}」`);
    }
  } catch (err) {
    toast(err.message || String(err), true);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCard();
  // 卡片可以 Tab 到，回车 / 空格打开（鼠标点走上面的 click）
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('word-tile')) {
    e.preventDefault();
    const word = e.target.dataset.word;
    const open = !$('#wordCard').hidden && $('#wordCard').dataset.word === word;
    if (open) closeCard(); else openCard(word);
  }
});

/* 窗口变了重新贴一次，别让卡片飘在奇怪的地方 */
window.addEventListener('resize', () => {
  const card = $('#wordCard');
  if (card && !card.hidden && card.dataset.word) placeCardNearCard(card, card.dataset.word);
});

/* ---------- 分区小导航（学习中 / 已掌握） ---------- */function syncSubNav() {
  const links = document.querySelectorAll('.sub-nav [data-jump]');
  if (!links.length) return;
  const header = document.querySelector('.site-header');
  const sub = document.querySelector('.sub-nav');
  const line =
    (header ? header.getBoundingClientRect().height : 0) +
    (sub ? sub.getBoundingClientRect().height : 0) +
    24;
  let active = '';
  document.querySelectorAll('.sub-nav [data-jump]').forEach((a) => {
    const section = document.getElementById(a.dataset.jump);
    if (section && section.getBoundingClientRect().top <= line) active = a.dataset.jump;
  });
  const doc = document.documentElement;
  if (window.scrollY + window.innerHeight >= doc.scrollHeight - 12) {
    const all = document.querySelectorAll('.sub-nav [data-jump]');
    if (all.length) active = all[all.length - 1].dataset.jump;
  }
  // 停在页顶时两块都还没越线，默认点亮第一块
  if (!active) active = links[0].dataset.jump;
  links.forEach((a) => {
    if (a.dataset.jump === active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/** 跳到某个分区：顶栏 + 分区导航条的实测高度之下再留 10px，不用 scrollIntoView（它会把 scroll-padding 和 scroll-margin 叠起来） */
function jumpToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const header = document.querySelector('.site-header');
  const sub = document.querySelector('.sub-nav');
  const offset = (header ? header.offsetHeight : 0) + (sub ? sub.offsetHeight : 0) + 10;
  const top = window.scrollY + el.getBoundingClientRect().top - offset;
  window.scrollTo({ top: Math.max(0, Math.round(top)), behavior: 'smooth' });
}

document.querySelector('.sub-nav')?.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-jump]');
  if (!a) return;
  e.preventDefault();
  jumpToSection(a.dataset.jump);
});

let subTicking = false;
window.addEventListener(
  'scroll',
  () => {
    if (subTicking) return;
    subTicking = true;
    requestAnimationFrame(() => {
      subTicking = false;
      syncSubNav();
    });
  },
  { passive: true }
);
window.addEventListener('resize', syncSubNav);

/* ---------- 启动 ---------- */
async function boot() {
  try {
    const [marksRes, stateRes] = await Promise.all([
      fetch('/api/marks'),
      fetch('/api/state').catch(() => null),
    ]);
    const body = await marksRes.json();
    state.marks = body.marks || [];
    if (stateRes && stateRes.ok) {
      const cfg = await stateRes.json().catch(() => ({}));
      state.hasKey = Boolean(cfg && cfg.config && cfg.config.deepseek && cfg.config.deepseek.hasKey);
    }
  } catch (err) {
    toast('读取生词本失败：' + (err.message || err), true);
    state.marks = [];
  }
  $('#btnEnrich')?.addEventListener('click', enrichAll);
  applyView(savedView(), false);
  syncSubNav();
}

boot();
