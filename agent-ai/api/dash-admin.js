'use strict';
/**
 * /api/dash-admin — API CRUD untuk Web Admin Toko (public/dash/).
 * Proteksi: ?pin= harus cocok dengan env DASHBOARD_PIN (default "1234").
 *
 * GET  ?action=products                    → daftar produk
 * GET  ?action=orders&status=&search=      → daftar order (filter + cari)
 * GET  ?action=order&id=INV-xxx            → detail order + items
 * GET  ?action=pengeluaran                 → daftar pengeluaran (30 hari)
 * GET  ?action=keuangan                    → rekap omset/pengeluaran/profit
 * POST ?action=create-order                → body: product_id, qty, nama, wa, alamat
 * POST ?action=update-order                → body: id, status
 * POST ?action=update-product              → body: id, harga, stok
 * POST ?action=add-product                 → body: nama, harga, stok, kategori
 * POST ?action=delete-product              → body: id
 * POST ?action=add-pengeluaran             → body: nominal, keterangan
 * POST ?action=delete-pengeluaran          → body: id
 */

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const PIN = process.env.DASHBOARD_PIN || '1234';

const STATUS_OK = ['pending', 'diproses', 'dikirim', 'selesai', 'batal'];

function wibDayStart(daysAgo = 0) {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 3600 * 1000);
  wib.setUTCHours(0, 0, 0, 0);
  wib.setUTCDate(wib.getUTCDate() - daysAgo);
  return new Date(wib.getTime() - 7 * 3600 * 1000).toISOString();
}

async function sbGet(table, params) {
  const q = new URLSearchParams(params);
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, { headers: { apikey: SB_KEY } });
  if (!r.ok) throw new Error(`${table}: ${r.status} ${await r.text().catch(() => '')}`.slice(0, 200));
  return r.json();
}

async function sbPost(table, rows) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
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

async function sbDelete(table, match) {
  const q = new URLSearchParams(match);
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, {
    method: 'DELETE',
    headers: { apikey: SB_KEY },
  });
  if (!r.ok) throw new Error(`${table} delete: ${r.status}`);
}

