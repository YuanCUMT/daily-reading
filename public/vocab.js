/* 单词本页（完整页面，不再是弹窗）
   三个列表：每日单词（按天导入的全部词）/ 我的生词（收藏，分学习中·已掌握）/ 短语。 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  tab: 'daily',
  sort: 'time-desc',
  query: '',
  days: [],
  total: 0,
  missing: 0,
  marks: [],
  filling: false,
};

/* ---------------- 基础工具 ---------------- */
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

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const pad = (n) => String(n).padStart(2, '0');
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

/** 生词本里的条目标记成短语：带空格，或者词性是 phr. */
const isPhraseMark = (m) => /\s/.test(String(m.word || '')) || String(m.pos || '').toLowerCase() === 'phr.';

const byAlpha = (a, b) => a.word.localeCompare(b.word, 'en', { sensitivity: 'base' });
const byTimeAsc = (a, b) => String(a.time).localeCompare(String(b.time)) || byAlpha(a, b);
const byTimeDesc = (a, b) => String(b.time).localeCompare(String(a.time)) || byAlpha(a, b);

/* ---------------- 数据 → 列表项 ---------------- */
function markToItem(m) {
  return {
    word: m.word,
    phonetic: m.phonetic || '',
    pos: m.pos || '',
    meaning: m.cn || '',
    collocation: m.collocation || '',
    examSense: m.examSense || '',
    note: m.note || '',
    time: m.addedAt || m.articleDate || '',
    date: String(m.addedAt || '').slice(0, 10) || m.articleDate || '',
    mastered: Boolean(m.mastered),
    masteredAt: m.masteredAt || '',
    articleDate: m.articleDate || '',
    removable: true,
  };
}

function dailyItems() {
  const out = [];
  for (const day of state.days || []) {
    for (const w of day.words || []) {
      out.push({
        word: w.word,
        phonetic: w.phonetic || '',
        pos: w.pos || '',
        meaning: w.meaning || '',
        time: day.date,
        date: day.date,
        removable: false,
      });
    }
  }
  return out;
}

function currentItems() {
  if (state.tab === 'daily') return dailyItems();
  const wantPhrase = state.tab === 'phrases';
  return state.marks.filter((m) => isPhraseMark(m) === wantPhrase).map(markToItem);
}

function filterAndSort(list) {
  const q = state.query.trim().toLowerCase();
  const filtered = q
    ? list.filter((it) => it.word.toLowerCase().includes(q) || it.meaning.toLowerCase().includes(q))
    : list;
  if (state.sort === 'alpha') return filtered.slice().sort(byAlpha);
  if (state.sort === 'alpha-desc') return filtered.slice().sort((a, b) => byAlpha(b, a));
  if (state.sort === 'time-asc') return filtered.slice().sort(byTimeAsc);
  return filtered.slice().sort(byTimeDesc);
}

/* ---------------- 渲染：卡片（每日单词 / 短语） ---------------- */
function vocabCard(it, showDate) {
  const subs = [
    it.collocation ? `<div class="sub"><i>搭配</i>${esc(it.collocation)}</div>` : '',
    it.examSense ? `<div class="sub"><i>考研常考</i>${esc(it.examSense)}</div>` : '',
    it.note ? `<div class="sub"><i>注释</i>${esc(it.note)}</div>` : '',
  ].join('');
  return `<div class="vcard" data-word="${esc(it.word)}">
    <div class="top">
      <span class="w">${esc(it.word)}</span>
      ${it.phonetic ? `<span class="ph">${esc(it.phonetic)}</span>` : ''}
      ${it.pos ? `<span class="pos">${esc(it.pos)}</span>` : ''}
    </div>
    ${it.meaning ? `<div class="m">${esc(it.meaning)}</div>` : ''}
    ${subs}
    ${showDate && it.date ? `<div class="foot">${it.removable ? '收于 ' : ''}${esc(it.date)}</div>` : ''}
    ${it.removable ? `<span class="rm" data-vrm="${esc(it.word)}" title="移出生词本">✕</span>` : ''}
  </div>`;
}

function renderCards(items) {
  const grouped = state.sort.startsWith('time-');
  if (!grouped) return `<div class="vocab-grid">${items.map((it) => vocabCard(it, true)).join('')}</div>`;

  const perDay = new Map();
  for (const it of items) perDay.set(it.date, (perDay.get(it.date) || 0) + 1);
  let html = '<div class="vocab-grid">';
  let last = null;
  for (const it of items) {
    if (it.date !== last) {
      last = it.date;
      html += `<div class="vgroup"><b>${esc(it.date)}</b><span>${perDay.get(it.date)} 个</span>${
        state.tab === 'daily'
          ? `<button class="mini-btn vgroup-clear" data-clear-day="${esc(it.date)}" title="删掉这一天的单词">清空这天</button>`
          : ''
      }</div>`;
    }
    html += vocabCard(it, false);
  }
  return html + '</div>';
}

