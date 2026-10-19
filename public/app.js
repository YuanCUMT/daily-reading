'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  date: null,
  today: null,
  config: null,
  dates: [],
  words: null,
  article: null,
  marks: [], // 生词本（服务端持久化）
  marksSet: new Set(), // 小写词 → 快速判断「这个词标过吗」
  dictCache: new Map(), // 本次会话已经查过的词，省一次请求
  images: [], // 待识别的截图 [{name, dataUrl}]
  candidates: [], // 识别出来的候选词
};

// ------------------------------------------------------------------ 网络
async function api(path, options = {}) {
  const { timeoutMs, ...init } = options;
  const ac = timeoutMs ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
      signal: ac?.signal,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const data = await res.json().catch(() => ({ ok: false, error: '返回内容无法解析' }));
    if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没回，网络或模型太慢了`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2600);
}

function showLoading(text) {
  $('#loadingText').textContent = text;
  $('#loading').hidden = false;
}
const hideLoading = () => ($('#loading').hidden = true);

// ------------------------------------------------------------------ 加载与渲染
async function load(date) {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  const data = await api(`/api/state${q}`);
  state.date = data.date;
  state.today = data.today;
  state.config = data.config;
  state.dates = data.dates;
  state.words = data.words;
  state.article = data.article;
  setMarks(data.marks || []);
  $('#datePicker').value = state.date;
  renderAll();
  migrateOldStars();
}

/** 生词本列表变化后，同步集合与侧栏 */
function setMarks(list) {
  state.marks = Array.isArray(list) ? list : [];
  state.marksSet = new Set();
  for (const m of state.marks) {
    if (m.word) state.marksSet.add(String(m.word).toLowerCase());
    if (m.lemma) state.marksSet.add(String(m.lemma).toLowerCase());
  }
  renderMarks();
}

/** 旧版本把「收藏」存在 localStorage 里，只存了单词没有释义 —— 迁移到服务端生词本 */
async function migrateOldStars() {
  let old = [];
  try {
    old = JSON.parse(localStorage.getItem('starred') || '[]');
  } catch {
    old = [];
  }
  if (!Array.isArray(old) || !old.length) return;
  localStorage.removeItem('starred');
  const known = new Set(state.marks.map((m) => m.word));
  for (const w of old) {
    if (!w || known.has(String(w).toLowerCase())) continue;
    try {
      await api('/api/marks', { method: 'POST', body: { word: w, articleDate: state.date } });
    } catch {
      /* 迁移失败不打扰用户 */
    }
  }
  const fresh = await api('/api/marks').catch(() => null);
  if (fresh) setMarks(fresh.marks);
}

function renderAll() {
  renderWords();
  renderArchive();
  renderMarks();
  renderArticle();
  $('#btnGenerate').disabled = !(state.words?.words?.length);
  const mode = state.config?.prefs?.mode === 'exam' ? 'exam' : 'review';
  if ($('#modeQuick').value !== mode) $('#modeQuick').value = mode;
  syncLedger();
}

// 首屏那条「台账」：数字跟着读写实时变，没生成文章时「本篇用到」显示破折号
function syncLedger() {
  const set = (sel, value) => {
    const el = $(sel);
    if (el) el.textContent = String(value);
  };
  const words = state.words?.words?.length || 0;
  const marks = state.marks?.length || 0;
  const days = state.dates?.length || 0;
  const a = state.article;
  const used = a ? (a.usedWords || a.words || []).length : null;
  set('#ledgerWords', words);
  set('#ledgerUsed', used === null ? '—' : used);
  set('#ledgerMarks', marks);
  set('#ledgerDays', days);
}

function renderWords() {
  const words = state.words?.words || [];
  $('#wordCount').textContent = words.length;
  const box = $('#wordList');
  if (!words.length) {
    box.innerHTML = '<p class="tip" style="margin:0">还没有导入单词。</p>';
    return;
  }
  box.innerHTML = words
    .map(
      (w) => `<button class="word-chip" data-word="${esc(w.word)}">
        <span class="w">${esc(w.word)}</span>
        <span class="m">${esc(w.meaning || w.phonetic || '')}</span>
      </button>`
    )
    .join('');
}

function renderArchive() {
  const box = $('#archive');
  if (!state.dates.length) {
    box.innerHTML = '<p class="tip" style="margin:0">还没有历史文章。</p>';
    return;
  }
  box.innerHTML = state.dates
    .map(
      (d) => `<button class="archive-item ${d === state.date ? 'active' : ''}" data-date="${d}">
        <span class="t">${d === state.today ? `${d} · 今天` : d}</span>
        <span class="d">${d === state.date ? '●' : ''}</span>
      </button>`
    )
    .join('');
}

function renderMarks() {
  const box = $('#markList');
  const n = state.marks.length;
  $('#markCount').textContent = n;
  $('#btnClearMarks').disabled = !n;
  syncLedger();
  if (!n) {
    box.innerHTML =
      '<p class="tip" style="margin:0">阅读时点任意单词就能查意思，点「☆ 收藏」收进这里。</p>';
    return;
  }
  box.innerHTML = state.marks
    .map((m) => {
      // 一行一个词太挤，释义/搭配/考研义项全被省略号吃掉。改成多行卡片，内容全部展开。
      const subs = [
        m.collocation ? `<div class="mk-sub"><i>搭配</i>${esc(m.collocation)}</div>` : '',
        m.examSense ? `<div class="mk-sub"><i>考研常考</i>${esc(m.examSense)}</div>` : '',
        m.note ? `<div class="mk-sub mk-note">${esc(m.note)}</div>` : '',
      ].join('');
      return `<div class="mark-chip" data-word="${esc(m.word)}">
        <div class="mk-top">
          <span class="w">${esc(m.word)}</span>
          ${m.phonetic ? `<span class="ph">${esc(m.phonetic)}</span>` : ''}
          ${m.pos ? `<span class="pos">${esc(m.pos)}</span>` : ''}
          <span class="rm" data-rm="${esc(m.word)}" title="移出生词本">✕</span>
        </div>
        ${m.cn ? `<div class="m">${esc(m.cn)}</div>` : ''}
        ${subs}
      </div>`;
    })
    .join('');
}

function renderArticle() {
  const a = state.article;
  const empty = $('#empty');
  const view = $('#articleView');
  if (!a) {
    view.hidden = true;
    empty.hidden = false;
    const n = state.words?.words?.length || 0;
    $('#emptyHint').textContent = n
      ? `今天已导入 ${n} 个单词，点右上角「生成文章」。`
      : '先「上传截图识别」把今天背的单词弄进来。';
    return;
  }
  empty.hidden = true;
  view.hidden = false;

  const glossaryMap = new Map(a.glossary.map((g) => [g.word.toLowerCase(), g]));
  const pattern = buildWordPattern(a.glossary, state.marks.map((m) => m.word));

  const usedCount = (a.usedWords || a.words || []).length;
  const totalCount = a.totalWords || usedCount;
  const head = `
    <div class="article-head">
      <h2>${esc(a.title)}</h2>
      ${a.titleZh ? `<p class="zh-title">${esc(a.titleZh)}</p>` : ''}
      <div class="meta">
        <span class="pill mode-${a.mode === 'exam' ? 'exam' : 'review'}">${a.mode === 'exam' ? '真题模式' : '复习模式'}</span>
        <span class="pill">${esc(a.date)}</span>
        ${a.level ? `<span class="pill">${esc(a.level)}</span>` : ''}
        <span class="pill">${a.paragraphs.length} 段</span>
        <span class="pill">约 ${a.wordCount} 词</span>
        ${a.avgSentenceLength ? `<span class="pill">平均句长 ${a.avgSentenceLength} 词</span>` : ''}
        ${
          a.mode === 'exam' && totalCount > usedCount
            ? `<span class="pill">本篇用到 ${usedCount}/${totalCount} 个词</span>`
            : `<span class="pill">目标词 ${usedCount} 个</span>`
        }
        ${
          a.mode !== 'exam' && a.missingWords?.length
            ? `<span class="pill warn">未用到 ${a.missingWords.length} 个</span>`
            : ''
        }
      </div>
      ${a.summary ? `<div class="summary">${esc(a.summary)}</div>` : ''}
    </div>`;

  const toolbar = `
    <div class="toolbar">
      <button class="btn ghost" id="btnSpeakAll">🔊 朗读全文</button>
      <button class="btn ghost" id="btnStopSpeak">⏹ 停止</button>
      <label class="switch"><input type="checkbox" id="chkZh" ${localStorage.getItem('showZh') === '1' ? 'checked' : ''} /> 显示中文</label>
      <div class="spacer"></div>
      <button class="btn ghost" id="btnRegen">重新生成</button>
      <button class="btn ghost" id="btnCopy">复制全文</button>
      <button class="btn ghost" id="btnDelete">删除</button>
    </div>`;

  const body = a.paragraphs
    .map(
      (p, i) => `
      <div class="para" data-para="${i}">
        <button class="speak" data-speak="${i}" title="朗读本段">🔊</button>
        <p class="en">${highlight(p.en, pattern)}</p>
        <p class="zh" ${localStorage.getItem('showZh') === '1' ? '' : 'hidden'}>${esc(p.zh)}</p>
      </div>`
    )
    .join('');

  const glossary = a.glossary.length
    ? `<div class="section"><h3>今日词汇</h3><div class="glossary">${a.glossary
        .map(
          (g) => `<div class="gcard" data-word="${esc(g.word)}">
            <div class="top">
              <span class="w">${esc(g.word)}</span>
              ${g.phonetic ? `<span class="ph">${esc(g.phonetic)}</span>` : ''}
              ${g.pos ? `<span class="pos">${esc(g.pos)}</span>` : ''}
              <button class="say" title="朗读">🔊</button>
            </div>
            <p class="cn">${esc(g.cn)}</p>
            ${g.examSense ? `<p class="exam-sense">考研常考：${esc(g.examSense)}</p>` : ''}
            ${g.context ? `<p class="ctx">${highlight(g.context, pattern)}</p>` : ''}
          </div>`
        )
        .join('')}</div></div>`
    : '';

  const longSentences = a.longSentences?.length
    ? `<div class="section"><h3>长难句拆解</h3><div class="long-sentences">${a.longSentences
        .map(
          (s, i) => `<div class="lsent">
            <p class="ls-en">${i + 1}. ${highlight(s.en, pattern)} <button class="say" data-ls-speak="${i}" title="朗读">🔊</button></p>
            <p class="ls-analysis">${esc(s.analysis)}</p>
            ${s.zh ? `<p class="ls-zh">${esc(s.zh)}</p>` : ''}
          </div>`
        )
        .join('')}</div></div>`
    : '';

  const quiz = a.questions?.length
    ? `<div class="section"><h3>理解题</h3><div class="quiz">${a.questions
        .map(
          (q, qi) => `<div class="q" data-q="${qi}">
            <p class="stem"><span class="qtype">${esc(q.type)}</span>${qi + 1}. ${esc(q.q)}</p>
            ${q.options.map((o, oi) => `<button class="opt" data-opt="${oi}">${String.fromCharCode(65 + oi)}. ${esc(o)}</button>`).join('')}
            <div class="answer-box" hidden>
              ${q.evidence ? `<p class="evidence">原文定位：${highlight(q.evidence, pattern)}</p>` : ''}
              ${q.explain ? `<p class="explain">${esc(q.explain)}</p>` : ''}
            </div>
          </div>`
        )
        .join('')}</div></div>`
    : '';

  view.innerHTML = head + toolbar + `<div class="article-body">${body}</div>` + glossary + longSentences + quiz;
  bindArticleEvents(glossaryMap, a);
}

/** 构造高亮正则：目标词 + 生词本里的词，都支持常见变形 */
function buildWordPattern(glossary, extraWords = []) {
  const stems = [
    ...new Set(
      [...(glossary || []).map((g) => String(g.word).toLowerCase()), ...extraWords.map((w) => String(w).toLowerCase())].filter(
        (w) => /^[a-z][a-z'\- ]*$/.test(w)
      )
    ),
  ];
  if (!stems.length) return null;
  const alts = stems
    .sort((a, b) => b.length - a.length) // 长的排前面，in terms of 不会被 terms 抢先匹配
    .map((w) => {
      // 短语不加词尾变化：take into account 的变化落在第一个词上（takes into account），
      // 在短语尾巴上补 s/ed 只会匹配出 into accounts 这种不存在的形式
      const suffix = /\s/.test(w) ? '' : '(?:s|es|ed|d|ing|ies|ied|ly|er|est)?';
      return `${esc(w).replace(/\s+/g, '\\s+')}${suffix}`;
    })
    .join('|');
  return new RegExp(`\\b(${alts})\\b`, 'gi');
}

function highlight(text, pattern) {
  const safe = esc(text);
  if (!pattern) return safe;
  return safe.replace(pattern, (m, stem) => {
    // 生词本里的词用另一种样式，和今日目标词区分开。
    // 用 stem（不含词尾变化的部分）去比对，否则 take 收藏后 *takes* 不会变蓝
    const key = String(stem || m).toLowerCase().replace(/\s+/g, ' ');
    const marked = state.marksSet.has(key);
    return `<mark class="word${marked ? ' mine' : ''}" data-hw="${esc(m.replace(/\s+/g, ' '))}">${m}</mark>`;
  });
}

// ------------------------------------------------------------------ 文章内事件
/** 正文区的点击处理。只绑一次（见 bindTop），内部从 state 取当前文章 */
function onArticleClick(e) {
  const a = state.article;
  if (!a) return;

  const speakBtn = e.target.closest('[data-speak]');
  if (speakBtn) {
    const i = Number(speakBtn.dataset.speak);
    speak(a.paragraphs[i].en, $(`.para[data-para="${i}"]`));
    return;
  }
  const lsSpeak = e.target.closest('[data-ls-speak]');
  if (lsSpeak) {
    speak(a.longSentences[Number(lsSpeak.dataset.lsSpeak)].en);
    return;
  }
  const mark = e.target.closest('mark.word');
  if (mark) {
    const key = mark.dataset.hw.toLowerCase().replace(/[^a-z'\- ]/g, '').trim();
    openWord(e.clientX, e.clientY, key, mark);
    // 别再冒泡到 document 的「点别处关闭浮层」处理器，否则刚开的浮层会被立刻关掉
    e.stopPropagation();
    return;
  }
  // 正文里任意单词都能点 —— 目标词以外的生词才是阅读时真正卡住的地方
  const hit = wordAtPoint(e.clientX, e.clientY);
  if (hit) {
    openWord(e.clientX, e.clientY, hit.word, hit.el);
    e.stopPropagation();
    return;
  }
  const opt = e.target.closest('.opt');
  if (opt) {
    const box = opt.closest('.q');
    const q = a.questions[Number(box.dataset.q)];
    $$('.opt', box).forEach((b, i) => {
      b.classList.remove('correct', 'wrong');
      if (i === q.answer) b.classList.add('correct');
    });
    if (Number(opt.dataset.opt) !== q.answer) opt.classList.add('wrong');
    const ans = $('.answer-box', box);
    if (ans) ans.hidden = false;
    return;
  }
  const card = e.target.closest('.gcard');
  if (card) {
    if (e.target.closest('.say')) speak(card.dataset.word);
    else openWord(e.clientX, e.clientY, card.dataset.word, card);
  }
}

function bindArticleEvents(glossaryMap, a) {
  $('#chkZh')?.addEventListener('change', (e) => {
    localStorage.setItem('showZh', e.target.checked ? '1' : '0');
    $$('#articleView .zh').forEach((el) => (el.hidden = !e.target.checked));
  });

  $('#btnSpeakAll')?.addEventListener('click', () => speakAll(a));
  $('#btnStopSpeak')?.addEventListener('click', () => window.speechSynthesis?.cancel());
  $('#btnRegen')?.addEventListener('click', () => generate());
  $('#btnDelete')?.addEventListener('click', async () => {
    if (!confirm(`确定删除 ${state.date} 的文章？`)) return;
    await api(`/api/article?date=${state.date}`, { method: 'DELETE' });
    toast('已删除');
    await load(state.date);
  });
  $('#btnCopy')?.addEventListener('click', async () => {
    const text = [
      a.title,
      a.titleZh,
      '',
      ...a.paragraphs.flatMap((p) => [p.en, p.zh, '']),
      '—— 词汇 ——',
      ...a.glossary.map((g) => `${g.word} ${g.phonetic} ${g.pos} ${g.cn}${g.examSense ? `（考研常考：${g.examSense}）` : ''}`),
      ...(a.longSentences?.length ? ['', '—— 长难句 ——', ...a.longSentences.flatMap((s) => [s.en, s.analysis, ''])] : []),
      ...(a.questions?.length
        ? [
            '—— 题目 ——',
            ...a.questions.flatMap((q, i) => [
              `${i + 1}. [${q.type}] ${q.q}`,
              ...q.options.map((o, oi) => `   ${String.fromCharCode(65 + oi)}. ${o}`),
              `   答案：${String.fromCharCode(65 + q.answer)}`,
              ...(q.evidence ? [`   原文定位：${q.evidence}`] : []),
              ...(q.explain ? [`   解析：${q.explain}`] : []),
              '',
            ]),
          ]
        : []),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
    } catch {
      toast('复制失败，请手动选择', true);
    }
  });

  // 注：#articleView / #wordList / #markList 的点击处理绑在 bindTop() 里只绑一次。
  // 这里如果每渲染一次就 addEventListener，会叠出一堆重复处理器（一次点击查好几次词）。

  state.glossaryMap = glossaryMap;
}

function findGlossary(map, key) {
  const exact = map.get(key);
  if (exact) return exact;
  // 短语只认完全一致；短词也不做前缀猜测，否则 in / the 会匹配到 inevitable、there 之类
  if (/\s/.test(key) || key.length < 4) return null;
  for (const [k, v] of map) {
    if (k.length < 4) continue;
    if (key.startsWith(k) || k.startsWith(key)) return v;
  }
  return null;
}

// ------------------------------------------------------------------ 朗读
function speak(text, paraEl) {
  if (!window.speechSynthesis) return toast('当前浏览器不支持朗读', true);
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 0.92;
  $$('.para').forEach((p) => p.classList.remove('playing'));
  if (paraEl) paraEl.classList.add('playing');
  u.onend = () => $$('.para').forEach((p) => p.classList.remove('playing'));
  window.speechSynthesis.speak(u);
}

function speakAll(a) {
  if (!window.speechSynthesis) return toast('当前浏览器不支持朗读', true);
  window.speechSynthesis.cancel();
  a.paragraphs.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.en);
    u.lang = 'en-US';
    u.rate = 0.92;
    u.onstart = () => {
      $$('.para').forEach((e) => e.classList.remove('playing'));
      $(`.para[data-para="${i}"]`)?.classList.add('playing');
    };
    if (i === a.paragraphs.length - 1) u.onend = () => $$('.para').forEach((e) => e.classList.remove('playing'));
    window.speechSynthesis.speak(u);
  });
}

// ------------------------------------------------------------------ 划词查词
/** 取光标下的英文单词。只认正文 .en 里的文字，避免把译文/界面文字也当成词 */
function wordAtPoint(x, y) {
  const sel = window.getSelection?.();
  if (sel && String(sel).trim()) return null; // 用户正在选词，别抢
  const range = document.caretRangeFromPoint?.(x, y);
  if (!range) return null;
  const node = range.startContainer;
  if (!node || node.nodeType !== 3) return null;
  const el = node.parentElement;
  if (!el || !el.closest('.en')) return null;
  const text = node.data;
  const isW = (ch) => !!ch && /[A-Za-z'\-]/.test(ch);
  let s = range.startOffset;
  let e = range.startOffset;
  if (!isW(text[s]) && !isW(text[s - 1])) return null;
  while (s > 0 && isW(text[s - 1])) s--;
  while (e < text.length && isW(text[e])) e++;
  const raw = text
    .slice(s, e)
    .replace(/^['\-]+/, '')
    .replace(/['\-]+$/, '');
  if (!/^[A-Za-z][A-Za-z'\-]{0,40}$/.test(raw)) return null;
  return { word: raw, el, sentence: el.textContent };
}

/**
 * 把用户框选的文字当成短语来查。
 * 只在同一个段落（.en）内部生效 —— 跨段框选会把两句话拼在一起，那不是短语。
 * 返回 { phrase, host, rect } 表示可以查；
 * 返回 { problem } 表示这次框选该查但被拒了（带原因，好给用户一句人话）；
 * 返回 null 表示根本不是英文框选（选了译文、界面文字），安静忽略。
 */
function selectionPhrase() {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;

  let range = sel.getRangeAt(0);
  const toEl = (n) => (n?.nodeType === 3 ? n.parentElement : n);
  const startEl = toEl(range.startContainer);
  const host = startEl?.closest?.('.en');
  if (!host) return null; // 选的是译文或界面文字，不归我们管

  const endEl = toEl(range.endContainer);
  if (endEl && endEl !== host && !host.contains(endEl)) {
    if (endEl.closest?.('.en')) return { problem: 'multi-para' };
    // 手滑拖出段落（拖进了中文译文、或者多拖了半行）是常事，
    // 不该让整次框选白费：把选区截到本段末尾，视觉上也跟着收回来。
    range = document.createRange();
    range.setStart(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
    range.setEnd(host, host.childNodes.length);
    try {
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  }

  const raw = String(sel).replace(/\s+/g, ' ').trim();
  const cleaned = raw.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z'\-]+$/, '');
  if (!/^[A-Za-z][A-Za-z'\- ]*$/.test(cleaned)) return null;

  const words = cleaned.split(' ').filter(Boolean);
  if (!words.length) return null;
  if (words.length > 8 || cleaned.length > 60) return { problem: 'too-long', wordCount: words.length };

  const rect = (sel.rangeCount ? sel.getRangeAt(0) : range).getBoundingClientRect();
  return { phrase: cleaned.toLowerCase(), host, wordCount: words.length, rect };
}

function getGlossary(key) {
  const map = state.glossaryMap;
  if (!map) return null;
  return map.get(key) || findGlossary(map, key);
}

const isMarked = (word) => state.marksSet.has(String(word || '').toLowerCase());

/**
 * 打开某个词的浮层。顺序：今日词表（免费即时）→ 本次会话缓存 → 本地缓存 → 模型查。
 */
async function openWord(x, y, word, anchorEl) {
  const key = String(word || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return;

  const g = getGlossary(key);
  if (g) return drawPopover(x, y, key, { g });

  const memo = state.dictCache.get(key);
  if (memo) return drawPopover(x, y, key, { entry: memo });

  drawPopover(x, y, key, { loading: true });
  const sentence = anchorEl?.closest?.('.en')?.textContent || '';
  try {
    const data = await api(
      `/api/lookup?word=${encodeURIComponent(key)}&context=${encodeURIComponent(sentence.slice(0, 400))}`,
      { timeoutMs: 25000 }
    );
    state.dictCache.set(key, data.entry);
    if ($('#popover').dataset.word === key) drawPopover(x, y, key, { entry: data.entry, cached: data.cached });
  } catch (err) {
    if ($('#popover').dataset.word === key) drawPopover(x, y, key, { error: err.message });
  }
}

function drawPopover(x, y, word, opts) {
  const pop = $('#popover');
  pop.dataset.word = word;
  pop.innerHTML = popoverHtml(word, opts);
  pop.hidden = false;

  const rect = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(Math.max(12, x - 40), window.innerWidth - rect.width - 12)}px`;
  pop.style.top = `${y + rect.height + 24 > window.innerHeight ? Math.max(12, y - rect.height - 12) : y + 14}px`;

  const target = opts.g?.word || opts.entry?.word || word;
  $('[data-say]', pop)?.addEventListener('click', (e) => {
    e.preventDefault();
    speak(target);
  });
  $('[data-mark]', pop)?.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (isMarked(word) || isMarked(opts.g?.word) || isMarked(opts.entry?.word)) {
        await unmarkWord(word, opts.g?.word || opts.entry?.word);
        btn.textContent = isPhraseKey(word) ? '☆ 收藏短语' : '☆ 收藏';
      } else {
        await markWord(word, opts.g || opts.entry, opts.entry);
        btn.textContent = '★ 已在生词本';
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

/** 浮层里的词条是不是一个短语（短语的收藏按钮、词典链接、提示语都不同） */
const isPhraseKey = (w) => /\s/.test(String(w || '').trim());

function popoverHtml(word, opts) {
  const { g, entry, loading, error } = opts;
  const w = g?.word || entry?.word || word;
  const phonetic = g?.phonetic || entry?.phonetic || '';
  const pos = g?.pos || entry?.pos || '';
  const cn = g?.cn || entry?.cn || '';
  const examSense = g?.examSense || entry?.examSense || '';
  const collocation = entry?.collocation || '';
  const note = entry?.note || '';
  const example = entry?.example || '';
  const context = g?.context || '';
  const marked = isMarked(w) || isMarked(word);
  const phrase = isPhraseKey(w) || isPhraseKey(word);

  const head = `<div><span class="w">${esc(w)}</span>${
    phonetic ? `<span class="ph">${esc(phonetic)}</span>` : ''
  }${pos ? `<span class="pos">${esc(pos)}</span>` : ''}${phrase ? '<span class="pos phr">短语</span>' : ''}</div>`;

  let body;
  if (loading) {
    body = `${head}<p class="cn pop-loading">正在查${phrase ? '这个短语' : '这个词'}……<span class="ph-hint">第一次查要等模型几秒，之后直接读缓存</span></p>`;
  } else if (error) {
    body = `${head}<p class="cn" style="color:var(--warn)">${esc(error)}</p>`;
  } else if (!cn) {
    body = `${head}<p class="cn" style="color:var(--ink-soft)">${esc(note || '没查到释义，可能是拼写不对或专有名词。')}</p>`;
  } else {
    body = `${head}
      <p class="cn">${esc(cn)}</p>
      ${examSense ? `<p class="exam-sense">考研常考：${esc(examSense)}</p>` : ''}
      ${collocation ? `<p class="colloc">搭配：${esc(collocation)}</p>` : ''}
      ${note ? `<p class="ctx">${esc(note)}</p>` : ''}
      ${context ? `<p class="ctx">${esc(context)}</p>` : ''}
      ${example ? `<p class="ctx">例：${esc(example)}</p>` : ''}`;
  }

  // 短语在剑桥词典里没有固定的词条 URL，只能用它的站内搜索
  const dictUrl = phrase
    ? `https://dictionary.cambridge.org/search/english/direct/?q=${encodeURIComponent(w)}`
    : `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(w)}`;
  const markLabel = marked ? '★ 已在生词本' : phrase ? '☆ 收藏短语' : '☆ 收藏';

  const canMark = !loading && !error && Boolean(cn);
  return `${body}
    <div class="links">
      <a href="#" data-say>🔊 朗读</a>
      <a href="${dictUrl}" target="_blank" rel="noreferrer">剑桥词典</a>
      ${canMark ? `<a href="#" data-mark class="${marked ? 'on' : ''}">${markLabel}</a>` : ''}
    </div>`;
}

async function markWord(word, g, entry) {
  const src = { ...(entry || {}), ...(g || {}) };
  const data = await api('/api/marks', {
    method: 'POST',
    body: {
      word,
      lemma: src.word,
      phonetic: src.phonetic || '',
      pos: src.pos || '',
      cn: src.cn || '',
      examSense: src.examSense || '',
      collocation: src.collocation || '',
      note: src.note || '',
      articleDate: state.date,
    },
  });
  setMarks(data.marks);
  paintMark();
  toast(`已加入生词本：${word}`);
}

async function unmarkWord(word, lemma) {
  const data = await api(`/api/marks?word=${encodeURIComponent(word)}`, { method: 'DELETE' });
  setMarks(data.marks);
  paintMark();
}

/**
 * 只重画正文里的文字，不重渲染整篇文章（答题进度、滚动位置都保住）。
 * 收藏/取消收藏后调用：高亮样式完全由 highlight() 决定，所以「谁该是蓝色」
 * 只需要重新算一次，不用再纠结怎么就地包裹文本节点（短语会跨好几个节点）。
 */
function repaintArticleText() {
  const a = state.article;
  if (!a) return;
  const pattern = buildWordPattern(a.glossary, state.marks.map((m) => m.word));
  $$('.para').forEach((p, i) => {
    const en = $('.en', p);
    if (en && a.paragraphs[i]) en.innerHTML = highlight(a.paragraphs[i].en, pattern);
  });
  $$('.lsent').forEach((box, i) => {
    const en = $('.ls-en', box);
    const s = a.longSentences?.[i];
    if (en && s) {
      en.innerHTML = `${i + 1}. ${highlight(s.en, pattern)} <button class="say" data-ls-speak="${i}" title="朗读">🔊</button>`;
    }
  });
}

/**
 * 收藏/取消收藏后刷新高亮。
 * 单词和短语走同一条路：直接重画正文，不区分单复数、也不管它跨了几个文本节点。
 */
function paintMark() {
  repaintArticleText();
}

document.addEventListener('click', (e) => {
  const keep =
    e.target.closest('#popover') ||
    e.target.closest('mark.word') ||
    e.target.closest('.gcard') ||
    e.target.closest('.word-chip') ||
    e.target.closest('.mark-chip');
  if (!keep) $('#popover').hidden = true;
});

// 框选一段就是查短语 —— 单词靠点，短语靠拖。
//
// 触发用的是 selectionchange 而不是 mouseup/mouseend：
// 划词翻译、搜题那类浏览器扩展会抢鼠标事件（有的直接 stopPropagation，
// 有的在 mouseup 之后再把选区改一遍），用 mouseup 就会「有时候没反应」。
// 选区本身是绕不过去的，只要它变了我们就能知道。
// 拖选过程中 selectionchange 会连续触发，所以防抖到停手之后。
let selTimer = null;
let selWait = 0;
let lastPhrase = '';
let hintAt = 0;
let hintText = '';

// 鼠标还按着（用户可能只是拖过头了想退回来）就先别查，等松手。
// 用 window 上的 pointerdown/pointerup 捕获阶段：划词扩展拦不住这一层。
let pointerHeld = false;
window.addEventListener('pointerdown', () => (pointerHeld = true), true);
window.addEventListener('pointerup', () => (pointerHeld = false), true);
window.addEventListener('pointercancel', () => (pointerHeld = false), true);

function hintOnce(msg) {
  if (msg === hintText && Date.now() - hintAt < 2500) return;
  hintText = msg;
  hintAt = Date.now();
  toast(msg);
}

document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selWait = 0;
  selTimer = setTimeout(onSelectionSettled, 260);
});

