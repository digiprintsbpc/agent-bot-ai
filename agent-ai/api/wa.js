'use strict';
/**
 * POST /api/wa — jembatan WhatsApp (via panel Pterodactyl + Baileys).
 *
 * Panel meneruskan pesan WA pelanggan ke sini, AI memproses dengan
 * mode pelanggan yang sama seperti Telegram, balasan dikembalikan
 * sebagai JSON untuk dikirim panel via Baileys.
 *
 * Auth: header x-wa-secret harus sama dengan env WA_AI_SECRET.
 * Body: { from: "62812xxxx", text: "...", name: "..." }
 * Balasan: { reply: "..."|null, photo: "url"|null, caption: "..."|null }
 */

const { opt } = require('../lib/env');
const customer = require('../lib/customer');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(200).send('wa-ai ok');

    const secret = opt('WA_AI_SECRET', '');
    if (!secret || req.headers['x-wa-secret'] !== secret) {
      return res.status(401).send('unauthorized');
    }

    const { from, text } = req.body || {};
    const cleanFrom = String(from || '').replace(/\D/g, '');
    const cleanText = String(text || '').trim();
    if (!cleanFrom || !cleanText) return res.status(200).json({ reply: null });

    const userId = 'wa:' + cleanFrom;
    console.log(`[wa] ${userId}: ${cleanText.slice(0, 80)}`);

    // --- AI Handoff: cek pause dulu (hemat 1x panggil LLM bila sedang pause) ---
    try {
      const SB_U = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
      const SB_K = process.env.SUPABASE_SERVICE_KEY || '';
      const pr = await fetch(`${SB_U}/rest/v1/ai_pause?user_id=eq.${encodeURIComponent(userId)}&select=paused_until`, {
        headers: { apikey: SB_K },
      });
      if (pr.ok) {
        const pj = await pr.json();
        if (pj[0] && pj[0].paused_until && Date.now() < new Date(pj[0].paused_until).getTime()) {
          console.log(`[wa] AI pause untuk ${userId}`);
          return res.status(200).json({ reply: null });
        }
      }
    } catch {}

    let photo = null;
    let caption = null;
    let reply;
    try {
      reply = await customer.handleCustomer(userId, cleanText, async (u, c) => {
        photo = u;
        caption = c;
      });
    } catch (e) {
      console.error('[wa] error:', e.message);
      reply = 'Maaf kak, ada gangguan sebentar. Coba lagi ya.';
    }
    return res.status(200).json({ reply: reply || null, photo, caption });
  } catch (e) {
    console.error('[wa] fatal:', e.message);
    return res.status(200).json({ reply: null });
  }
};
