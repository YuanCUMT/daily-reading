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
  for (const d of [DATA_DIR, WORDS_DIR, ARTICLES_DIR]) fs.mkdirSync(d, { recursive: true });
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
};
