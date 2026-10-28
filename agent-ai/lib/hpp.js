'use strict';
/**
 * lib/hpp — mesin hitung bahan baku / HPP (murni, tanpa I/O).
 * Dipakai api/dash-admin.js (aksi bahan-baku / compute-hpp).
 *
 * RUMUS NYATA dari spreadsheet pemilik (sheet "Offline").
 * Sheet memakai satuan ribu rupiah; di sini dipakai rupiah penuh
 * (sheet 0,3 ribu = Rp 300; 140 ribu = Rp 140.000; 0,02 ribu = Rp 20).
 *
 *   harga kertas per lembar = harga_per_box / isi_per_box
 *     (Top 160, Middle 160, Buttom 152, HVS 144)
 *   harga print per lembar (E) = harga kertas per lembar + biaya_print_per_lembar
 *     (E Top 460, Middle 460, Buttom 452, HVS 444 — dengan print Rp 300)
 *   HPP per buku:
 *     1ply: qty x E[kertas tunggal] + flat
 *     2ply/3ply: (qty/2) x E[tiap kertas komposisi] + flat
 *     flat = Rp 20 per buku (sel F3/F4 sheet)
 *     Contoh: 1ply-50 = 50x444+20 = 22.220; 2ply-50 = 25x460+25x452+20 = 22.820;
 *             3ply-50 = 25x460+25x460+25x452+20 = 34.320
 *   Harga 1 folio = HPP x (1 + margin) — dengan QUIRK sheet:
 *     100-lembar 1ply/2ply menerapkan margin DUA KALI secara aditif,
 *     yaitu x (1 + 2*margin), BUKAN x (1+margin)^2.
 *     Contoh margin 2%: 1ply-100 = 44.420 x 1,04 = 46.196,8 (bukan x 1,0404).
 *     50-lembar semua ply dan 100-lembar 3ply: margin sekali, x (1 + margin).
 *   Harga jual per ukuran = fraksi folio x harga 1 folio
 *     (fraksi 1, 1/2, 1/3, 1/4, 1/6, 1/8, 1/10; dibulatkan ke rupiah).
 *     Validasi: 1/2 1ply 50 = 0,5 x 22.664,4 = 11.332,2 -> Rp 11.332 (cocok katalog).
 *   Paket rim offline (harga box KEDUA, berbeda dari tabel utama):
 *     harga rim = jumlah harga_box_rim komposisi rim + keuntungan_rim
 *     (1ply 152rb + 140rb = 292rb; 2ply 146rb + 140rb = 286rb;
 *      3ply 222rb + 140rb = 362rb; free ongkir Malang).
 *
 * KOMPOSISI DEFAULT (dari sheet, bisa diubah admin di UI):
 *   utama: 1ply = [HVS]; 2ply = [Top Putih, Buttom];
 *          3ply = [Top Putih, Middle, Buttom].
 *   rim (lihat ASUMSI di bawah): 1ply = [Top, Middle]; 2ply = [Top, Buttom];
 *          3ply = [Top, Middle, Buttom].
 *
 * ATURAN KERAS: modul ini TIDAK mengubah harga katalog. Margin, biaya print,
 * dan keuntungan rim hanya dipakai menghitung harga_hitung pembanding.
 */

const DENOM = [1, 2, 3, 4, 6, 8, 10];
const PLY = [1, 2, 3];
const QTY = [50, 100];
const FLAT_PER_BUKU = 20; // sel F3/F4 sheet: 0,02 ribu per buku

const DEFAULT_KOMPOSISI = {
  1: ['hvs-60gsm'],
  2: ['top-putih', 'buttom'],
  3: ['top-putih', 'middle', 'buttom'],
};

// Komposisi rim default — LIHAT ASUMSI: kertas persisnya tidak dinamai di sheet,
// default ini dipilih agar jumlahnya cocok (152/146/222 ribu).
const DEFAULT_KOMPOSISI_RIM = {
  1: ['top-putih', 'middle'],
  2: ['top-putih', 'buttom'],
  3: ['top-putih', 'middle', 'buttom'],
};

const DEFAULT_CONFIG = {
  margin_persen: 2,
  biaya_print_per_lembar: 300,
  keuntungan_rim: 140000,
  komposisi: DEFAULT_KOMPOSISI,
};

const DEFAULT_AMBANG_PERSEN = 10;