/* ---------------- 渲染：行（我的生词，带朗读/已掌握/删除） ---------------- */
function rowHTML(m, mastered) {
  const extras = [
    m.examSense ? `<p class="row-extra"><i>考研常考</i>${esc(m.examSense)}</p>` : '',
    m.collocation ? `<p class="row-extra"><i>搭配</i>${esc(m.collocation)}</p>` : '',
    m.note ? `<p class="row-note">${esc(m.note)}</p>` : '',
    m.articleDate && m.articleDate !== m.date ? `<p class="row-from">来自 ${esc(m.articleDate)} 那篇</p>` : '',
  ].join('');

  return `<li class="mark-row${mastered ? ' is-mastered' : ''}" data-word="${esc(m.word)}">
    <div class="row-main">
      <div class="row-top">
        <span class="w">${esc(m.word)}</span>
        ${m.phonetic ? `<span class="ph">${esc(m.phonetic)}</span>` : ''}
        ${m.pos ? `<span class="pos">${esc(m.pos)}</span>` : ''}
      </div>
      ${m.meaning ? `<p class="row-cn">${esc(m.meaning)}</p>` : ''}
      ${extras}
    </div>
    <div class="row-actions">
      <button class="btn tiny" type="button" data-act="say" title="朗读">朗读</button>
      <button class="btn tiny" type="button" data-act="master" data-next="${mastered ? '0' : '1'}">${mastered ? '退回学习' : '已掌握'}</button>
      <button class="btn tiny danger" type="button" data-act="remove" title="移出生词本">删除</button>
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
        <ul class="mark-rows">${g.items.map((m) => rowHTML(m, mastered)).join('')}</ul>
      </section>`
    )
    .join('');
}

function renderMine(items) {
  const learning = items.filter((it) => !it.mastered);
  const mastered = items.filter((it) => it.mastered);
  if (!items.length) return '';

  const parts = [];
  if (learning.length) {
    parts.push(`<section class="marks-section">
      <div class="section-heading">
        <h3>学习中 <span class="count">${learning.length}</span></h3>
        <p>还没背下来的词。背下来就点这一行的「已掌握」。</p>
      </div>
      <div class="mark-groups">${groupsHTML(groupByDay(learning, (m) => m.time), false)}</div>
    </section>`);
  }
  if (mastered.length) {
    parts.push(`<section class="marks-section">
      <div class="section-heading">
        <h3>已掌握 <span class="count">${mastered.length}</span></h3>
        <p>按掌握日期排。想再背一遍，点「退回学习」。</p>
      </div>
      <div class="mark-groups">${groupsHTML(groupByDay(mastered, (m) => m.masteredAt || m.time), true)}</div>
    </section>`);
  }
  const q = state.query.trim();
  if (q) {
    parts.unshift(`<p class="tip">匹配「${esc(q)}」的生词：${items.length} 个</p>`);
  }
  return parts.join('');
}

/* ---------------- 渲染：整体 ---------------- */
function setStatus(text, isError = false) {
  const el = $('#vocabStatus');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('err', Boolean(isError));
}

function render() {
  const phraseMarks = state.marks.filter(isPhraseMark).length;
  $('#vtabDailyCount').textContent = state.total ?? 0;
  $('#vtabMineCount').textContent = state.marks.length - phraseMarks;
  $('#vtabPhraseCount').textContent = phraseMarks;
  $$('[data-vtab]').forEach((b) => b.classList.toggle('active', b.dataset.vtab === state.tab));
  const sel = $('#vocabSort');
  if (sel) sel.value = state.sort;

  $('#statTotal').textContent = state.total ?? 0;
  $('#statLearning').textContent = state.marks.length - phraseMarks - state.marks.filter((m) => m.mastered && !isPhraseMark(m)).length;
  $('#statMastered').textContent = state.marks.filter((m) => m.mastered && !isPhraseMark(m)).length;
  $('#statPhrases').textContent = phraseMarks;
  // 导航徽标和首页保持一致：只数「还没背下来的词」，不是全部收藏
  const learningWords = state.marks.filter((m) => !m.mastered && !isPhraseMark(m)).length;
  $('#navCount').textContent = learningWords;

  // 「补全释义」只在每日单词页、且确实还缺释义时出现
  const missing = state.missing ?? 0;
  const fillBtn = $('#btnFillMeaning');
  if (fillBtn) {
    fillBtn.hidden = state.tab !== 'daily' || !missing;
    fillBtn.textContent = `补全释义（${missing}）`;
    fillBtn.disabled = Boolean(state.filling);
  }

  const items = filterAndSort(currentItems());
  const box = $('#vocabBody');
  if (!items.length) {
    const q = state.query.trim();
    box.className = 'vocab-cards';
    box.innerHTML = `<p class="tip empty-tip">${
      q
        ? `没有匹配「${esc(q)}」的词。`
        : state.tab === 'daily'
          ? '还没有导入过单词。回「今天」那页点「导入单词」开始。'
          : state.tab === 'phrases'
            ? '还没有收藏过短语。在正文里拖选几个词（比如 in terms of），松手后点「☆ 收藏短语」。'
            : '生词本还是空的。阅读时点任意单词，再点「☆ 收藏」就能收进来。'
    }</p>`;
  } else if (state.tab === 'mine') {
    box.className = 'vocab-rows';
    box.innerHTML = renderMine(items);
  } else {
    box.className = 'vocab-cards';
    box.innerHTML = renderCards(items);
  }
}

