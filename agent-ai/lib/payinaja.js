'use strict';
/**
 * lib/payinaja.js — klien PayinAja QRIS.
 * Diadaptasi dari database.js bot toko Pterodactyl.
 * Env: PAYINAJA_API_KEY
 */

const API_KEY = process.env.PAYINAJA_API_KEY || '';
const CREATE_URL = 'https://payinaja.com/api/v1/qris/create2';
const CHECK_URL = (trxId) => `https://payinaja.com/api/v1/transaction/${encodeURIComponent(trxId)}`;

function configured() {
  return !!API_KEY;
}

/**
 * Buat QRIS. Mengembalikan { ok, trx_id, qr_image_url, amount, raw } atau { ok:false, error }.
 */
async function createQRIS(amount, reference_id, customer_name = 'Customer', customer_phone = '') {
  if (!configured()) return { ok: false, error: 'PAYINAJA_API_KEY belum diisi' };
  try {
    const res = await fetch(CREATE_URL, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: parseInt(amount, 10),
        reference_id,
        customer_name: customer_name || 'Customer',
        customer_phone: customer_phone || '',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.success || data.status) {
      const d = data.data || {};
      return {
        ok: true,
        trx_id: d.trx_id || d.payinaja_trx_id || reference_id,
        qr_image_url: d.qris_image_url || d.qr_image_url || d.image_url || null,
        amount: d.amount || amount,
        raw: d,
      };
    }
    return { ok: false, error: data.message || 'Ditolak server PayinAja' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Cek status transaksi. Mengembalikan { ok, paid, status, raw } atau { ok:false, error }.
 * paid = true bila PayinAja menyatakan status 'success' (lunas).
 */
async function checkTransaction(trx_id) {
  if (!configured()) return { ok: false, error: 'PAYINAJA_API_KEY belum diisi' };
  try {
    const res = await fetch(CHECK_URL(trx_id), {
      method: 'GET',
      headers: { 'x-api-key': API_KEY },
    });
    const data = await res.json().catch(() => ({}));
    if (data.success || data.status) {
      const d = data.data || {};
      const st = String(d.status || '').toLowerCase();
      return { ok: true, paid: st === 'success', status: d.status || st, raw: d };
    }
    return { ok: false, error: data.message || 'Transaksi tidak ditemukan' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { configured, createQRIS, checkTransaction };
