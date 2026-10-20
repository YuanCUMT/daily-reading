'use strict';
/**
 * 端到端测试：假模型 + 真服务 + 真 HTTP + 真 Windows OCR。
 * 运行： node test/e2e.js
 *
 * 覆盖：静态页面、配置读写、单词解析、截图 OCR、文章生成、归档读取、删除、密钥掩码。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MPORT = 8899;
const SPORT = 8791;
const BASE = `http://127.0.0.1:${SPORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bcz-reader-test-'));
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

let passed = 0;
let skipped = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name} ${extra}`);
  }
}
function skip(name, why) {
  skipped++;
  console.log(`  ~ 跳过 ${name}（${why}）`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

async function json(pathname, options) {
  const res = await fetch(BASE + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

(async () => {
  console.log(`\n数据目录: ${DATA}\n`);

  const mock = spawn(process.execPath, [path.join(ROOT, 'test', 'mock-llm.js'), String(MPORT)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, BCZ_READER_DATA: DATA, PORT: String(SPORT) },
  });

  const cleanup = () => {
    mock.kill();
    srv.kill();
    try {
      fs.rmSync(DATA, { recursive: true, force: true });
    } catch {}
  };

  try {
    check('mock 模型已启动', await waitFor(`http://127.0.0.1:${MPORT}/chat/completions`));
    check('阅读器服务已启动', await waitFor(`${BASE}/`));

    // ---- 1. 静态页面 ----
    const page = await fetch(`${BASE}/`);
    const html = await page.text();
    check('首页返回 200', page.status === 200);
    check('首页是阅读器页面', html.includes('每日阅读'));
    check('页面里已经去掉了百词斩导入', !html.includes('百词斩抓取') && !html.includes('accessToken'));
    check('页面里有常驻的截图入口', html.includes('id="dropzone"') && html.includes('id="intake"'));
    check('导入区不再藏在弹窗里', !html.includes('modalImport') && !html.includes('上传截图识别'));

    // 生词本页：列表 / 网状切换、词条卡片、补全入口
    const marksPage = await fetch(`${BASE}/marks.html`);
    const marksHtml = await marksPage.text();
    const marksJs = await (await fetch(`${BASE}/marks.js`)).text();
    check('生词本页可取', marksPage.status === 200 && marksHtml.includes('生词本'));
    check(
      '生词本有列表 / 网状两种视图',
      marksHtml.includes('data-view="list"') && marksHtml.includes('data-view="graph"') && marksJs.includes('function tileHTML')
    );
    check('生词本有词条卡片容器', marksHtml.includes('id="wordCard"') && marksHtml.includes('id="wordCardBody"'));
    check('生词本有补全入口', marksHtml.includes('id="btnEnrich"') && marksJs.includes('/api/marks/enrich'));
    check('生词本文案没有乱码替换符', !marksHtml.includes('\uFFFD') && !marksJs.includes('\uFFFD'));
    const css = await fetch(`${BASE}/style.css`);
    check('样式表可取', css.status === 200 && (await css.text()).includes('.article-body'));
    const js = await fetch(`${BASE}/app.js`);
    const jsText = await js.text();
    check('前端脚本可取', js.status === 200 && jsText.includes('renderArticle'));
    check('前端已经不再请求百词斩接口', !jsText.includes('/api/fetch-words') && !jsText.includes('/api/check-baicizhan'));

    // ---- 2. 初始状态 ----
    // 脚本类文件的编码/换行是踩过坑的地方：cmd.exe 按 ANSI 代码页逐字节解析 .cmd，
    // UTF-8 中文会把它的解析指针搞错位；只有 LF 也会让 if(...) 块解析失败。
    const startCmd = fs.readFileSync(path.join(ROOT, 'start.cmd'));
    check('start.cmd 是纯 ASCII', !startCmd.some((b) => b > 127));
    check('start.cmd 用 CRLF 换行', !/(?<!\r)\n/.test(startCmd.toString('latin1')));
    const ocrPs1 = fs.readFileSync(path.join(ROOT, 'lib', 'ocr.ps1'));
    check('ocr.ps1 是纯 ASCII（PS 5.1 按 ANSI 读 .ps1）', !ocrPs1.some((b) => b > 127));
    const splitPs1 = fs.readFileSync(path.join(ROOT, 'lib', 'split-images.ps1'));
    check('split-images.ps1 是纯 ASCII（同 ocr.ps1）', !splitPs1.some((b) => b > 127));
    // install-shortcut.ps1 里有中文快捷方式名，必须带 UTF-8 BOM，否则 PS 5.1 会按 ANSI 解码成乱码
    const shortcutPs1 = fs.readFileSync(path.join(ROOT, 'tools', 'install-shortcut.ps1'));
    check(
      'install-shortcut.ps1 带 UTF-8 BOM',
      shortcutPs1[0] === 0xef && shortcutPs1[1] === 0xbb && shortcutPs1[2] === 0xbf,
      `前三个字节: ${[...shortcutPs1.slice(0, 3)].join(',')}`
    );
    // start.cmd 必须被 .gitignore/.gitattributes 之外的东西保护：确认它没进 data/，且仓库配置里强制 CRLF
    const gitattributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
    check('.gitattributes 强制 .cmd 用 CRLF', /\*\.cmd\s+text\s+eol=crlf/.test(gitattributes));
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    check('.gitignore 排除了 data/（里面有 API Key）', /^data\/$/m.test(gitignore));
    check('start.cmd 指向 server.js', startCmd.toString('latin1').includes('node server.js'));
    // start.cmd 不能自己写中文（见上方注释），但它要用 type 打出中文提示，
    // 所以提示文本单独放在 UTF-8 .txt 里：必须无 BOM（否则 type 会把 BOM 打成乱码），
    // 且必须真的是 UTF-8（cmd 在 chcp 65001 下按 UTF-8 解释这些字节）。
    for (const [name, needle] of [
      ['msg-no-node.txt', '没有找到 Node.js'],
      ['msg-old-node.txt', '版本太旧'],
    ]) {
      const p = path.join(ROOT, 'tools', name);
      const raw = fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0);
      check(`tools/${name} 存在且非空`, raw.length > 0);
      check(
        `tools/${name} 无 UTF-8 BOM`,
        !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf)
      );
      let decoded = null;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {}
      check(`tools/${name} 是合法 UTF-8`, decoded !== null && decoded.includes(needle));
      check(`start.cmd 会用 type 打出 ${name}`, startCmd.toString('latin1').includes(name));
    }

    const { openBrowser } = require(path.join(ROOT, 'server.js'));
    const dry = openBrowser('http://127.0.0.1:1234', { dryRun: true });
    check('自动开浏览器只走 start.cmd 的开关，测试不会弹窗', dry.args.includes('http://127.0.0.1:1234') && dry.file === 'cmd');

    const s0 = await json('/api/state');
    check('初始状态 ok', s0.data.ok === true);
    check('初始无文章', s0.data.article === null);
    check('初始无 key', s0.data.config.deepseek.hasKey === false);
    check('配置里已经没有百词斩项', s0.data.config.baicizhan === undefined);
    check('默认是考研难度', /考研|C1/.test(s0.data.config.prefs.level), s0.data.config.prefs.level);

    // ---- 3. 单词解析 ----
    const parsed = await json('/api/parse-words', {
      method: 'POST',
      body: { text: '1. abandon 放弃\nprocedure /prəˈsiːdʒə/ n. 程序，步骤\nreluctant\nabandon 重复的' },
    });
    check('解析出 3 个词（去重）', parsed.data.words.length === 3, JSON.stringify(parsed.data.words));
    check('音标被识别', parsed.data.words[1].phonetic.includes('prəˈsiːdʒə'));
    check('词性被识别', parsed.data.words[1].pos === 'n.');

    const messy = await json('/api/parse-words', {
      method: 'POST',
      body: { text: 'abandon, procedure, reluctant\nvivid   cautious   witness\nharvest 收获, modest 谦虚的\ngive up 放弃' },
    });
    const mw = messy.data.words.map((w) => w.word);
    check('逗号分隔的多个词能拆开', mw.includes('abandon') && mw.includes('procedure') && mw.includes('reluctant'), JSON.stringify(mw));
    check('空格分隔的多个词能拆开', mw.includes('vivid') && mw.includes('cautious'), JSON.stringify(mw));
    check('中英混排的逗号也能拆', mw.includes('harvest') && mw.includes('modest'), JSON.stringify(mw));
    check('两个词的词组不会被拆散', mw.includes('give up'), JSON.stringify(mw));
    check('中文释义跟着走', messy.data.words.find((w) => w.word === 'harvest')?.meaning === '收获');

    // ---- 4. 截图 OCR ----
    const bad = await json('/api/ocr', { method: 'POST', body: { images: [] } });
    check('没有图片时报错', bad.data.ok === false);

    const noAuth = await json('/api/ocr', {
      method: 'POST',
      body: { images: [dataUrl(path.join(FIXTURES, 'word-card.png'))], fix: false },
    });

    if (!noAuth.data.ok && noAuth.status === 500 && /OCR|语言包/.test(noAuth.data.error || '')) {
      skip('截图 OCR', '这台机器的 Windows OCR 不可用');
    } else {
      check('单词卡截图 OCR 成功', noAuth.data.ok === true, JSON.stringify(noAuth.data).slice(0, 200));
      const cardWords = (noAuth.data.words || []).map((w) => w.word);
      check('只挑出大字目标词', cardWords.length === 1, JSON.stringify(cardWords));
      check('小字例句里的词被滤掉', !cardWords.includes('reluctant') && !cardWords.includes('harvest'), JSON.stringify(cardWords));
      check('识别出了那个（故意拼错的）目标词', cardWords[0].toLowerCase() === 'cautlous', JSON.stringify(cardWords));

      const listRes = await json('/api/ocr', {
        method: 'POST',
        body: { images: [dataUrl(path.join(FIXTURES, 'word-list.png'))], fix: false },
      });
      const listWords = (listRes.data.words || []).map((w) => w.word.toLowerCase());
      check('单词列表截图能识别出全部 6 个词', listWords.length === 6, JSON.stringify(listWords));
      check(
        '识别内容正确',
        ['abandon', 'procedure', 'reluctant', 'vivid', 'harvest', 'modest'].every((w) => listWords.some((x) => x.includes(w.slice(0, 4)))),
        JSON.stringify(listWords)
      );
      check('返回了原始识别文字供核对', (listRes.data.rawLines || []).length > 0);

      // 多张图一次性识别：单词卡的大字不能把列表页的小字压掉（阈值必须每张图各算各的）
      const multi = await json('/api/ocr', {
        method: 'POST',
        body: { images: [dataUrl(path.join(FIXTURES, 'word-card.png')), dataUrl(path.join(FIXTURES, 'word-list.png'))], fix: false },
      });
      const multiWords = (multi.data.words || []).map((w) => w.word.toLowerCase());
      check('多张图一次识别不再报错', multi.data.ok === true, JSON.stringify(multi.data).slice(0, 200));
      check('两张图的结果会合并', multiWords.length === 7, JSON.stringify(multiWords));
      check('每张图各自按字号挑词', (multi.data.perImage || []).length === 2, JSON.stringify(multi.data.perImage));
      check(
        '卡片的大字没有压掉列表的小字',
        multiWords.includes('cautlous') && multiWords.includes('abandon') && multiWords.includes('harvest'),
        JSON.stringify(multiWords)
      );
      check('提示里说明了处理了几张图', /2 张图/.test(multi.data.hint || ''), multi.data.hint);

      // 同一张图重复给多次不会产生重复词
      const dup = await json('/api/ocr', {
        method: 'POST',
        body: { images: [dataUrl(path.join(FIXTURES, 'word-list.png')), dataUrl(path.join(FIXTURES, 'word-list.png'))], fix: false },
      });
      check('重复图片自动去重', (dup.data.words || []).length === 6, JSON.stringify((dup.data.words || []).map((w) => w.word)));

      // 坏图要和好图混在一起时只跳过坏的那张
      const mixed = await json('/api/ocr', {
        method: 'POST',
        body: { images: [dataUrl(path.join(FIXTURES, 'word-list.png')), 'data:image/png;base64,bm90LWFuLWltYWdl'], fix: false },
      });
      check('坏图会被跳过而不是整批失败', mixed.data.ok === true && (mixed.data.words || []).length === 6, JSON.stringify(mixed.data).slice(0, 200));
      check('失败的那张图有记录', (mixed.data.failedImages || []).length === 1);

      // 全是坏图时要报明确的错
      const allBad = await json('/api/ocr', { method: 'POST', body: { images: ['data:image/png;base64,bm90LWFuLWltYWdl'], fix: false } });
      check('全是坏图时报错而不是静默返回空', allBad.data.ok === false && /识别失败/.test(allBad.data.error || ''), JSON.stringify(allBad.data));

      // 开了 AI 校正：假模型会把 cautlous 改成 cautious
      const fixed = await json('/api/ocr', {
        method: 'POST',
        body: { images: [dataUrl(path.join(FIXTURES, 'word-card.png'))], fix: true },
        // 这一步需要 key
      });
      check('未配置 Key 时跳过 AI 校正但仍能识别', fixed.data.ok === true && fixed.data.cleaned === false);

      // 长图：Windows OCR 有 10000px 硬上限，程序要先切块、识别、再按坐标拼回一张
      {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcz-tall-'));
        const tall = path.join(tmp, 'tall.png');
        const mk = path.join(tmp, 'mk.ps1');
        const psExe = process.env.SystemRoot
          ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          : 'powershell.exe';
        fs.writeFileSync(
          mk,
          [
            'Add-Type -AssemblyName System.Drawing',
            '$img = New-Object System.Drawing.Bitmap(1080, 12000)',
            '$g = [System.Drawing.Graphics]::FromImage($img)',
            '$g.Clear([System.Drawing.Color]::White)',
            '$f = New-Object System.Drawing.Font("Arial", 56)',
            '$words = @("abandon","cautious","paralyze","journal","misalign","resilient","scrutiny","undermine","incentive","advocate","ambiguous","coherent")',
            'for ($i = 0; $i -lt 40; $i++) { $g.DrawString($words[$i % 12], $f, [System.Drawing.Brushes]::Black, 60, (40 + $i * 290)) }',
            '$g.Dispose()',
            '$img.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)',
            '$img.Dispose()',
          ].join('\r\n')
        );
        const { spawnSync } = require('node:child_process');
        const gen = spawnSync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', mk, tall], {
          encoding: 'utf8',
          timeout: 120000,
        });
        if (!fs.existsSync(tall) || fs.statSync(tall).size < 1000) {
          skip('超长截图自动切块', `生成测试图失败：${(gen.stderr || '').slice(0, 120)}`);
        } else {
          const shot = await json('/api/ocr', { method: 'POST', body: { images: [dataUrl(tall)], fix: false } });
          const tw = (shot.data.words || []).map((w) => w.word.toLowerCase());
          check('12000px 长图能识别（自动切块）', shot.data.ok === true, JSON.stringify(shot.data).slice(0, 200));
          check('切块后 12 个词都在、没有重复', tw.length === 12, JSON.stringify(tw));
          check('切块结果并回成一张图（perImage 只有 1 条）', (shot.data.perImage || []).length === 1, JSON.stringify(shot.data.perImage));
          check('没有切片被跳过', (shot.data.failedImages || []).length === 0, JSON.stringify(shot.data.failedImages));
          check('长图提示写的是 1 张图', /1 张图/.test(shot.data.hint || ''), shot.data.hint);
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    // ---- 4b. OCR 桥的向后兼容：旧版 Node 传 JSON 列表文件时，新脚本也必须能读 ----
    // （真实踩过的坑：服务进程里缓存着旧 ocr.js 写 JSON，磁盘上的新 ocr.ps1 按行读，
    //   路径里混进引号 → 报「路径中具有非法字符」。现在两种格式都认。）
    {
      const { spawnSync } = require('node:child_process');
      const ps = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
      if (fs.existsSync(ps)) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcz-bridge-'));
        const list = path.join(tmp, 'legacy.json');
        const out = path.join(tmp, 'out.json');
        fs.writeFileSync(list, JSON.stringify([path.join(FIXTURES, 'word-card.png')]), 'utf8');
        spawnSync(
          ps,
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'lib', 'ocr.ps1'), '-ListFile', list, '-OutFile', out],
          { encoding: 'utf8', timeout: 120000 }
        );
        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
        } catch {}
        check(
          '旧版 JSON 列表文件仍能被新脚本读取',
          Boolean(parsed?.ok) && parsed.results?.[0]?.lines?.length > 0,
          JSON.stringify(parsed).slice(0, 160)
        );
        check('脚本报告了桥接版本号', parsed?.bridge === 2, String(parsed?.bridge));
        fs.rmSync(tmp, { recursive: true, force: true });
      } else {
        skip('旧版 JSON 列表兼容性', '找不到 powershell.exe');
      }
    }

    // ---- 4c. 长图切块的两个零件：头部尺寸解析、重叠行归并（纯函数，不跑 OCR）----
    {
      const { readImageSize, mergeSlices } = require(path.join(ROOT, 'lib', 'ocr.js'));

      const png = Buffer.alloc(32);
      png.writeUInt32BE(0x89504e47, 0); // \x89 P N G
      png.writeUInt32BE(1080, 16);
      png.writeUInt32BE(14000, 20);
      const pngSize = readImageSize(png);
      check('从 PNG 头读出宽高', pngSize?.width === 1080 && pngSize?.height === 14000, JSON.stringify(pngSize));

      const gif = Buffer.alloc(16); // 真实 GIF 至少 13 字节；这里补到 16，和 readImageSize 的最小长度一致
      gif.write('GIF89a', 0, 'latin1');
      gif.writeUInt16LE(800, 6);
      gif.writeUInt16LE(600, 8);
      const gifSize = readImageSize(gif);
      check('从 GIF 头读出宽高', gifSize?.width === 800 && gifSize?.height === 600, JSON.stringify(gifSize));

      const jpg = Buffer.alloc(16);
      jpg[0] = 0xff;
      jpg[1] = 0xd8;
      jpg[2] = 0xff;
      jpg[3] = 0xc0;
      jpg.writeUInt16BE(17, 4);
      jpg[6] = 8;
      jpg.writeUInt16BE(900, 7);
      jpg.writeUInt16BE(1600, 9);
      const jpgSize = readImageSize(jpg);
      check('从 JPEG 的 SOF 段读出宽高', jpgSize?.width === 1600 && jpgSize?.height === 900, JSON.stringify(jpgSize));

      const unit = {
        orig: 'D:\\tmp\\long.png',
        size: { width: 100, height: 200 },
        slices: [{ file: 'a', x: 0, y: 0 }, { file: 'b', x: 0, y: 90 }],
      };
      const merged = mergeSlices(unit, [
        { lines: [{ text: 'hello world', words: [{ t: 'hello', x: 0, y: 95, h: 20 }, { t: 'world', x: 60, y: 95, h: 20 }] }] },
        {
          lines: [
            { text: 'hello world', words: [{ t: 'hello', x: 0, y: 5, h: 20 }, { t: 'world', x: 60, y: 5, h: 20 }] },
            { text: 'second line', words: [{ t: 'second', x: 0, y: 60, h: 20 }] },
          ],
        },
      ]);
      check('重叠区的重复行被去掉', merged.lines.length === 2, JSON.stringify(merged.lines.map((l) => l.text)));
      check('切片坐标换算回原图', merged.lines[1]?.words[0]?.y === 150, String(merged.lines[1]?.words[0]?.y));
      check('归并后仍报告原图尺寸', merged.width === 100 && merged.height === 200);

      const half = mergeSlices(unit, [
        { lines: [{ text: 'hello world', words: [{ x: 0, y: 95, h: 20 }] }] },
        { lines: [{ text: 'hello wor', words: [{ x: 0, y: 5, h: 20 }] }] },
      ]);
      check('被切断的半截行只留完整那条', half.lines.length === 1 && half.lines[0].text === 'hello world', JSON.stringify(half.lines.map((l) => l.text)));

      const allBadSlices = mergeSlices(unit, [{ error: 'X' }, { error: 'Y' }]);
      check('所有切片都失败时返回错误而不是空结果', allBadSlices.error === 'X', JSON.stringify(allBadSlices));
    }

    // ---- 5. 保存单词（关键：分多次导入要累加，不能互相覆盖） ----
    const text = ['abandon 放弃', 'procedure /prəˈsiːdʒə/ n. 程序，步骤', 'reluctant 不情愿的', 'cautious 谨慎的', 'vivid 生动的'].join('\n');
    const saved = await json('/api/words', { method: 'POST', body: { date: '2026-10-16', text } });
    check('保存 5 个单词', saved.data.total === 5 && saved.data.added === 5, JSON.stringify(saved.data));
    check('写入了文件', fs.existsSync(path.join(DATA, 'words', '2026-10-16.json')));

    // 第二批：只加 2 个新词，第一批的 5 个必须还在
    const batch2 = await json('/api/words', {
      method: 'POST',
      body: { date: '2026-10-16', words: [{ word: 'harvest' }, { word: 'modest', meaning: '谦虚的' }] },
    });
    check('第二批是追加而不是覆盖', batch2.data.total === 7 && batch2.data.added === 2, JSON.stringify(batch2.data));
    const afterBatch2 = await json('/api/state?date=2026-10-16');
    const kept = afterBatch2.data.words.words.map((w) => w.word);
    check('第一批的单词还在', kept.includes('abandon') && kept.includes('vivid'), JSON.stringify(kept));
    check('第二批的单词已加入', kept.includes('harvest') && kept.includes('modest'), JSON.stringify(kept));

    // 重复导入同一批：一个都不新增，全部计入 skipped
    const again = await json('/api/words', { method: 'POST', body: { date: '2026-10-16', text } });
    check('重复导入不会产生重复词', again.data.total === 7 && again.data.added === 0 && again.data.skipped === 5, JSON.stringify(again.data));

    // 大小写不同的同一个词也算重复
    const caseDup = await json('/api/words', { method: 'POST', body: { date: '2026-10-16', words: [{ word: 'ABANDON' }] } });
    check('大小写不同也判为重复', caseDup.data.total === 7 && caseDup.data.skipped === 1, JSON.stringify(caseDup.data));

    // 已存在的词如果之前没释义，新导入的释义要补上；已有释义则不覆盖（避免冲掉用户改过的内容）
    const beforeFill = (await json('/api/state?date=2026-10-16')).data.words.words.find((w) => w.word.toLowerCase() === 'harvest');
    check('无释义的词先存为空', beforeFill.meaning === '');
    const fill = await json('/api/words', {
      method: 'POST',
      body: { date: '2026-10-16', words: [{ word: 'harvest', meaning: '收割；收成' }, { word: 'modest', meaning: '不应覆盖' }] },
    });
    const harvest = fill.data.words.words.find((w) => w.word.toLowerCase() === 'harvest');
    const modest = fill.data.words.words.find((w) => w.word.toLowerCase() === 'modest');
    check('重复词会补上缺失的释义', harvest.meaning === '收割；收成', JSON.stringify(harvest));
    check('已有释义不会被覆盖', modest.meaning === '谦虚的', JSON.stringify(modest));

    // 显式覆盖
    const replaced = await json('/api/words', {
      method: 'POST',
      body: { date: '2026-10-16', mode: 'replace', words: [{ word: 'solitary' }] },
    });
    check('mode=replace 时才是整表替换', replaced.data.total === 1 && replaced.data.mode === 'replace', JSON.stringify(replaced.data));

    // 清空
    const cleared = await json('/api/words?date=2026-10-16', { method: 'DELETE' });
    const afterClear = await json('/api/state?date=2026-10-16');
    check('可以清空当天的单词', cleared.data.cleared === true && afterClear.data.words.words.length === 0);

    // 恢复成 5 个词，供后面的文章测试用
    await json('/api/words', { method: 'POST', body: { date: '2026-10-16', text } });

    // ---- 6. 配置 ----
    const cfg = await json('/api/config', {
      method: 'POST',
      body: {
        deepseek: { apiKey: 'sk-test-secret-1234', baseUrl: `http://127.0.0.1:${MPORT}`, model: 'mock-model' },
        prefs: { paragraphs: 4, questionCount: 3, withLongSentences: true },
      },
    });
    check('配置保存成功', cfg.data.ok === true);
    check('key 被掩码', cfg.data.config.deepseek.keyMask.includes('…') && !JSON.stringify(cfg.data).includes('sk-test-secret-1234'));

    const cfgFile = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
    check('配置文件里存了真 key', cfgFile.deepseek.apiKey === 'sk-test-secret-1234');
    check('偏好已合并', cfgFile.prefs.paragraphs === 4 && cfgFile.prefs.style);
    check('旧配置里的百词斩字段已被清掉', JSON.stringify(cfgFile).includes('baicizhan') === false || !cfgFile.baicizhan);

    // 配好 key 之后，OCR 的 AI 校正应该生效
    if (!failures.includes('单词卡截图 OCR 成功')) {
      const fixed2 = await json('/api/ocr', {
        method: 'POST',
        body: { images: [dataUrl(path.join(FIXTURES, 'word-card.png'))], fix: true },
      });
      const w = (fixed2.data.words || []).map((x) => x.word);
      check('开了 AI 校正后拼写被修正', fixed2.data.cleaned === true && w[0] === 'cautious', JSON.stringify(w));
    }

    // ---- 7. 生成文章（考研版） ----
    const gen = await json('/api/article/generate', { method: 'POST', body: { date: '2026-10-16' } });
    const art = gen.data.article;
    check('生成接口返回 ok', gen.data.ok === true, JSON.stringify(gen.data).slice(0, 200));
    check('段落数符合偏好（4 段）', art.paragraphs.length === 4, `实际 ${art.paragraphs?.length}`);
    check('词汇表覆盖 5 个目标词', art.glossary.length === 5);
    check('词汇表带考研常考义项', art.glossary[0].examSense.length > 0);
    check('有长难句拆解', art.longSentences.length >= 1 && art.longSentences[0].analysis.length > 0);
    check('题量符合偏好（3 题）', art.questions.length === 3, `实际 ${art.questions?.length}`);
    check('题目带题型标签', art.questions.every((q) => ['细节题', '推断题', '词义句意题', '态度题', '主旨题'].includes(q.type)), JSON.stringify(art.questions.map((q) => q.type)));
    check('题目带原文定位', art.questions[0].evidence.length > 0);
    check('每题有解析', art.questions[0].explain.length > 0);
    check('没有遗漏目标词', art.missingWords.length === 0, JSON.stringify(art.missingWords));
    check('记录了模型', art.model === 'mock-model');
    check('文章已落盘', fs.existsSync(path.join(DATA, 'articles', '2026-10-16.json')));
    check('记录了模式', art.mode === 'review' && art.totalWords === 5, `${art.mode}/${art.totalWords}`);

    // ---- 7b. 真题模式：只挑一部分词，句子更难 ----
    await json('/api/config', { method: 'POST', body: { prefs: { mode: 'exam', examWordLimit: 2 } } });
    const genExam = await json('/api/article/generate', { method: 'POST', body: { date: '2026-10-16' } });
    const exam = genExam.data.article;
    check('真题模式生成成功', genExam.data.ok === true && exam.mode === 'exam', JSON.stringify(genExam.data).slice(0, 160));
    check('真题模式只用指定数量的词', exam.glossary.length === 2, `实际 ${exam.glossary.length}`);
    check('记录了词表总数和未用到的词', exam.totalWords === 5 && exam.unusedWords.length === 3, JSON.stringify(exam.unusedWords));
    check('真题模式不把没用到的词当成遗漏', exam.missingWords.length === 0);
    check('真题模式的提示词要求了让步反驳结构', /让步与反驳/.test(require(path.join(ROOT, 'lib', 'prompt.js')).buildPrompt({ words: [{ word: 'x' }], prefs: { mode: 'exam' }, date: 'd' }).user));
    check('真题模式的提示词要求干扰项套路', /偷换概念/.test(require(path.join(ROOT, 'lib', 'prompt.js')).buildPrompt({ words: [{ word: 'x' }], prefs: { mode: 'exam' }, date: 'd' }).user));
    check('复习模式的提示词不包含真题限制', !/让步与反驳/.test(require(path.join(ROOT, 'lib', 'prompt.js')).buildPrompt({ words: [{ word: 'x' }], prefs: { mode: 'review' }, date: 'd' }).user));

    // 切回复习模式，后面的断言按复习模式来
    await json('/api/config', { method: 'POST', body: { prefs: { mode: 'review' } } });
    const gen2 = await json('/api/article/generate', { method: 'POST', body: { date: '2026-10-16' } });
    check('切回复习模式后重新覆盖全部词', gen2.data.article.glossary.length === 5, `实际 ${gen2.data.article.glossary.length}`);

    // ---- 8. 重新读取 ----
    const s1 = await json('/api/state?date=2026-10-16');
    check('归档里有这篇文章', s1.data.dates.includes('2026-10-16'));
    check('文章可从接口读回', s1.data.article.title === art.title);
    check('长难句读得回来', s1.data.article.longSentences.length >= 1);

    // ---- 9. 错误处理 ----
    const noWords = await json('/api/article/generate', { method: 'POST', body: { date: '2030-01-01' } });
    check('没有单词时给出明确错误', noWords.data.ok === false && noWords.data.error.includes('单词'));
    const badParse = await json('/api/words', { method: 'POST', body: { date: '2026-10-16', text: '!!!***' } });
    check('解析失败时报错', badParse.data.ok === false);
    const tooMany = await json('/api/ocr', { method: 'POST', body: { images: new Array(20).fill('data:image/png;base64,AAA') } });
    check('图片过多时报错', tooMany.data.ok === false && tooMany.data.error.includes('12'));

    // ---- 9b. 划词查词：查的不是今天的词，而是文章里的生词 ----
    const lookupPrompt = require(path.join(ROOT, 'lib', 'prompt.js')).buildLookupPrompt(
      'borrowed',
      'He borrowed a book from me.'
    );
    check('查词提示词要求给原形', /原形/.test(lookupPrompt.user) && /borrowed/.test(lookupPrompt.user));
    check('查词提示词带上了上下文', lookupPrompt.user.includes('He borrowed a book from me.'));

    const look1 = await json('/api/lookup?word=borrowed&context=' + encodeURIComponent('He borrowed a book from me.'));
    check('查词成功', look1.data.ok === true && !!look1.data.entry, JSON.stringify(look1.data).slice(0, 160));
    check('查词返回了原形（不是用户点的变形）', look1.data.entry.word === 'borrow', look1.data.entry?.word);
    check('查词返回中文释义', look1.data.entry.cn.includes('中文释义'));
    check('第一次查词是走模型（未命中缓存）', look1.data.cached === false);

    const look2 = await json('/api/lookup?word=borrowed');
    check('第二次查同一个词命中缓存', look2.data.cached === true);
    check('词典缓存已落盘', fs.existsSync(path.join(DATA, 'dict', 'borrowed.json')));

    const st0 = await json('/api/state?date=2026-10-16');
    check('state 里能看到词典缓存条数', st0.data.dictCount === 1, String(st0.data.dictCount));

    const noKeyDate = await json('/api/lookup');
    check('查词缺少 word 参数时报错', noKeyDate.data.ok === false && /缺少/.test(noKeyDate.data.error));

    // ---- 9b-2. 短语查词：框选 in terms of 这种要能查、能存 ----
    const phrasePrompt = require(path.join(ROOT, 'lib', 'prompt.js')).buildLookupPrompt(
      'in terms of',
      'In terms of cost, it is cheaper.'
    );
    check('短语提示词标明了这是短语', /短语/.test(phrasePrompt.user), phrasePrompt.user.slice(0, 120));
    check('短语提示词要求给搭配结构', /搭配/.test(phrasePrompt.user));

    const ph1 = await json('/api/lookup?word=' + encodeURIComponent('in terms of'));
    check('短语查词成功', ph1.data.ok === true && !!ph1.data.entry, JSON.stringify(ph1.data).slice(0, 160));
    check('短语的词性标成 phr.', ph1.data.entry?.pos === 'phr.', ph1.data.entry?.pos);
    check('短语带回了搭配结构', !!ph1.data.entry?.collocation, ph1.data.entry?.collocation);
    check('短语第一次也走模型', ph1.data.cached === false);
    check('短语缓存文件名把空格换成下划线', fs.existsSync(path.join(DATA, 'dict', 'in_terms_of.json')));

    const ph2 = await json('/api/lookup?word=In%20Terms%20Of');
    check('短语大小写不同也能命中缓存', ph2.data.cached === true);

    const tooLong = await json('/api/lookup?word=' + encodeURIComponent('a'.repeat(70)));
    check('过长的输入被挡掉', tooLong.data.ok === false && tooLong.status === 400, String(tooLong.status));

    const mkPhrase = await json('/api/marks', {
      method: 'POST',
      body: { word: 'in terms of', cn: '就……而言', collocation: 'in terms of sth' },
    });
    check('短语能收进生词本', mkPhrase.data.ok === true && mkPhrase.data.marks.some((m) => m.word === 'in terms of'));
    check(
      '生词本保留了短语的搭配',
      mkPhrase.data.marks.find((m) => m.word === 'in terms of')?.collocation === 'in terms of sth'
    );
    await json('/api/marks?all=1', { method: 'DELETE' });
    await json('/api/dict', { method: 'DELETE' });

    // ---- 9c. 自定义标记（生词本）----
    const mk1 = await json('/api/marks', { method: 'POST', body: { word: 'borrowed', lemma: 'borrow', cn: '借' } });
    check('收藏生词成功', mk1.data.ok === true && mk1.data.marks.length === 1);
    check('收藏记录了原形和释义', mk1.data.marks[0].lemma === 'borrow' && mk1.data.marks[0].cn === '借');

    const mk2 = await json('/api/marks', { method: 'POST', body: { word: 'Borrowed' } });
    check('重复收藏不会产生两条', mk2.data.marks.length === 1, `实际 ${mk2.data.marks.length}`);

    // 这是功能的核心：词表里根本没有的词也要能收
    const mk3 = await json('/api/marks', { method: 'POST', body: { word: 'sanction' } });
    check('可以收藏今天的词表里没有的词', mk3.data.marks.length === 2);
    check('生词落盘', fs.existsSync(path.join(DATA, 'marks.json')));

    const st1 = await json('/api/state?date=2026-10-16');
    // 新加的排前面，方便刚收完就能看到
    check(
      'state 带上了生词本（新的在前）',
      st1.data.marks.length === 2 &&
        st1.data.marks[0].word === 'sanction' &&
        st1.data.marks[1].word === 'borrowed',
      JSON.stringify(st1.data.marks.map((m) => m.word))
    );

    const mkRm = await json('/api/marks?word=sanction', { method: 'DELETE' });
    check('能单独删掉一个生词', mkRm.data.marks.length === 1 && mkRm.data.marks[0].word === 'borrowed');

    const dictClear = await json('/api/dict', { method: 'DELETE' });
    check('能清空词典缓存', dictClear.data.dictCount === 0);
    const look3 = await json('/api/lookup?word=borrowed');
    check('清缓存后重新查会再走模型', look3.data.cached === false);

    const mkAll = await json('/api/marks?all=1', { method: 'DELETE' });
    check('能一键清空生词本', mkAll.data.marks.length === 0);

    // ---- 9d. 没配 Key 时查词的提示要能看懂 ----
    await json('/api/config', { method: 'POST', body: { deepseek: { clearKey: true } } });
    const noKey = await json('/api/lookup?word=sanction');
    check('没配 Key 时查词给出中文提示', noKey.data.ok === false && /API Key/.test(noKey.data.error), noKey.data.error);

    // ---- 10. 删除 ----
    const del = await json('/api/article?date=2026-10-16', { method: 'DELETE' });
    check('删除成功', del.data.deleted === true);
    const s2 = await json('/api/state?date=2026-10-16');
    check('删除后文章为空', s2.data.article === null);
    check('单词仍在', s2.data.words.words.length === 5);
  } catch (err) {
    failures.push(`异常：${err.message}`);
    console.error(err);
  } finally {
    cleanup();
  }

  const skipNote = skipped ? `，跳过 ${skipped} 项` : '';
  console.log(`\n通过 ${passed} 项${skipNote}${failures.length ? `，失败 ${failures.length} 项：\n - ${failures.join('\n - ')}` : '，全部通过 🎉'}\n`);
  process.exit(failures.length ? 1 : 0);
})();
