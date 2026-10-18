'use strict';
/**
 * Briefing pagi otomatis — dipanggil Vercel Cron tiap 07:00 WIB.
 * Isi: ringkasan order kemarin (jumlah + omset), daftar belum bayar
 * (perlu follow-up), dan pesanan yang sedang berjalan.
 * Dikirim ke owner via Telegram. Tanpa LLM — deterministik, tanpa kuota API.
 */

const { sendMessage } = require('../lib/telegram-api');
const { opt } = require('../lib/env');
const { logActivity } = require('../lib/memory');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const WIB_MS = 7 * 3600 * 1000;

const rp = (n) => 'Rp ' + new Intl.NumberFormat('id-ID').format(Math.round(Number(n) || 0));
const tglId = (d) =>
  new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);

async function sbGet(table, pairs) {
  const q = new URLSearchParams();
  for (const [k, v] of pairs) q.append(k, v);
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, { headers: { apikey: SB_KEY } });
  if (!res.ok) throw new Error(`Supabase GET ${table}: ${res.status}`);
  return res.json();
}

module.exports = async (req, res) => {
  try {
    // Pengaman: tanpa ini, siapa pun yang tahu URL bisa memicu pesan
    // sekaligus melihat data order. Hanya Vercel Cron atau token manual.
    const isCron = String(req.headers['x-vercel-cron'] || '') === '1';
    const secret = opt('CRON_SECRET', '');
    const okToken = secret && String(((req.query || {}).token || '')) === secret;
    if (!isCron && !okToken) return res.status(401).json({ error: 'unauthorized' });

    const ownerId = opt('TELEGRAM_ALLOWED_ID', '');
    if (!SB_URL || !SB_KEY || !ownerId) {
      return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY / TELEGRAM_ALLOWED_ID belum lengkap' });
    }

    // "Kemarin" dalam zona WIB; kolom orders.tanggal bertipe timestamptz
    // (00:00–23:59 WIB = hari sebelumnya 17:00 UTC s.d. 16:59:59 UTC).
    const nowWib = new Date(Date.now() + WIB_MS);
    const kemarin = new Date(nowWib);
    kemarin.setUTCDate(kemarin.getUTCDate() - 1);
    const labelKemarin = kemarin.toISOString().slice(0, 10);
    const sehariLalu = new Date(kemarin);
    sehariLalu.setUTCDate(sehariLalu.getUTCDate() - 1);
    const gte = sehariLalu.toISOString().slice(0, 10) + 'T17:00:00Z';
    const lte = labelKemarin + 'T16:59:59.999Z';

    const [ordersKemarin, belumBayar, berjalan] = await Promise.all([
      sbGet('orders', [
        ['select', 'id,nama_penerima,total_harga,status'],
        ['tanggal', `gte.${gte}`],
        ['tanggal', `lte.${lte}`],
        ['order', 'tanggal.asc'],
        ['limit', '200'],
      ]),
      sbGet('orders', [
        ['select', 'id,nama_penerima,nomor_wa,total_harga,tanggal'],
        ['status', 'eq.pending'],
        ['order', 'tanggal.asc'],
        ['limit', '10'],
      ]),
      sbGet('orders', [
        ['select', 'id,status'],
        ['status', 'in.(diproses,dikirim)'],
        ['limit', '200'],
      ]),
    ]);

    const valid = ordersKemarin.filter((o) => o.status !== 'batal');
    const omset = valid.reduce((s, o) => s + (Number(o.total_harga) || 0), 0);
    const nSelesai = valid.filter((o) => o.status === 'selesai').length;
    const nPendingKemarin = valid.filter((o) => o.status === 'pending').length;

    const lines = [];
    lines.push(`📊 Briefing Pagi — ${tglId(nowWib)}`);
    lines.push('');
    if (valid.length) {
      lines.push(`🛒 Kemarin (${tglId(kemarin)}): ${valid.length} order • omset ${rp(omset)}`);
      lines.push(`   ✅ selesai: ${nSelesai} • 💰 belum bayar: ${nPendingKemarin}`);
    } else {
      lines.push(`🛒 Kemarin (${tglId(kemarin)}): tidak ada order masuk.`);
    }
    lines.push('');

    if (belumBayar.length) {
      const tunggakan = belumBayar.reduce((s, o) => s + (Number(o.total_harga) || 0), 0);
      lines.push('💰 Belum bayar — follow-up:');
      for (const o of belumBayar.slice(0, 8)) {
        const wa = o.nomor_wa ? ` • ${o.nomor_wa}` : '';
        lines.push(`   • ${o.nama_penerima} (${o.id}) — ${rp(o.total_harga)}${wa}`);
      }
      if (belumBayar.length > 8) lines.push(`   …dan ${belumBayar.length - 8} lagi`);
      lines.push(`   Total tertunggak: ${rp(tunggakan)}`);
    } else {
      lines.push('💰 Belum bayar: tidak ada — semua lunas 🎉');
    }
    lines.push('');

    const nProses = berjalan.filter((o) => o.status === 'diproses').length;
    const nKirim = berjalan.filter((o) => o.status === 'dikirim').length;
    lines.push(`📦 Sedang berjalan: ${nProses} diproses • ${nKirim} dikirim`);
    lines.push('');
    lines.push('🏢 Kantor 3D: https://agent-bot-ai-agent-ai.vercel.app/kerja/');

    const msg = lines.join('\n');
    await sendMessage(ownerId, msg);
    await logActivity(ownerId, 'toko', `Briefing pagi terkirim (${valid.length} order kemarin, omset ${rp(omset)})`);

    return res.status(200).json({ ok: true, sent: true, orders: valid.length, omset });
  } catch (e) {
    console.error('[briefing] gagal:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
