'use strict';

/**
 * 阅读材料生成。两种模式：
 *
 *   review（复习模式，默认）
 *     把当天背的词尽可能都用上，文章好读、能靠语境猜词。记忆优先。
 *
 *   exam（真题模式）
 *     从当天词表里挑 N 个，写成像考研英语 Part A 那种外刊议论文：
 *     句子多层嵌套、有明显的让步-反驳论证、语域严格、
 *     选项按考研套路造干扰项。只求像真题，不追求词汇覆盖率。
 *
 * 两个模式共用的底线：文章必须是自然行文，不能出现「为塞词而生」的句子、
 * 含糊的虚构地名、以及语域不搭的口语化用法。
 */

const QUESTION_TYPES = ['细节题', '推断题', '词义句意题', '态度题', '主旨题'];
const DISTRACTOR_KINDS = ['偷换概念', '以偏概全', '过度推断', '张冠李戴', '正话反说'];

const SCHEMA_HINT = `{
  "title": "英文标题",
  "titleZh": "中文标题",
  "level": "难度，如 C1",
  "summary": "一句话中文导读（40 字以内）",
  "usedWords": ["本篇实际用到的目标词原形"],
  "paragraphs": [
    { "en": "英文段落", "zh": "对应的中文翻译" }
  ],
  "glossary": [
    {
      "word": "目标词原形（必须与给定单词一致）",
      "phonetic": "/音标/",
      "pos": "词性缩写，如 n. / v. / adj.",
      "cn": "本文语境下的中文释义",
      "examSense": "该词在考研中的常考义项或熟词僻义；没有就写空字符串",
      "context": "该词在本文中出现的那一句原文"
    }
  ],
  "longSentences": [
    {
      "en": "从本文挑出的长难句原文",
      "analysis": "中文拆解：先说主干（主语+谓语+宾语），再说各修饰成分挂在哪里、代词指代谁、逻辑关系是什么",
      "zh": "这句话的中文翻译"
    }
  ],
  "questions": [
    {
      "q": "英文题干（考研风格）",
      "type": "题型，只能从：细节题、推断题、词义句意题、态度题、主旨题 中选一个",
      "options": ["A 选项", "B 选项", "C 选项", "D 选项"],
      "answer": 0,
      "evidence": "该题依据的原文句子（原样摘录）",
      "explain": "中文解析：为什么选它，并逐个说明干扰项属于哪一类错误"
    }
  ]
}`;

const SYSTEM = [
  '你是一位资深的考研英语命题与教学专家，长期为考研英语阅读模拟题撰稿。',
  '你熟悉《经济学人》《时代》《卫报》《科学美国人》等外刊的行文风格。',
  '你只输出一个 JSON 对象，不要输出 Markdown 代码块、不要输出任何解释文字。',
].join('\n');

/** 两个模式共用的行文底线 */
const COMMON_RULES = `- 文章必须是自然行文，绝对不能出现「为塞单词而生」的句子
- 不要写「某个大陆城市」「某国某地」这种含糊的虚构地点；需要地点就写真实具体的城市/机构/期刊
- 语域统一为正式书面语，禁止口语化或搭配突兀的动词用法（例如把 trash 当「毁掉」、把 smuggle 当「偷偷加入」）
- paragraphs 的 en 和 zh 一一对应，中文翻译要通顺，不是逐字直译`;

function wordListBlock(words, mode, limit) {
  const lines = words
    .map((w, i) => {
      const extra = [w.phonetic, w.pos, w.meaning].filter(Boolean).join(' ');
      return `${i + 1}. ${w.word}${extra ? `  —— ${extra}` : ''}`;
    })
    .join('\n');
  // 这一行的格式是机器可读的（测试用的假模型靠它判断该用几个词），改动前先看 test/mock-llm.js
  const header =
    mode === 'exam'
      ? `## 今日目标词（共 ${words.length} 个，本篇只用其中 ${limit} 个）`
      : `## 今日目标词（共 ${words.length} 个，全部要用上）`;
  return `${header}\n${lines}`;
}

