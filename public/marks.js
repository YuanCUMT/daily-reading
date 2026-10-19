/* 生词本页：把 /api/marks 的结果按「学习中 / 已掌握」两摞渲染，
   每摞内按日期倒序分组，一天一段，段与段之间是一条 2px 长横线。 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = { marks: [] };

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

/* ---------- 渲染 ---------- */
function rowHTML(m, mastered, groupKey) {
  const extras = [
    m.examSense ? `<p class="row-extra"><i>考研常考</i>${esc(m.examSense)}</p>` : '',
    m.collocation ? `<p class="row-extra"><i>搭配</i>${esc(m.collocation)}</p>` : '',
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
  text('#navCount', learning.length);

  $('#learningEmpty').hidden = learning.length > 0;
  $('#masteredEmpty').hidden = mastered.length > 0;
  // 有内容时列表自己撑开，空态文案不要和分组叠在一起
  $('#learningList').hidden = learning.length === 0;
  $('#masteredList').hidden = mastered.length === 0;
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
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = btn.closest('.mark-row');
  if (!row) return;
  const word = row.dataset.word;

  try {
    if (btn.dataset.act === 'say') return speak(word);
    if (btn.dataset.act === 'master') {
      const next = btn.dataset.next === '1';
      await setMastered(word, next);
      return toast(next ? `「${word}」挪到已掌握` : `「${word}」回到学习中`);
    }
    if (btn.dataset.act === 'remove') {
      await removeMark(word);
      return toast(`已从生词本删掉「${word}」`);
    }
  } catch (err) {
    toast(err.message || String(err), true);
  }
});

/* ---------- 启动 ---------- */
async function boot() {
  try {
    const res = await fetch('/api/marks');
    const body = await res.json();
    state.marks = body.marks || [];
  } catch (err) {
    toast('读取生词本失败：' + (err.message || err), true);
    state.marks = [];
  }
  render();
}

boot();
