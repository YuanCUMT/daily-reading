'use strict';
/**
 * 用真实浏览器（Edge/Chrome + CDP）打开页面，走完一整套日常流程：
 * 拖入截图 → OCR → 勾选单词 → 保存 → 生成文章 → 做题 → 看长难句，
 * 断言 DOM 渲染正确、控制台无报错，并截图。
 *
 * 运行： node test/ui-check.js
 * 产物： test/screenshot.png、test/screenshot-settings.png
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MPORT = 8899;
const SPORT = 8792;
const CDP_PORT = 9223;
const BASE = `http://127.0.0.1:${SPORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bcz-ui-test-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'bcz-ui-prof-'));
const SHOT = path.join(ROOT, 'test', 'screenshot.png');
const SHOT_SETTINGS = path.join(ROOT, 'test', 'screenshot-settings.png');
const SHOT_LOOKUP = path.join(ROOT, 'test', 'screenshot-lookup.png');
const SHOT_PHRASE = path.join(ROOT, 'test', 'screenshot-phrase.png');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));

let passed = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name} ${extra}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { tries = 60, interval = 300, label = '条件' } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

/** 在页面里把若干张本地 PNG 伪造成拖拽进来的文件 */
function dropFixtureExpr(files) {
  const list = Array.isArray(files) ? files : [files];
  const payload = list.map((f) => ({
    name: f,
    b64: fs.readFileSync(path.join(FIXTURES, f)).toString('base64'),
  }));
  return `(() => {
    const dt = new DataTransfer();
    for (const item of ${JSON.stringify(payload)}) {
      const bin = atob(item.b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      dt.items.add(new File([arr], item.name, { type: 'image/png' }));
    }
    document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return 'dropped';
  })()`;
}

const candidateValues = (cdp) =>
  cdp.eval(`JSON.stringify([...document.querySelectorAll('#ocrResult .cand-word')].map(i => i.value))`).then(JSON.parse);

const sidebarWords = (cdp) =>
  cdp.eval(`JSON.stringify([...document.querySelectorAll('.word-chip .w')].map(e => e.textContent))`).then(JSON.parse);

function seed() {
  fs.mkdirSync(path.join(DATA, 'words'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'articles'), { recursive: true });
  fs.writeFileSync(
    path.join(DATA, 'config.json'),
    JSON.stringify(
      {
        deepseek: { apiKey: 'sk-ui-test', baseUrl: `http://127.0.0.1:${MPORT}`, model: 'mock-model', temperature: 1 },
        prefs: {
          level: 'C1（考研英语一难度）',
          paragraphs: 5,
          style: '考研真题风格（社科 / 科普议论文）',
          withQuestions: true,
          questionCount: 5,
          withLongSentences: true,
          ocrFix: true,
        },
      },
      null,
      2
    )
  );
}