function buildPrompt({ words, prefs, date }) {
  const mode = prefs.mode === 'exam' ? 'exam' : 'review';
  const paragraphs = Number(prefs.paragraphs) || 6;
  // 注意：Number(undefined) 是 NaN，而 NaN ?? 5 仍然是 NaN（?? 只兜 null/undefined），
  // 所以这里必须显式处理，不能写成 Number(x) ?? 5
  const rawQ = prefs.questionCount;
  const questionCount = rawQ === undefined || rawQ === null || rawQ === '' ? 5 : Math.max(0, Math.floor(Number(rawQ) || 0));
  const withQuestions = prefs.withQuestions !== false && questionCount > 0;
  const withLongSentences = prefs.withLongSentences !== false;
  const rawLimit = Number(prefs.examWordLimit);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 15, 1), words.length || 1);

  const pickRule =
    mode === 'exam'
      ? `- 从上面的词表里挑出 **${limit} 个**最适合放进考研真题难度文章的词（优先选考研核心词、能体现考研用法的词），` +
        `本篇**只使用**这 ${limit} 个，其余的词不要出现在文章里\n` +
        `- glossary 只列这 ${limit} 个词，顺序与你在文中使用它们的顺序一致\n` +
        `- usedWords 字段列出你实际挑中的这 ${limit} 个词的原形`
      : `- 每一个目标词都必须至少出现一次，自然分布在全文各处\n` +
        `- glossary 必须覆盖全部 ${words.length} 个目标词，顺序与上面一致\n` +
        `- usedWords 字段列出全部用到的词`;

  const styleRules =
    mode === 'exam'
      ? `- 结构：要有清晰的论证链条，**必须包含让步与反驳**（先承认对立观点，再指出其局限），可加入限定条件、例证、正反对比
- 不要写成「现象 → 科学 → 历史 → 问题 → 对策 → 升华」这种模板；结尾不要格言式升华
- 开头：直接切入现象、数据、观点或引述，不要用「在某个郊区，一项实验开始了」这类故事化虚构开头
- 句法：平均句长 25–30 词；每段至少一个含两层以上从句或插入语的长句；多用后置定语、同位语、分词结构
- 用词克制，模拟外刊语气，允许出现"研究显示""批评者认为"这类论证引导`
      : `- 结构：话题自然展开即可，段落之间要有推进
- 句法：句子偏短偏清晰，让读者能靠语境猜出目标词的意思`;

  const fullSentencesRule = withLongSentences
    ? mode === 'exam'
      ? '- longSentences：从本文挑 3 句结构最复杂的（每句 25 词以上），做主干拆解'
      : '- longSentences：从本文挑 3 句结构较复杂的，做主干拆解'
    : '- longSentences 输出空数组 []';

  const questionRule = withQuestions
    ? mode === 'exam'
      ? `- questions 出 ${questionCount} 道题
- 题型配比：细节题 2–3 题，推断题 1–2 题；词义句意题、态度题、主旨题**各不超过 1 题**
- 正确选项必须是原文的**同义改写**，不允许照抄原文句子
- 干扰项必须按考研常见套路设计，并在 explain 里逐个点名它属于哪一类：
  ${DISTRACTOR_KINDS.join(' / ')}
- 词义句意题要针对一个真正需要靠上下文推断的短语或句子
- 每题给出原文定位句（原样摘录）`
      : `- questions 出 ${questionCount} 道题，题型尽量覆盖不同类别`
    : '- questions 输出空数组 []';

  const user = `请写一篇英文阅读文章，并配好考研风格的题目和解析。

${wordListBlock(words, mode, limit)}

## 写作要求
- 日期背景：${date}
- 模式：${mode === 'exam' ? '考研真题模式（像真题，不追求词汇覆盖率）' : '复习模式（尽量把当天背的词都用上）'}
- 难度：${prefs.level}
- 题材：${prefs.style}
- 篇幅：正文恰好 ${paragraphs} 段，总词数 ${paragraphs * (mode === 'exam' ? 70 : 65)} 词左右
${pickRule}
${styleRules}
${COMMON_RULES}
- 目标词可以使用变形（复数、过去式、-ing、比较级等），但 glossary 的 "word" 必须是原形
${fullSentencesRule}
${questionRule}

## 输出格式（严格 JSON，字段名照抄）
${SCHEMA_HINT}`;

  return { system: SYSTEM, user, mode };
}

/** 宽容地从模型输出里取 JSON 对象 */
function parseModelJson(text) {
  if (!text) throw new Error('模型返回为空');
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new Error(`无法解析模型返回的 JSON：${s.slice(0, 200)}`);
  }
}

const str = (v) => String(v ?? '').trim();

