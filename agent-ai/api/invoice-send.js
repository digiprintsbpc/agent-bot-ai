'use strict';
/**
 * api/invoice-send.js — Generate & kirim invoice PDF ke WA customer.
 * Dipanggil oleh panel setelah pembayaran terdeteksi.
 *
 * POST /api/invoice-send
 * Body: { order_id, secret }
 * secret harus sama dengan WA_AI_SECRET
 */

const { sbGet, sbPost } = require('../lib/supabase');
const { generateInvoice } = require('../lib/invoice');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

async function getProfile() {
  try {
    const rows = await sbGet('store_profile', { select: '*', limit: 1 });
    return rows[0] || {};
  } catch { return {}; }
}

function formatWA(n) {
  let d = String(n || '').replace(/[^0-9]/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const { order_id, secret } = req.body || {};
  if (secret !== process.env.WA_AI_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!order_id) {
    return res.status(400).json({ ok: false, error: 'order_id required' });
  }

  try {
    // Ambil order
    const orders = await sbGet('orders', {
      select: 'id,tanggal,nama_penerima,nomor_wa,alamat_lengkap,total_harga,status',
      id: `eq.${order_id}`,
      limit: 1,
    });
    if (!orders[0]) {
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }
    const order = orders[0];

    // Ambil items
    const items = await sbGet('order_items', {
      select: 'nama_produk,qty,harga_satuan',
      order_id: `eq.${order_id}`,
    }).catch(() => []);

    // Generate PDF
    const profile = await getProfile().catch(() => ({}));
    const pdfBuffer = await generateInvoice({
      ...order, items, _profile: profile,
    });

    // Upload ke Storage
    const fileName = `Invoice-${order_id}-${Date.now()}.pdf`;
    const upRes = await fetch(`${SB_URL}/storage/v1/object/invoices/${fileName}`, {
      method: 'POST',
      headers: { apikey: SB_KEY, 'Content-Type': 'application/pdf' },
      body: pdfBuffer,
    });
    if (!upRes.ok) {
      throw new Error('Upload gagal: ' + upRes.status);
    }
    const publicUrl = `${SB_URL}/storage/v1/object/public/invoices/${fileName}`;

    // Queue ke WA outbox
    await sbPost('wa_outbox', [{
      to_wa: formatWA(order.nomor_wa),
      kind: 'document',
      content: publicUrl,
      caption: `Invoice-${order_id}.pdf`,
      status: 'pending',
    }], 'return=minimal');

    return res.status(200).json({ ok: true, url: publicUrl });
  } catch (e) {
    console.error('[invoice-send]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
