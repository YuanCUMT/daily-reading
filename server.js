'use strict';
/**
 * 百词斩每日阅读器 —— 本地服务
 * 零第三方依赖，只需要 Node 18+（本项目在 Node 24 上开发验证）。
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');

const store = require('./lib/store');
const { runOcr, extractWords, saveDataUrl } = require('./lib/ocr');
const { generateArticle, cleanOcrWords } = require('./lib/deepseek');
const { lookupWord } = require('./lib/dict');

const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- 工具

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}
const ok = (res, data) => send(res, 200, { ok: true, ...data });
const fail = (res, message, status = 400, extra = {}) => send(res, status, { ok: false, error: message, ...extra });

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) return fail(res, 'forbidden', 403);
  fs.readFile(target, (err, buf) => {
    if (err) {
      // 前端是单页应用，未知路径回落到 index.html
      if (!path.extname(target)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) return fail(res, 'not found', 404);
          send(res, 200, html, { 'Content-Type': MIME['.html'] });
        });
      }
      return fail(res, 'not found', 404);
    }
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
  });
}

// ---------------------------------------------------------------- 单词文本解析

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * 一行可能包含多个词条，先切成若干「条目」。
 * 规则：
 *   - 逗号/分号/竖线/制表符分隔，且每段都以字母开头 → 视为多个词条
 *   - 否则含中文的整行算一个词条（可能是 "give up 放弃" 这种词组）
 *   - 不含中文、空格分隔且 ≥3 个纯英文单词 → 视为多个词条
 */
function splitSegments(line) {
  const parts = line
    .split(/[,;，；、|\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const latinStarts = parts.filter((p) => /^[A-Za-z]/.test(p)).length;
  if (parts.length > 1 && latinStarts >= 2) return parts;

  const hasCJK = CJK.test(line);
  if (hasCJK) return [line];

  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length >= 3 && tokens.every((t) => /^[A-Za-z][A-Za-z'’\-]*$/.test(t))) return tokens;
  return [line];
}

function addSegment(seg, out, seen) {
  const m = seg.match(/[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,2}/);
  if (!m) return;
  const word = m[0].trim();
  if (word.length < 2) return;
  const key = word.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);

  let rest = seg.slice(m.index + word.length).trim();
  const phoneticMatch = rest.match(/\/[^/\n]{1,40}\/|\[[^\]\n]{1,40}\]/);
  const phonetic = phoneticMatch ? phoneticMatch[0] : '';
  if (phonetic) rest = rest.replace(phonetic, ' ').trim();

  let pos = '';
  const posMatch = rest.match(
    /^((?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|abbr|phr)\s*\.(?:\s*&\s*(?:n|v|adj|adv)\.)?)/i
  );
  if (posMatch) {
    pos = posMatch[1].replace(/\s+/g, '');
    rest = rest.slice(posMatch[0].length).trim();
  }
  const meaning = rest.replace(/^[-—:：\s]+/, '').trim();
  out.push({ word, phonetic, pos, meaning });
}

/** 把用户粘贴的任意文本解析成 [{word, phonetic, pos, meaning}] */
function parseWordText(text) {
  const out = [];
  const seen = new Set();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    line = line.replace(/^\d+[.、)\]]\s*/, ''); // 去掉 "1. " 之类的前缀
    if (!line) continue;
    for (const seg of splitSegments(line)) addSegment(seg, out, seen);
  }
  return out;
}

// ---------------------------------------------------------------- 路由

