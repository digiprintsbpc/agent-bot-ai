'use strict';
/**
 * GET /api/cron/hourly — jalan tiap hari 09:00 WIB (cron: 0 2 * * *).
 * (Paket Hobby Vercel hanya boleh cron harian.)
 *  1) Auto-selesai: pesanan "dikirim" yang sudah melewati estimasi → "selesai".
 *  2) Follow-up 30 hari: promo ke customer lama (anti-dobel via followup_log).
 * Port dari interval bot lama. Auth: Authorization: Bearer CRON_SECRET.
 */
const { sendMessage, sendDocument } = require('../../lib/telegram-api');

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
  const r = await fetch(`${SB_URL}/rest/v1/wa_outbox`, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify([{ to_wa: formatWA(toWa), kind, content, caption: caption || null, status: 'pending' }]),
  }).catch(() => null);
  return !!(r && r.ok);
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

    // ---- 0) Bersihkan sesi basi >7 hari (bug #8; sesi basi antar-langkah
    //         juga sudah diabaikan di getSession lib/customer.js) ----
    {
      const cutoff = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
      await fetch(`${SB_URL}/rest/v1/order_sessions?updated_at=lt.${encodeURIComponent(cutoff)}`, {
        method: 'DELETE', headers: H,
      }).catch(() => {});
    }

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
        // Tepat 3 hari setelah dikirim → selesai otomatis
        const target = new Date(o.updated_at).getTime() + 3 * 24 * 3600 * 1000;
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

    // ---- 2) Follow-up 20 hari: tanya kepuasan + tawarkan produk ----
    {
      const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
      t.setDate(t.getDate() - 20);
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
        const pesan = `Halo kak ${o.nama_penerima}! 👋\n\nPesanan kakak (ID: ${o.id}) sudah 20 hari yang lalu. Gimana, puas dengan produknya? 😊\n\nKalau ada kebutuhan cetak lagi (nota, kwitansi, dll), langsung balas chat ini aja ya kak! Ada diskon spesial untuk pelanggan setia. 🚀`;
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

    // ---- 3) FITUR JUALAN: Pengingat bayar otomatis ----
    // Order pending > 3 jam & belum pernah diingatkan → kirim WA reminder
    {
      out.reminder = 0;
      const tigaJamLalu = new Date(now - 3 * 3600 * 1000).toISOString();
      const q3 = new URLSearchParams({
        select: 'id,nama_penerima,nomor_wa,total_harga,tanggal', status: 'eq.pending',
        tanggal: `lt.${tigaJamLalu}`, limit: '100', order: 'tanggal',
      });
      const r = await fetch(`${SB_URL}/rest/v1/orders?${q3}`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      for (const o of rows) {
        if (!o.nomor_wa) continue;
        // Sudah pernah diingatkan? (cek reminder_sent_at)
        const cek = await fetch(`${SB_URL}/rest/v1/orders?id=eq.${o.id}&select=reminder_sent_at`, { headers: H });
        const cj = cek.ok ? await cek.json() : [];
        if (cj[0] && cj[0].reminder_sent_at) continue;

        const rpF = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
        await queueWA(o.nomor_wa, 'text',
          `⏰ *PENGINGAT PEMBAYARAN*\n\nHalo kak ${o.nama_penerima}! Pesanan *${o.id}* (${rpF(o.total_harga)}) belum dibayar nih.\n\nYuk selesaikan pembayaran agar pesanan segera diproses! 🙏\nBalas chat ini kalau ada kendala ya kak.`).catch(() => {});
        await fetch(`${SB_URL}/rest/v1/orders?id=eq.${o.id}`, {
          method: 'PATCH', headers: H,
          body: JSON.stringify({ reminder_sent_at: new Date().toISOString() }),
        }).catch(() => {});
        out.reminder++;
      }
      if (out.reminder > 0 && OWNER_ID) {
        await sendMessage(OWNER_ID,
          `⏰ *${out.reminder} pengingat bayar* terkirim via WA.`,
          { parse_mode: 'Markdown' }).catch(() => {});
      }
    }

    // ---- 4) FITUR ADMIN: Alert stok menipis (1x sehari, anti-dobel) ----
    {
      out.stokAlert = 0;
      const wibNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
      const p2 = (n) => String(n).padStart(2, '0');
      const todayKey = `${wibNow.getFullYear()}-${p2(wibNow.getMonth() + 1)}-${p2(wibNow.getDate())}`;
      const r = await fetch(`${SB_URL}/rest/v1/products?select=id,nama,stok&stok=lt.10&order=stok.asc&limit=50`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      if (rows.length && OWNER_ID) {
        const cek = await fetch(`${SB_URL}/rest/v1/agent_activity?aksi=eq.stok_alert_${todayKey}&limit=1`, { headers: H });
        const cj = cek.ok ? await cek.json() : [];
        if (!cj.length) {
          const list = rows.map((x) => `• *${x.id}* — ${x.nama} (sisa ${x.stok ?? 0})`).join('\n');
          await sendMessage(OWNER_ID,
            `⚠️ *STOK MENIPIS*\n\n${list}\n\nSegera restock ya!`,
            { parse_mode: 'Markdown' }).catch(() => {});
          await fetch(`${SB_URL}/rest/v1/agent_activity`, {
            method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify([{ kategori: 'toko', aksi: `stok_alert_${todayKey}`, detail: `${rows.length} produk stok < 10` }]),
          }).catch(() => {});
          out.stokAlert = rows.length;
        }
      }
    }

    // ---- 5) FITUR ADMIN: Backup otomatis tiap Senin ----
    {
      out.backup = 0;
      const wibNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
      if (wibNow.getDay() === 1 && OWNER_ID) { // 1 = Senin
        try {
          const dump = { tanggal: new Date().toISOString(), tabel: {} };
          for (const t of ['orders', 'products', 'customers']) {
            const rr = await fetch(`${SB_URL}/rest/v1/${t}?select=*&limit=5000`, { headers: H });
            dump.tabel[t] = rr.ok ? await rr.json() : [];
          }
          const p2 = (n) => String(n).padStart(2, '0');
          const fname = `backup-toko-${wibNow.getFullYear()}${p2(wibNow.getMonth() + 1)}${p2(wibNow.getDate())}.json`;
          await sendDocument(OWNER_ID, Buffer.from(JSON.stringify(dump, null, 2), 'utf8'), fname,
            `💾 *Backup mingguan toko*\nOrders: ${dump.tabel.orders.length} | Products: ${dump.tabel.products.length} | Customers: ${dump.tabel.customers.length}`)
            .catch(() => {});
          out.backup = 1;
        } catch (e) { console.error('[cron] backup gagal:', e.message); }
      }
    }

    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('[cron-hourly]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
