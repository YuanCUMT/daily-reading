'use strict';
/**
 * 极简 JSON 文件存储：data/config.json、data/words/<date>.json、data/articles/<date>.json
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// 允许通过环境变量切换数据目录（测试用）
const DATA_DIR = process.env.BCZ_READER_DATA
  ? path.resolve(process.env.BCZ_READER_DATA)
  : path.join(ROOT, 'data');
const WORDS_DIR = path.join(DATA_DIR, 'words');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');
const DICT_DIR = path.join(DATA_DIR, 'dict');
const MARKS_FILE = path.join(DATA_DIR, 'marks.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  deepseek: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 1.0,
  },
  prefs: {
    mode: 'review',
    level: 'C1（考研英语一难度）',
    paragraphs: 6,
    style: '考研真题风格（社科 / 科普议论文）',
    withQuestions: true,
    questionCount: 5,
    withLongSentences: true,
    ocrFix: true,
    examWordLimit: 15,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, WORDS_DIR, ARTICLES_DIR, DICT_DIR]) fs.mkdirSync(d, { recursive: true });
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadConfig() {
  ensureDirs();
  return deepMerge(DEFAULT_CONFIG, readJson(CONFIG_FILE, {}));
}

function saveConfig(patch) {
  const next = deepMerge(loadConfig(), patch);
  writeJson(CONFIG_FILE, next);
  return next;
}

// ---- 日期 ----
function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function normalizeDate(s) {
  if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return todayStr();
}

// ---- 单词 ----
function wordsFile(date) {
  return path.join(WORDS_DIR, `${normalizeDate(date)}.json`);
}
function loadWords(date) {
  return readJson(wordsFile(date), null);
}
function saveWords(date, payload) {
  const value = { date: normalizeDate(date), ...payload };
  writeJson(wordsFile(date), value);
  return value;
}

// ---- 文章 ----
function articleFile(date) {
  return path.join(ARTICLES_DIR, `${normalizeDate(date)}.json`);
}
function loadArticle(date) {
  return readJson(articleFile(date), null);
}
function saveArticle(date, payload) {
  const value = { date: normalizeDate(date), ...payload };
  writeJson(articleFile(date), value);
  return value;
}
function deleteArticle(date) {
  const f = articleFile(date);
  if (fs.existsSync(f)) {
    fs.rmSync(f);
    return true;
  }
  return false;
}
function listArticles() {
  ensureDirs();
  return fs
    .readdirSync(ARTICLES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

/** 历史文章卡片用的摘要：只读每篇开头的几个字段，不把整篇文章塞进首页 */
function listArticleSummaries() {
  return listArticles().map((date) => {
    const a = loadArticle(date);
    if (!a) return { date, title: '', titleZh: '', mode: 'review', paragraphs: 0, wordCount: 0 };
    return {
      date,
      title: a.title || '',
      titleZh: a.titleZh || '',
      mode: a.mode === 'exam' ? 'exam' : 'review',
      paragraphs: Array.isArray(a.paragraphs) ? a.paragraphs.length : 0,
      wordCount: a.wordCount || 0,
      usedWords: (a.usedWords || a.words || []).length,
    };
  });
}

