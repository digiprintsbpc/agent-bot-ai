'use strict';
/**
 * Briefing pagi otomatis — dipanggil Vercel Cron tiap 07:00 WIB.
 * Format SAMA PERSIS dengan bot lama (toko-bot/telegram.js).
 * Auth: header x-vercel-cron, atau Authorization: Bearer CRON_SECRET, atau ?token=CRON_SECRET.
 */
const { sendMessage } = require('../lib/telegram-api');
const { opt } = require('../lib/env');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

function authorized(req) {
  if (String(req.headers['x-vercel-cron'] || '') === '1') return true;
  const secret = opt('CRON_SECRET', '');
  if (!secret) return false;
  if (req.headers.authorization === `Bearer ${secret}`) return true;
  if (String((req.query || {}).token || '') === secret) return true;
  return false;
}

module.exports = async (req, res) => {
  try {
    if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
    const ownerId = opt('TELEGRAM_ALLOWED_ID', '');
    if (!SB_URL || !SB_KEY || !ownerId) {
      return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY / TELEGRAM_ALLOWED_ID belum lengkap' });
    }
    const q = new URLSearchParams({ select: 'status,total_harga', limit: '1000' });
    const r = await fetch(`${SB_URL}/rest/v1/orders?${q}`, { headers: { apikey: SB_KEY } });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    const orders = await r.json();
    let blmBayar = 0, diproses = 0, dikirim = 0, omsetTotal = 0;
    for (const o of orders) {
      if (o.status === 'pending') blmBayar++;
      else {
        omsetTotal += Number(o.total_harga) || 0;
        if (o.status === 'diproses') diproses++;
        if (o.status === 'dikirim') dikirim++;
      }
    }
    const txt = `☀️ *MORNING BRIEFING TOKO*\n\nSelamat Pagi Bos! Berikut status pesanan kita saat ini:\n\n⏳ *Belum Bayar:* ${blmBayar} antrean\n⚙️ *Sedang Diproses:* ${diproses} antrean\n🚚 *Sedang Dikirim:* ${dikirim} paket\n\n💰 *Total Akumulasi Omset:* ${rp(omsetTotal)}\n\nSemangat cuan hari ini! 🚀`;
    await sendMessage(ownerId, txt, { parse_mode: 'Markdown' });
    await fetch(`${SB_URL}/rest/v1/agent_activity`, {
      method: 'POST',
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify([{ kategori: 'laporan', aksi: 'briefing', detail: `Morning briefing terkirim: ${blmBayar} belum bayar, ${diproses} diproses, ${dikirim} dikirim.` }]),
    }).catch(() => {});
    return res.status(200).json({ ok: true, blmBayar, diproses, dikirim });
  } catch (e) {
    console.error('[briefing]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