/** Sinkronkan products.stok produk digital = jumlah stok_digital tersedia. */
async function syncDigitalStock(produkId) {
  try {
    const rows = await sbGet('stok_digital', { select: 'id', produk_id: `eq.${produkId}`, status: 'eq.tersedia', limit: 5000 });
    await sbPatch('products', { id: `eq.${produkId}` }, { stok: rows.length });
    return rows.length;
  } catch { return null; }
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

module.exports = async (req, res) => {
  const pin = String(req.query?.pin || '');
  if (pin !== PIN) return res.status(401).json({ ok: false, error: 'PIN salah' });
  if (!SB_URL || !SB_KEY) return res.status(500).json({ ok: false, error: 'Supabase belum dikonfigurasi' });

  const action = String(req.query?.action || '');
  const method = req.method || 'GET';

  try {
    // ---------- GET ----------
    if (method === 'GET' && action === 'products') {
      const rows = await sbGet('products', { select: 'id,nama,kategori,harga,stok', order: 'nama.asc', limit: 200 });
      return res.status(200).json({ ok: true, products: rows });
    }

    // ---------- PRODUK DIGITAL ----------
    if (method === 'GET' && action === 'digital-products') {
      const rows = await sbGet('products', { select: 'id,nama,harga,template_kirim,durasi_hari,garansi_hari', tipe: 'eq.digital', order: 'id.asc', limit: 100 });
      const stok = await sbGet('stok_digital', { select: 'produk_id,status', limit: 5000 }).catch(() => []);
      const counts = {};
      for (const s of stok) {
        counts[s.produk_id] = counts[s.produk_id] || { tersedia: 0, dikunci: 0, terjual: 0 };
        if (counts[s.produk_id][s.status] !== undefined) counts[s.produk_id][s.status]++;
      }
      const products = rows.map((p) => ({ ...p, stokHitung: counts[p.id] || { tersedia: 0, dikunci: 0, terjual: 0 } }));
      return res.status(200).json({ ok: true, products });
    }

    if (method === 'GET' && action === 'digital-stock') {
      const produk = String(req.query?.produk || '');
      if (!produk) return res.status(400).json({ ok: false, error: 'produk wajib' });
      const rows = await sbGet('stok_digital', {
        select: 'id,isi,isi2,status,order_id,nomor_wa,dikirim_at,kedaluwarsa_at,created_at',
        produk_id: `eq.${produk}`, order: 'created_at.desc', limit: 500,
      });
      return res.status(200).json({ ok: true, items: rows });
    }

    if (method === 'GET' && action === 'orders') {
      const status = String(req.query?.status || '');
      const search = String(req.query?.search || '').trim();
      const params = { select: 'id,tanggal,nama_penerima,nomor_wa,total_harga,status', order: 'tanggal.desc', limit: 100 };
      if (STATUS_OK.includes(status)) params.status = `eq.${status}`;
      if (search) params.or = `(id.ilike.*${search}*,nama_penerima.ilike.*${search}*)`;
      const rows = await sbGet('orders', params);
      return res.status(200).json({ ok: true, orders: rows });
    }

    if (method === 'GET' && action === 'order') {
      const id = String(req.query?.id || '').toUpperCase();
      const rows = await sbGet('orders', { select: '*', id: `eq.${id}`, limit: 1 });
      if (!rows[0]) return res.status(404).json({ ok: false, error: 'Order tidak ditemukan' });
      const items = await sbGet('order_items', { select: 'nama_produk,qty,harga_satuan', order_id: `eq.${id}`, limit: 50 });
      return res.status(200).json({ ok: true, order: rows[0], items });
    }

    if (method === 'GET' && action === 'pengeluaran') {
      let rows = [];
      try {
        rows = await sbGet('pengeluaran', { select: 'id,tanggal,nominal,keterangan', order: 'tanggal.desc', limit: 100 });
      } catch (e) { return res.status(200).json({ ok: true, pengeluaran: [], belumMigrasi: true }); }
      return res.status(200).json({ ok: true, pengeluaran: rows });
    }

    if (method === 'GET' && action === 'keuangan') {
      const bulanIni = wibDayStart(0).slice(0, 7); // YYYY-MM (UTC approx, cukup)
      const orders = await sbGet('orders', {
        select: 'total_harga,tanggal', status: 'neq.batal', tanggal: `gte.${wibDayStart(30)}`, limit: 1000,
      });
      const sum = (arr) => arr.reduce((a, o) => a + Number(o.total_harga || 0), 0);
      const hariIni = wibDayStart(0);
      let keluar = [];
      try {
        keluar = await sbGet('pengeluaran', { select: 'nominal,tanggal', tanggal: `gte.${wibDayStart(30)}`, limit: 1000 });
      } catch { /* tabel belum ada */ }
      const sumK = (arr) => arr.reduce((a, o) => a + Number(o.nominal || 0), 0);
      return res.status(200).json({
        ok: true,
        omsetHari: sum(orders.filter((o) => o.tanggal >= hariIni)),
        omsetBulan: sum(orders),
        keluarHari: sumK(keluar.filter((o) => o.tanggal >= hariIni)),
        keluarBulan: sumK(keluar),
      });
    }

    // ---------- POST ----------
    if (method === 'POST') {
      const b = await body(req);

      if (action === 'create-order') {
        const { product_custom, harga, qty, nama, wa, alamat } = b;
        const namaProduk = String(product_custom || '').trim();
        if (!namaProduk) return res.status(400).json({ ok: false, error: 'Nama produk wajib diisi' });
        const hargaSatuan = Math.max(0, parseInt(harga, 10) || 0);
        const q = Math.max(1, parseInt(qty, 10) || 1);
        const total = hargaSatuan * q;
        const orderId = await genOrderId();
        // customer: cari by WA, buat bila belum ada
        let customerId = null;
        const cWa = String(wa || '').replace(/\D/g, '');
        if (cWa) {
          try {
            const found = await sbGet('customers', { select: 'id', nomor_wa: `eq.${cWa}`, limit: 1 });
            customerId = found[0]?.id || null;
          } catch {}
          if (!customerId) {
            try {
              const created = await sbPost('customers', [{ nama: String(nama || '-'), nomor_wa: cWa, alamat_lengkap: String(alamat || '') }]);
              customerId = created[0]?.id || null;
            } catch {}
          }
        }
        await sbPost('orders', [{
          id: orderId, customer_id: customerId,
          nama_penerima: String(nama || '-'), nomor_wa: cWa,
          alamat_lengkap: String(alamat || ''), total_harga: total, status: 'pending',
        }]);
        await sbPost('order_items', [{
          order_id: orderId, product_id: null, nama_produk: namaProduk,
          qty: q, harga_satuan: hargaSatuan,
        }]);
        // Notifikasi: WA ke customer (tagihan + QRIS) + Telegram ke owner
        try {
          const rpF = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
          // Generate QRIS
          let qrUrl = null;
          try {
            const payinaja = require('../lib/payinaja');
            const qris = await payinaja.createQRIS(total, orderId, String(nama || '-'), cWa);
            if (qris.ok) {
              qrUrl = qris.qr_image_url;
              await sbPatch('orders', { id: `eq.${orderId}` }, { payment_trx_id: qris.trx_id }).catch(() => {});
            }
          } catch (e) { console.error('[dash] QRIS gagal:', e.message); }
          if (cWa.length >= 10) {
            const tagihan = `🧾 *PESANAN BARU (${orderId})*\n\nHalo kak ${nama}! Terima kasih sudah order di Digiprint.\n\n📦 ${namaProduk}\nJumlah: ${q}\n*Total: ${rpF(total)}*\n\n${qrUrl ? 'Silakan scan QRIS di bawah untuk bayar 👇' : 'Silakan lakukan pembayaran. Kirim bukti transfer ke sini ya kak 🙏'}`;
            if (qrUrl) {
              // Kirim gambar QRIS + teks tagihan
              await sbPost('wa_outbox', [{ to_wa: cWa, kind: 'image', status: 'pending', content: qrUrl, caption: tagihan, image_url: qrUrl }]);
            } else {
              await sbPost('wa_outbox', [{ to_wa: cWa, kind: 'text', status: 'pending', content: tagihan }]);
            }
          }
          const ownerId = process.env.TELEGRAM_ALLOWED_ID || '';
          const botTok = process.env.TELEGRAM_BOT_TOKEN || '';
          if (ownerId && botTok) {
            await fetch(`https://api.telegram.org/bot${botTok}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: ownerId,
                text: `🛍️ *ORDER BARU (Dashboard)*\n\nID: ${orderId}\nCustomer: ${nama} (${cWa})\nProduk: ${namaProduk} x${q}\nTotal: ${rpF(total)}`,
                parse_mode: 'Markdown',
              }),
            }).catch(() => {});
          }
        } catch (e) { console.error('[dash] notif gagal:', e.message); }
        return res.status(200).json({ ok: true, id: orderId, total });
      }

      if (action === 'update-order') {
        const id = String(b.id || '').toUpperCase();
        const status = String(b.status || '');
        if (!STATUS_OK.includes(status)) return res.status(400).json({ ok: false, error: 'Status tidak valid' });
        await sbPatch('orders', { id: `eq.${id}` }, { status });
        // Notifikasi WA ke customer saat status berubah
        try {
          const ords = await sbGet('orders', { select: 'nama_penerima,nomor_wa,nomor_resi', id: `eq.${id}`, limit: 1 });
          const o = ords[0];
          const cWa = String(o?.nomor_wa || '').replace(/\D/g, '');
          const statusLabel = { pending: 'Menunggu Pembayaran ⏳', diproses: 'Diproses ⚙️', dikirim: 'Dikirim 🚚', selesai: 'Selesai ✅', batal: 'Dibatalkan ❌' };
          if (cWa.length >= 10 && statusLabel[status]) {
            let msg = `📦 *UPDATE PESANAN (${id})*\n\nHalo kak ${o.nama_penerima}! Status pesanan kakak: *${statusLabel[status]}*`;
            if (status === 'dikirim' && o.nomor_resi) msg += `\n\nNo. Resi: ${o.nomor_resi}`;
            if (status === 'selesai') msg += `\n\nTerima kasih sudah order di Digiprint! 🙏`;
            await sbPost('wa_outbox', [{ to_wa: cWa, kind: 'text', status: 'pending', content: msg }]);
          }
        } catch (e) { console.error('[dash] notif status gagal:', e.message); }
        return res.status(200).json({ ok: true });
      }

      if (action === 'bulk-update-status') {
        const ids = Array.isArray(b.ids) ? b.ids.map((x) => String(x).toUpperCase()) : [];
        const status = String(b.status || '');
        if (!STATUS_OK.includes(status)) return res.status(400).json({ ok: false, error: 'Status tidak valid' });
        if (!ids.length) return res.status(400).json({ ok: false, error: 'Tidak ada order dipilih' });
        const statusLabel = { pending: 'Menunggu Pembayaran ⏳', diproses: 'Diproses ⚙️', dikirim: 'Dikirim 🚚', selesai: 'Selesai ✅', batal: 'Dibatalkan ❌' };
        let okCount = 0;
        for (const id of ids.slice(0, 50)) {
          try {
            await sbPatch('orders', { id: `eq.${id}` }, { status });
            try {
              const ords = await sbGet('orders', { select: 'nama_penerima,nomor_wa,nomor_resi', id: `eq.${id}`, limit: 1 });
              const o = ords[0];
              const cWa = String(o?.nomor_wa || '').replace(/\D/g, '');
              if (cWa.length >= 10 && statusLabel[status]) {
                let msg = `📦 *UPDATE PESANAN (${id})*\n\nHalo kak ${o.nama_penerima}! Status pesanan kakak: *${statusLabel[status]}*`;
                if (status === 'dikirim' && o.nomor_resi) msg += `\n\nNo. Resi: ${o.nomor_resi}`;
                if (status === 'selesai') msg += `\n\nTerima kasih sudah order di Digiprint! 🙏`;
                await sbPost('wa_outbox', [{ to_wa: cWa, kind: 'text', status: 'pending', content: msg }]);
              }
            } catch (e) { console.error('[dash] notif bulk gagal:', id, e.message); }
            okCount++;
          } catch (e) { console.error('[dash] bulk-update gagal:', id, e.message); }
        }
        return res.status(200).json({ ok: true, updated: okCount, total: ids.length });
      }

      if (action === 'bulk-delete') {
        const ids = Array.isArray(b.ids) ? b.ids.map((x) => String(x).toUpperCase()) : [];
        if (!ids.length) return res.status(400).json({ ok: false, error: 'Tidak ada order dipilih' });
        let okCount = 0;
        for (const id of ids.slice(0, 50)) {
          try {
            await sbDelete('order_items', { order_id: `eq.${id}` }).catch(() => {});
            await sbDelete('orders', { id: `eq.${id}` });
            okCount++;
          } catch (e) { console.error('[dash] bulk-delete gagal:', id, e.message); }
        }
        return res.status(200).json({ ok: true, deleted: okCount, total: ids.length });
      }

      if (action === 'update-product') {
        const id = String(b.id || '');
        const data = {};
        if (b.harga !== undefined && b.harga !== '') data.harga = Number(b.harga);
        if (b.stok !== undefined && b.stok !== '') data.stok = Number(b.stok);
        if (!Object.keys(data).length) return res.status(400).json({ ok: false, error: 'Tidak ada perubahan' });
        await sbPatch('products', { id: `eq.${id}` }, data);
        return res.status(200).json({ ok: true });
      }

      if (action === 'add-product') {
        const nama = String(b.nama || '').trim();
        if (!nama) return res.status(400).json({ ok: false, error: 'Nama wajib diisi' });
        const id = 'P' + Date.now().toString(36).toUpperCase();
        await sbPost('products', [{
          id, nama, kategori: String(b.kategori || 'Lainnya'),
          harga: Number(b.harga || 0), stok: Number(b.stok || 0),
        }]);
        return res.status(200).json({ ok: true, id });
      }

      if (action === 'delete-product') {
        const id = String(b.id || '');
        await sbDelete('products', { id: `eq.${id}` });
        return res.status(200).json({ ok: true });
      }

      if (action === 'add-pengeluaran') {
        const nominal = Number(b.nominal || 0);
        if (!nominal) return res.status(400).json({ ok: false, error: 'Nominal wajib diisi' });
        await sbPost('pengeluaran', [{ nominal, keterangan: String(b.keterangan || '') }]);
        return res.status(200).json({ ok: true });
      }

      if (action === 'delete-pengeluaran') {
        await sbDelete('pengeluaran', { id: `eq.${String(b.id || '')}` });
        return res.status(200).json({ ok: true });
      }

      // ---------- PRODUK DIGITAL (POST) ----------
      if (action === 'save-digital-product') {
        const id = String(b.id || '').trim().replace(/\s+/g, '');
        if (!/^[A-Za-z0-9_-]{2,20}$/.test(id)) return res.status(400).json({ ok: false, error: 'Kode tidak valid (2–20 huruf/angka)' });
        const nama = String(b.nama || '').trim();
        if (!nama) return res.status(400).json({ ok: false, error: 'Nama wajib diisi' });
        const row = {
          id, nama, kategori: 'Digital', deskripsi: '',
          harga: Math.max(0, parseInt(b.harga, 10) || 0),
          tipe: 'digital',
          template_kirim: String(b.template_kirim || ''),
          durasi_hari: Math.max(0, parseInt(b.durasi_hari, 10) || 0),
          garansi_hari: Math.max(0, parseInt(b.garansi_hari, 10) || 0),
        };
        const r = await fetch(`${SB_URL}/rest/v1/products`, {
          method: 'POST',
          headers: { apikey: SB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([row]),
        });
        if (!r.ok) throw new Error(`products upsert: ${r.status} ${await r.text().catch(() => '')}`.slice(0, 200));
        await syncDigitalStock(id);
        return res.status(200).json({ ok: true, id });
      }

      if (action === 'add-digital-stock') {
        const produkId = String(b.produk_id || '').trim();
        if (!produkId) return res.status(400).json({ ok: false, error: 'produk wajib' });
        const entries = String(b.teks || '').split('\n').map((s) => s.trim()).filter(Boolean)
          .map((ln) => { const parts = ln.split('|').map((s) => s.trim()); return { isi: parts[0], isi2: parts[1] || '' }; })
          .filter((e) => e.isi);
        if (!entries.length) return res.status(400).json({ ok: false, error: 'Tidak ada stok terbaca' });
        const existing = await sbGet('stok_digital', { select: 'isi,isi2', produk_id: `eq.${produkId}`, status: 'neq.terjual', limit: 5000 });
        const seen = new Set(existing.map((e) => `${e.isi}||${e.isi2 || ''}`));
        const rows = [];
        let dupes = 0;
        for (const e of entries) {
          const key = `${e.isi}||${e.isi2 || ''}`;
          if (seen.has(key)) { dupes++; continue; }
          seen.add(key);
          rows.push({ produk_id: produkId, isi: e.isi, isi2: e.isi2 || null, status: 'tersedia' });
        }
        if (rows.length) await sbPost('stok_digital', rows);
        const sisa = await syncDigitalStock(produkId);
        return res.status(200).json({ ok: true, added: rows.length, dupes, sisa });
      }

      if (action === 'delete-digital-stock') {
        const itemId = String(b.id || '');
        const rows = await sbGet('stok_digital', { select: 'id,produk_id,status', id: `eq.${itemId}`, limit: 1 });
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'Item tidak ditemukan' });
        if (rows[0].status !== 'tersedia') return res.status(400).json({ ok: false, error: 'Hanya stok tersedia yang bisa dihapus' });
        await sbDelete('stok_digital', { id: `eq.${itemId}` });
        const sisa = await syncDigitalStock(rows[0].produk_id);
        return res.status(200).json({ ok: true, sisa });
      }

      if (action === 'delete-digital-product') {
        const id = String(b.id || '').trim();
        if (!id) return res.status(400).json({ ok: false, error: 'id wajib' });
        await sbDelete('stok_digital', { produk_id: `eq.${id}`, status: 'eq.tersedia' }).catch(() => {});
        await sbDelete('products', { id: `eq.${id}` });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ ok: false, error: 'Aksi tidak dikenal' });
    }

    return res.status(400).json({ ok: false, error: 'Aksi tidak dikenal' });
  } catch (e) {
    console.error('[dash-admin]', action, e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