const ASUMSI = [
  'Margin live 2% (bukan 7%): label "Pendapatan Income 7%" dan "10%" di sheet HANYA skenario, tidak dipakai rumus utama.',
  'Komposisi rim default (1ply=[Top, Middle], 2ply=[Top, Buttom], 3ply=[Top, Middle, Buttom]) dipilih agar jumlahnya cocok (152/146/222 ribu) — kertas rim persisnya tidak dinamai di sheet, wajib validasi pemilik. Harga box rim HVS (70rb) tidak terpakai oleh default ini.',
  'Tambahan flat Rp 20/buku (sel F3/F4) dipakai sebagai konstanta rumus, bukan config.',
  'Lembar per kertas: 1ply = qty lembar; 2ply/3ply = qty/2 lembar per kertas (generalisasi harfiah rumus 50/100 sheet; katalog hanya punya 50/100).',
  'Quirk margin ganda (100-lembar 1ply/2ply) digeneralisasi sebagai x (1 + 2*margin) untuk margin berapa pun, karena rumus sheet memakai sel rate F3.',
  'Ambang flag selisih default 10% (bisa diubah saat hitung). Harga akhir dibulatkan ke rupiah (Math.round).',
  'Modul ini TIDAK mengubah harga katalog — hanya menghitung dan membandingkan.',
];

