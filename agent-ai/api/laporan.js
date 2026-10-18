'use strict';
/**
 * GET /api/laporan — Laporan harian toko, dikirim ke owner via Telegram.
 *
 * Dijalankan via Vercel Cron tiap hari 21:00 WIB (jadwal di vercel.json: 0 14 * * *).
 * Isi: order masuk hari ini, omset, belum bayar, diproses, selesai.
 *
 * Auth: header x-vercel-cron, atau Authorization: Bearer CRON_SECRET, atau ?token=CRON_SECRET.
 */

const { sendMessage } = require('../lib/telegram-api');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const OWNER_ID = String(process.env.TELEGRAM_ALLOWED_ID || '');
const H = { apikey: SB_KEY, 'Content-Type': 'application/json' };

const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

function authorized(req) {
  if (String(req.headers['x-vercel-cron'] || '') === '1') return true;
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return false;
  if (req.headers.authorization === `Bearer ${secret}`) return true;
  if (String((req.query || {}).token || '') === secret) return true;
  return false;
}

module.exports = async (req, res) => {
  try {
    if (!authorized(req)) return res.status(401).send('unauthorized');
    if (!OWNER_ID) return res.status(200).json({ ok: false, error: 'OWNER_ID kosong' });

    // Rentang hari ini (WIB)
    const nowWib = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const p = (n) => String(n).padStart(2, '0');
    const dayStart = `${nowWib.getFullYear()}-${p(nowWib.getMonth() + 1)}-${p(nowWib.getDate())}T00:00:00+07:00`;
    const dayEnd = `${nowWib.getFullYear()}-${p(nowWib.getMonth() + 1)}-${p(nowWib.getDate())}T23:59:59+07:00`;
    const tglLabel = nowWib.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

    // Ambil semua order hari ini
    const q = new URLSearchParams({
      select: 'id,total_harga,status', limit: '500',
      and: `(tanggal.gte.${dayStart},tanggal.lte.${dayEnd})`,
    });
    const r = await fetch(`${SB_URL}/rest/v1/orders?${q}`, { headers: H });
    const rows = r.ok ? await r.json() : [];

    let orderMasuk = rows.length;
    let omset = 0;
    let belumBayar = 0, belumBayarRp = 0;
    let diproses = 0, dikirim = 0, selesai = 0, batal = 0;

    for (const o of rows) {
      const total = Number(o.total_harga || 0);
      if (o.status !== 'batal') omset += total;
      switch (o.status) {
        case 'pending': belumBayar++; belumBayarRp += total; break;
        case 'diproses': diproses++; break;
        case 'dikirim': dikirim++; break;
        case 'selesai': selesai++; break;
        case 'batal': batal++; break;
      }
    }

    const laporan =
`📊 *LAPORAN HARIAN — ${tglLabel}*
━━━━━━━━━━━━━━━
• Order masuk: *${orderMasuk}*
• Omset: *${rp(omset)}*
• Belum bayar: *${belumBayar}* (${rp(belumBayarRp)})
• Diproses: *${diproses}*
• Dikirim: *${dikirim}*
• Selesai: *${selesai}*
• Batal: *${batal}*
━━━━━━━━━━━━━━━
Semangat jualannya! 💪`;

    await sendMessage(OWNER_ID, laporan, { parse_mode: 'Markdown' });
    return res.status(200).json({ ok: true, orderMasuk, omset });
  } catch (e) {
    console.error('[laporan]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