function onSelectionSettled() {
  // 拖选途中会反复触发，按着鼠标时只是拖过头而已，不要急着查
  if (pointerHeld && selWait < 24) {
    selWait += 1;
    selTimer = setTimeout(onSelectionSettled, 150);
    return;
  }
  const hit = selectionPhrase();
  if (!hit) return;
  if (hit.problem === 'multi-para') return hintOnce('一次只能查同一段里的短语');
  if (hit.problem === 'too-long') return hintOnce('选得太长了，一次最多 8 个词');

  const pop = $('#popover');
  if (hit.phrase === lastPhrase && !pop.hidden && pop.dataset.word === hit.phrase) return;
  lastPhrase = hit.phrase;
  openWord(hit.rect.left, hit.rect.bottom + 4, hit.phrase, hit.host);
}

// ------------------------------------------------------------------ 生成
async function generate() {
  const words = state.words?.words || [];
  if (!words.length) return toast('先导入单词', true);
  showLoading(`正在用这 ${words.length} 个单词写文章……`);
  try {
    const data = await api('/api/article/generate', { method: 'POST', body: { date: state.date } });
    state.article = data.article;
    await load(state.date);
    toast('文章生成好了');
  } catch (e) {
    toast(e.message, true);
  } finally {
    hideLoading();
  }
}