function num(v, nama) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${nama} harus angka`);
  return n;
}

function hargaKertasPerLembar(bahan) {
  const label = bahan.id || bahan.nama || '';
  const isi = num(bahan.isi_per_box, `isi_per_box ${label}`);
  const harga = num(bahan.harga_per_box, `harga_per_box ${label}`);
  if (isi <= 0) throw new Error(`isi_per_box harus > 0 (bahan ${label})`);
  if (harga < 0) throw new Error(`harga_per_box tidak boleh negatif (bahan ${label})`);
  return harga / isi;
}

function normalisasiConfig(config) {
  const c = config || {};
  const ambil = (key, def) => (c[key] === undefined || c[key] === null || c[key] === '' ? def : num(c[key], key));
  const margin = ambil('margin_persen', DEFAULT_CONFIG.margin_persen);
  if (margin < 0) throw new Error('margin_persen tidak boleh negatif');
  const print = ambil('biaya_print_per_lembar', DEFAULT_CONFIG.biaya_print_per_lembar);
  if (print < 0) throw new Error('biaya_print_per_lembar tidak boleh negatif');
  const untungRim = ambil('keuntungan_rim', DEFAULT_CONFIG.keuntungan_rim);
  if (untungRim < 0) throw new Error('keuntungan_rim tidak boleh negatif');
  const komposisi = c.komposisi || DEFAULT_CONFIG.komposisi;
  for (const ply of PLY) {
    const k = komposisi[ply] || komposisi[String(ply)];
    if (!Array.isArray(k) || !k.length || k.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new Error(`Komposisi ${ply}ply harus daftar ID bahan yang tidak kosong`);
    }
  }
  return {
    margin_persen: margin,
    biaya_print_per_lembar: print,
    keuntungan_rim: untungRim,
    komposisi: { 1: komposisi[1] || komposisi['1'], 2: komposisi[2] || komposisi['2'], 3: komposisi[3] || komposisi['3'] },
  };
}

function hppBuku(ply, qty, bahanById, cfg) {
  const lembarPerKertas = ply === 1 ? qty : qty / 2;
  let total = 0;
  for (const id of cfg.komposisi[ply]) {
    const b = bahanById.get(id);
    if (!b) throw new Error(`Bahan tidak ditemukan di komposisi ${ply}ply: ${id} (perbaiki komposisi di config)`);
    total += lembarPerKertas * (hargaKertasPerLembar(b) + cfg.biaya_print_per_lembar);
  }
  return total + FLAT_PER_BUKU;
}

function hargaSatuFolio(ply, qty, hpp, marginPersen) {
  // QUIRK sheet: 100-lembar 1ply/2ply menerapkan margin dua kali (aditif).
  const quirk = qty === 100 && (ply === 1 || ply === 2);
  const faktor = quirk ? (1 + (2 * marginPersen) / 100) : (1 + marginPersen / 100);
  return { harga: hpp * faktor, quirk };
}

function selesaikanBaris(o, ambangPersen) {
  const hargaHitung = Math.round(o.hargaHitung);
  const hargaKatalog = o.hargaKatalog === undefined || o.hargaKatalog === null ? null : Math.round(Number(o.hargaKatalog));
  let selisih = null;
  let selisihPersen = null;
  let flag = 'tanpa-pembanding';
  if (hargaKatalog !== null) {
    selisih = hargaHitung - hargaKatalog;
    selisihPersen = Math.round((selisih / hargaKatalog) * 1000) / 10;
    flag = Math.abs(selisihPersen) > ambangPersen ? 'selisih-besar' : 'ok';
  }
  return {
    denom: o.denom,
    fraksi_label: o.denom === 1 ? '1' : `1/${o.denom}`,
    ply: o.ply,
    qty: o.qty,
    produk_id: o.produkId,
    hpp_buku: Math.round(o.hpp),
    harga_satu_folio: Math.round(o.hargaSatuFolio * 10) / 10,
    harga_hitung: hargaHitung,
    harga_katalog: hargaKatalog,
    selisih,
    selisih_persen: selisihPersen,
    flag,
    quirk_margin_ganda: !!o.quirk,
  };
}

function ambangDari(v) {
  const a = v === undefined || v === null || v === '' ? DEFAULT_AMBANG_PERSEN : num(v, 'ambang_persen');
  if (a < 0) throw new Error('ambang_persen tidak boleh negatif');
  return a;
}

function computeTabel({ bahan, config, katalog, ambangPersen }) {
  const cfg = normalisasiConfig(config);
  const ambang = ambangDari(ambangPersen);
  const bahanById = new Map((bahan || []).map((b) => [b.id, b]));
  const rows = [];
  for (const denom of DENOM) {
    const fraksi = 1 / denom;
    for (const ply of PLY) {
      for (const qty of QTY) {
        const hpp = hppBuku(ply, qty, bahanById, cfg);
        const { harga, quirk } = hargaSatuFolio(ply, qty, hpp, cfg.margin_persen);
        const produkId = `N${denom}-${ply}P-${qty}`;
        rows.push(selesaikanBaris({
          denom, ply, qty, produkId,
          hpp,
          hargaSatuFolio: harga,
          hargaHitung: fraksi * harga,
          hargaKatalog: katalog ? katalog[produkId] : undefined,
          quirk,
        }, ambang));
      }
    }
  }
  return { config: cfg, ambang_persen: ambang, rows };
}

function computeRim({ bahan, config, katalog, ambangPersen }) {
  const cfg = normalisasiConfig(config);
  const ambang = ambangDari(ambangPersen);
  const bahanById = new Map((bahan || []).map((b) => [b.id, b]));
  const rows = [];
  for (const ply of PLY) {
    let bahanRim = 0;
    for (const id of DEFAULT_KOMPOSISI_RIM[ply]) {
      const b = bahanById.get(id);
      if (!b) throw new Error(`Bahan tidak ditemukan di komposisi rim ${ply}ply: ${id}`);
      const rim = b.harga_box_rim;
      if (rim === undefined || rim === null || rim === '') {
        throw new Error(`harga_box_rim belum diisi untuk bahan ${id} — isi dulu di tab Bahan Baku`);
      }
      const r = num(rim, `harga_box_rim ${id}`);
      if (r < 0) throw new Error(`harga_box_rim tidak boleh negatif (bahan ${id})`);
      bahanRim += r;
    }
    const hargaHitung = bahanRim + cfg.keuntungan_rim;
    const produkId = `RIM-${ply}P`;
    const hargaKatalog = katalog ? katalog[produkId] : undefined;
    let selisih = null;
    let selisihPersen = null;
    let flag = 'tanpa-pembanding';
    const hitung = Math.round(hargaHitung);
    const kat = hargaKatalog === undefined || hargaKatalog === null ? null : Math.round(Number(hargaKatalog));
    if (kat !== null) {
      selisih = hitung - kat;
      selisihPersen = Math.round((selisih / kat) * 1000) / 10;
      flag = Math.abs(selisihPersen) > ambang ? 'selisih-besar' : 'ok';
    }
    rows.push({
      ply, produk_id: produkId,
      bahan_rim: Math.round(bahanRim),
      keuntungan_rim: Math.round(cfg.keuntungan_rim),
      harga_hitung: hitung,
      harga_katalog: kat,
      selisih, selisih_persen: selisihPersen, flag,
    });
  }
  return rows;
}

module.exports = {
  DENOM, PLY, QTY, FLAT_PER_BUKU,
  DEFAULT_KOMPOSISI, DEFAULT_KOMPOSISI_RIM, DEFAULT_CONFIG, DEFAULT_AMBANG_PERSEN, ASUMSI,
  hargaKertasPerLembar, normalisasiConfig, hppBuku, hargaSatuFolio, computeTabel, computeRim,
};
