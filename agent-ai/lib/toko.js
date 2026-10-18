'use strict';
/**
 * Skill TOKO: jawab pertanyaan bahasa Indonesia tentang toko
 * (stok, pesanan, omset, pelanggan) via database Supabase.
 * Pola: router (LLM) -> query PostgREST -> jawab (LLM).
 */

const { chat } = require('./llm');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const ROUTER_PROMPT = `Kamu adalah perencana query untuk database toko.
Tabel dan kolom yang tersedia:
- orders(id, tanggal, nama_penerima, nomor_wa, alamat_lengkap, nomor_resi, total_harga, status, link_tracking, catatan)
  status ∈ pending, diproses, dikirim, selesai, batal
  ("belum bayar" = pending, "diproses" = diproses, "dikirim" = dikirim, "selesai" = selesai, "batal" = batal)
- products(id, nama, kategori, deskripsi, harga, stok, link_gambar)
- customers(id, nama, nomor_wa, provinsi, kota_kabupaten, kecamatan, desa_kelurahan, patokan, kode_pos, alamat_lengkap)
- order_summary(id, tanggal, nama_penerima, nomor_wa, nomor_resi, status, total_harga, jumlah_item, ringkasan_produk)

Tugas: baca pertanyaan user (Bahasa Indonesia), keluarkan SATU objek JSON saja:
{"queries": [{"table": "orders|products|customers|order_summary", "select": "kolom1,kolom2", "filter": {"kolom": "eq.nilai"}, "order": "kolom.desc", "limit": 20}]}
Aturan filter: "eq.nilai" sama dengan, "ilike.*teks*" mengandung teks, "gte.2026-10-01" tanggal >= , "lte.2026-10-18" tanggal <= .
Untuk pertanyaan tanggal relatif ("minggu ini", "hari ini"), hitung dari hari ini dan pakai gte/lte.
Jika pertanyaan tidak butuh data (salam, basa-basi), keluarkan {"queries": []}.
PENTING: pertanyaan tentang PRODUK (ukuran, varian, harga, stok, "nota ukuran mana",
"ukuran apa aja yang ada", "yang biasa dipesan") BUKAN basa-basi — selalu buat query ke products.
Contoh: "mau cetak nota ukuran mana ya biasanya"
→ {"queries": [{"table": "products", "select": "id,nama,harga,stok,deskripsi", "limit": 20}]}
JANGAN tulis apa pun selain JSON.`;

const ANSWER_PROMPT = `Kamu adalah asisten toko yang ramah, menjawab dalam Bahasa Indonesia.
Diberi pertanyaan user dan hasil query database (JSON), jawab singkat dan jelas.
Format uang sebagai Rupiah (contoh: Rp 150.000). Angka ribuan pakai titik.
Jika hasil query ada yang error 'gagal mengambil data', katakan database sedang tidak bisa diakses dan minta user coba lagi nanti.
Jika data kosong (count 0), katakan terus terang ("belum ada data") dan tawarkan alternatif terdekat.
Jangan mengarang data yang tidak ada di hasil query.

PENGETAHUAN PRODUK (toko nota NCR ini):
- Ukuran yang dijual: 1/2, 1/3, 1/4, 1/6, 1/8, 1/10 folio.
- Tiap ukuran ada 50 lembar (Rp 22.830) dan 100 lembar (Rp 45.650); semua bisa 1ply/2ply/3ply.
- Ukuran yang paling biasa dipesan pelanggan: 1/2 folio dan 1/3 folio.
- Saat user minta rekomendasi ukuran, sarankan 1/2 atau 1/3 folio dengan harga dari hasil query,
  dan pastikan stoknya > 0 — jangan tawarkan produk yang stoknya habis.
- Harga pasti mengikuti hasil query products, bukan ingatan.`;

function parsePlan(raw) {
  let plan = { queries: [] };
  try {
    plan = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    try {
      const m = String(raw).match(/\{[\s\S]*\}/);
      if (m) plan = JSON.parse(m[0]);
    } catch { /* tetap kosong */ }
  }
  if (!Array.isArray(plan.queries)) plan.queries = [];
  return plan;
}

async function sbQuery({ table, select = '*', filter = {}, order, limit = 20 }) {
  const p = new URLSearchParams({ select, limit: String(limit) });
  for (const [k, v] of Object.entries(filter)) p.append(k, v);
  if (order) p.append('order', order);
  // Retry 3x dengan backoff untuk atasi intermittent failure
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?${p}`, {
        headers: { apikey: SB_KEY },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Supabase ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Jawab pertanyaan toko. Mengembalikan { answer, usedDb }.
 * usedDb=false berarti pertanyaan tidak butuh data (sapaan/dll).
 */
async function answer(question) {
  if (!SB_URL || !SB_KEY || SB_KEY.includes('___ISI')) {
    throw new Error('SUPABASE_SERVICE_KEY belum diisi — skill toko butuh service_role key.');
  }
  const planRaw = await chat(
    [
      { role: 'system', content: ROUTER_PROMPT },
      { role: 'user', content: String(question) },
    ],
    { maxTokens: 500, temperature: 0.2 }
  );
  const plan = parsePlan(planRaw);
  if (!plan.queries.length) return { answer: null, usedDb: false };

  const results = [];
  for (const q of plan.queries.slice(0, 4)) {
    try {
      const rows = await sbQuery(q);
      results.push({ table: q.table, count: rows.length, rows: rows.slice(0, 30) });
    } catch {
      results.push({ table: q.table, error: 'gagal mengambil data' });
    }
  }
  const answerText = await chat(
    [
      { role: 'system', content: ANSWER_PROMPT },
      { role: 'user', content: `Pertanyaan: ${question}\n\nHasil database:\n${JSON.stringify(results).slice(0, 6000)}` },
    ],
    { maxTokens: 1200, temperature: 0.3 }
  );
  return { answer: answerText, usedDb: true };
}

module.exports = { answer, parsePlan };
