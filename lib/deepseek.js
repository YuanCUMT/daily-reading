'use strict';
/**
 * DeepSeek（OpenAI 兼容）调用封装。零依赖，用 Node 内置 fetch。
 */
const { buildPrompt, buildOcrFixPrompt, parseModelJson, normalizeArticle } = require('./prompt');

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${path}`;
}

async function chatJson({ apiKey, baseUrl, model, temperature, system, user, timeoutMs = 180000 }) {
  if (!apiKey) throw new Error('没有配置 DeepSeek API Key');
  const url = joinUrl(baseUrl || 'https://api.deepseek.com', '/chat/completions');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: ac.signal,
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        temperature: typeof temperature === 'number' ? temperature : 1.0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try {
        detail = JSON.parse(text).error?.message || detail;
      } catch {}
      throw new Error(`模型接口返回 ${res.status}：${detail}`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`模型接口返回了非 JSON 内容：${text.slice(0, 200)}`);
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('模型没有返回内容');
    return { raw: parseModelJson(content), usage: payload.usage || null, model: payload.model || model };
  } finally {
    clearTimeout(timer);
  }
}

async function generateArticle({ config, words, date }) {
  const prefs = config.prefs || {};
  const { system, user } = buildPrompt({ words, prefs, date });
  const out = await chatJson({
    apiKey: config.deepseek.apiKey,
    baseUrl: config.deepseek.baseUrl,
    model: config.deepseek.model,
    temperature: config.deepseek.temperature,
    system,
    user,
  });
  const article = normalizeArticle(out.raw, words);
  article.usage = out.usage;
  article.model = out.model;
  return article;
}

/** 用模型把 OCR 结果里的拼写错误和界面噪声清掉 */
async function cleanOcrWords({ config, words }) {
  const { system, user } = buildOcrFixPrompt(words);
  const out = await chatJson({
    apiKey: config.deepseek.apiKey,
    baseUrl: config.deepseek.baseUrl,
    model: config.deepseek.model,
    temperature: 0.2,
    system,
    user,
    timeoutMs: 90000,
  });
  const fixed = Array.isArray(out.raw?.words) ? out.raw.words.map((w) => String(w).trim()).filter(Boolean) : [];
  return { words: fixed.length ? fixed : words, changed: fixed.length ? fixed : words };
}

module.exports = { chatJson, generateArticle, cleanOcrWords };
