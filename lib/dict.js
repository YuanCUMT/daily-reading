'use strict';
/**
 * 划词查词：阅读时点任意单词，给出中文释义。
 *
 * 查词结果按词缓存在 data/dict/<word>.json —— 同一个词只花一次模型调用，
 * 之后（包括离线、换日期、换文章）都是直接读本地。缓存文件是明文 JSON，
 * 想重新查就把对应文件删掉。
 */
const store = require('./store');
const { buildLookupPrompt } = require('./prompt');
const { chatJson } = require('./deepseek');

/** 把模型输出收敛成固定形状，脏数据一律当空处理，不让它穿到前端 */
function normalizeEntry(raw, word) {
  const pick = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    word: pick(raw?.word, 60) || String(word || '').trim(),
    phonetic: pick(raw?.phonetic, 60),
    pos: pick(raw?.pos, 20),
    cn: pick(raw?.cn, 120),
    examSense: pick(raw?.examSense, 120),
    example: pick(raw?.example, 200),
    note: pick(raw?.note, 200),
  };
}

/** 从一段文字里切出包含目标词的那一句，作为释义的语境（最多 240 字） */
function sentenceAround(text, word) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  if (src.length <= 240) return src;
  const at = src.toLowerCase().indexOf(String(word || '').toLowerCase());
  if (at < 0) return src.slice(0, 240);
  const start = Math.max(0, at - 120);
  return `${start > 0 ? '…' : ''}${src.slice(start, start + 240)}…`;
}

class LookupError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * 查一个词。命中缓存直接返回，不花钱。
 * @returns {{entry: object, cached: boolean}}
 */
async function lookupWord({ config, word, context = '', refresh = false }) {
  const key = store.dictKey(word);
  if (!key) throw new LookupError('这不是一个英文单词', 'BAD_WORD');

  if (!refresh) {
    const cached = store.loadDictEntry(key);
    if (cached) return { entry: cached, cached: true };
  }

  const apiKey = config?.deepseek?.apiKey;
  if (!apiKey) {
    throw new LookupError('还没配置 API Key，查词需要调用模型。点右上角 ⚙️ 填一个。', 'NO_KEY');
  }

  const { system, user } = buildLookupPrompt(key, sentenceAround(context, key));
  const out = await chatJson({
    apiKey,
    baseUrl: config.deepseek.baseUrl,
    model: config.deepseek.model,
    temperature: 0.2,
    system,
    user,
    timeoutMs: 45000,
  });

  const entry = normalizeEntry(out.raw, key);
  if (!entry.cn) {
    // 不是词、拼错了、专有名词 —— 不写缓存，改完还能再查
    return { entry, cached: false };
  }
  store.saveDictEntry(key, { ...entry, surface: key });
  return { entry, cached: false };
}

module.exports = { lookupWord, normalizeEntry, sentenceAround, LookupError };
