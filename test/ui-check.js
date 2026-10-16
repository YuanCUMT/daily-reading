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