// ------------------------------------------------------------------ 弹窗
function openModal(sel) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.hidden = false;
}
function closeModal(el) {
  const node = typeof el === 'string' ? $(el) : el;
  if (node) node.hidden = true;
}

// ------------------------------------------------------------------ 截图导入
function addImages(list) {
  for (const f of list) {
    if (!f || !/^image\//.test(f.type || '')) continue;
    if (state.images.length >= 12) {
      toast('一次最多 12 张', true);
      break;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.images.push({ name: f.name || 'screenshot', dataUrl: reader.result });
      renderThumbs();
    };
    reader.readAsDataURL(f);
  }
}

function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = state.images
    .map(
      (im, i) => `<div class="thumb">
        <img src="${im.dataUrl}" alt="${esc(im.name)}" />
        <button class="thumb-x" data-rm="${i}" title="移除">✕</button>
      </div>`
    )
    .join('');
  $('#btnDoOcr').disabled = state.images.length === 0;
  box.querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = () => {
      state.images.splice(Number(b.dataset.rm), 1);
      renderThumbs();
    };
  });
}

function renderCandidates(box, candidates, hint, extraHtml = '') {
  state.candidates = candidates;
  box.innerHTML = `
    <p class="tip">${esc(hint)} 勾选要保留的，拼写不对可以直接改：
      <a href="#" id="candAll">全选</a> · <a href="#" id="candNone">全不选</a>
    </p>
    <div class="cand-list">
      ${candidates
        .map(
          (w, i) => `<label class="cand-item">
            <input type="checkbox" name="cand" ${i < 30 ? 'checked' : ''} />
            <input class="cand-word" value="${esc(w.word)}" spellcheck="false" />
          </label>`
        )
        .join('')}
    </div>
    ${extraHtml}`;
  $('#candAll').onclick = (e) => {
    e.preventDefault();
    $$('#ocrResult input[name="cand"]').forEach((el) => (el.checked = true));
  };
  $('#candNone').onclick = (e) => {
    e.preventDefault();
    $$('#ocrResult input[name="cand"]').forEach((el) => (el.checked = false));
  };
}

