'use strict';
/**
 * 假的「DeepSeek」接口，用来端到端验证生成流程，不花一分钱、不发一次外网请求。
 * 用法：node test/mock-llm.js [port]
 */
const http = require('node:http');

const PORT = Number(process.argv[2] || 8899);

/** 从 prompt 里取出目标词表，并识别模式（真题模式只挑一部分） */
function pickWords(promptText) {
  const block = promptText.split('## 今日目标词')[1] || '';
  const header = block.split('\n')[0];
  const m = header.match(/共 (\d+) 个，(?:本篇只用其中 (\d+) 个|全部要用上)/);
  const limit = m && m[2] ? Number(m[2]) : null;

  const lines = block.split('\n').slice(1);
  const words = [];
  for (const line of lines) {
    const w = line.match(/^\s*\d+\.\s*([A-Za-z][A-Za-z'\- ]*)/);
    if (!w) break;
    words.push(w[1].trim());
  }
  return limit ? words.slice(0, limit) : words;
}

const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    const parsed = JSON.parse(body || '{}');
    const user = parsed.messages?.find((m) => m.role === 'user')?.content || '';
    const isOcrFix = user.includes('OCR 出来的候选英文单词');
    const isLookup = /读者在文章中点了这(个词|个短语)/.test(user);
    const isBatch = user.includes('请给出每个词的中文释义');

    // 单词本批量补释义：按编号把词抄回来，每个都给一条假释义
    if (isBatch) {
      const listed = user
        .split('\n')
        .map((l) => l.match(/^\s*\d+\.\s*([A-Za-z][A-Za-z'\- ]*?)\s*$/))
        .filter(Boolean)
        .map((m) => m[1].trim());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: parsed.model || 'mock',
          usage: { prompt_tokens: 80, completion_tokens: 120 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  entries: listed.map((w) => ({
                    word: w,
                    phonetic: `/${w.toLowerCase().replace(/\s+/g, '_')}/`,
                    pos: 'n.',
                    cn: `${w} 的批量释义（测试）`,
                    examSense: '',
                  })),
                }),
              },
            },
          ],
        })
      );
      return;
    }

    // 划词查词：返回固定假释义；单词的 lemma 去掉常见后缀，用来验证前端显示的是原形。
    // 短语不做后缀剥离（in other words 不能被砍成 in other word）。
    if (isLookup) {
      const phrase = /^短语：(.+)$/m.test(user);
      const word = (user.match(/^(?:单词|短语)：(.+)$/m) || [])[1]?.trim() || 'word';
      const lemma = phrase ? word : word.replace(/(ies|ied|ing|ed|es|s)$/i, '') || word;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: parsed.model || 'mock',
          usage: { prompt_tokens: 50, completion_tokens: 60 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  word: lemma,
                  phonetic: phrase ? '' : `/${lemma.toLowerCase()}/`,
                  pos: phrase ? 'phr.' : 'n.',
                  cn: `${lemma} 的中文释义（查询测试）`,
                  examSense: '',
                  collocation: phrase ? `${lemma} sth` : '',
                  example: `They talked about ${lemma} for a while.`,
                  note: '',
                }),
              },
            },
          ],
        })
      );
      return;
    }

    // OCR 校正请求：把 cautlous 改回 cautious，并丢掉界面词
    if (isOcrFix) {
      const listed = user
        .split('\n')
        .map((l) => l.match(/^\s*\d+\.\s*([A-Za-z][A-Za-z'\-]*)\s*$/))
        .filter(Boolean)
        .map((m) => m[1]);
      const fixed = listed
        .map((w) => (w.toLowerCase() === 'cautlous' ? 'cautious' : w))
        .filter((w) => !['day', 'with', 'new', 'words'].includes(w.toLowerCase()));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: parsed.model || 'mock',
          choices: [{ message: { content: JSON.stringify({ words: fixed }) } }],
        })
      );
      return;
    }

    const words = pickWords(user);
    const paras = Number((user.match(/正文恰好 (\d+) 段/) || [])[1]) || 3;

    const paragraphs = [];
    // 把目标词轮询分配到各段，保证每个词都出现（模拟真实模型的行为）
    const buckets = Array.from({ length: paras }, () => []);
    words.forEach((w, i) => buckets[i % paras].push(w));
    for (let i = 0; i < paras; i++) {
      const chunk = buckets[i];
      const en =
        `This is paragraph ${i + 1}. ` +
        chunk.map((w) => `People often mention ${w} when they talk about this.`).join(' ') +
        ` That is how the story goes.`;
      paragraphs.push({ en, zh: `这是第 ${i + 1} 段的中文翻译，包含目标词：${chunk.join('、')}。` });
    }

    const types = ['细节题', '推断题', '词义句意题', '态度题', '主旨题'];
    const article = {
      title: 'A Day with New Words',
      titleZh: '与新单词的一天',
      level: 'C1',
      summary: '一篇由假模型生成的测试文章。',
      usedWords: words,
      paragraphs,
      glossary: words.map((w) => ({
        word: w,
        phonetic: '/test/',
        pos: 'n.',
        cn: `${w} 的中文释义（测试）`,
        examSense: `${w} 的考研常考义项（测试）`,
        context: `People often mention ${w} when they talk about this.`,
      })),
      longSentences: words.length
        ? [
            {
              en: `People who often mention ${words[0]} when they talk about this tend to overlook the fact that the story, however simple it may appear, is far more complicated than it seems.`,
              analysis: `主干是 People tend to overlook the fact；who 引导定语从句修饰 People；that 引导同位语从句解释 fact，里面 however simple it may appear 是让步状语从句。`,
              zh: `常常谈起 ${words[0]} 的人，往往忽略了这样一个事实：这个故事看似简单，实则复杂得多。`,
            },
          ]
        : [],
      questions: [0, 1, 2].map((i) => ({
        q: `Question ${i + 1} about the text?`,
        type: types[i % types.length],
        options: ['Testing', 'Cooking', 'Driving', 'Sleeping'],
        answer: 0,
        evidence: 'That is how the story goes.',
        explain: '端到端测试用的解析。',
      })),
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: parsed.model || 'mock',
        usage: { prompt_tokens: 100, completion_tokens: 200 },
        choices: [{ message: { content: JSON.stringify(article) } }],
        __echo: { auth: auth.replace(/Bearer (....).*/, 'Bearer $1…'), sawWords: words },
      })
    );
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock-llm listening on ${PORT}`));
