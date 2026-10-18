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
        const { product_id, qty, nama, wa, alamat } = b;
        const prods = await sbGet('products', { select: 'id,nama,harga', id: `eq.${String(product_id || '')}`, limit: 1 });
        if (!prods[0]) return res.status(400).json({ ok: false, error: 'Produk tidak ditemukan' });
        const q = Math.max(1, parseInt(qty, 10) || 1);
        const total = Math.round(Number(prods[0].harga) * q);
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
          order_id: orderId, product_id: prods[0].id, nama_produk: prods[0].nama,
          qty: q, harga_satuan: Number(prods[0].harga),
        }]);
        return res.status(200).json({ ok: true, id: orderId, total });
      }

      if (action === 'update-order') {
        const id = String(b.id || '').toUpperCase();
        const status = String(b.status || '');
        if (!STATUS_OK.includes(status)) return res.status(400).json({ ok: false, error: 'Status tidak valid' });
        await sbPatch('orders', { id: `eq.${id}` }, { status });
        return res.status(200).json({ ok: true });
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

      return res.status(400).json({ ok: false, error: 'Aksi tidak dikenal' });
    }

    return res.status(400).json({ ok: false, error: 'Aksi tidak dikenal' });
  } catch (e) {
    console.error('[dash-admin]', action, e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