/** 校验并规整文章结构 */
function normalizeArticle(raw, expectedWords) {
  const paragraphs = Array.isArray(raw.paragraphs)
    ? raw.paragraphs.map((p) => ({ en: str(p?.en), zh: str(p?.zh) })).filter((p) => p.en)
    : [];
  if (!paragraphs.length) throw new Error('模型没有返回任何段落');

  const glossary = Array.isArray(raw.glossary)
    ? raw.glossary
        .map((g) => ({
          word: str(g?.word),
          phonetic: str(g?.phonetic),
          pos: str(g?.pos),
          cn: str(g?.cn),
          examSense: str(g?.examSense),
          context: str(g?.context),
        }))
        .filter((g) => g.word)
    : [];

  const longSentences = Array.isArray(raw.longSentences)
    ? raw.longSentences
        .map((s) => ({ en: str(s?.en), analysis: str(s?.analysis), zh: str(s?.zh) }))
        .filter((s) => s.en)
    : [];

  const questions = Array.isArray(raw.questions)
    ? raw.questions
        .map((q) => ({
          q: str(q?.q),
          type: QUESTION_TYPES.includes(str(q?.type)) ? str(q.type) : '细节题',
          options: Array.isArray(q?.options) ? q.options.map(str) : [],
          answer: Number.isInteger(q?.answer) ? q.answer : 0,
          evidence: str(q?.evidence),
          explain: str(q?.explain),
        }))
        .filter((q) => q.q && q.options.length >= 2)
    : [];

  const fullText = paragraphs.map((p) => p.en).join(' ');
  const lower = fullText.toLowerCase();

  // 每个 glossary 词都要真的出现在正文里（变形也认）
  const notInText = [];
  for (const g of glossary) {
    const base = g.word.toLowerCase();
    const stem = base.length > 4 ? base.slice(0, Math.max(4, base.length - 2)) : base;
    if (!lower.includes(stem)) notInText.push(base);
  }

  // 相对「给定词表」的覆盖情况
  const used = (Array.isArray(raw.usedWords) && raw.usedWords.length ? raw.usedWords.map((w) => str(w).toLowerCase()) : []).filter(Boolean);
  const glossaryWords = glossary.map((g) => g.word.toLowerCase());
  const effectiveUsed = used.length ? used : glossaryWords;
  const missing = [];
  for (const w of expectedWords || []) {
    const base = String(w.word || w).toLowerCase();
    if (!base) continue;
    const stem = base.length > 4 ? base.slice(0, Math.max(4, base.length - 2)) : base;
    if (!lower.includes(stem)) missing.push(base);
  }

  return {
    title: str(raw.title) || 'Untitled',
    titleZh: str(raw.titleZh),
    level: str(raw.level),
    summary: str(raw.summary),
    paragraphs,
    glossary,
    longSentences,
    questions,
    usedWords: effectiveUsed,
    missingWords: missing,
    glossaryNotInText: notInText,
    wordCount: fullText.split(/\s+/).filter(Boolean).length,
    avgSentenceLength: Number((fullText.split(/[.!?]+\s/).filter((s) => s.trim().split(/\s+/).length > 3).reduce((acc, s, _, arr) => acc + s.trim().split(/\s+/).length / arr.length, 0)).toFixed(1)),
  };
}

// ---------------------------------------------------------------- OCR 结果校正

function buildOcrFixPrompt(words) {
  const system = [
    '你在帮一个准备考研英语的中国学生整理单词表。',
    '这些词是用 OCR 从手机截图里识别出来的，会有拼写错误和无关内容。',
    '你只输出一个 JSON 对象，不要输出解释文字。',
  ].join('\n');

  const user = `下面是从截图 OCR 出来的候选英文单词：

${words.map((w, i) => `${i + 1}. ${w}`).join('\n')}

请：
1. 修正明显的 OCR 拼写错误（比如 cautlous → cautious、recieve → receive）
2. 删掉不像「要背的单词」的内容：界面文字、页面标题、人名、地名、公司名、缩写、常见到不需要背的基础词（the/is/and 这类）
3. 保持原有顺序，不要新增原本没有的词
4. 如果某个词拼写没错但不确定是不是词，保留它

输出格式：{"words": ["修正后的单词", ...]}`;

  return { system, user };
}

// ---------------------------------------------------------------- 划词查词

function buildLookupPrompt(word, context = '') {
  const system = [
    '你是一本英汉词典，服务于准备考研英语的中国学生。',
    '你只输出一个 JSON 对象，不要输出任何解释文字或 Markdown 代码块。',
    '释义要简洁准确，面向考研阅读语境；不要列一堆生僻义项。',
  ].join('\n');

  const user = `读者在文章中点了这个词，请给出它在这个句子里的意思。

单词：${word}
${context ? `所在句子：${context}` : ''}

输出 JSON：
{
  "word": "词的原形（如果点的就是原形就原样返回）",
  "phonetic": "音标，例如 /ˈsækrɪfaɪs/",
  "pos": "词性缩写，例如 n. / v. / adj. / adv. / phr.",
  "cn": "中文释义；有多个常用义项时用；分隔，总长不超过 30 字",
  "examSense": "考研常考的引申义或熟词僻义，没有就填空字符串",
  "example": "一个短的英文例句（≤ 12 词）",
  "note": "如果这个词在此句里取的是引申义/比喻义，用一句话说明；否则填空字符串"
}

如果这个词不是英语单词（拼错、专有名词、人名地名、或者根本不是词），把 "cn" 留空、在 "note" 里说明原因。`;

  return { system, user };
}

module.exports = {
  buildPrompt,
  buildOcrFixPrompt,
  buildLookupPrompt,
  parseModelJson,
  normalizeArticle,
  QUESTION_TYPES,
  DISTRACTOR_KINDS,
};
