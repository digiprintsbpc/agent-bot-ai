'use strict';
/**
 * lib/orderLookup.js — Lapisan query DETERMINISTIK untuk bot owner.
 * Dipakai lapisan penerjemah (lib/penerjemah.js) dan jalur deterministik toko.
 *
 * ATURAN KERAS:
 * - Setiap jawaban di sini disusun KODE dari baris database nyata. Tidak ada
 *   LLM di modul ini, jadi tidak mungkin mengarang angka/status/nama.
 * - Semua nomor yang perlu disalin (ID order, nomor resi, nomor WA) ditulis
 *   sebagai kode tap-to-copy Telegram: dibungkus backtick, mis. `INV-537328`.
 * - Produk yang dicakup HANYA fisik. Modul ini tidak mengenal produk digital
 *   dan tidak boleh diberi referensi digital apa pun.
 * - Status omset mengikuti dashboard: "dibayar" = status diproses/dikirim/
 *   selesai (bukan pending/batal). Lihat api/dash-admin.js STATUS_OK.
 */

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const code = (s) => '`' + String(s) + '`';

const STATUS_OK = ['diproses', 'dikirim', 'selesai'];
const STATUS_LABEL = {
  pending: 'pending ⏳',
  diproses: 'diproses ⚙️',
  dikirim: 'dikirim 🚚',
  selesai: 'selesai ✅',
  batal: 'batal ❌',
};

function sbHeaders() {
  return { apikey: SB_KEY, 'Content-Type': 'application/json' };
}

async function sbFetch(path) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
        headers: sbHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Supabase ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i === 0) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

function wibDateParts(d = new Date()) {
  const s = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); // YYYY-MM-DD
  const [y, m, day] = s.split('-').map(Number);
  return { y, m, day };
}

function wibDayRange(d = new Date()) {
  const { y, m, day } = wibDateParts(d);
  const start = new Date(Date.UTC(y, m - 1, day) - 7 * 3600 * 1000);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function wibMonthRange(d = new Date()) {
  const { y, m } = wibDateParts(d);
  const start = new Date(Date.UTC(y, m - 1, 1) - 7 * 3600 * 1000);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  const end = new Date(Date.UTC(ny, nm - 1, 1) - 7 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function wibWeekRange(d = new Date()) {
  const { y, m, day } = wibDateParts(d);
  const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay(); // 0=Min .. 6=Sab
  const mondayOffset = (dow + 6) % 7; // Senin = awal pekan
  const start = new Date(Date.UTC(y, m - 1, day - mondayOffset) - 7 * 3600 * 1000);
  const end = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function fmtTanggal(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }) + ' WIB';
  } catch { return String(iso); }
}

function formatWA(wa) {
  let clean = String(wa || '').replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) clean = '62' + clean.substring(1);
  if (clean && !clean.startsWith('62')) clean = '62' + clean;
  return clean;
}

/**
 * Ekstrak kandidat digit ID order dari teks bebas.
 * - "INV-537328", "INV 537328", "NV-537328", "NV 537328" -> "537328"
 * - Angka pendek (3-6 digit) dalam konteks order ("invoice 537", "pesanan 537328")
 *   -> digit tersebut.
 * - Nomor HP (10+ digit, 62.../08...) TIDAK PERNAH dianggap ID order.
 * Mengembalikan string digit atau null.
 */
function extractOrderDigits(text) {
  const t = String(text || '');
  const mPref = t.match(/(?:INV|NV)\s*-?\s*(\d{3,6})/i);
  if (mPref) return mPref[1];
  // Nomor HP -> bukan ID order (ditangani jalur riwayat WA).
  if (/\b(?:62\d{9,}|08\d{8,})\b/.test(t)) return null;
  const mCtx = t.match(/\b(?:invoice|pesanan|order|resi|penerima|tagihan)\b[^0-9]{0,20}(\d{3,6})\b/i)
    || t.match(/\b(\d{3,6})\b/);
  if (!mCtx) return null;
  const digits = mCtx[1];
  // Angka pendek tanpa konteks order yang jelas (mis. "537" saja) tetap diterima
  // sebagai kandidat — resolveOrder akan meminta klarifikasi bila ganda.
  return digits;
}

/**
 * Resolusi ID order dari digit kandidat.
 * Cari order yang ID-nya berawalan INV-<digit> (pola LIKE server-side).
 * - tepat 1 -> { status: 'found', order }
 * - >1     -> { status: 'multi', candidates: [order, ...] }
 * - 0      -> { status: 'none' }
 */
async function resolveOrder(digits) {
  const rows = await sbFetch(
    `orders?select=id,tanggal,nama_penerima,nomor_wa,alamat_lengkap,nomor_resi,total_harga,status`
    + `&id=like.INV-${digits}*&order=tanggal.desc&limit=20`
  );
  if (!rows.length) return { status: 'none' };
  if (rows.length === 1) return { status: 'found', order: rows[0] };
  return { status: 'multi', candidates: rows };
}

