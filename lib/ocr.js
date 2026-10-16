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

/**
 * 对一组本地图片跑 OCR。
 * @param {string[]} imagePaths
 * @returns {Promise<{ok:boolean, engine?:string, available?:string[], results?:Array, error?:string}>}
 */
function runOcr(imagePaths) {
  return new Promise((resolve) => {
    const ps = findPowerShell();
    if (!ps) {
      return resolve({ ok: false, error: 'NO_POWERSHELL', message: '找不到 Windows PowerShell' });
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcz-ocr-'));
    const outFile = path.join(tmp, 'out.json');
    // 图片路径用 base64(JSON) 直接当参数传，不落中间文件：
    // 少一个临时文件、少一层编码，也杜绝了「Node 写 JSON / 脚本按行读」这类格式错配。
    const listB64 = Buffer.from(JSON.stringify(imagePaths), 'utf8').toString('base64');

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
    child.on('error', (e) => {
      cleanup(tmp);
      resolve({ ok: false, error: 'SPAWN_FAILED', message: String(e.message) });
    });
    child.on('close', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      } catch (e) {
        cleanup(tmp);
        return resolve({
          ok: false,
          error: 'OCR_FAILED',
          message: (stderr || String(e.message)).slice(0, 400),
        });
      }
      cleanup(tmp);

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

module.exports = { runOcr, extractWords, saveDataUrl, STOP };