function collectPickedCandidates(scope = '#ocrResult') {
  const rows = $$(`${scope} .cand-item`);
  const picked = [];
  for (const row of rows) {
    const cb = $('input[name="cand"]', row);
    const input = $('.cand-word', row);
    if (cb?.checked && input?.value.trim()) picked.push({ word: input.value.trim(), meaning: '' });
  }
  return picked;
}

async function runOcr() {
  if (!state.images.length) return;
  const box = $('#ocrResult');
  box.innerHTML = '<p class="tip">正在识别图片……（本地 OCR，不上传）</p>';
  showLoading('正在识别截图……');
  try {
    const data = await api('/api/ocr', {
      method: 'POST',
      body: {
        images: state.images.map((i) => i.dataUrl),
        fix: $('#chkOcrFix').checked,
      },
    });
    const words = data.words || [];
    if (!words.length) {
      box.innerHTML = `<p class="tip" style="color:#b13b25">${esc(data.hint || '没识别出单词')}</p>`;
      return;
    }
    renderCandidates(
      box,
      words,
      data.hint,
      `<details class="diag"><summary>原始识别文字（${esc(data.engine || '')}）</summary><pre>${esc((data.rawLines || []).join('\n'))}</pre></details>`
    );
    toast(`识别出 ${words.length} 个候选词`);
  } catch (e) {
    box.innerHTML = `<p class="tip" style="color:#b13b25">${esc(e.message)}</p>`;
  } finally {
    hideLoading();
  }
}

