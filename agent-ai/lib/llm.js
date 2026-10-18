'use strict';
/**
 * Otak AI dengan failover antar provider ("akumulasi token antar AI").
 * Urutan: Groq (utama, gratis & cepat) -> NVIDIA (cadangan, gratis)
 *          -> EXTRA (cadangan tambahan, OpenAI-compatible, opsional).
 * Daftar provider gratis lain (referensi): Free-LLM-Collection (OpenAI-format).
 *
 * Semua provider di bawah memakai format OpenAI chat/completions,
 * jadi satu fungsi cukup untuk semuanya.
 */

const { opt } = require('./env');

function providers() {
  return [
    {
      name: 'groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: opt('GROQ_API_KEY', ''),
      model: opt('GROQ_MODEL', 'openai/gpt-oss-120b'),
    },
    {
      name: 'nvidia',
      url: 'https://integrate.api.nvidia.com/v1/chat/completions',
      key: opt('NVIDIA_API_KEY', ''),
      model: opt('NVIDIA_MODEL', 'meta/llama-3.2-11b-vision-instruct'),
    },
    {
      name: opt('EXTRA_NAME', 'extra'),
      url: opt('EXTRA_BASE_URL', '').replace(/\/$/, '') + '/chat/completions',
      key: opt('EXTRA_API_KEY', ''),
      model: opt('EXTRA_MODEL', 'glm-5.3'),
    },
  ].filter((p) => p.key && p.url !== '/chat/completions');
}

async function callProvider(p, messages, maxTokens, temperature, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(p.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: p.model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const err = new Error(`${p.name} API ${res.status}: ${t.slice(0, 200)}`);
      err.providerStatus = res.status;
      throw err;
    }
    const j = await res.json();
    const text = (j.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error(`${p.name}: respons kosong`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat dengan failover otomatis.
 * Coba provider satu per satu; 429/5xx/timeout -> lanjut ke provider berikut.
 */
async function chat(messages, { maxTokens = 800, temperature = 0.3, timeoutMs = 25000 } = {}) {
  const ps = providers();
  if (!ps.length) throw new Error('Tidak ada API key AI yang terisi (GROQ_API_KEY / NVIDIA_API_KEY)');
  let lastErr = null;
  for (const p of ps) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callProvider(p, messages, maxTokens, temperature, timeoutMs);
      } catch (e) {
        lastErr = e;
        const retryable =
          e.name === 'AbortError' || e.providerStatus === 429 || (e.providerStatus >= 500 && e.providerStatus < 600);
        console.error(`[llm] ${p.name} gagal (percobaan ${attempt + 1}): ${e.message.slice(0, 120)}`);
        if (!retryable || attempt === 1) break;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    // lanjut ke provider berikutnya (failover)
  }
  throw lastErr;
}

module.exports = { chat, providers };