/* ---------------- 交互 ---------------- */
function speak(word) {
  if (!window.speechSynthesis) return toast('当前浏览器不支持朗读', true);
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  u.rate = 0.92;
  window.speechSynthesis.speak(u);
}

async function reload() {
  const [vocab, marks] = await Promise.all([api('/api/vocab'), api('/api/marks')]);
  state.days = vocab.days || [];
  state.total = vocab.total || 0;
  state.missing = vocab.missing || 0;
  state.marks = marks.marks || [];
}

async function setMastered(word, next) {
  const body = await api('/api/marks/mastered', { method: 'POST', body: { word, mastered: next } });
  state.marks = body.marks || state.marks;
  render();
}

async function removeMark(word) {
  const body = await api(`/api/marks?word=${encodeURIComponent(word)}`, { method: 'DELETE' });
  state.marks = body.marks || state.marks;
  render();
}

async function fillMissingMeanings() {
  if (state.filling) return;
  const missing = state.missing;
  if (!missing) return;
  const rounds = Math.ceil(missing / 40);
  const ok = confirm(
    `有 ${missing} 个词还没有中文释义。\n\n` +
      `要调用模型补全吗？大约 ${rounds} 次请求（${Math.min(missing, 40)} 个一批），` +
      `补过的会存进本地词典缓存，以后再也不会重复花钱。`
  );
  if (!ok) return;

  state.filling = true;
  render();
  let done = 0;
  try {
    for (let round = 0; round < 15; round++) {
      setStatus(`正在补第 ${done + 1} 个开始的这一批……（已补 ${done}，还剩 ${missing - done}）`);
      const r = await api('/api/vocab/fill', { method: 'POST', body: { limit: 40 } });
      done += r.filled || 0;
      await reload();
      render();
      setStatus(`已补 ${done} 个，还剩 ${r.remaining} 个……`);
      if (!r.remaining) break;
      if (!r.filled) {
        setStatus(`这一批没补成功：${(r.errors || []).slice(0, 3).join('；') || '未知原因'}`, true);
        break;
      }
    }
    if (!state.missing) {
      setStatus(`释义补全了，共补 ${done} 个。`);
      setTimeout(() => setStatus(''), 4000);
    }
  } catch (e) {
    setStatus(e.message || '补全失败', true);
  } finally {
    state.filling = false;
    render();
  }
}

/* ---------------- 事件绑定 ---------------- */
document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-vtab]');
  if (tab) {
    state.tab = ['mine', 'phrases'].includes(tab.dataset.vtab) ? tab.dataset.vtab : 'daily';
    state.query = '';
    const search = $('#vocabSearch');
    if (search) search.value = '';
    setStatus('');
    render();
    return;
  }

  const clearDay = e.target.closest('[data-clear-day]');
  if (clearDay) {
    e.stopPropagation();
    const date = clearDay.dataset.clearDay;
    if (!confirm(`删掉 ${date} 导入的单词？\n\n每天那篇文章不受影响。`)) return;
    try {
      await api(`/api/words?date=${encodeURIComponent(date)}`, { method: 'DELETE' });
      await reload();
      render();
      toast(`已清空 ${date} 的单词`);
    } catch (err) {
      toast(err.message || '清空失败', true);
    }
    return;
  }

  const rm = e.target.closest('[data-vrm]');
  if (rm) {
    e.stopPropagation();
    try {
      await removeMark(rm.dataset.vrm);
      toast(`已移出生词本：${rm.dataset.vrm}`);
    } catch (err) {
      toast(err.message || '移出失败', true);
    }
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (btn) {
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
  }
});

$('#vocabSort')?.addEventListener('change', (e) => {
  state.sort = e.target.value;
  render();
});

$('#vocabSearch')?.addEventListener('input', (e) => {
  state.query = e.target.value;
  render();
});

$('#btnFillMeaning')?.addEventListener('click', () => fillMissingMeanings());

/* ---------------- 启动 ---------------- */
(async function boot() {
  // 支持 /vocab.html?tab=mine 这样的直达
  const want = new URLSearchParams(location.search).get('tab');
  if (['daily', 'mine', 'phrases'].includes(want)) state.tab = want;
  try {
    await reload();
  } catch (e) {
    toast('读取单词本失败：' + (e.message || e), true);
  }
  render();
})();
