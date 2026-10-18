'use strict';
/**
 * lib/ocr.js — baca teks dari gambar via OCR.space.
 * Dipakai untuk: resi pengiriman (cocokkan ID pesanan) & bukti transfer (baca nominal).
 */

const OCR_URL = 'https://api.ocr.space/parse/image';

async function ocrImage(imageUrl) {
  const key = process.env.OCR_APIKEY || '';
  if (!key) return { ok: false, error: 'OCR_APIKEY belum diisi' };
  try {
    const form = new URLSearchParams();
    form.append('apikey', key);
    form.append('url', imageUrl);
    form.append('OCREngine', '2');
    const res = await fetch(OCR_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(45000) });
    const j = await res.json().catch(() => ({}));
    if (j.IsErroredOnProcessing || !j.ParsedResults || !j.ParsedResults.length) {
      return { ok: false, error: 'Gambar tidak terbaca' };
    }
    return { ok: true, text: String(j.ParsedResults[0].ParsedText || '') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Ambil semua angka nominal (Rp) dari teks OCR, urut terbesar dulu. */
function extractAmounts(text) {
  const nums = [];
  const re = /(?:rp\.?\s?|idr\s?)?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|\d{4,})/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    let raw = m[1].replace(/\./g, '').replace(/,/g, '');
    // tangani desimal ",00" di akhir
    if (/,\d{2}$/.test(m[1]) || /\.\d{2}$/.test(m[1])) raw = raw.slice(0, -2);
    const n = parseInt(raw, 10);
    if (n >= 1000) nums.push(n);
  }
  return [...new Set(nums)].sort((a, b) => b - a);
}

/**
 * Ekstrak info resi pengiriman dari teks OCR.
 * Return: { inv, resi, resiKurir, penerima }
 * - inv: nomor pesanan /INV-\d{6}/i
 * - resi: nomor resi/awb terkuat
 * - resiKurir: tebakan kurir (JNE/J&T/SiCepat/dll)
 * - penerima: nama penerima (dekat kata "penerima"/"kepada"/"to")
 */
function extractResiInfo(text) {
  const t = String(text || '');
  const out = { inv: null, resi: null, resiKurir: null, penerima: null };

  // 1) Nomor pesanan INV-xxxxxx
  const invM = t.match(/INV-\d{6}/i);
  if (invM) out.inv = invM[0].toUpperCase();

  // 2) Nomor resi — cari kandidat per kurir, pilih yang paling kuat
  const candidates = [];

  // J&T Express: JD atau JP diikuti 8+ digit
  let m;
  const jtRe = /\b(JD|JP)\d{8,}\b/gi;
  while ((m = jtRe.exec(t))) candidates.push({ resi: m[0].toUpperCase(), kurir: 'J&T', kuat: 3 });

  // SiCepat: diawali 00 diikuti 8+ digit
  const scRe = /\b00\d{8,}\b/g;
  while ((m = scRe.exec(t))) candidates.push({ resi: m[0], kurir: 'SiCepat', kuat: 3 });

  // JNE & umum: 10-15 digit angka (hindari nomor HP: jangan diawali 08/628)
  const jneRe = /\b(?!(?:08|628))\d{10,15}\b/g;
  while ((m = jneRe.exec(t))) {
    // skip kalau terlihat seperti nominal harga (didahului Rp)
    const before = t.slice(Math.max(0, m.index - 5), m.index);
    if (/rp\.?\s?$/i.test(before)) continue;
    candidates.push({ resi: m[0], kurir: 'JNE', kuat: 2 });
  }

  // Cari di dekat kata kunci resi/AWB/tracking → naikkan kekuatan
  const keywordRe = /(resi|awb|tracking|no\.?\s*resi|nomor\s*resi)[\s:]*([A-Z0-9]{8,20})/gi;
  while ((m = keywordRe.exec(t))) {
    const val = m[2].toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (val.length >= 8) {
      const existing = candidates.find((c) => c.resi === val);
      if (existing) existing.kuat += 2;
      else candidates.push({ resi: val, kurir: null, kuat: 2 });
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.kuat - a.kuat);
    out.resi = candidates[0].resi;
    out.resiKurir = candidates[0].kurir;
  }

  // 3) Nama penerima — cari di dekat kata kunci
  const penerimaRe = /(?:penerima|kepada|to|nama\s*penerima)[\s:]+([A-Za-z\s.'-]{3,40})/i;
  const pm = t.match(penerimaRe);
  if (pm) {
    out.penerima = pm[1].trim().replace(/\s+/g, ' ').slice(0, 40);
  }

  return out;
}

// Ekstrak SEMUA kandidat angka (6+ digit) untuk dicocokkan dengan database.
// Mengembalikan array unik, urut dari yang terpanjang (lebih spesifik dulu).
function extractAllNumbers(text) {
  const t = String(text || '');
  const found = new Set();
  // Angka 6-20 digit (bisa dengan spasi/titik/dash sebagai pemisah ribuan)
  const re = /\b\d[\d\s.\-]{5,25}\d\b/g;
  let m;
  while ((m = re.exec(t))) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 6 && digits.length <= 20) found.add(digits);
  }
  // Juga tangkap INV-xxxxxx → ambil angka saja
  const invRe = /INV-(\d{6})/gi;
  while ((m = invRe.exec(t))) found.add(m[1]);
  return [...found].sort((a, b) => b.length - a.length);
}

module.exports = { ocrImage, extractAmounts, extractResiInfo, extractAllNumbers };