// ---- 单词本（按天汇总）----
// 侧栏只放今天那天的词，单词本要能看到历史上所有天加的词，所以单独给一个读全部的函数。
function listWordDays() {
  ensureDirs();
  return fs
    .readdirSync(WORDS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
    .reverse()
    .map((date) => {
      const payload = loadWords(date);
      const words = (Array.isArray(payload?.words) ? payload.words : []).filter((w) => w && w.word);
      return { date, words };
    })
    .filter((d) => d.words.length > 0);
}

// ---- 查词缓存 ----
// 每个词一个小 JSON（data/dict/<word>.json）。这样用户可以自己打开看、删掉重查，
// 也不用把一个越来越大的字典塞进单个文件里。
function dictKey(word) {
  const k = String(word || '').trim().toLowerCase().replace(/\s+/g, ' ');
  // 只允许可能出现在英文里的字符，顺带挡住 ../ 之类的目录穿越。
  // 长度放宽到 60，短语句子以外的一般搭配（take into account 之类）都装得下
  if (!/^[a-z][a-z'\- ]{0,59}$/.test(k)) return null;
  return k;
}

function dictFile(word) {
  const k = dictKey(word);
  return k ? path.join(DICT_DIR, `${k.replace(/\s+/g, '_')}.json`) : null;
}

function loadDictEntry(word) {
  const f = dictFile(word);
  return f ? readJson(f, null) : null;
}

function saveDictEntry(word, entry) {
  const f = dictFile(word);
  if (!f) return null;
  const value = { ...entry, key: dictKey(word), lookedUpAt: new Date().toISOString() };
  writeJson(f, value);
  return value;
}

/** 已经查过多少个词（只用于界面上的小统计） */
function dictCount() {
  try {
    return fs.readdirSync(DICT_DIR).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/** 清空查词缓存（换了模型或发现释义不对时可以手动倒掉） */
function clearDict() {
  try {
    for (const f of fs.readdirSync(DICT_DIR)) {
      if (f.endsWith('.json')) fs.rmSync(path.join(DICT_DIR, f), { force: true });
    }
  } catch {}
  return dictCount();
}

// ---- 生词本 ----
function normalizeMarkKey(word) {
  return String(word || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function loadMarks() {
  const data = readJson(MARKS_FILE, null);
  const list = Array.isArray(data?.marks) ? data.marks : [];
  return {
    marks: list
      .filter((m) => m && normalizeMarkKey(m.word))
      .map((m) => ({
        mastered: false,
        ...m,
        word: normalizeMarkKey(m.word),
      })),
  };
}

function saveMarks({ marks }) {
  const list = (Array.isArray(marks) ? marks : []).slice(0, 2000);
  writeJson(MARKS_FILE, { marks: list });
  return { marks: list };
}

/** 加一个生词；已经存在就更新释义等字段，不重复添加 */
function addMark(entry) {
  const key = normalizeMarkKey(entry.word);
  if (!key) throw new Error('单词为空');
  const { marks } = loadMarks();
  const idx = marks.findIndex((m) => m.word === key);
  const now = new Date().toISOString();
  const merged = {
    ...(idx >= 0 ? marks[idx] : { addedAt: now }),
    ...entry,
    word: key,
    ...(idx >= 0 ? { addedAt: marks[idx].addedAt || now } : {}),
  };
  if (idx >= 0) marks[idx] = merged;
  else marks.unshift(merged);
  saveMarks({ marks });
  return { mark: merged, marks };
}

/**
 * 批量加生词（导入单词时用）。
 * 已在生词本里的只补空着的字段，不覆盖已有的释义/笔记，也不改它的收藏时间。
 */
function addMarks(entries) {
  const incoming = Array.isArray(entries) ? entries : [];
  if (!incoming.length) return { added: 0, total: loadMarks().marks.length };
  const { marks } = loadMarks();
  const index = new Map(marks.map((m, i) => [m.word, i]));
  const now = new Date().toISOString();
  let added = 0;
  for (const entry of incoming) {
    const key = normalizeMarkKey(entry && entry.word);
    if (!key) continue;
    const at = index.get(key);
    if (at === undefined) {
      marks.unshift({
        word: key,
        cn: entry.cn || '',
        phonetic: entry.phonetic || '',
        pos: entry.pos || '',
        mastered: false,
        addedAt: now,
      });
      index.set(key, 0);
      for (const [k, v] of index) if (k !== key) index.set(k, v + 1);
      added++;
      continue;
    }
    const cur = marks[at];
    for (const f of ['cn', 'phonetic', 'pos']) {
      if (!cur[f] && entry[f]) cur[f] = entry[f];
    }
  }
  saveMarks({ marks });
  return { added, total: marks.length };
}

function removeMark(word) {
  const key = normalizeMarkKey(word);
  const { marks } = loadMarks();
  const next = marks.filter((m) => m.word !== key);
  saveMarks({ marks: next });
  return { removed: next.length !== marks.length, marks: next };
}

/** 标记「已掌握 / 回到学习中」。掌握时间留着，取消时清掉 */
function setMarkMastered(word, mastered) {
  const key = normalizeMarkKey(word);
  const { marks } = loadMarks();
  const idx = marks.findIndex((m) => m.word === key);
  if (idx < 0) throw new Error('生词本里没有这个词');
  const now = new Date().toISOString();
  marks[idx] = {
    ...marks[idx],
    mastered: !!mastered,
    masteredAt: mastered ? now : undefined,
  };
  if (!mastered) delete marks[idx].masteredAt;
  saveMarks({ marks });
  return { mark: marks[idx], marks };
}

function isMarked(word) {
  const key = normalizeMarkKey(word);
  return loadMarks().marks.some((m) => m.word === key || normalizeMarkKey(m.lemma) === key);
}

module.exports = {
  ROOT,
  DATA_DIR,
  ensureDirs,
  loadConfig,
  saveConfig,
  DEFAULT_CONFIG,
  todayStr,
  normalizeDate,
  loadWords,
  saveWords,
  loadArticle,
  saveArticle,
  deleteArticle,
  listArticles,
  listArticleSummaries,
  listWordDays,
  dictKey,
  loadDictEntry,
  saveDictEntry,
  dictCount,
  clearDict,
  normalizeMarkKey,
  loadMarks,
  saveMarks,
  addMark,
  addMarks,
  removeMark,
  setMarkMastered,
  isMarked,
};