(async () => {
  console.log(`\n数据目录: ${DATA}`);
  if (!EDGE) {
    console.log('找不到 Edge/Chrome，跳过 UI 检查');
    process.exit(0);
  }

  seed();
  const mock = spawn(process.execPath, [path.join(ROOT, 'test', 'mock-llm.js'), String(MPORT)], { stdio: 'ignore' });
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    stdio: 'ignore',
    env: { ...process.env, BCZ_READER_DATA: DATA, PORT: String(SPORT) },
  });
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1440,1100',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      `${BASE}/`,
    ],
    { stdio: 'ignore' }
  );

  const cleanup = () => {
    edge.kill();
    mock.kill();
    srv.kill();
    setTimeout(() => {
      for (const d of [DATA, PROFILE]) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    }, 500);
  };

  try {
    await waitFor(async () => (await fetch(`${BASE}/api/state`)).ok, { label: '服务启动' });
    check('阅读器服务已启动', true);

    const targets = await waitFor(
      async () => {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
        return page ? [page] : null;
      },
      { label: '浏览器页面就绪' }
    );
    check('浏览器已打开页面', true);

    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    await waitFor(() => cdp.eval(`!!document.getElementById('empty') && !document.getElementById('empty').hidden`), {
      label: '空态渲染',
    });

    const initial = JSON.parse(
      await cdp.eval(`JSON.stringify({
        chips: document.querySelectorAll('.word-chip').length,
        emptyVisible: !document.getElementById('empty').hidden,
        title: document.title,
        hasBaicizhan: document.body.innerHTML.includes('百词斩抓取') || document.body.innerHTML.includes('accessToken'),
        emptyButtons: [...document.querySelectorAll('#empty [data-act]')].map(b => b.textContent.trim()),
        modalsHidden: [...document.querySelectorAll('.modal,.loading')].every(e => getComputedStyle(e).display === 'none')
      })`)
    );
    check('侧栏初始没有单词', initial.chips === 0);
    check('空态可见', initial.emptyVisible === true);
    check('页面标题是考研版', initial.title.includes('考研'), initial.title);
    check('界面上已经没有百词斩导入', initial.hasBaicizhan === false);
    check('空态首选「上传截图识别」', initial.emptyButtons[0].includes('截图'), JSON.stringify(initial.emptyButtons));
    check('弹窗默认关闭', initial.modalsHidden === true);
    check('没有 JS 报错', cdp.consoleErrors.length === 0 && cdp.pageErrors.length === 0, JSON.stringify([...cdp.consoleErrors, ...cdp.pageErrors]));

    // ---------- 顶栏一键切模式 ----------
    const quick0 = await cdp.eval(`document.getElementById('modeQuick').value`);
    check('顶栏有一键切换模式，默认复习模式', quick0 === 'review', String(quick0));

    await cdp.eval(`(() => {
      const s = document.getElementById('modeQuick');
      s.value = 'exam';
      s.dispatchEvent(new Event('change'));
      return 'ok';
    })()`);
    await waitFor(async () => {
      const r = await (await fetch(`${BASE}/api/state`)).json();
      return r.config.prefs.mode === 'exam';
    }, { label: '模式已存到服务端' });
    check('切换后立刻保存到服务端', true);

    // 打开设置，下拉框应该已经同步成真题模式
    await cdp.eval(`document.getElementById('btnSettings').click(); 'ok'`);
    await sleep(200);
    const synced = JSON.parse(
      await cdp.eval(`JSON.stringify({
        modal: document.getElementById('cfgMode').value,
        limitRowHidden: document.getElementById('examLimitRow').hidden
      })`)
    );
    check('设置里的模式跟着同步', synced.modal === 'exam', JSON.stringify(synced));
    check('同步后「每篇用词数」可见', synced.limitRowHidden === false);
    await cdp.eval(`document.querySelector('#modalSettings [data-close]').click(); 'ok'`);

    // 再从设置里切回复习模式，顶栏也要跟着变
    await cdp.eval(`document.getElementById('btnSettings').click(); 'ok'`);
    await sleep(150);
    await cdp.eval(`(() => {
      const s = document.getElementById('cfgMode');
      s.value = 'review';
      s.dispatchEvent(new Event('change'));
      document.getElementById('btnSaveSettings').click();
      return 'ok';
    })()`);
    await waitFor(() => cdp.eval(`document.getElementById('modeQuick').value === 'review'`), { label: '顶栏同步回复习模式' });
    check('从设置里改模式，顶栏也跟着变', true);
    await cdp.eval(`document.querySelector('#modalSettings [data-close]').click(); 'ok'`);

    // ---------- 截图识别 ----------
    await cdp.eval(`document.getElementById('btnImport').click(); 'ok'`);
    await sleep(200);
    const tabs = JSON.parse(
      await cdp.eval(`JSON.stringify({
        active: document.querySelector('.tab.active').dataset.tab,
        labels: [...document.querySelectorAll('.tab')].map(t => t.textContent.trim())
      })`)
    );
    check('导入弹窗默认停在「上传截图识别」', tabs.active === 'image', JSON.stringify(tabs));
    check('只剩两个入口：截图 / 粘贴', tabs.labels.length === 2, JSON.stringify(tabs.labels));

    check('识别按钮初始禁用', (await cdp.eval(`document.getElementById('btnDoOcr').disabled`)) === true);

    // ---------- 一次拖入多张图 ----------
    await cdp.eval(dropFixtureExpr(['word-card.png', 'word-list.png']));
    await waitFor(() => cdp.eval(`document.querySelectorAll('#thumbs .thumb').length === 2`), { label: '两张缩略图' });
    check('一次拖入两张图都进了队列', true);
    check('识别按钮变为可用', (await cdp.eval(`document.getElementById('btnDoOcr').disabled`)) === false);

    await cdp.eval(`document.getElementById('btnDoOcr').click(); 'ok'`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('#ocrResult .cand-item').length >= 7`), {
      tries: 120,
      label: '多图 OCR 结果',
    });
    const multi = await candidateValues(cdp);
    check('一次识别多张图不再报错', multi.length === 7, JSON.stringify(multi));
    check('两张图的结果都拿到了', multi.includes('abandon') && multi.includes('reluctant'), JSON.stringify(multi));
    check('AI 校正把单词卡上的拼写修对了', multi.includes('cautious'), JSON.stringify(multi));
    check('没有报错提示', (await cdp.eval(`!document.querySelector('#ocrResult .tip[style*="b13b25"]')`)) === true);

    check('候选词是可编辑的输入框', multi.length === (await cdp.eval(`document.querySelectorAll('#ocrResult .cand-word').length`)));

    await cdp.eval(`document.getElementById('btnSaveWords').click(); 'ok'`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('.word-chip').length === 7`), { label: '7 个词进侧栏' });
    check('多图识别的结果一次保存成功', (await sidebarWords(cdp)).length === 7);
    check('保存后弹窗保持打开，方便继续加', (await cdp.eval(`document.getElementById('modalImport').hidden`)) === false);
    check(
      '弹窗底部提示了这次新增了几个',
      /新增 7 个/.test(await cdp.eval(`document.getElementById('importStatus').textContent`)),
      await cdp.eval(`document.getElementById('importStatus').textContent`)
    );
    check('保存后候选列表已清空，不会重复提交', (await cdp.eval(`document.querySelectorAll('#ocrResult .cand-item').length`)) === 0);

    // ---------- 一张一张加：上一批的词不能被冲掉 ----------
    await cdp.eval(dropFixtureExpr('word-card.png'));
    await waitFor(() => cdp.eval(`document.querySelectorAll('#thumbs .thumb').length === 1`), { label: '第二批缩略图' });
    await cdp.eval(`document.getElementById('btnDoOcr').click(); 'ok'`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('#ocrResult .cand-item').length >= 1`), {
      tries: 120,
      label: '第二批 OCR',
    });
    await cdp.eval(`document.getElementById('btnSaveWords').click(); 'ok'`);
    await waitFor(() => cdp.eval(`/新增 0 个/.test(document.getElementById('importStatus').textContent)`), {
      label: '合并提示',
    });
    const status = await cdp.eval(`document.getElementById('importStatus').textContent`);
    check('第二批全部是重复词，被跳过而不是覆盖', /新增 0 个，跳过重复 1 个，词表共 7 个/.test(status), status);
    check('第一批的 7 个词一个都没少', (await sidebarWords(cdp)).length === 7, JSON.stringify(await sidebarWords(cdp)));
    await cdp.eval(`document.querySelector('#modalImport [data-close]').click(); 'ok'`);

    // ---------- 清空 ----------
    cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    await cdp.eval(`window.confirm = () => true; 'ok'`);
    await cdp.eval(`document.getElementById('btnClearWords').click(); 'ok'`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('.word-chip').length === 0`), { label: '清空单词' });
    check('「清空」能清掉当天的单词', true);

    // ---------- 用手动粘贴把词表补齐 ----------
    await cdp.eval(`document.getElementById('btnImport').click(); 'ok'`);
    await sleep(150);
    await cdp.eval(`document.querySelector('.tab[data-tab="paste"]').click(); 'ok'`);
    await cdp.eval(`(() => {
      const t = document.getElementById('pasteBox');
      t.value = 'abandon 放弃\\nprocedure /prəˈsiːdʒə/ n. 程序\\nreluctant 不情愿的\\nvivid 生动的\\ncautious 谨慎的';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('#pastePreview .pv-word').length === 5`), { label: '粘贴预览' });
    check('粘贴即时预览工作正常', true);
    await cdp.eval(`document.getElementById('btnSaveWords').click(); 'ok'`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('.word-chip').length === 5`), { label: '词表补齐' });
    check('侧栏凑齐 5 个单词', true);
    await cdp.eval(`document.querySelector('#modalImport [data-close]').click(); 'ok'`);

    // ---------- 生成文章 ----------
    await cdp.eval(`document.getElementById('btnGenerate').click(); 'ok'`);
    await waitFor(() => cdp.eval(`!document.getElementById('articleView').hidden && !!document.querySelector('.article-head h2')`), {
      tries: 100,
      label: '文章渲染',
    });

    const after = JSON.parse(
      await cdp.eval(`JSON.stringify({
        title: document.querySelector('.article-head h2')?.textContent,
        paras: document.querySelectorAll('.para').length,
        marks: document.querySelectorAll('mark.word').length,
        cards: document.querySelectorAll('.gcard').length,
        examSense: document.querySelectorAll('.gcard .exam-sense').length,
        longSentences: document.querySelectorAll('.lsent').length,
        lsAnalysis: document.querySelector('.ls-analysis')?.textContent.length || 0,
        questions: document.querySelectorAll('.q').length,
        qtypes: [...document.querySelectorAll('.q .qtype')].map(e => e.textContent),
        loadingHidden: document.getElementById('loading').hidden,
        firstPara: document.querySelector('.para .en')?.textContent.slice(0, 60)
      })`)
    );
    check('文章标题渲染', after.title === 'A Day with New Words', after.title);
    check('渲染了 5 段正文', after.paras === 5, `实际 ${after.paras}`);
    check('目标词被高亮', after.marks >= 5, `高亮 ${after.marks} 处`);
    check('词汇卡片 5 张', after.cards === 5, `实际 ${after.cards}`);
    check('词汇卡带「考研常考」标注', after.examSense === 5, `实际 ${after.examSense}`);
    check('渲染了长难句拆解', after.longSentences === 1 && after.lsAnalysis > 20, JSON.stringify(after));
    check('理解题带题型标签', after.qtypes.length === 3 && after.qtypes.every((t) => t.length > 0), JSON.stringify(after.qtypes));
    check('加载遮罩已关闭', after.loadingHidden === true);
    check('没有新增 JS 报错', cdp.consoleErrors.length === 0 && cdp.pageErrors.length === 0, JSON.stringify([...cdp.consoleErrors, ...cdp.pageErrors]));

    // 交互：点单词弹释义
    await cdp.eval(`document.querySelector('mark.word').click(); 'ok'`);
    await sleep(300);
    check('点单词弹出释义浮层', (await cdp.eval(`!document.getElementById('popover').hidden`)) === true);

    // ---------- 划词查词 + 生词本 ----------
    check('侧栏有生词本面板', (await cdp.eval(`!!document.getElementById('markList')`)) === true);

    // 点正文里一个「不是今天目标词」的生词 —— 这才是查词功能真正的用处
    const clickedWord = await cdp.eval(`(() => {
      try { window.getSelection().removeAllRanges(); } catch {}
      const p = document.querySelector('.para[data-para="0"] .en');
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let node, hit = null;
      while ((node = walker.nextNode())) {
        if (node.parentElement.closest('mark.word')) continue;
        const i = node.nodeValue.toLowerCase().indexOf('paragraph');
        if (i >= 0) { hit = { node, i }; break; }
      }
      if (!hit) return 'notfound';
      const r = document.createRange();
      r.setStart(hit.node, hit.i);
      r.setEnd(hit.node, hit.i + 'paragraph'.length);
      const rect = r.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      document.querySelector('#articleView').dispatchEvent(
        new MouseEvent('click', { clientX: x, clientY: y, bubbles: true, cancelable: true })
      );
      return 'clicked';
    })()`);
    check('能在正文里点到非目标词', clickedWord === 'clicked', clickedWord);

    await waitFor(
      () => cdp.eval(`(document.querySelector('#popover .cn')?.textContent || '').includes('查询测试')`),
      { label: '划词查词结果' }
    );
    const lookupPop = JSON.parse(
      await cdp.eval(`JSON.stringify({
        word: document.getElementById('popover').dataset.word,
        cn: document.querySelector('#popover .cn')?.textContent || '',
        hasMark: !!document.querySelector('#popover [data-mark]'),
        hidden: document.getElementById('popover').hidden
      })`)
    );
    // 曾经的 bug：正文点击冒泡到 document，浮层刚打开就被关掉
    check('点非目标词也能查，浮层没被关掉', lookupPop.hidden === false && lookupPop.word === 'paragraph', JSON.stringify(lookupPop));
    check('查到的释义来自模型', lookupPop.cn.includes('paragraph 的中文释义'), lookupPop.cn);
    check('浮层里有收藏按钮', lookupPop.hasMark === true);

    await sleep(150);
    const shotLookup = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_LOOKUP, Buffer.from(shotLookup.data, 'base64'));
    check('划词浮层截图已保存', fs.existsSync(SHOT_LOOKUP) && fs.statSync(SHOT_LOOKUP).size > 10000);

    await cdp.eval(`document.querySelector('#popover [data-mark]').click(); 'ok'`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('#markList .mark-chip').length === 1`), { label: '收藏入生词本' });
    const marks1 = JSON.parse(
      await cdp.eval(`JSON.stringify({
        n: document.querySelectorAll('#markList .mark-chip').length,
        word: document.querySelector('#markList .mark-chip .w')?.textContent,
        cn: document.querySelector('#markList .mark-chip .m')?.textContent,
        btn: document.querySelector('#popover [data-mark]')?.textContent || '',
        count: document.getElementById('markCount').textContent
      })`)
    );
    check('收藏后生词本里有这个词', marks1.n === 1 && marks1.word === 'paragraph', JSON.stringify(marks1));
    check('生词本记住了释义', marks1.cn.includes('中文释义'), marks1.cn);
    check('收藏后按钮变成「已在生词本」', marks1.btn.includes('已在生词本'), marks1.btn);
    check('生词本计数同步', marks1.count === '1', marks1.count);

    // 生词本要能一眼看全：多行卡片 + 不截断 + 侧栏可滚动
    const markLayout = JSON.parse(
      await cdp.eval(`JSON.stringify((() => {
        const chip = document.querySelector('#markList .mark-chip');
        const w = chip.querySelector('.w');
        const m = chip.querySelector('.m');
        const cs = getComputedStyle(m);
        return {
          hasTop: !!chip.querySelector('.mk-top'),
          wrapped: cs.whiteSpace === 'normal' && cs.textOverflow !== 'ellipsis',
          notClipped: m.scrollWidth <= m.clientWidth + 1 && w.scrollWidth <= w.clientWidth + 1,
          stacked: m.offsetTop >= w.offsetTop,
          sideOverflow: getComputedStyle(document.querySelector('.sidebar')).overflowY,
          listOverflow: getComputedStyle(document.getElementById('markList')).overflowY
        };
      })())`)
    );
    check('生词本是「词 + 释义」多行卡片', markLayout.hasTop && markLayout.stacked, JSON.stringify(markLayout));
    check('生词本里的释义不再被省略号截断', markLayout.wrapped && markLayout.notClipped, JSON.stringify(markLayout));
    check('侧栏与生词本都能滚动', markLayout.sideOverflow === 'auto' && markLayout.listOverflow === 'auto', JSON.stringify(markLayout));

    // 塞满生词本，验证真的能滚到底（不是只有 overflow 属性写着 auto）
    const scrollInfo = JSON.parse(
      await cdp.eval(`JSON.stringify((() => {
        window.__realMarks = state.marks.slice();
        state.marks = window.__realMarks.concat(Array.from({ length: 12 }, (_, i) => ({
          word: 'zzsample' + i,
          cn: '很长的示例释义，用来把生词本撑高，看看滚轮能不能划到底 ' + i,
          pos: 'n.',
          collocation: 'sample sth'
        })));
        renderMarks();
        const box = document.getElementById('markList');
        const before = box.scrollTop;
        box.scrollTop = box.scrollHeight;
        const after = box.scrollTop;
        return {
          overflows: box.scrollHeight > box.clientHeight + 2,
          scrolled: after > before + 10,
          count: document.querySelectorAll('#markList .mark-chip').length
        };
      })())`)
    );
    check('生词本变长后能滚到底', scrollInfo.overflows && scrollInfo.scrolled, JSON.stringify(scrollInfo));
    await cdp.eval(`state.marks = window.__realMarks; renderMarks(); 'ok'`);

    // 非目标词本来只是纯文本，收藏之后正文里要立刻变成蓝色，不能等重新渲染
    await waitFor(() => cdp.eval(`document.querySelectorAll('.para .en mark.word.mine[data-hw="paragraph"]').length > 0`), {
      label: '非目标词立刻变色',
    });
    const wrapped = JSON.parse(
      await cdp.eval(`JSON.stringify({
        mine: document.querySelectorAll('mark.word.mine').length,
        hw: document.querySelector('.para .en mark.word.mine')?.dataset.hw,
        inPara: !!document.querySelector('.para .en mark.word.mine')
      })`)
    );
    check('收藏后正文立刻给这个词上高亮', wrapped.mine > 0 && wrapped.inPara === true, JSON.stringify(wrapped));
    check('变色的词就是刚才点的词', String(wrapped.hw).toLowerCase() === 'paragraph', wrapped.hw);

    // 标一个今日目标词：正文里应该从黄底变成「生词本」样式
    await cdp.eval(`document.querySelector('#articleView mark.word:not(.mine)').click(); 'ok'`);
    await waitFor(() => cdp.eval(`!!document.querySelector('#popover [data-mark]')`), { label: '目标词浮层' });
    await cdp.eval(`document.querySelector('#popover [data-mark]').click(); 'ok'`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('#markList .mark-chip').length === 2`), {
      label: '收藏目标词',
    });
    const marks2 = JSON.parse(
      await cdp.eval(`JSON.stringify({
        chips: document.querySelectorAll('#markList .mark-chip').length,
        mine: document.querySelectorAll('#articleView mark.word.mine').length
      })`)
    );
    check('生词本里现在有两项', marks2.chips === 2, JSON.stringify(marks2));
    check('标过的目标词在正文里换了样式', marks2.mine >= 2, JSON.stringify(marks2));

    // 从侧栏移除刚才那个非目标词：正文里要拆回纯文本，不能留下目标词的黄色样式
    await cdp.eval(`document.querySelector('#markList [data-rm="paragraph"]').click(); 'ok'`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('#markList .mark-chip').length === 1`), { label: '移出生词本' });
    const afterRemove = JSON.parse(
      await cdp.eval(`JSON.stringify({
        chips: document.querySelectorAll('#markList .mark-chip').length,
        left: document.querySelectorAll('mark.word[data-hw="paragraph"]').length,
        stillMarked: document.querySelectorAll('#markList .mark-chip .w')[0]?.textContent
      })`)
    );
    check('能从侧栏把词移出生词本', afterRemove.chips === 1, JSON.stringify(afterRemove));
    check('移出后这个词在正文里变回纯文本', afterRemove.left === 0, JSON.stringify(afterRemove));

    // ---------- 框选短语查词（真的用鼠标拖选，不是伪造 selection）----------
    const dragPos = JSON.parse(
      await cdp.eval(`(() => {
        try { window.getSelection().removeAllRanges(); } catch {}
        document.getElementById('popover').hidden = true;
        const p = document.querySelector('.para[data-para="0"] .en');
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        let node, hit = null;
        while ((node = walker.nextNode())) {
          if (node.parentElement.closest('mark.word')) continue;
          const i = node.nodeValue.toLowerCase().indexOf('talk about');
          if (i >= 0) { hit = { node, i }; break; }
        }
        if (!hit) return JSON.stringify({ ok: false });
        const rectOf = (a, b) => {
          const r = document.createRange();
          r.setStart(hit.node, a);
          r.setEnd(hit.node, b);
          return r.getBoundingClientRect();
        };
        const r1 = rectOf(hit.i, hit.i + 4);
        const r2 = rectOf(hit.i + 5, hit.i + 10);
        return JSON.stringify({
          ok: true,
          x1: Math.round(r1.left + 2), y1: Math.round(r1.top + r1.height / 2),
          x2: Math.round(r2.right - 2), y2: Math.round(r2.top + r2.height / 2)
        });
      })()`)
    );
    check('正文里能找到可拖选的短语', dragPos.ok === true, JSON.stringify(dragPos));

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: dragPos.x1, y: dragPos.y1, button: 'left', buttons: 1, clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: dragPos.x2, y: dragPos.y2, button: 'left', buttons: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: dragPos.x2, y: dragPos.y2, button: 'left', buttons: 0, clickCount: 1,
    });

    await waitFor(
      () => cdp.eval(`(document.querySelector('#popover .cn')?.textContent || '').includes('查询测试')`),
      { label: '框选短语查词结果' }
    );
    const phrasePop = JSON.parse(
      await cdp.eval(`JSON.stringify({
        word: document.getElementById('popover').dataset.word,
        pos: document.querySelector('#popover .pos')?.textContent || '',
        colloc: document.querySelector('#popover .colloc')?.textContent || '',
        btn: document.querySelector('#popover [data-mark]')?.textContent || '',
        hidden: document.getElementById('popover').hidden
      })`)
    );
    // 曾经的 bug：拖选时 mousedown 时已有选区，mouseup 就不再处理，框选什么也不发生
    check('拖选短语能弹出浮层', phrasePop.hidden === false && phrasePop.word === 'talk about', JSON.stringify(phrasePop));
    check('短语浮层标出了词性是短语', /phr\./.test(phrasePop.pos), phrasePop.pos);
    check('短语浮层给出了搭配', phrasePop.colloc.includes('搭配'), phrasePop.colloc);
    check('短语的收藏按钮文案是「收藏短语」', /收藏短语/.test(phrasePop.btn), phrasePop.btn);

    await sleep(150);
    const shotPhrase = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_PHRASE, Buffer.from(shotPhrase.data, 'base64'));
    check('框选短语的浮层截图已保存', fs.existsSync(SHOT_PHRASE) && fs.statSync(SHOT_PHRASE).size > 10000);

    await cdp.eval(`document.querySelector('#popover [data-mark]').click(); 'ok'`);
    await waitFor(
      () => cdp.eval(`!!document.querySelector('#articleView mark.word.mine[data-hw="talk about"]')`),
      { label: '短语收藏后变色' }
    );
    const phraseMarked = JSON.parse(
      await cdp.eval(`JSON.stringify({
        inArticle: document.querySelectorAll('#articleView mark.word.mine[data-hw="talk about"]').length,
        chips: document.querySelectorAll('#markList .mark-chip').length,
        btn: document.querySelector('#popover [data-mark]')?.textContent || ''
      })`)
    );
    check('之前框选的短语被整体标成生词', phraseMarked.inArticle >= 1, JSON.stringify(phraseMarked));
    check('短语收藏后按钮变为「已在生词本」', /已在生词本/.test(phraseMarked.btn), phraseMarked.btn);

    // 短语要能在单词本里单独列出来，不然收藏了也没处看
    await cdp.eval(`document.getElementById('btnVocab').click(); 'ok'`);
    await waitFor(() => cdp.eval(`document.getElementById('modalVocab')?.hidden === false`), { label: '打开单词本' });
    await cdp.eval(`document.querySelector('#modalVocab [data-vtab="phrases"]').click(); 'ok'`);
    await sleep(200);
    const phraseTab = JSON.parse(
      await cdp.eval(`JSON.stringify({
        active: document.querySelector('#modalVocab [data-vtab="phrases"]').classList.contains('active'),
        count: document.getElementById('vtabPhraseCount').textContent,
        words: [...document.querySelectorAll('#vocabBody .vcard .w')].map((e) => e.textContent),
        colloc: document.querySelector('#vocabBody .vcard .sub')?.textContent || ''
      })`)
    );
    check('短语标签页单独列出短语', phraseTab.active === true && phraseTab.count === '1', JSON.stringify(phraseTab));
    check('短语标签页里就是刚收藏的短语', JSON.stringify(phraseTab.words) === '["talk about"]', JSON.stringify(phraseTab.words));
    check('短语卡片带搭配结构', phraseTab.colloc.includes('搭配'), phraseTab.colloc);
    await cdp.eval(`document.querySelector('#modalVocab [data-close]').click(); 'ok'`);
    await sleep(200);

    // 清掉短语，别把它带进截图
    await cdp.eval(`document.querySelector('#markList [data-rm="talk about"]').click(); 'ok'`);
    await waitFor(
      () => cdp.eval(`!document.querySelector('mark.word.mine[data-hw="talk about"]')`),
      { label: '短语移出生词本' }
    );
    check('短语也能从侧栏移除', (await cdp.eval(`document.querySelectorAll('#markList .mark-chip').length`)) === 1);

    // ---- 单词本 ----
    await cdp.eval(`document.getElementById('btnVocab').click(); 'ok'`);
    await waitFor(() => cdp.eval(`document.getElementById('modalVocab')?.hidden === false`), { label: '打开单词本' });
    const vocab1 = JSON.parse(
      await cdp.eval(`JSON.stringify({
        tabs: document.querySelectorAll('#modalVocab [data-vtab]').length,
  hasPhraseTab: !!document.querySelector('#modalVocab [data-vtab="phrases"]'),
  phraseCount: document.getElementById('vtabPhraseCount')?.textContent,
  fillVisible: (() => {
    const b = document.getElementById('btnFillMeaning');
    return !!b && !b.hidden;
  })(),
  fillLabel: document.getElementById('btnFillMeaning')?.textContent || '',
        dailyActive: document.querySelector('#modalVocab [data-vtab="daily"]').classList.contains('active'),
        dailyCount: document.getElementById('vtabDailyCount').textContent,
        mineCount: document.getElementById('vtabMineCount').textContent,
        cards: document.querySelectorAll('#vocabBody .vcard').length,
        groups: document.querySelectorAll('#vocabBody .vgroup').length
      })`)
    );
    check('单词本有两个标签页', vocab1.tabs === 3 && vocab1.dailyActive === true, JSON.stringify(vocab1));
    check('单词本有单独的短语标签页', vocab1.hasPhraseTab === true && vocab1.phraseCount === '0', JSON.stringify(vocab1));
    check('文章已补全释义时不给「补全释义」按钮', vocab1.fillVisible === false, JSON.stringify(vocab1));
    check('单词本每日单词数正确', vocab1.dailyCount === '5', vocab1.dailyCount);
    check('单词本生词数正确', vocab1.mineCount === '1', vocab1.mineCount);
    check('单词本按天分组显示', vocab1.cards === 5 && vocab1.groups === 1, JSON.stringify(vocab1));

    const defWords = JSON.parse(
      await cdp.eval(`JSON.stringify([...document.querySelectorAll('#vocabBody .vcard .w')].map((e) => e.textContent))`)
    );
    const defSorted = defWords.slice().sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    check('时间排序时同一天内按字母排', JSON.stringify(defWords) === JSON.stringify(defSorted), defWords.join(','));

    const setSort = (v) =>
      cdp.eval(`(() => { const s = document.getElementById('vocabSort'); s.value = '${v}'; s.dispatchEvent(new Event('change')); return 'ok'; })()`);
    await setSort('alpha');
    const alpha = JSON.parse(
      await cdp.eval(`JSON.stringify({
        words: [...document.querySelectorAll('#vocabBody .vcard .w')].map((e) => e.textContent),
        groups: document.querySelectorAll('#vocabBody .vgroup').length
      })`)
    );
    const expected = alpha.words.slice().sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    check('按字母排序生效', JSON.stringify(alpha.words) === JSON.stringify(expected), alpha.words.join(','));
    check('字母排序时不显示日期分组', alpha.groups === 0, String(alpha.groups));

    await setSort('alpha-desc');
    const desc = JSON.parse(await cdp.eval(`JSON.stringify([...document.querySelectorAll('#vocabBody .vcard .w')].map((e) => e.textContent))`));
    check('字母倒序也能排', JSON.stringify(desc) === JSON.stringify(expected.slice().reverse()), desc.join(','));

    await setSort('time-asc');
    check('按时间旧→新也能排', (await cdp.eval(`document.querySelectorAll('#vocabBody .vgroup').length`)) === 1);

    await cdp.eval(`(() => { const i = document.getElementById('vocabSearch'); i.value = 'aband'; i.dispatchEvent(new Event('input')); return 'ok'; })()`);
    const found = JSON.parse(
      await cdp.eval(`JSON.stringify({
        n: document.querySelectorAll('#vocabBody .vcard').length,
        w: document.querySelector('#vocabBody .vcard .w')?.textContent || ''
      })`)
    );
    check('搜索能过滤单词', found.n === 1 && found.w === 'abandon', JSON.stringify(found));

    await cdp.eval(`(() => { const i = document.getElementById('vocabSearch'); i.value = 'zzzz'; i.dispatchEvent(new Event('input')); return 'ok'; })()`);
    check('搜不到时给提示', (await cdp.eval(`document.querySelector('#vocabBody .empty-tip')?.textContent || ''`)).includes('没有匹配'));

    await cdp.eval(`document.querySelector('#modalVocab [data-vtab="mine"]').click(); 'ok'`);
    const mineTab = JSON.parse(
      await cdp.eval(`JSON.stringify({
        active: document.querySelector('#modalVocab [data-vtab="mine"]').classList.contains('active'),
        cards: document.querySelectorAll('#vocabBody .vcard').length,
        word: document.querySelector('#vocabBody .vcard .w')?.textContent || '',
        hasRemove: !!document.querySelector('#vocabBody [data-vrm]')
      })`)
    );
    check('切到「我的生词」标签', mineTab.active === true && mineTab.cards === 1, JSON.stringify(mineTab));
    check('生词卡片带移出按钮', mineTab.hasRemove === true && mineTab.word === 'abandon', JSON.stringify(mineTab));

    await cdp.eval(`document.querySelector('#modalVocab [data-close]').click(); 'ok'`);
    check('单词本能关掉', (await cdp.eval(`document.getElementById('modalVocab').hidden`)) === true);

    // 回归：单词本的标签页以前复用了 .tab 类名，会被导入弹窗那个全局处理器带歪
    await cdp.eval(`document.getElementById('btnImport').click(); 'ok'`);
    await cdp.eval(`document.querySelector('#modalImport .tab[data-tab="paste"]').click(); 'ok'`);
    check(
      '导入弹窗的分页没被单词本影响',
      (await cdp.eval(`document.querySelector('#modalImport [data-panel="paste"]').hidden`)) === false
    );
    await cdp.eval(`document.querySelector('#modalImport [data-close]').click(); 'ok'`);

    // 「补全释义」按钮：词表里确实有没释义的词时才出现
    const seedRes = await fetch(`${BASE}/api/words`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-01', words: [{ word: 'quokka' }, { word: 'numbat' }] }),
    });
    check('塞了两个没释义的词', seedRes.ok === true, String(seedRes.status));
    await cdp.eval(`document.getElementById('btnVocab').click(); 'ok'`);
    await waitFor(() => cdp.eval(`document.getElementById('modalVocab')?.hidden === false`), { label: '再开单词本' });
    await sleep(250);
    const fillBtn = JSON.parse(
      await cdp.eval(`JSON.stringify({
        visible: !document.getElementById('btnFillMeaning').hidden,
        label: document.getElementById('btnFillMeaning').textContent,
        statusHidden: document.getElementById('vocabStatus').hidden
      })`)
    );
    check('缺释义时出现「补全释义」按钮', fillBtn.visible === true && /补全释义（2）/.test(fillBtn.label), JSON.stringify(fillBtn));
    check('补释义前不显示状态行', fillBtn.statusHidden === true, JSON.stringify(fillBtn));
    await cdp.eval(`document.querySelector('#modalVocab [data-close]').click(); 'ok'`);
    await fetch(`${BASE}/api/words?date=2026-07-01`, { method: 'DELETE' });
    await sleep(200);
    await cdp.eval(`(() => {
      const p0 = document.querySelector('.para[data-para="0"] .en');
      const p1 = document.querySelector('.para[data-para="1"] .en');
      const r = document.createRange();
      r.setStart(p0.firstChild, 0);
      r.setEnd(p1.firstChild, 6);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return 'ok';
    })()`);
    await sleep(500);
    const multiToast = await cdp.eval(`document.getElementById('toast').textContent`);
    check('跨段框选给出提示而不是没反应', /同一段/.test(multiToast), multiToast);

    await cdp.eval(`(() => {
      const p = document.querySelector('.para[data-para="0"] .en');
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) nodes.push(n);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const r = document.createRange();
      // "People often mention abandon when they talk about this." —— 9 个词，不带数字和小数点
      r.setStart(first, first.nodeValue.indexOf('People'));
      r.setEnd(last, last.nodeValue.indexOf('this.') + 5);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return 'ok';
    })()`);
    await sleep(500);
    const longToast = await cdp.eval(`document.getElementById('toast').textContent`);
    check('选太长时提示上限', /8 个词/.test(longToast), longToast);

    await cdp.eval(`try { window.getSelection().removeAllRanges(); } catch {} 'ok'`);

    // 收尾：关掉浮层，留下一项生词本内容给截图用
    await cdp.eval(`document.getElementById('popover').hidden = true; 'ok'`);

    // 交互：做题
    await cdp.eval(`document.querySelector('.q .opt').click(); 'ok'`);
    await sleep(200);
    const quiz = JSON.parse(
      await cdp.eval(`JSON.stringify({
        correct: document.querySelectorAll('.q .opt.correct').length,
        answerShown: !document.querySelector('.q .answer-box').hidden,
        evidence: !!document.querySelector('.q .evidence')
      })`)
    );
    check('答题后标记答案并展开解析', quiz.correct === 1 && quiz.answerShown === true, JSON.stringify(quiz));
    check('解析里带原文定位', quiz.evidence === true);

    // 交互：显示中文
    await cdp.eval(`const c=document.getElementById('chkZh'); c.checked=true; c.dispatchEvent(new Event('change')); 'ok'`);
    await sleep(200);
    check('切换「显示中文」后译文可见', (await cdp.eval(`document.querySelectorAll('#articleView .zh:not([hidden])').length`)) === 5);

    // ---------- 设置 ----------
    await cdp.eval(`document.getElementById('btnSettings').click(); 'ok'`);
    await sleep(200);
    const settings = JSON.parse(
      await cdp.eval(`JSON.stringify({
        open: !document.getElementById('modalSettings').hidden,
        base: document.getElementById('cfgBase').value,
        keyPlaceholder: document.getElementById('cfgKey').placeholder,
        level: document.getElementById('cfgLevel').value,
        qcount: document.getElementById('cfgQuestionCount').value,
        longSentences: document.getElementById('cfgLongSentences').checked,
        ocrFix: document.getElementById('cfgOcrFix').checked,
        hasBaicizhan: document.body.innerHTML.includes('accessToken')
      })`)
    );
    check('设置弹窗打开', settings.open === true);
    check('设置回填了 baseUrl', settings.base.includes('127.0.0.1'), settings.base);
    check('设置展示了已保存的 key 掩码', /已保存/.test(settings.keyPlaceholder));
    check('默认难度是考研英语一', settings.level.includes('考研英语一'), settings.level);
    check('题量回填正确', String(settings.qcount) === '5', settings.qcount);
    check('长难句开关默认开', settings.longSentences === true);
    check('AI 校正开关默认开', settings.ocrFix === true);
    check('设置里已经没有任何百词斩字段', settings.hasBaicizhan === false);

    // 模式开关：复习模式默认，切到真题模式才出现「每篇用词数」
    const modeUi = JSON.parse(
      await cdp.eval(`JSON.stringify({
        mode: document.getElementById('cfgMode').value,
        limitRowHidden: document.getElementById('examLimitRow').hidden,
        tip: document.getElementById('modeTip').textContent
      })`)
    );
    check('默认是复习模式', modeUi.mode === 'review', JSON.stringify(modeUi));
    check('复习模式下隐藏「每篇用词数」', modeUi.limitRowHidden === true);
    check('复习模式有对应说明', modeUi.tip.includes('尽量全用上'), modeUi.tip);

    await cdp.eval(`(() => {
      const s = document.getElementById('cfgMode');
      s.value = 'exam';
      s.dispatchEvent(new Event('change'));
      return 'ok';
    })()`);
    await sleep(150);
    const modeUi2 = JSON.parse(
      await cdp.eval(`JSON.stringify({
        limitRowHidden: document.getElementById('examLimitRow').hidden,
        limit: document.getElementById('cfgExamLimit').value,
        tip: document.getElementById('modeTip').textContent
      })`)
    );
    check('真题模式显示「每篇用词数」', modeUi2.limitRowHidden === false, JSON.stringify(modeUi2));
    check('每篇用词数有默认值', Number(modeUi2.limit) >= 6, modeUi2.limit);
    check('真题模式有对应说明', modeUi2.tip.includes('真题'), modeUi2.tip);

    // 回到复习模式再截图，截图展示的是默认状态
    await cdp.eval(`(() => {
      const s = document.getElementById('cfgMode');
      s.value = 'review';
      s.dispatchEvent(new Event('change'));
      return 'ok';
    })()`);
    await sleep(150);

    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_SETTINGS, Buffer.from(shot2.data, 'base64'));
    check('设置截图已保存', fs.existsSync(SHOT_SETTINGS) && fs.statSync(SHOT_SETTINGS).size > 10000);
    await cdp.eval(`document.querySelector('#modalSettings [data-close]').click(); 'ok'`);

    await cdp.eval(`window.scrollTo(0,0); 'ok'`);
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    check('截图已保存', fs.existsSync(SHOT) && fs.statSync(SHOT).size > 10000, `${fs.statSync(SHOT).size} bytes`);

    ws.close();
  } catch (err) {
    failures.push(`异常：${err.message}`);
    console.error(err);
  } finally {
    cleanup();
  }

  console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项：\n - ${failures.join('\n - ')}` : '，全部通过 🎉'}\n`);
  process.exit(failures.length ? 1 : 0);
})();
