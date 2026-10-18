'use strict';
/**
 * GET /api/cron/hourly — jalan tiap jam (cron: 0 * * * *):
 *  1) Auto-selesai: pesanan "dikirim" yang sudah melewati estimasi → "selesai".
 *  2) Follow-up 30 hari: promo ke customer lama (anti-dobel via followup_log).
 * Port dari interval bot lama. Auth: Authorization: Bearer CRON_SECRET.
 */
const { sendMessage } = require('../../lib/telegram-api');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const OWNER_ID = String(process.env.TELEGRAM_ALLOWED_ID || '');
const H = { apikey: SB_KEY, 'Content-Type': 'application/json' };

function getEstimasi(alamat) {
  const s = String(alamat || '').toLowerCase();
  if (s.match(/jawa|jatim|jateng|jabar|jakarta|banten/)) return 3;
  if (s.match(/bali|sumatera|ntb/)) return 5;
  return 4;
}
function formatWA(wa) {
  let c = String(wa || '').replace(/[^0-9]/g, '');
  if (c.startsWith('0')) c = '62' + c.substring(1);
  if (!c.startsWith('62')) c = '62' + c;
  return c;
}
async function queueWA(toWa, kind, content, caption) {
  await fetch(`${SB_URL}/rest/v1/wa_outbox`, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify([{ to_wa: formatWA(toWa), kind, content, caption: caption || null, status: 'pending' }]),
  });
}

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
    const now = Date.now();
    const out = { autoSelesai: 0, followup: 0 };

    // ---- 1) Auto-selesai ----
    {
      const q = new URLSearchParams({ select: 'id,nomor_wa,alamat_lengkap,updated_at', status: 'eq.dikirim', limit: '200' });
      const r = await fetch(`${SB_URL}/rest/v1/orders?${q}`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      // profil untuk nama toko
      let namaToko = 'toko kami';
      try {
        const pr = await fetch(`${SB_URL}/rest/v1/store_profile?id=eq.1`, { headers: H });
        const pj = await pr.json();
        if (pj[0] && pj[0].nama) namaToko = pj[0].nama;
      } catch {}
      for (const o of rows) {
        const hari = getEstimasi(o.alamat_lengkap);
        const target = new Date(o.updated_at).getTime() + hari * 24 * 3600 * 1000;
        if (now >= target) {
          await fetch(`${SB_URL}/rest/v1/orders?id=eq.${o.id}`, {
            method: 'PATCH', headers: H, body: JSON.stringify({ status: 'selesai' }),
          });
          if (o.nomor_wa) {
            await queueWA(o.nomor_wa, 'text',
              `✅ *PESANAN SELESAI (${o.id})*\n\nHalo kak! Masa garansi pengiriman pesanan kakak telah habis, sehingga transaksi otomatis kami selesaikan.\n\nTerima kasih telah berbelanja di *${namaToko}*! 🥰`).catch(() => {});
          }
          if (OWNER_ID) {
            await sendMessage(OWNER_ID,
              `🤖 *AUTO-SELESAI WILAYAH*\nPesanan ${o.id} telah ditutup otomatis karena masa estimasi pengiriman kurir telah habis.`,
              { parse_mode: 'Markdown' }).catch(() => {});
          }
          out.autoSelesai++;
        }
      }
    }

    // ---- 2) Follow-up 30 hari ----
    {
      const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
      t.setDate(t.getDate() - 30);
      const p = (n) => String(n).padStart(2, '0');
      const dayStart = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T00:00:00+07:00`;
      const dayEnd = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T23:59:59+07:00`;
      // rentang satu hari penuh (PostgREST: and=)
      const q2 = new URLSearchParams({
        select: 'id,tanggal,nama_penerima,nomor_wa,status', limit: '200',
        and: `(tanggal.gte.${dayStart},tanggal.lte.${dayEnd})`, order: 'tanggal',
      });
      const r = await fetch(`${SB_URL}/rest/v1/orders?${q2}`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      let namaToko = 'toko kami';
      try {
        const pr = await fetch(`${SB_URL}/rest/v1/store_profile?id=eq.1`, { headers: H });
        const pj = await pr.json();
        if (pj[0] && pj[0].nama) namaToko = pj[0].nama;
      } catch {}
      for (const o of rows) {
        if (o.status === 'pending' || !o.nomor_wa) continue;
        // sudah pernah follow-up?
        const fl = await fetch(`${SB_URL}/rest/v1/followup_log?order_id=eq.${o.id}`, { headers: H });
        const flj = fl.ok ? await fl.json() : [];
        if (flj.length) continue;
        const pesan = `Halo kak ${o.nama_penerima}! 👋\nNggak kerasa udah sebulan ya sejak pesanan terakhir (ID: ${o.id}) di *${namaToko}*.\n\nKalau ada kebutuhan cetak lagi, silakan balas chat ini ya kak buat klaim diskon spesial pelanggan lama! 🚀`;
        await queueWA(o.nomor_wa, 'text', pesan).catch(() => {});
        await fetch(`${SB_URL}/rest/v1/followup_log`, {
          method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify([{ order_id: o.id }]),
        }).catch(() => {});
        if (OWNER_ID) {
          await sendMessage(OWNER_ID,
            `📣 *Auto Follow-Up Terkirim!*\nKepada: ${o.nama_penerima} (${o.nomor_wa})\nID Pesanan: ${o.id}`,
            { parse_mode: 'Markdown' }).catch(() => {});
        }
        out.followup++;
      }
    }

    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('[cron-hourly]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
