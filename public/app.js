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
  images: [], // 待识别的截图 [{name, dataUrl}]
  candidates: [], // 识别出来的候选词
  starred: new Set(JSON.parse(localStorage.getItem('starred') || '[]')),
};

// ------------------------------------------------------------------ 网络
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: '返回内容无法解析' }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
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
  $('#datePicker').value = state.date;
  renderAll();
}

function renderAll() {
  renderWords();
  renderArchive();
  renderArticle();
  $('#btnGenerate').disabled = !(state.words?.words?.length);
  const mode = state.config?.prefs?.mode === 'exam' ? 'exam' : 'review';
  if ($('#modeQuick').value !== mode) $('#modeQuick').value = mode;
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
  const pattern = buildWordPattern(a.glossary);

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

/** 构造目标词正则：支持常见变形 */
function buildWordPattern(glossary) {
  const stems = [...new Set(glossary.map((g) => String(g.word).toLowerCase()).filter((w) => /^[a-z][a-z'\- ]*$/.test(w)))];
  if (!stems.length) return null;
  const alts = stems
    .sort((a, b) => b.length - a.length)
    .map((w) => esc(w).replace(/\s+/g, '\\s+'))
    .join('|');
  return new RegExp(`\\b(${alts})(s|es|ed|d|ing|ies|ied|ly|er|est)?\\b`, 'gi');
}

function highlight(text, pattern) {
  const safe = esc(text);
  if (!pattern) return safe;
  return safe.replace(pattern, (m) => `<mark class="word" data-hw="${esc(m.replace(/\s+/g, ' '))}">${m}</mark>`);
}

// ------------------------------------------------------------------ 文章内事件
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

  $('#articleView').addEventListener('click', (e) => {
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
      const key = mark.dataset.hw.toLowerCase().replace(/[^a-z'\- ]/g, '');
      showPopover(mark, glossaryMap.get(key) || findGlossary(glossaryMap, key), key, e.clientX, e.clientY);
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
      else showPopover(card, glossaryMap.get(card.dataset.word.toLowerCase()), card.dataset.word, e.clientX, e.clientY);
    }
  });

  $('#wordList').onclick = (e) => {
    const chip = e.target.closest('.word-chip');
    if (chip) showPopover(chip, glossaryMap.get(chip.dataset.word.toLowerCase()), chip.dataset.word, e.clientX, e.clientY);
  };
}

function findGlossary(map, key) {
  for (const [k, v] of map) {
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

// ------------------------------------------------------------------ 浮层
function showPopover(anchor, g, word, x, y) {
  const pop = $('#popover');
  const body = g
    ? `<div><span class="w">${esc(g.word)}</span>${g.phonetic ? `<span class="ph">${esc(g.phonetic)}</span>` : ''}${
        g.pos ? `<span class="pos">${esc(g.pos)}</span>` : ''
      }</div>
       <p class="cn">${esc(g.cn)}</p>
       ${g.examSense ? `<p class="exam-sense">考研常考：${esc(g.examSense)}</p>` : ''}
       ${g.context ? `<p class="ctx">${esc(g.context)}</p>` : ''}`
    : `<div><span class="w">${esc(word)}</span></div><p class="cn" style="color:var(--ink-soft)">这个词不在今天的词表里。</p>`;

  pop.innerHTML = `${body}
    <div class="links">
      <a href="#" data-say>🔊 朗读</a>
      <a href="https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(word)}" target="_blank" rel="noreferrer">剑桥词典</a>
      <a href="#" data-star>${state.starred.has(word.toLowerCase()) ? '★ 已收藏' : '☆ 收藏生词'}</a>
    </div>`;
  pop.hidden = false;

  const rect = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(Math.max(12, x - 40), window.innerWidth - rect.width - 12)}px`;
  pop.style.top = `${y + rect.height + 24 > window.innerHeight ? Math.max(12, y - rect.height - 12) : y + 14}px`;

  $('[data-say]', pop).onclick = (e) => {
    e.preventDefault();
    speak(g?.word || word);
  };
  $('[data-star]', pop).onclick = (e) => {
    e.preventDefault();
    const k = word.toLowerCase();
    state.starred.has(k) ? state.starred.delete(k) : state.starred.add(k);
    localStorage.setItem('starred', JSON.stringify([...state.starred]));
    e.target.textContent = state.starred.has(k) ? '★ 已收藏' : '☆ 收藏生词';
  };
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#popover') && !e.target.closest('mark.word') && !e.target.closest('.gcard') && !e.target.closest('.word-chip')) {
    $('#popover').hidden = true;
  }
});

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
}

bindTop();
bindModals();
bindImageImport();
renderThumbs();
load().catch((e) => toast(e.message, true));
