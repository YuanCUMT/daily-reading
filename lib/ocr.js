'use strict';
/**
 * 本地图片文字识别（Windows 自带 OCR）。
 *
 * 走 Windows.Media.Ocr：不联网、不需要 API Key、不用装东西。
 * 通过 Windows PowerShell 5.1 调用（PowerShell 7 对 WinRT 的支持不完整）。
 *
 * 关键点：结果里带每个词的**字号**。百词斩的单词卡上，目标单词是屏幕上最大的
 * 那行字，例句和界面文字都更小 —— 所以按字号过滤就能自动挑出真正要背的词。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PS1 = path.join(__dirname, 'ocr.ps1');
const SPLIT_PS1 = path.join(__dirname, 'split-images.ps1');

/**
 * Windows OCR 的硬上限：OcrEngine.MaxImageDimension = 10000 像素（宽高任一超了，
 * RecognizeAsync 直接抛 "Image dimensions are too large!"）。手机长截图很容易超过
 * 这个高度，所以超限的图先切成几块分别识别，再按坐标拼回一张结果。
 */
const MAX_DIM = 10000;
/** 相邻切块的重叠高度：避免正好把一行字从中间切断 */
const SLICE_OVERLAP = 240;

const WIN_PS = [
  path.join(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  'powershell.exe',
];

/** 识别结果里要丢掉的界面噪声 */
const STOP = new Set([
  'ok', 'yes', 'no', 'next', 'skip', 'done', 'back', 'close', 'cancel', 'confirm', 'submit',
  'review', 'learn', 'learning', 'study', 'word', 'words', 'english', 'chinese', 'mean',
  'meaning', 'example', 'sentence', 'correct', 'wrong', 'right', 'answer', 'question',
  'score', 'level', 'day', 'days', 'week', 'month', 'year', 'today', 'total', 'progress',
  'setting', 'settings', 'help', 'about', 'login', 'logout', 'share', 'search', 'list',
  'the', 'and', 'for', 'you', 'are', 'was', 'were', 'this', 'that', 'with', 'have', 'has',
  'not', 'but', 'his', 'her', 'she', 'him', 'they', 'them', 'from', 'what', 'when', 'which',
  'who', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'been', 'being',
  'into', 'than', 'then', 'there', 'their', 'about', 'would', 'make', 'made', 'like', 'just',
  'over', 'such', 'only', 'also', 'more', 'most', 'some', 'any', 'all', 'one', 'two', 'get',
]);

/** 丢掉界面噪声 + 去重 */
function pickWords(list, maxWords) {
  const seen = new Map();
  for (const it of list) {
    const low = it.word.toLowerCase();
    if (STOP.has(low)) continue;
    if (/^[A-Z]{2,4}$/.test(it.word)) continue; // 全大写短词多半是 logo / 缩写
    if (!seen.has(low)) seen.set(low, it.word);
    if (seen.size >= maxWords) break;
  }
  return [...seen.values()];
}

/**
 * 从 OCR 结果里按字号挑出候选单词。
 * 字号阈值**每张图单独计算**：单词卡上目标词远大于例句，而单词列表页所有词一样大；
 * 如果跨图统一算阈值，单词卡的大字会把列表页的小字全部压掉。
 */
function extractWords(results, { ratio = 0.72, maxWords = 80 } = {}) {
  const collected = [];
  const perImage = [];
  let strict = true;
  let sawAny = false;

  for (const r of results || []) {
    const all = [];
    for (const line of r.lines || []) {
      for (const w of line.words || []) {
        const t = String(w.t || '').trim();
        if (!/^[A-Za-z][A-Za-z'’-]*$/.test(t)) continue;
        if (t.length < 2) continue;
        all.push({ word: t, h: Number(w.h) || 0 });
      }
    }
    if (!all.length) continue;
    sawAny = true;

    const maxHeight = Math.max(...all.map((w) => w.h));
    let words = pickWords(
      all.filter((w) => w.h >= maxHeight * ratio),
      maxWords
    );
    if (!words.length) {
      // 整张图字号都差不多（比如被裁得很小），或者压根没有明显大字：退回全量
      words = pickWords(all, maxWords);
      strict = false;
    }
    perImage.push({ file: r.file, maxHeight, words });
    collected.push(...words);
  }

  // 跨图去重，保持出现顺序
  const seen = new Map();
  for (const w of collected) {
    const low = w.toLowerCase();
    if (!seen.has(low)) seen.set(low, w);
    if (seen.size >= maxWords) break;
  }

  return { words: [...seen.values()], strict: sawAny ? strict : true, perImage, maxHeight: perImage[0]?.maxHeight || 0 };
}

function findPowerShell() {
  for (const p of WIN_PS) {
    if (p === 'powershell.exe' || fs.existsSync(p)) return p;
  }
  return null;
}

/** 本模块与 ocr.ps1 之间的接口版本；两边对不上就明确报错，而不是给出莫名其妙的失败 */
const BRIDGE_VERSION = 2;

/** 只读文件头判断宽高：PNG / JPEG / GIF / WEBP，不整张解码 */
function readImageSize(buf) {
  if (!buf || buf.length < 12) return null;
  try {
    // PNG：签名 89 50 4E 47，IHDR 的宽高在第 16、20 字节（大端）
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF：逻辑屏幕宽高，小端
    if (buf.toString('latin1', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // JPEG：逐个段扫到 SOF（C0~CF，但不含 C4/C8/CC）
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const m = buf[i + 1];
        if (m === 0xff) {
          i++;
          continue;
        }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = buf.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    // WEBP：VP8X 存的是「宽-1 / 高-1」的 24 位小端；VP8 是 14 位
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8X') {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
      if (chunk === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
    }
  } catch {}
  return null;
}

/** 把超大图切成若干块（交给 split-images.ps1），失败返回 null */
function splitImage(ps, file, destDir, prefix) {
  return new Promise((resolve) => {
    const outFile = path.join(destDir, `${prefix}.split.json`);
    const child = spawn(
      ps,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SPLIT_PS1,
        '-Path',
        file,
        '-OutDir',
        destDir,
        '-Prefix',
        prefix,
        '-MaxDim',
        String(MAX_DIM),
        '-Overlap',
        String(SLICE_OVERLAP),
        '-OutFile',
        outFile,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    );
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        if (!parsed.ok || !Array.isArray(parsed.slices) || !parsed.slices.length) return resolve(null);
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });
  });
}

/** 去掉大小写/标点，用来判断两块切片是不是认出了同一行 */
function normalizeLine(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'’-]+/g, ' ')
    .trim();
}

/**
 * 重叠区里同一行会被两块切片各认一次（还可能被切成半截）。
 * 按 y 排序后，相邻且文本相同 / 一方是另一方前缀的，只留更长的那条。
 */
function isSameLine(a, b) {
  const na = normalizeLine(a.text);
  const nb = normalizeLine(b.text);
  if (!na || !nb) return false;
  const ha = a.words?.[0]?.h || 20;
  const hb = b.words?.[0]?.h || 20;
  const near = Math.abs(a.y - b.y) <= Math.max(ha, hb);
  if (!near) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.startsWith(nb) || nb.startsWith(na))) return true;
  return false;
}

/** 把一张超长图的各切片结果拼回「一张图」的样子（坐标换回原图） */
function mergeSlices(unit, sliceResults) {
  const good = sliceResults.filter((r) => r && !r.error);
  if (!good.length) {
    const err = sliceResults.find((r) => r && r.error)?.error || 'SLICE_FAILED';
    return { file: path.basename(unit.orig), path: unit.orig, error: err, lines: [], text: '' };
  }
  const lines = [];
  unit.slices.forEach((s, i) => {
    const r = sliceResults[i];
    if (!r || r.error) return;
    for (const line of r.lines || []) {
      const words = (line.words || []).map((w) => ({ ...w, x: w.x + (s.x || 0), y: w.y + (s.y || 0) }));
      const y = words.length ? Math.min(...words.map((w) => w.y)) : 0;
      lines.push({ text: line.text, words, y });
    }
  });
  lines.sort((a, b) => a.y - b.y);

  const merged = [];
  for (const line of lines) {
    const prev = merged[merged.length - 1];
    if (prev && isSameLine(prev, line)) {
      if (line.text.length > prev.text.length) merged[merged.length - 1] = line;
      continue;
    }
    merged.push(line);
  }

  return {
    file: path.basename(unit.orig),
    path: unit.orig,
    width: unit.size?.width,
    height: unit.size?.height,
    sliced: unit.slices.length,
    lines: merged.map(({ text, words }) => ({ text, words })),
    text: merged.map((l) => l.text).join('\n'),
  };
}

/** 调 ocr.ps1 识别一批图片文件（这些文件保证都没超尺寸） */
function runBridge(ps, files, tmp) {
  return new Promise((resolve) => {
    const outFile = path.join(tmp, 'out.json');
    const listB64 = Buffer.from(JSON.stringify(files), 'utf8').toString('base64');

    const child = spawn(
      ps,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        PS1,
        '-ListB64',
        listB64,
        '-OutFile',
        outFile,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    );

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => resolve({ ok: false, error: 'SPAWN_FAILED', message: String(e.message) }));
    child.on('close', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      } catch (e) {
        return resolve({
          ok: false,
          error: 'OCR_FAILED',
          message: (stderr || String(e.message)).slice(0, 400),
        });
      }
      if (parsed.bridge !== BRIDGE_VERSION) {
        // 服务进程里加载的 ocr.js 和磁盘上的 ocr.ps1 版本不一致（改了代码但没重启服务）
        return resolve({
          ok: false,
          error: 'BRIDGE_MISMATCH',
          message: `OCR 脚本版本不匹配（脚本报告 ${parsed.bridge ?? '未知'}，程序需要 ${BRIDGE_VERSION}）。请关掉启动窗口后重新双击图标。`,
        });
      }
      resolve(parsed);
    });
  });
}