async function fetchOrderFull(orderId) {
  const orders = await sbFetch(
    `orders?select=id,tanggal,nama_penerima,nomor_wa,alamat_lengkap,nomor_resi,total_harga,status`
    + `&id=eq.${orderId}&limit=1`
  );
  if (!orders.length) return null;
  // order_items.harga_satuan TERVERIFIKASI ADA (live 28 Okt 2026) — dipakai
  // untuk harga + subtotal per item di template INV lengkap.
  const items = await sbFetch(
    `order_items?select=nama_produk,qty,harga_satuan&order_id=eq.${orderId}&limit=50`
  ).catch(() => []);
  return { order: orders[0], items: Array.isArray(items) ? items : [] };
}

function formatItems(items) {
  if (!items.length) return '(tidak ada rincian item)';
  return items.map((it, idx) => {
    const hs = it.harga_satuan;
    // NULL-safe: baris tanpa harga_satuan tampil tanpa harga (baris lain utuh).
    if (hs == null || hs === '') return `${idx + 1}. ${it.nama_produk} ×${it.qty}`;
    const subtotal = Number(it.qty || 0) * Number(hs);
    return `${idx + 1}. ${it.nama_produk} ×${it.qty} @ ${rp(hs)} = ${rp(subtotal)}`;
  }).join('\n');
}

/** Template jawaban INV LENGKAP — satu lookup menjawab semua pertanyaan lanjutan. */
function formatOrderFull(o, items) {
  let teks = `🧾 *Detail Pesanan* ${code(o.id)}\n`
    + `- Nama: ${o.nama_penerima || '-'}\n`
    + `- Nomor WA: ${o.nomor_wa ? code(o.nomor_wa) : '-'}\n`
    + `- Alamat: ${o.alamat_lengkap || '-'}\n`
    + `- Tanggal: ${fmtTanggal(o.tanggal)}\n`
    + `- Status: ${STATUS_LABEL[o.status] || o.status}\n`
    + `- Total: ${rp(o.total_harga)}\n`
    + `- Resi: ${o.nomor_resi ? code(o.nomor_resi) : 'belum ada'}\n`
    + `\nIsi pesanan:\n${formatItems(items)}`;
  return teks;
}

function formatField(o, field) {
  const id = code(o.id);
  switch (field) {
    case 'nama':
      return `Nama penerima pesanan ${id} adalah *${o.nama_penerima || '-'}*.`;
    case 'nomor':
      return o.nomor_wa
        ? `Nomor WA penerima pesanan ${id} adalah ${code(o.nomor_wa)}.`
        : `Pesanan ${id} tidak memiliki nomor WA tercatat.`;
    case 'alamat':
      return `Alamat pesanan ${id}: ${o.alamat_lengkap || '-'}.`;
    case 'status':
      return `Status pesanan ${id} saat ini *${o.status}* (${o.nama_penerima || '-'}, ${rp(o.total_harga)}).`;
    case 'total':
      return `Total pesanan ${id} adalah *${rp(o.total_harga)}* (status: ${o.status}).`;
    case 'resi':
      return o.nomor_resi
        ? `Nomor resi pesanan ${id}: ${code(o.nomor_resi)}.`
        : `Pesanan ${id} belum memiliki nomor resi.`;
    default:
      return formatOrderFull(o, []);
  }
}

function formatOrderLine(o) {
  return `- ${code(o.id)} — ${o.nama_penerima || '-'} (${rp(o.total_harga)})`;
}

async function listByStatus(status, { todayOnly = false } = {}) {
  let path = `orders?select=id,tanggal,nama_penerima,total_harga,status&status=eq.${status}&order=tanggal.desc&limit=20`;
  if (todayOnly) {
    const { start } = wibDayRange();
    path += `&tanggal=gte.${encodeURIComponent(start)}`;
  }
  const rows = await sbFetch(path);
  const label = STATUS_LABEL[status] || status;
  if (!rows.length) {
    return todayOnly
      ? `Tidak ada pesanan berstatus *${status}* hari ini.`
      : `Tidak ada pesanan berstatus *${status}*.`;
  }
  return `Ada *${rows.length}* pesanan berstatus ${label}${todayOnly ? ' hari ini' : ''}:\n`
    + rows.map(formatOrderLine).join('\n');
}

async function historyByWA(waRaw) {
  const wa = formatWA(waRaw);
  if (wa.length < 10) return `Nomor WA ${code(waRaw)} tidak valid.`;
  const rows = await sbFetch(
    `orders?select=id,tanggal,nama_penerima,status,total_harga&nomor_wa=eq.${wa}&order=tanggal.desc&limit=20`
  );
  if (!rows.length) {
    return `Tidak ditemukan pesanan dengan nomor WA ${code(wa)}.`;
  }
  return `Riwayat pesanan nomor WA ${code(wa)} (${rows.length} pesanan):\n`
    + rows.map((o) => `- ${code(o.id)} | ${fmtTanggal(o.tanggal)} | ${o.nama_penerima || '-'} | ${o.status} | ${rp(o.total_harga)}`).join('\n');
}