function bindImageImport() {
  const dz = $('#dropzone');
  const input = $('#fileInput');

  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    addImages([...input.files]);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('over');
    })
  );
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    addImages([...(e.dataTransfer?.files || [])]);
  });

  // 直接 Ctrl+V 粘贴截图
  document.addEventListener('paste', (e) => {
    if ($('#modalImport').hidden) return;
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file' && /^image\//.test(it.type))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addImages(files);
      toast(`已加入 ${files.length} 张截图`);
    }
  });
}

// ------------------------------------------------------------------ 弹窗事件
function bindModals() {
  // 粘贴框实时预览
  let previewTimer;
  const box = $('#pasteBox');
  if (box) {
    box.addEventListener('input', () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        const text = box.value.trim();
        const out = $('#pastePreview');
        if (!text) {
          out.innerHTML = '';
          return;
        }
        try {
          const r = await api('/api/parse-words', { method: 'POST', body: { text } });
          const ws = r.words || [];
          out.innerHTML = ws.length
            ? `<span class="ok">已识别 ${ws.length} 个单词：</span>` +
              ws.map((w) => `<span class="pv-word">${esc(w.word)}<i>${esc(w.meaning || '')}</i></span>`).join('')
            : '<span class="bad">没识别出单词，检查一下内容</span>';
        } catch {
          out.innerHTML = '';
        }
      }, 250);
    });
  }

  $$('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) closeModal(m);
    });
  });

  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
    })
  );

  $('#btnDoOcr').onclick = runOcr;

  $('#btnSaveWords').onclick = async () => {
    const activeTab = $('.tab.active')?.dataset.tab;
    const status = $('#importStatus');
    try {
      let res;
      if (activeTab === 'image') {
        const picked = collectPickedCandidates();
        if (!picked.length) return toast('先识别并勾选单词', true);
        res = await api('/api/words', { method: 'POST', body: { date: state.date, words: picked, source: '截图识别' } });
        resetImport();
      } else {
        if (!$('#pasteBox').value.trim()) return toast('粘贴框是空的', true);
        res = await api('/api/words', { method: 'POST', body: { date: state.date, text: $('#pasteBox').value } });
        $('#pasteBox').value = '';
        $('#pastePreview').innerHTML = '';
      }

      // 弹窗保持打开，方便「一张一张加」——上一批的词不会再被冲掉
      status.textContent = `已保存：新增 ${res.added} 个，跳过重复 ${res.skipped} 个，词表共 ${res.total} 个。可以继续添加。`;
      toast(`新增 ${res.added} 个，词表共 ${res.total} 个`);
      await load(state.date);
    } catch (e) {
      toast(e.message, true);
      status.textContent = e.message;
    }
  };

  $('#chkOcrFix').checked = true;
  $('#cfgMode').addEventListener('change', syncModeUI);

  $('#btnSaveSettings').onclick = async () => {
    const status = $('#settingsStatus');
    status.textContent = '保存中……';
    try {
      await api('/api/config', {
        method: 'POST',
        body: {
          deepseek: {
            apiKey: $('#cfgKey').value,
            baseUrl: $('#cfgBase').value.trim(),
            model: $('#cfgModel').value.trim(),
          },
          prefs: {
            mode: $('#cfgMode').value === 'exam' ? 'exam' : 'review',
            level: $('#cfgLevel').value,
            paragraphs: Number($('#cfgParas').value) || 6,
            style: $('#cfgStyle').value,
            questionCount: Number($('#cfgQuestionCount').value) || 0,
            examWordLimit: Number($('#cfgExamLimit').value) || 15,
            withQuestions: $('#cfgQuestions').checked,
            withLongSentences: $('#cfgLongSentences').checked,
            ocrFix: $('#cfgOcrFix').checked,
          },
        },
      });
      status.textContent = '已保存 ✓';
      toast('设置已保存');
      $('#cfgKey').value = '';
      await load(state.date);
      setTimeout(() => (status.textContent = ''), 2000);
    } catch (e) {
      status.textContent = e.message;
    }
  };
}

