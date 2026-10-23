'use strict';
/**
 * /api/web-order — API PUBLIK untuk pemesanan dari kantor 3D (mode tamu).
 *
 * Keamanan: tanpa PIN (untuk customer), jadi SEMUA harga diambil dari
 * database — harga dari browser tidak pernah dipercaya. Validasi ketat
 * di setiap input; respons status tidak membocorkan data pribadi.
 *
 * GET  ?action=katalog        → daftar produk yang bisa dibeli (harga > 0)
 * POST ?action=buat           → body {items:[{id,qty}], nama, wa, alamat}
 *                               buat order (pending) + QRIS PayinAja.
 *                               Order digital: stok dikunci dulu; campuran
 *                               digital+fisik ditolak (pisah order).
 * GET  ?action=status&id=INV- → { status } saja (untuk polling halaman tamu)
 *
 * Order yang lunas dideteksi panel seperti biasa (payment_trx_id) —
 * fisik: jadi diproses + invoice WA; digital: konten terkirim ke WA.
 */

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

async function sbGet(table, params) {
  const q = new URLSearchParams(params);
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, { headers: { apikey: SB_KEY } });
  if (!r.ok) throw new Error(`${table}: ${r.status} ${await r.text().catch(() => '')}`.slice(0, 200));
  return r.json();
}
async function sbPost(table, rows, prefer = 'return=representation') {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, 'Content-Type': 'application/json', Prefer: prefer },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`${table} insert: ${r.status} ${await r.text().catch(() => '')}`.slice(0, 200));
  return r.json();
}
async function sbPatch(table, match, data) {
  const q = new URLSearchParams(match);
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, {
    method: 'PATCH',
    headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`${table} patch: ${r.status} ${await r.text().catch(() => '')}`.slice(0, 200));
}