async function historyByName(name) {
  const q = String(name || '').trim();
  if (q.length < 2) return 'Sebutkan nama customer yang dicari, contoh: cari customer firman.';
  const rows = await sbFetch(
    `orders?select=id,tanggal,nama_penerima,nomor_wa,status,total_harga&nama_penerima=ilike.*${encodeURIComponent(q)}*&order=tanggal.desc&limit=20`
  );
  if (!rows.length) {
    return `Tidak ditemukan pesanan atas nama yang mengandung "${q}".`;
  }
  return `Riwayat belanja "${q}" (${rows.length} pesanan, dari data order):\n`
    + rows.map((o) => `- ${code(o.id)} | ${fmtTanggal(o.tanggal)} | ${o.nama_penerima || '-'} | ${o.nomor_wa ? code(o.nomor_wa) : '-'} | ${o.status} | ${rp(o.total_harga)}`).join('\n');
}

async function distinctWAList(limit = 50) {
  const rows = await sbFetch(
    `orders?select=nomor_wa&order=tanggal.desc&limit=500`
  );
  const seen = new Set();
  const list = [];
  for (const r of rows) {
    const wa = String(r.nomor_wa || '').replace(/[^0-9]/g, '');
    if (wa.length >= 10 && !seen.has(wa)) { seen.add(wa); list.push(wa); }
    if (list.length >= limit) break;
  }
  if (!list.length) return 'Belum ada nomor WA penerima di data pesanan.';
  return `Berikut daftar nomor WA penerima yang ada pada data pesanan:\n`
    + list.map((wa) => `- ${code(wa)}`).join('\n');
}

async function omset(period) {
  let range;
  let label;
  if (period === 'hari') { range = wibDayRange(); label = 'hari ini'; }
  else if (period === 'kemarin') {
    const y = new Date(Date.now() - 24 * 3600 * 1000);
    range = wibDayRange(y); label = 'kemarin';
  } else if (period === 'minggu') { range = wibWeekRange(); label = 'minggu ini'; }
  else if (period === 'bulan_lalu') {
    const { start } = wibMonthRange();
    const prev = new Date(new Date(start).getTime() - 24 * 3600 * 1000);
    range = wibMonthRange(prev); label = 'bulan lalu';
  }
  else { range = wibMonthRange(); label = 'bulan ini'; }
  const rows = await sbFetch(
    `orders?select=total_harga,tanggal&status=in.(${STATUS_OK.join(',')})`
    + `&tanggal=gte.${encodeURIComponent(range.start)}&tanggal=lte.${encodeURIComponent(range.end)}&limit=1000`
  );
  const total = rows.reduce((a, o) => a + Number(o.total_harga || 0), 0);
  return `Omset ${label}: *${rp(total)}* dari ${rows.length} pesanan (status diproses/dikirim/selesai).`;
}

/**
 * Katalog produk fisik dengan filter. TIDAK PERNAH memuntahkan seluruh katalog
 * kecuali diminta eksplisit (explicit=true).
 */
async function catalogFilter({ ply = null, ukuran = null, explicit = false } = {}) {
  const prods = await sbFetch(`products?select=id,nama,harga,stok&order=id&limit=100`);
  const byName = (p) => String(p.nama || '');
  let rows = prods;
  if (ply) rows = rows.filter((p) => byName(p).toLowerCase().includes(`${ply}ply`));
  if (ukuran) rows = rows.filter((p) => byName(p).includes(ukuran));
  if (!ply && !ukuran && !explicit) {
    // Ringkasan saja + minta filter — jangan memuntahkan katalog.
    const ukuranSet = [...new Set(prods.map((p) => (byName(p).match(/1\/\d+/) || [])[0]).filter(Boolean))];
    return `Katalog nota tersedia dalam ukuran: ${ukuranSet.join(', ')} — masing-masing 1ply/2ply/3ply, 50 dan 100 lembar.\n`
      + `Sebutkan filternya, contoh: "produk nota 2ply saja" atau "produk nota ukuran 1/4 saja".\n`
      + `Untuk daftar lengkap, ketik: katalog`;
  }
  if (!rows.length) {
    const desc = [ukuran ? `ukuran ${ukuran}` : null, ply ? `${ply}ply` : null].filter(Boolean).join(' ');
    return `Tidak ada produk nota ${desc} di katalog.`;
  }
  const shown = rows.slice(0, 50);
  const desc = [ukuran ? `ukuran ${ukuran}` : null, ply ? `${ply}ply` : null].filter(Boolean).join(' ');
  return `Produk nota${desc ? ` ${desc}` : ''} (${shown.length} dari ${rows.length}):\n`
    + shown.map((p) => `- ${code(p.id)} — ${p.nama} — ${rp(p.harga)}`).join('\n');
}

const NOT_FOUND = 'Tidak ditemukan order dengan pola itu. Kirim nomor INV lengkap (contoh: `INV-537328`).';

module.exports = {
  rp, code, formatWA, fmtTanggal,
  extractOrderDigits, resolveOrder, fetchOrderFull,
  formatOrderFull, formatField, formatOrderLine,
  listByStatus, historyByWA, historyByName, distinctWAList,
  omset, catalogFilter, NOT_FOUND, STATUS_LABEL,
  wibDayRange, wibMonthRange, wibWeekRange,
};
