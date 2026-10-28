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
- order_items(order_id, product_id, nama_produk, qty) — isi barang per order; filter order_id "eq.INV-xxxxxx"
- pengeluaran(id, keterangan, nominal, tanggal) — biaya operasional toko.

Tugas: baca pertanyaan user (Bahasa Indonesia), keluarkan SATU objek JSON saja:
{"queries": [{"table": "orders|products|customers|order_summary|order_items|pengeluaran", "select": "kolom1,kolom2", "filter": {"kolom": "eq.nilai"}, "order": "kolom.desc", "limit": 20}]}
Aturan AGREGAT (omset, jumlah order, total pengeluaran): pakai limit 500 agar semua baris ikut terhitung.
Aturan filter: "eq.nilai" sama dengan, "ilike.*teks*" mengandung teks, "gte.2026-10-01" tanggal >= , "lte.2026-10-18" tanggal <= .
Untuk pencarian nomor WA/Hape: jika user memberi nomor lengkap (10+ digit) pakai "ilike.*nomor*"; jika hanya akhiran (mis. "3053", 4 digit) juga pakai "ilike.*3053*" pada kolom nomor_wa.
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

ATURAN KERAS: Kamu HANYA bisa MEMBACA data. Kamu TIDAK BISA mengubah status, menghapus, mengirim pesan, atau menyimpan apa pun. JANGAN PERNAH mengklaim sudah melakukan aksi tulis ("sudah diubah", "sudah dihapus", "sudah dikirim") — klaim seperti itu bohong. Bila user meminta aksi tulis, katakan aksi itu dilakukan lewat perintah admin/dashboard, bukan dari jawaban ini.

PENGETAHUAN PRODUK (toko nota NCR ini):
- Ukuran yang dijual: 1/2, 1/3, 1/4, 1/6, 1/8, 1/10 folio.
- Tiap ukuran tersedia 50 lembar dan 100 lembar; semua bisa 1ply/2ply/3ply.
  HARGA tiap varian BERBEDA — selalu sebutkan harga dari hasil query, JANGAN memakai contoh angka dari ingatan.
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

const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

/**
 * Jawab pertanyaan tentang SATU invoice secara DETERMINISTIK (tanpa LLM):
 * data selalu asli dari database, diformat oleh kode — tidak bisa mengarang.
 */
async function jawabInvoice(invId) {
  const orders = await sbQuery({
    table: 'orders',
    select: 'id,tanggal,nama_penerima,nomor_wa,alamat_lengkap,nomor_resi,total_harga,status',
    filter: { id: `eq.${invId}` }, limit: 1,
  });
  if (!orders.length) {
    return `Invoice \`${invId}\` tidak ditemukan di database. Pastikan nomornya benar ya.`;
  }
  const o = orders[0];
  const items = await sbQuery({
    table: 'order_items',
    // Skema nyata: hanya product_id, nama_produk, qty (tidak ada harga).
    select: 'nama_produk,qty',
    filter: { order_id: `eq.${invId}` }, limit: 50,
  }).catch(() => []);
  const tgl = o.tanggal
    ? new Date(o.tanggal).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '-';
  // Template LENGKAP (fase 1): semua field baris order + backtick untuk
  // ID/resi/WA agar sekali ketuk langsung tersalin di Telegram.
  let teks = `🧾 *Invoice \`${o.id}\`*\n` +
    `- Nama: ${o.nama_penerima || '-'}\n` +
    `- Nomor WA: ${o.nomor_wa ? `\`${o.nomor_wa}\`` : '-'}\n` +
    `- Alamat: ${o.alamat_lengkap || '-'}\n` +
    `- Tanggal: ${tgl} WIB\n` +
    `- Status: ${o.status}\n` +
    `- Resi: ${o.nomor_resi ? `\`${o.nomor_resi}\`` : 'belum ada'}\n`;
  if (items.length) {
    const totalQty = items.reduce((a, i) => a + Number(i.qty || 0), 0);
    teks += `\nIsi pesanan (${totalQty} unit):\n` + items.map((i, idx) => {
      // order_items di skema nyata tidak punya kolom harga — tampilkan harga
      // hanya bila kolom itu benar-benar ada, jangan karang angka.
      const harga = i.harga_satuan != null && i.harga_satuan !== ''
        ? ` @ ${rp(i.harga_satuan)} = ${rp(Number(i.qty || 0) * Number(i.harga_satuan || 0))}`
        : '';
      return `${idx + 1}. ${i.nama_produk} ×${i.qty}${harga}`;
    }).join('\n') + '\n';
  } else {
    teks += '\nIsi pesanan: (tidak ada rincian item)\n';
  }
  teks += `\n*Total: ${rp(o.total_harga)}*`;
  return teks;
}

/**
 * Jawab pertanyaan toko. Mengembalikan { answer, usedDb }.
 * usedDb=false berarti pertanyaan tidak butuh data (sapaan/dll).
 */
async function answer(question) {
  if (!SB_URL || !SB_KEY || SB_KEY.includes('___ISI')) {
    throw new Error('SUPABASE_SERVICE_KEY belum diisi — skill toko butuh service_role key.');
  }
  // REM KLAIM TULIS: skill toko HANYA bisa membaca. Permintaan AKSI TULIS (ubah status,
  // hapus, jadikan, kirim ke WA, dsb) TIDAK BOLEH dijawab LLM yang mengaku sudah
  // melakukannya — arahkan ke jalur deterministik yang benar-benar mengeksekusi.
  const qLow = String(question).toLowerCase();
  const niatTulis = /(rubah|ubah|ganti|jadikan|tandai|set)\s+(status|pesanan|order)|hapus\s+(order|pesanan|produk)|kirim(kan)?\s+.*(ke\s+wa|invoice|pdf|resi)|simpan\s+(catatan|data)|catat(kan)?\s+pengeluaran/.test(qLow);
  if (niatTulis) {
    return {
      usedDb: false,
      answer: 'Itu aksi mengubah data — saya di jalur baca saja, tidak bisa (dan tidak akan mengaku bisa) mengubah database dari sini.\n\nLakukan lewat jalur yang benar-benar mengeksekusi:\n• Ubah status 1 order: ketik `rubah status INV-xxxxxx menjadi selesai`\n• Banyak order: ketik `status massal`\n• Hapus order: `/hapus INV-xxxxxx`\n• Kirim invoice ke WA: `kirim invoice INV-xxxxxx ke WA`\n• Atau lewat dashboard /dash/ → Kelola Order.',
    };
  }
  // JALUR DETERMINISTIK: pertanyaan yang menyebut nomor invoice dijawab
  // langsung dari database TANPA LLM (cegah "belum ada data" palsu & karangan isi pesanan).
  const invMatch = String(question).match(/INV-\d{6}/i);
  if (invMatch) {
    const invId = invMatch[0].toUpperCase();
    try {
      return { answer: await jawabInvoice(invId), usedDb: true };
    } catch (e) {
      console.error('[toko] jawabInvoice gagal:', e.message);
      return { answer: `Maaf, database sedang tidak bisa diakses untuk cek ${invId}. Coba lagi nanti ya.`, usedDb: true };
    }
  }
  // Tanggal acuan WIB diinjeksikan agar filter "hari ini/minggu ini/bulan ini"
  // dihitung dari tanggal yang BENAR, bukan asumsi model.
  const todayWIB = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  const planRaw = await chat(
    [
      { role: 'system', content: ROUTER_PROMPT + `\n\nHari ini: ${todayWIB} (WIB). Hitung semua tanggal relatif dari tanggal ini.` },
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

module.exports = { answer, parsePlan, jawabInvoice };