function resetImport() {
  state.images = [];
  state.candidates = [];
  renderThumbs();
  $('#ocrResult').innerHTML = '';
}

function fillSettings() {
  const c = state.config;
  $('#cfgBase').value = c.deepseek.baseUrl;
  $('#cfgModel').value = c.deepseek.model;
  $('#cfgKey').placeholder = c.deepseek.hasKey ? `已保存（${c.deepseek.keyMask}），留空则不改动` : 'sk-...';
  $('#cfgMode').value = c.prefs.mode === 'exam' ? 'exam' : 'review';
  $('#cfgLevel').value = c.prefs.level;
  $('#cfgParas').value = c.prefs.paragraphs;
  $('#cfgStyle').value = c.prefs.style;
  $('#cfgQuestionCount').value = c.prefs.questionCount ?? 5;
  $('#cfgExamLimit').value = c.prefs.examWordLimit ?? 15;
  $('#cfgQuestions').checked = c.prefs.withQuestions !== false;
  $('#cfgLongSentences').checked = c.prefs.withLongSentences !== false;
  $('#cfgOcrFix').checked = c.prefs.ocrFix !== false;
  $('#chkOcrFix').checked = c.prefs.ocrFix !== false;
  syncModeUI();
}

/** 真题模式才有「每篇用词数」；提示文案也跟着模式变 */
function syncModeUI() {
  const exam = $('#cfgMode').value === 'exam';
  $('#examLimitRow').hidden = !exam;
  $('#modeTip').textContent = exam
    ? '真题模式：从今天的词表里挑一部分，按考研阅读原文的难度和结构写（句子更长、有明显让步反驳、选项按考研套路造干扰项），句子更难但更像真题。'
    : '复习模式：把今天背的词尽量全用上，句子偏短、能靠语境猜词，重点是把词记住。';
}

