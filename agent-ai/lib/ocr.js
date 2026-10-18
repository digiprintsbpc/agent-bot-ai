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

module.exports = { ocrImage, extractAmounts };