function mask(t) {
  const s = String(t || '');
  if (!s) return '';
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function publicConfig(cfg) {
  return {
    deepseek: {
      baseUrl: cfg.deepseek.baseUrl,
      model: cfg.deepseek.model,
      temperature: cfg.deepseek.temperature,
      hasKey: Boolean(cfg.deepseek.apiKey),
      keyMask: mask(cfg.deepseek.apiKey),
    },
    prefs: cfg.prefs,
  };
}

async function handleApi(req, res, url) {
  const cfg = store.loadConfig();
  const p = url.pathname;

  if (p === '/api/state' && req.method === 'GET') {
    const date = store.normalizeDate(url.searchParams.get('date'));
    return ok(res, {
      today: store.todayStr(),
      date,
      config: publicConfig(cfg),
      dates: store.listArticles(),
      words: store.loadWords(date),
      article: store.loadArticle(date),
      marks: store.loadMarks().marks,
      dictCount: store.dictCount(),
    });
  }

  if (p === '/api/articles' && req.method === 'GET') {
    return ok(res, { articles: store.listArticleSummaries() });
  }

  if (p === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    const patch = {};
    if (body.deepseek) {
      patch.deepseek = {};
      for (const k of ['baseUrl', 'model', 'temperature']) {
        if (body.deepseek[k] !== undefined) patch.deepseek[k] = body.deepseek[k];
      }
      // 空字符串表示「不改动」，避免前端回填掩码后把 key 抹掉
      if (typeof body.deepseek.apiKey === 'string' && body.deepseek.apiKey.trim()) {
        patch.deepseek.apiKey = body.deepseek.apiKey.trim();
      }
      if (body.deepseek.clearKey) patch.deepseek.apiKey = '';
    }
    if (body.prefs) patch.prefs = body.prefs;
    const next = store.saveConfig(patch);
    return ok(res, { config: publicConfig(next) });
  }

  if (p === '/api/words' && req.method === 'POST') {
    const body = await readBody(req);
    const date = store.normalizeDate(body.date);
    let incoming = [];
    if (Array.isArray(body.words) && body.words.length) {
      incoming = body.words
        .map((w) =>
          typeof w === 'string'
            ? { word: String(w).trim(), meaning: '' }
            : {
                word: String(w.word || '').trim(),
                meaning: String(w.meaning || '').trim(),
                phonetic: w.phonetic || '',
                pos: w.pos || '',
              }
        )
        .filter((w) => w.word);
    } else {
      incoming = parseWordText(body.text);
    }
    if (!incoming.length) return fail(res, '没有解析出任何单词，检查一下粘贴内容');

    // 默认「追加并去重」：分几次导入（一次一张截图、或者截图 + 手动粘贴）不会互相冲掉。
    // 需要整表替换时传 mode: 'replace'。
    const existing = store.loadWords(date);
    let words = incoming;
    let added = incoming.length;
    let skipped = 0;

    if (body.mode !== 'replace' && existing?.words?.length) {
      words = existing.words.map((w) => ({ ...w }));
      const index = new Map(words.map((w) => [w.word.toLowerCase(), w]));
      for (const w of incoming) {
        const key = w.word.toLowerCase();
        const hit = index.get(key);
        if (hit) {
          skipped++;
          // 已存在的词：把新拿到的释义/音标补上，不覆盖原有内容
          for (const f of ['meaning', 'phonetic', 'pos']) {
            if (!hit[f] && w[f]) hit[f] = w[f];
          }
          continue;
        }
        const copy = { ...w };
        index.set(key, copy);
        words.push(copy);
        added++;
      }
      added = words.length - (existing.words.length || 0);
    }

    const saved = store.saveWords(date, { source: body.source || '手动输入', words });
    return ok(res, { words: saved, added, skipped, total: saved.words.length, mode: body.mode === 'replace' ? 'replace' : 'merge' });
  }

  if (p === '/api/words' && req.method === 'DELETE') {
    const date = store.normalizeDate(url.searchParams.get('date'));
    store.saveWords(date, { source: '已清空', words: [] });
    return ok(res, { cleared: true, date });
  }

  // ---- 图片 OCR：把手机截图里的单词认出来 ----
  if (p === '/api/ocr' && req.method === 'POST') {
    const body = await readBody(req);
    const images = Array.isArray(body.images) ? body.images : [];
    if (!images.length) return fail(res, '没有收到图片');
    if (images.length > 12) return fail(res, '一次最多 12 张图');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcz-upload-'));
    let ocr;
    try {
      const files = images.map((img, i) => saveDataUrl(img, tmpDir, i)).filter(Boolean);
      if (!files.length) return fail(res, '图片格式不支持，请用 PNG / JPG');
      ocr = await runOcr(files);
      if (!ocr.ok) {
        const msg =
          ocr.error === 'NO_OCR_ENGINE'
            ? `系统里没有可用的 OCR 语言包（已装：${(ocr.available || []).join(', ') || '无'}）。请在 Windows 设置里安装中文或英文语言包。`
            : `OCR 失败：${ocr.message || ocr.error}`;
        return fail(res, msg, 500);
      }

      const extracted = extractWords(ocr.results, { ratio: Number(body.ratio) || 0.72 });
      const failed = (ocr.results || []).filter((r) => r.error);
      const describeError = (e) => {
        if (e === 'HEIC_NOT_SUPPORTED') return 'iPhone 的 HEIC 格式认不了，请先转成 JPG/PNG';
        if (e === 'FILE_NOT_FOUND') return '临时文件不见了';
        return e;
      };

      // 整批都失败时，把真实原因说出来，别让用户看到「没识别出英文单词」这种误导性提示
      if (!ocr.results?.length || failed.length === ocr.results.length) {
        const first = describeError(failed[0]?.error) || '没有可识别的图片';
        return fail(res, `图片识别失败：${first}（PNG / JPG 最稳）`, 500);
      }

      let words = extracted.words;
      let cleaned = false;

      // 可选：让模型修 OCR 拼写错误、剔除界面噪声
      const wantFix = body.fix !== false && cfg.prefs.ocrFix !== false && cfg.deepseek.apiKey;
      if (wantFix && words.length) {
        try {
          const fixed = await cleanOcrWords({ config: cfg, words });
          if (fixed.words.length) {
            words = fixed.words;
            cleaned = true;
          }
        } catch (e) {
          // 校正失败不影响主流程，把原始结果交给用户
          cleaned = false;
        }
      }

      return ok(res, {
        engine: ocr.engine,
        images: ocr.results.map((r) => ({ file: r.file, lines: (r.lines || []).length, error: r.error })),
        perImage: extracted.perImage || [],
        failedImages: failed.map((r) => ({ file: r.file, error: describeError(r.error) })),
        rawLines: ocr.results.flatMap((r) => (r.lines || []).map((l) => l.text)),
        words: words.map((w) => ({ word: w, meaning: '' })),
        strict: extracted.strict,
        cleaned,
        hint: words.length
          ? `从 ${ocr.results.length} 张图识别出 ${words.length} 个候选词${cleaned ? '（已用 AI 校正拼写）' : ''}${failed.length ? `，其中 ${failed.length} 张识别失败已跳过` : ''}，确认后保存。`
          : `处理了 ${ocr.results.length} 张图，但没找出英文单词。${failed.length ? `其中 ${failed.length} 张识别失败。` : '确认截图里单词清晰、没有被裁掉。'}`,
      });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  if (p === '/api/article/generate' && req.method === 'POST') {
    const body = await readBody(req);
    const date = store.normalizeDate(body.date);
    const wordRecord = store.loadWords(date);
    let words = wordRecord?.words || [];
    if (Array.isArray(body.words) && body.words.length) {
      words = body.words.map((w) => (typeof w === 'string' ? { word: w } : w));
      store.saveWords(date, { source: '临时输入', words });
    }
    if (!words.length) return fail(res, '这一天还没有单词，先导入或粘贴单词');

    const dynamicCfg = { ...cfg, prefs: { ...cfg.prefs, ...(body.prefs || {}) } };
    if (body.apiKey && String(body.apiKey).trim()) {
      dynamicCfg.deepseek = { ...cfg.deepseek, apiKey: String(body.apiKey).trim() };
    }
    const started = Date.now();
    const article = await generateArticle({ config: dynamicCfg, words, date });
    const mode = dynamicCfg.prefs.mode === 'exam' ? 'exam' : 'review';

    // 真题模式只用到其中一部分词，所以「没出现在文中的词」是正常的，不算遗漏
    const glossaryWords = new Set(article.glossary.map((g) => g.word.toLowerCase()));
    const unusedWords = mode === 'exam' ? words.map((w) => w.word).filter((w) => !glossaryWords.has(w.toLowerCase())) : [];
    if (mode === 'exam') article.missingWords = [];

    const saved = store.saveArticle(date, {
      ...article,
      date,
      mode,
      usedWords: article.glossary.map((g) => g.word),
      totalWords: words.length,
      unusedWords,
      elapsedMs: Date.now() - started,
    });
    return ok(res, { article: saved, mode });
  }

  if (p === '/api/article' && req.method === 'GET') {
    const date = store.normalizeDate(url.searchParams.get('date'));
    return ok(res, { date, article: store.loadArticle(date) });
  }

  if (p === '/api/article' && req.method === 'DELETE') {
    const date = store.normalizeDate(url.searchParams.get('date'));
    return ok(res, { deleted: store.deleteArticle(date) });
  }

  // ---- 划词查词 ----
  if (p === '/api/lookup' && req.method === 'GET') {
    const word = url.searchParams.get('word') || '';
    const context = url.searchParams.get('context') || '';
    if (!word.trim()) return fail(res, '缺少 word 参数');
    try {
      const { entry, cached } = await lookupWord({
        config: cfg,
        word,
        context,
        refresh: url.searchParams.get('refresh') === '1',
      });
      return ok(res, { entry, cached, hasKey: Boolean(cfg.deepseek.apiKey) });
    } catch (e) {
      // NO_KEY / BAD_WORD 是用户能自己解决的情况，别报成 500
      const status = e.code === 'NO_KEY' ? 400 : e.code === 'BAD_WORD' ? 400 : 500;
      return fail(res, e.message || String(e), status, { code: e.code || 'LOOKUP_FAILED' });
    }
  }

  // ---- 查词缓存 ----
  if (p === '/api/dict' && req.method === 'DELETE') {
    return ok(res, { dictCount: store.clearDict() });
  }

  // ---- 生词本 ----
  if (p === '/api/marks' && req.method === 'GET') {
    return ok(res, { marks: store.loadMarks().marks });
  }

  if (p === '/api/marks' && req.method === 'POST') {
    const body = await readBody(req);
    const word = String(body.word || '').trim();
    if (!word) return fail(res, '单词为空');
    const saved = store.addMark({
      word,
      lemma: String(body.lemma || '').trim() || undefined,
      phonetic: String(body.phonetic || '').trim(),
      pos: String(body.pos || '').trim(),
      cn: String(body.cn || '').trim(),
      examSense: String(body.examSense || '').trim(),
      collocation: String(body.collocation || '').trim(),
      note: String(body.note || '').trim(),
      articleDate: body.articleDate ? store.normalizeDate(body.articleDate) : undefined,
    });
    return ok(res, saved);
  }

  if (p === '/api/marks/mastered' && req.method === 'POST') {
    const body = await readBody(req);
    const word = String(body.word || '').trim();
    if (!word) return fail(res, '单词为空');
    try {
      return ok(res, store.setMarkMastered(word, !!body.mastered));
    } catch (err) {
      return fail(res, err.message || String(err), 400);
    }
  }

  if (p === '/api/marks' && req.method === 'DELETE') {
    if (url.searchParams.get('all') === '1') {
      return ok(res, store.saveMarks({ marks: [] }));
    }
    const word = url.searchParams.get('word') || '';
    if (!word.trim()) return fail(res, '缺少 word 参数');
    return ok(res, store.removeMark(word));
  }

  if (p === '/api/parse-words' && req.method === 'POST') {
    const body = await readBody(req);
    return ok(res, { words: parseWordText(body.text) });
  }

  return fail(res, `未知接口 ${req.method} ${p}`, 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (err) {
    return fail(res, err.message || String(err), 500);
  }
});

// ---------------------------------------------------------------- 启动

/**
 * 用系统默认浏览器打开页面。
 * dryRun 只返回命令、不真的执行（测试用）。
 * 只有 start.cmd 会设 BCZ_OPEN_BROWSER=1，测试和其他启动方式不会弹浏览器。
 */
function openBrowser(url, { dryRun = false, port = PORT } = {}) {
  const u = url || `http://${HOST}:${port}`;
  const cmd = process.platform === 'win32' ? { file: 'cmd', args: ['/c', 'start', '', u] } : { file: 'xdg-open', args: [u] };
  if (dryRun) return cmd;
  try {
    spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    console.log(`  （没能自动打开浏览器，请手动访问 ${u}）`);
  }
  return cmd;
}

/** 数据目录里已有的文章/单词，用来自检是否装好了 */
function summary() {
  return `${store.listArticles().length} 篇文章`;
}

function start(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    // 端口被占用说明已经开着一个了 —— 直接说清楚，并把浏览器指向已有实例，
    // 而不是让新进程默默崩掉（那会让人以为启动成功了）
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`\n  端口 ${port} 已经被占用：这个程序很可能已经开着了。`);
        console.log(`  →  正在打开 http://${host}:${port}\n`);
        console.log(`  如果你刚改过代码，请先关掉那个旧的启动窗口再重新启动。\n`);
        if (process.env.BCZ_OPEN_BROWSER === '1') openBrowser(null, { port });
        reject(new Error(`端口 ${port} 已被占用`));
        return;
      }
      reject(err);
    });

    server.listen(port, host, () => {
      store.ensureDirs();
      console.log(`\n  每日阅读 · 考研英语 —— 已启动`);
      console.log(`  →  http://${host}:${port}\n`);
      console.log(`  数据目录: ${store.DATA_DIR}（${summary()}）`);
      console.log(`  截图识别: Windows 自带 OCR（本地，不联网）`);
      console.log(`  停止服务: Ctrl + C\n`);
      if (process.env.BCZ_OPEN_BROWSER === '1') openBrowser(null, { port });
      resolve(server.address());
    });
  });
}

if (require.main === module) {
  start().catch((e) => {
    if (!/已被占用/.test(e.message)) console.error(e);
    process.exitCode = 1;
  });
}

module.exports = { parseWordText, start, server, openBrowser };