/**
 * 对一组本地图片跑 OCR。
 * 超过 10000 像素的图会先切块再识别，结果按原图归并。
 * @param {string[]} imagePaths
 * @returns {Promise<{ok:boolean, engine?:string, available?:string[], results?:Array, error?:string}>}
 */
async function runOcr(imagePaths) {
  const ps = findPowerShell();
  if (!ps) {
    return { ok: false, error: 'NO_POWERSHELL', message: '找不到 Windows PowerShell' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcz-ocr-'));
  try {
    // 1. 规划：超尺寸的图先切块
    const plan = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const p = imagePaths[i];
      let size = null;
      try {
        size = readImageSize(fs.readFileSync(p));
      } catch {}
      let unit = { orig: p, size, slices: [{ file: p, x: 0, y: 0 }] };
      if (size && Math.max(size.width, size.height) > MAX_DIM) {
        const sp = await splitImage(ps, p, tmp, `slice-${i}`);
        if (sp) {
          unit = {
            orig: p,
            size: { width: sp.width, height: sp.height },
            slices: sp.slices,
            split: true,
          };
        }
      }
      plan.push(unit);
    }

    // 2. 所有切块一次交给 PowerShell（每块都在尺寸上限内）
    const flat = [];
    for (const u of plan) for (const s of u.slices) flat.push(s.file);
    const raw = await runBridge(ps, flat, tmp);
    if (!raw.ok || !Array.isArray(raw.results)) return raw;

    // 3. 归并回「每张原图一个结果」
    const results = [];
    let k = 0;
    for (const u of plan) {
      const mine = u.slices.map(() => raw.results[k++]);
      results.push(u.split ? mergeSlices(u, mine) : mine[0]);
    }

    // 4. 把引擎的英文原始报错换成能看懂的标记，交给 server 翻译成中文
    for (const r of results) {
      if (r && r.error && /too large|MaxImageDimension/i.test(r.error)) r.error = 'TOO_LARGE';
    }

    return { ...raw, results };
  } finally {
    cleanup(tmp);
  }
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/** 把 dataURL / base64 存成临时图片文件 */
function saveDataUrl(dataUrl, destDir, index) {
  const m = String(dataUrl).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return null;
  const ext = m[1].includes('png') ? '.png' : m[1].includes('webp') ? '.webp' : m[1].includes('gif') ? '.gif' : '.jpg';
  const file = path.join(destDir, `shot-${index}${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

module.exports = { runOcr, extractWords, saveDataUrl, STOP, MAX_DIM, readImageSize, mergeSlices, isSameLine };