// ------------------------------------------------------------------ 启动
function bindTop() {
  $('#datePicker').addEventListener('change', (e) => load(e.target.value));
  $('#btnImport').onclick = () => openModal($('#modalImport'));
  // 首屏 Hero 上的两个大按钮：和顶栏、空态按钮走同一条路
  const heroImport = $('#btnHeroImport');
  if (heroImport) {
    heroImport.onclick = () => {
      openModal($('#modalImport'));
      $('.tab[data-tab="image"]')?.click();
    };
  }
  const heroGenerate = $('#btnHeroGenerate');
  if (heroGenerate) heroGenerate.onclick = () => generate();
  $('#empty')?.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    openModal($('#modalImport'));
    if (act === 'import') $('.tab[data-tab="paste"]').click();
    else $('.tab[data-tab="image"]').click();
  });
  $('#btnGenerate').onclick = generate;

  // 一键切模式：改完立刻存，但不会自动花你的额度重新生成
  $('#modeQuick').addEventListener('change', async (e) => {
    const mode = e.target.value === 'exam' ? 'exam' : 'review';
    try {
      const r = await api('/api/config', { method: 'POST', body: { prefs: { mode } } });
      state.config = r.config;
      const hasArticle = Boolean(state.article);
      const label = mode === 'exam' ? '真题模式' : '复习模式';
      toast(hasArticle ? `已切到${label} —— 点「重新生成」才会用新模式重写` : `已切到${label}`);
      if (hasArticle && !confirm(`已切到${label}。\n\n要现在重新生成今天的文章吗？（会重新调用一次模型）`)) return;
      if (hasArticle) await generate();
    } catch (err) {
      toast(err.message, true);
      e.target.value = state.config?.prefs?.mode === 'exam' ? 'exam' : 'review';
    }
  });
  $('#btnClearWords').onclick = async () => {
    const n = state.words?.words?.length || 0;
    if (!n) return toast('今天还没有单词', true);
    if (!confirm(`清空 ${state.date} 的单词表（共 ${n} 个）？\n\n只清单词，已生成的文章不受影响。`)) return;
    try {
      await api(`/api/words?date=${state.date}`, { method: 'DELETE' });
      toast('已清空');
      await load(state.date);
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#btnSettings').onclick = () => {
    fillSettings();
    openModal($('#modalSettings'));
  };
  $('#archive').onclick = (e) => {
    const item = e.target.closest('.archive-item');
    if (item) load(item.dataset.date);
  };

  // 下面这几块容器本身不会被重渲染，处理器只能绑一次，否则会叠加
  $('#articleView').addEventListener('click', onArticleClick);

  $('#wordList').onclick = (e) => {
    const chip = e.target.closest('.word-chip');
    if (chip) openWord(e.clientX, e.clientY, chip.dataset.word, chip);
  };

  $('#markList').onclick = async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      e.stopPropagation();
      await unmarkWord(rm.dataset.rm);
      return;
    }
    const chip = e.target.closest('.mark-chip');
    if (chip) openWord(e.clientX, e.clientY, chip.dataset.word, chip);
  };

  $('#btnClearMarks').onclick = async () => {
    if (!state.marks.length) return;
    if (!confirm(`确定清空生词本里的 ${state.marks.length} 个词？`)) return;
    const data = await api('/api/marks?all=1', { method: 'DELETE' });
    setMarks(data.marks);
    paintMark();
    toast('生词本已清空');
  };
}

bindTop();
bindModals();
bindImageImport();
renderThumbs();
load().catch((e) => toast(e.message, true));