function body(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function genOrderId() {
  for (let i = 0; i < 5; i++) {
    const id = 'INV-' + Math.floor(100000 + Math.random() * 900000);
    try {
      const rows = await sbGet('orders', { select: 'id', id: `eq.${id}`, limit: 1 });
      if (!rows.length) return id;
    } catch { return id; }
  }
  return 'INV-' + Date.now().toString().slice(-6);
}

const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

// Throttle sederhana per IP (per instance) untuk endpoint buat order
const hits = new Map();
function throttled(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}

module.exports = async (req, res) => {
  if (!SB_URL || !SB_KEY) return res.status(500).json({ ok: false, error: 'Server belum dikonfigurasi' });
  const action = String(req.query?.action || '');
  const method = req.method || 'GET';

  try {
    // ---------- Katalog publik ----------
    if (method === 'GET' && action === 'katalog') {
      const rows = await sbGet('products', {
        select: 'id,nama,harga,tipe', order: 'nama.asc', limit: 200,
      });
      const produk = [];
      for (const p of rows) {
        if (!(Number(p.harga) > 0)) continue; // harga belum diatur → tidak dijual dulu
        const item = { id: p.id, nama: p.nama, harga: Number(p.harga), tipe: p.tipe || 'fisik' };
        if (item.tipe === 'digital') {
          try {
            const stok = await sbGet('stok_digital', {
              select: 'id', produk_id: `eq.${p.id}`, status: 'eq.tersedia', limit: 5000,
            });
            item.stok = stok.length;
          } catch { item.stok = 0; }
        }
        produk.push(item);
      }
      return res.status(200).json({ ok: true, produk });
    }

    // ---------- Status order (polling) ----------
    if (method === 'GET' && action === 'status') {
      const id = String(req.query?.id || '').toUpperCase();
      if (!/^INV-\d{6}$/.test(id)) return res.status(400).json({ ok: false, error: 'ID tidak valid' });
      const rows = await sbGet('orders', { select: 'status', id: `eq.${id}`, limit: 1 });
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Order tidak ditemukan' });
      return res.status(200).json({ ok: true, status: rows[0].status });
    }

    // ---------- Buat order ----------
    if (method === 'POST' && action === 'buat') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
      if (throttled(ip)) return res.status(429).json({ ok: false, error: 'Terlalu banyak permintaan. Coba lagi nanti ya.' });

      const b = await body(req);
      const nama = String(b.nama || '').trim().slice(0, 60);
      // Normalisasi WA ke format 62 (konsisten dgn jalur Telegram) — cegah customer
      // ganda format 08/62 & pastikan JID WhatsApp panel valid.
      let wa = String(b.wa || '').replace(/\D/g, '');
      if (wa.startsWith('0')) wa = '62' + wa.slice(1);
      else if (wa.startsWith('8')) wa = '62' + wa;
      const alamat = String(b.alamat || '').trim().slice(0, 300);
      const itemsIn = Array.isArray(b.items) ? b.items.slice(0, 10) : [];

      if (nama.length < 2) return res.status(400).json({ ok: false, error: 'Nama wajib diisi' });
      if (wa.length < 10 || wa.length > 15) return res.status(400).json({ ok: false, error: 'Nomor WA tidak valid' });
      if (!itemsIn.length) return res.status(400).json({ ok: false, error: 'Belum ada produk dipilih' });

      // Validasi item terhadap database (harga SELALU dari DB)
      const items = [];
      let total = 0;
      let adaFisik = false;
      let adaDigital = false;
      for (const it of itemsIn) {
        const pid = String(it.id || '');
        const qtyRaw = parseInt(it.qty, 10);
        if (!pid || !Number.isFinite(qtyRaw) || qtyRaw < 1) return res.status(400).json({ ok: false, error: 'Item tidak valid' });
        const qty = Math.min(100, qtyRaw);
        const rows = await sbGet('products', { select: 'id,nama,harga,tipe', id: `eq.${pid}`, limit: 1 });
        const p = rows[0];
        if (!p) return res.status(400).json({ ok: false, error: `Produk ${pid} tidak ditemukan` });
        if (!(Number(p.harga) > 0)) return res.status(400).json({ ok: false, error: `Produk ${p.nama} belum bisa dipesan` });
        const tipe = p.tipe || 'fisik';
        if (tipe === 'digital') adaDigital = true; else adaFisik = true;
        items.push({ id: p.id, nama: p.nama, harga: Number(p.harga), qty, tipe });
        total += Number(p.harga) * qty;
      }
      if (adaFisik && adaDigital) {
        return res.status(400).json({ ok: false, error: 'Pesanan produk fisik dan digital harus dipisah ya kak 🙏' });
      }
      if (adaFisik && alamat.length < 10) {
        return res.status(400).json({ ok: false, error: 'Alamat lengkap wajib diisi untuk pengiriman' });
      }
      if (total <= 0) return res.status(400).json({ ok: false, error: 'Total tidak valid' });

      // Anti order ganda: order web pending yang sama (WA + total) dalam 2 menit
      // terakhir dianggap pengiriman ulang — kembalikan order yang sudah ada.
      try {
        const recent = await sbGet('orders', { select: 'id,total_harga,tanggal', nomor_wa: `eq.${wa}`, status: 'eq.pending', catatan: 'eq.web-kantor', order: 'tanggal.desc', limit: 5 });
        const dup = recent.find((o) => Number(o.total_harga) === total && (Date.now() - new Date(o.tanggal).getTime()) < 2 * 60 * 1000);
        if (dup) {
          return res.status(200).json({ ok: true, id: dup.id, duplikat: true, error: 'Order yang sama baru saja dibuat — QRIS-nya sudah dikirim ke WA kakak. Cek WhatsApp ya 🙏' });
        }
      } catch { /* cek duplikat gagal → lanjut buat order */ }

      const orderId = await genOrderId();
      const digital = require('../lib/digital');

      // Digital: kunci stok SEBELUM order dibuat; gagal = tidak jadi order
      if (adaDigital) {
        for (const it of items) {
          const locked = await digital.lockStock(orderId, it.id, it.qty).catch(() => 0);
          if (!locked || locked < it.qty) {
            await digital.releaseLock(orderId).catch(() => {});
            return res.status(400).json({ ok: false, error: `Stok ${it.nama} tidak cukup / habis` });
          }
        }
      }

      // QRIS dibuat SEBELUM order disimpan → payment_trx_id ikut dalam SATU tulisan
      // order (tidak ada PATCH terpisah yang bisa gagal diam-diam).
      let qris = null;
      try {
        const payinaja = require('../lib/payinaja');
        qris = await payinaja.createQRIS(total, orderId, nama, wa);
      } catch (e) { console.error('[web-order] QRIS error:', e.message); }
      if (!qris || !qris.ok) {
        if (adaDigital) await digital.releaseLock(orderId).catch(() => {});
        return res.status(502).json({ ok: false, error: 'QRIS gagal dibuat. Coba lagi sebentar ya 🙏' });
      }

      // Customer: cari by WA, buat bila belum ada
      let customerId = null;
      try {
        const found = await sbGet('customers', { select: 'id', nomor_wa: `eq.${wa}`, limit: 1 });
        customerId = found[0]?.id || null;
        if (!customerId) {
          const created = await sbPost('customers', [{ nama, nomor_wa: wa, alamat_lengkap: alamat }]);
          customerId = created[0]?.id || null;
        }
      } catch { /* order tetap dibuat walau customer gagal tersimpan */ }

      try {
        await sbPost('orders', [{
          id: orderId, customer_id: customerId, nama_penerima: nama, nomor_wa: wa,
          alamat_lengkap: alamat, total_harga: total, status: 'pending', catatan: 'web-kantor',
          payment_trx_id: qris.trx_id,
        }]);
        await sbPost('order_items', items.map((it) => ({
          order_id: orderId, product_id: it.id, nama_produk: it.nama, qty: it.qty, harga_satuan: it.harga,
        })));
      } catch (e) {
        // Kompensasi: jangan tinggalkan order setengah jadi / kunci stok yatim
        console.error('[web-order] simpan order gagal:', e.message);
        await fetch(`${SB_URL}/rest/v1/order_items?order_id=eq.${orderId}`, { method: 'DELETE', headers: { apikey: SB_KEY } }).catch(() => {});
        await fetch(`${SB_URL}/rest/v1/orders?id=eq.${orderId}`, { method: 'DELETE', headers: { apikey: SB_KEY } }).catch(() => {});
        if (adaDigital) await digital.releaseLock(orderId).catch(() => {});
        return res.status(500).json({ ok: false, error: 'Gangguan server saat menyimpan pesanan. Coba lagi sebentar ya 🙏' });
      }

      // WA ke customer: ringkasan + QRIS (sama seperti jalur lain; berguna bila halaman ditutup)
      try {
        const ringkas = items.map((it) => `📦 ${it.nama} ×${it.qty}`).join('\n');
        const tagihan = `🧾 *PESANAN BARU (${orderId})*\n\nHalo kak ${nama}! Terima kasih sudah order di Digiprint lewat kantor virtual kami 🏢\n\n${ringkas}\n*Total: ${rp(total)}*\n\nSilakan scan QRIS di bawah untuk bayar 👇`;
        if (qris.qr_image_url) {
          await sbPost('wa_outbox', [{ to_wa: wa, kind: 'image', status: 'pending', content: qris.qr_image_url, caption: tagihan, image_url: qris.qr_image_url }], 'return=minimal');
        } else {
          await sbPost('wa_outbox', [{ to_wa: wa, kind: 'text', status: 'pending', content: tagihan }], 'return=minimal');
        }
      } catch (e) { console.error('[web-order] antre WA gagal:', e.message); }

      // Notif Telegram ke owner
      try {
        const ownerId = process.env.TELEGRAM_ALLOWED_ID || '';
        const botTok = process.env.TELEGRAM_BOT_TOKEN || '';
        if (ownerId && botTok) {
          const ringkas = items.map((it) => `${it.nama} x${it.qty}`).join(', ');
          await fetch(`https://api.telegram.org/bot${botTok}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: ownerId,
              text: `🏢 *ORDER BARU (Web Kantor 3D)*\n\nID: ${orderId}\nCustomer: ${nama} (${wa})\nProduk: ${ringkas}\nTotal: ${rp(total)}`,
              parse_mode: 'Markdown',
            }),
          }).catch(() => {});
        }
      } catch { /* abaikan */ }

      return res.status(200).json({ ok: true, id: orderId, total, qr: qris.qr_image_url || null });
    }

    return res.status(404).json({ ok: false, error: 'Action tidak dikenal' });
  } catch (e) {
    console.error('[web-order] error:', e.message);
    return res.status(500).json({ ok: false, error: 'Ada gangguan di server. Coba lagi ya.' });
  }
};
