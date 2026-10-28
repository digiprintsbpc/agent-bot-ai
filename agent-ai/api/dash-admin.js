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
 * GET  ?action=bahan-baku                  → daftar bahan baku
 * GET  ?action=bahan-baku-config           → config HPP tersimpan (atau null)
 * GET  ?action=compute-hpp                 → hitung HPP pakai config tersimpan
 * POST ?action=save-bahan-baku             → body: id?, nama, isi_per_box, harga_per_box, keterangan
 * POST ?action=delete-bahan-baku           → body: id
 * POST ?action=save-bahan-baku-config      → body: margin_persen, biaya_print_per_lembar, keuntungan_rim, komposisi {1:[...],2:[...],3:[...]}
 * POST ?action=compute-hpp                 → body opsional (override simulasi): margin_persen, biaya_print_per_lembar, keuntungan_rim, komposisi, ambang_persen
 *
 * MODUL BAHAN BAKU / HPP (FASE 2, rumus sheet "Offline" pemilik):
 * modul ini TIDAK mengubah harga katalog. Ia hanya menghitung HPP +
 * harga hitung pembanding (lib/hpp.js) dan membandingkannya dengan harga
 * products. Harga katalog tetap diubah manual via tab Produk.
 * Butuh tabel bahan_baku + bahan_baku_config
 * (lihat sql-bahan-baku.sql — dijalankan pemilik di SQL Editor Supabase).
 * Config: margin_persen (live 2%), biaya_print_per_lembar (Rp 300),
 * keuntungan_rim (Rp 140.000), komposisi {1:[...],2:[...],3:[...]}.
 */

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const PIN = process.env.DASHBOARD_PIN || '1234';
const hpp = require('../lib/hpp');

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
    headers: { apikey: SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`${table} patch: ${r.status} ${await r.text().catch(() => '')}`.slice(0, 200));
  return r.json().catch(() => []);
}

async function sbDelete(table, match) {
  const q = new URLSearchParams(match);
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, {
    method: 'DELETE',
    headers: { apikey: SB_KEY, Prefer: 'return=representation' },
  });
  if (!r.ok) throw new Error(`${table} delete: ${r.status}`);
  return r.json().catch(() => []);
}

/* ---------- modul bahan baku / HPP (rumus sheet "Offline") ---------- */
async function loadBahan() {
  try {
    const rows = await sbGet('bahan_baku', { select: 'id,nama,isi_per_box,harga_per_box,harga_box_rim,keterangan', order: 'nama.asc', limit: 200 });
    return { bahan: rows, belumMigrasi: false };
  } catch (e) {
    return { bahan: [], belumMigrasi: true };
  }
}

async function loadConfigTersimpan() {
  try {
    const rows = await sbGet('bahan_baku_config', { select: 'id,margin_persen,biaya_print_per_lembar,keuntungan_rim,komposisi', id: 'eq.default', limit: 1 });
    if (rows[0]) return { config: rows[0], belumMigrasi: false };
  } catch (e) {
    return { config: null, belumMigrasi: true };
  }
  return { config: null, belumMigrasi: false };
}

// Terima komposisi sebagai objek array ATAU string koma ("top-putih, middle").
function parseKomposisiInput(k) {
  if (!k || typeof k !== 'object') throw new Error('Komposisi harus objek {1:[...],2:[...],3:[...]}');
  const out = {};
  for (const ply of [1, 2, 3]) {
    let v = k[ply] ?? k[String(ply)];
    if (typeof v === 'string') v = v.split(',').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(v) || !v.length) throw new Error(`Komposisi ${ply}ply harus daftar ID bahan yang tidak kosong`);
    out[ply] = v;
  }
  return out;
}

async function hitungHpp(overrides) {
  const { bahan, belumMigrasi } = await loadBahan();
  if (belumMigrasi) {
    const err = new Error('Tabel bahan_baku belum ada — jalankan sql-bahan-baku.sql di Supabase dulu');
    err.belumMigrasi = true;
    throw err;
  }
  if (!bahan.length) throw new Error('Belum ada data bahan — isi dulu di tab Bahan Baku atau jalankan SQL seed');
  const tersimpan = await loadConfigTersimpan();
  const config = {
    margin_persen: overrides?.margin_persen ?? tersimpan.config?.margin_persen ?? hpp.DEFAULT_CONFIG.margin_persen,
    biaya_print_per_lembar: overrides?.biaya_print_per_lembar ?? tersimpan.config?.biaya_print_per_lembar ?? hpp.DEFAULT_CONFIG.biaya_print_per_lembar,
    keuntungan_rim: overrides?.keuntungan_rim ?? tersimpan.config?.keuntungan_rim ?? hpp.DEFAULT_CONFIG.keuntungan_rim,
    komposisi: overrides?.komposisi || tersimpan.config?.komposisi || hpp.DEFAULT_CONFIG.komposisi,
  };
  const prods = await sbGet('products', { select: 'id,harga', limit: 200 });
  const katalog = {};
  for (const p of prods) katalog[p.id] = Number(p.harga || 0);
  const ambang = overrides?.ambang_persen;
  const tabel = hpp.computeTabel({ bahan, config, katalog, ambangPersen: ambang });
  const rim = hpp.computeRim({ bahan, config, katalog, ambangPersen: ambang });
  return {
    config: tabel.config,
    config_dari_default: !tersimpan.config,
    ambang_persen: tabel.ambang_persen,
    rows: tabel.rows,
    rim,
    asumsi: hpp.ASUMSI,
  };
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
        // Omset hanya dari order yang SUDAH DIBAYAR (pending = belum bayar, batal = gagal)
        select: 'total_harga,tanggal', status: 'in.(diproses,dikirim,selesai)', tanggal: `gte.${wibDayStart(30)}`, limit: 1000,
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

    if (method === 'GET' && action === 'bahan-baku') {
      const { bahan, belumMigrasi } = await loadBahan();
      return res.status(200).json({ ok: true, bahan, belumMigrasi });
    }

    if (method === 'GET' && action === 'bahan-baku-config') {
      const tersimpan = await loadConfigTersimpan();
      if (tersimpan.belumMigrasi) return res.status(200).json({ ok: true, config: null, belumMigrasi: true });
      return res.status(200).json({ ok: true, config: tersimpan.config, dariDefault: !tersimpan.config });
    }

    if (method === 'GET' && action === 'compute-hpp') {
      try {
        const hasil = await hitungHpp(null);
        return res.status(200).json({ ok: true, ...hasil });
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message, belumMigrasi: !!e.belumMigrasi });
      }
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
        let cWa = String(wa || '').replace(/\D/g, '');
        if (cWa.startsWith('0')) cWa = '62' + cWa.slice(1);
        else if (cWa.startsWith('8')) cWa = '62' + cWa;
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
        // QRIS dibuat SEBELUM order disimpan → payment_trx_id ikut SATU tulisan order
        let qrUrl = null;
        let trxId = null;
        try {
          const payinaja = require('../lib/payinaja');
          const qris = await payinaja.createQRIS(total, orderId, String(nama || '-'), cWa);
          if (qris.ok) { qrUrl = qris.qr_image_url; trxId = qris.trx_id; }
        } catch (e) { console.error('[dash] QRIS gagal:', e.message); }
        await sbPost('orders', [{
          id: orderId, customer_id: customerId,
          nama_penerima: String(nama || '-'), nomor_wa: cWa,
          alamat_lengkap: String(alamat || ''), total_harga: total, status: 'pending',
          payment_trx_id: trxId,
        }]);
        await sbPost('order_items', [{
          order_id: orderId, product_id: null, nama_produk: namaProduk,
          qty: q, harga_satuan: hargaSatuan,
        }]);
        // Notifikasi: WA ke customer (tagihan + QRIS) + Telegram ke owner
        try {
          const rpF = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
          if (cWa.length >= 10) {
            const tagihan = `🧾 *PESANAN BARU (${orderId})*\n\nHalo kak ${nama}! Terima kasih sudah order di Digiprint.\n\n📦 ${namaProduk}\nJumlah: ${q}\n*Total: ${rpF(total)}*\n\n${qrUrl ? '⏰ *QRIS aktif 10 menit saja* — kalau sudah lewat, jangan di-scan ya kak, minta QRIS baru ke admin.\nSilakan scan QRIS di bawah untuk bayar 👇' : 'Silakan lakukan pembayaran. Kirim bukti transfer ke sini ya kak 🙏'}`;
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
        const upd = await sbPatch('orders', { id: `eq.${id}` }, { status });
        if (!upd.length) return res.status(404).json({ ok: false, error: `Order ${id} tidak ditemukan — tidak ada yang berubah.` });
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
            const upd = await sbPatch('orders', { id: `eq.${id}` }, { status });
            if (!upd.length) { console.error('[dash] bulk-update: order tidak ditemukan:', id); continue; }
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
        return res.status(200).json({ ok: true, updated: okCount, total: Math.min(ids.length, 50), diminta: ids.length });
      }

      if (action === 'bulk-delete') {
        const ids = Array.isArray(b.ids) ? b.ids.map((x) => String(x).toUpperCase()) : [];
        if (!ids.length) return res.status(400).json({ ok: false, error: 'Tidak ada order dipilih' });
        let okCount = 0;
        for (const id of ids.slice(0, 50)) {
          try {
            await sbDelete('order_items', { order_id: `eq.${id}` });
            const del = await sbDelete('orders', { id: `eq.${id}` });
            if (del.length) okCount++;
          } catch (e) { console.error('[dash] bulk-delete gagal:', id, e.message); }
        }
        return res.status(200).json({ ok: true, deleted: okCount, total: Math.min(ids.length, 50), diminta: ids.length });
      }

      if (action === 'update-product') {
        const id = String(b.id || '');
        const data = {};
        if (b.harga !== undefined && b.harga !== '') data.harga = Number(b.harga);
        if (b.stok !== undefined && b.stok !== '') data.stok = Number(b.stok);
        if (!Object.keys(data).length) return res.status(400).json({ ok: false, error: 'Tidak ada perubahan' });
        if (Object.values(data).some((v) => Number.isNaN(v) || v < 0)) return res.status(400).json({ ok: false, error: 'Harga/stok tidak valid' });
        const updP = await sbPatch('products', { id: `eq.${id}` }, data);
        if (!updP.length) return res.status(404).json({ ok: false, error: `Produk ${id} tidak ditemukan — tidak ada yang berubah.` });
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
        const delP = await sbDelete('products', { id: `eq.${id}` });
        if (!delP.length) return res.status(404).json({ ok: false, error: `Produk ${id} tidak ditemukan — tidak ada yang terhapus.` });
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

      if (action === 'save-bahan-baku') {
        const nama = String(b.nama || '').trim();
        const isi = parseInt(b.isi_per_box, 10);
        const harga = Number(b.harga_per_box);
        if (!nama) return res.status(400).json({ ok: false, error: 'Nama bahan wajib diisi' });
        if (!Number.isInteger(isi) || isi <= 0) return res.status(400).json({ ok: false, error: 'Isi per box harus bilangan bulat > 0' });
        if (!Number.isFinite(harga) || harga < 0) return res.status(400).json({ ok: false, error: 'Harga per box tidak valid' });
        // harga_box_rim opsional (untuk paket rim offline); kosong = null.
        let hargaRim = null;
        if (b.harga_box_rim !== undefined && b.harga_box_rim !== '' && b.harga_box_rim !== null) {
          hargaRim = Number(b.harga_box_rim);
          if (!Number.isFinite(hargaRim) || hargaRim < 0) return res.status(400).json({ ok: false, error: 'Harga box rim tidak valid' });
        }
        const keterangan = String(b.keterangan || '');
        const id = String(b.id || '').trim();
        const row = { nama, isi_per_box: isi, harga_per_box: harga, harga_box_rim: hargaRim, keterangan };
        if (id) {
          const upd = await sbPatch('bahan_baku', { id: `eq.${id}` }, row);
          if (upd.length) return res.status(200).json({ ok: true, id });
          const created = await sbPost('bahan_baku', [{ id, ...row }]);
          return res.status(200).json({ ok: true, id: created[0]?.id || id });
        }
        const slug = nama.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bahan';
        try {
          const created = await sbPost('bahan_baku', [{ id: slug, ...row }]);
          return res.status(200).json({ ok: true, id: created[0]?.id || slug });
        } catch (e) {
          return res.status(400).json({ ok: false, error: `ID "${slug}" sudah ada — ubah nama bahan atau isi ID lain` });
        }
      }

      if (action === 'delete-bahan-baku') {
        const id = String(b.id || '');
        const del = await sbDelete('bahan_baku', { id: `eq.${id}` });
        if (!del.length) return res.status(404).json({ ok: false, error: `Bahan ${id} tidak ditemukan — tidak ada yang terhapus.` });
        return res.status(200).json({ ok: true });
      }

      if (action === 'save-bahan-baku-config') {
        const margin = Number(b.margin_persen);
        const print = Number(b.biaya_print_per_lembar);
        const untungRim = Number(b.keuntungan_rim);
        if (!Number.isFinite(margin) || margin < 0) return res.status(400).json({ ok: false, error: 'Margin % tidak valid' });
        if (!Number.isFinite(print) || print < 0) return res.status(400).json({ ok: false, error: 'Biaya print per lembar tidak valid' });
        if (!Number.isFinite(untungRim) || untungRim < 0) return res.status(400).json({ ok: false, error: 'Keuntungan rim tidak valid' });
        let komposisi;
        try { komposisi = parseKomposisiInput(b.komposisi); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
        try {
          const { bahan } = await loadBahan();
          const ids = new Set(bahan.map((x) => x.id));
          for (const ply of [1, 2, 3]) for (const bid of komposisi[ply]) {
            if (!ids.has(bid)) return res.status(400).json({ ok: false, error: `Bahan "${bid}" di komposisi ${ply}ply tidak ada di daftar bahan` });
          }
        } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
        const row = { id: 'default', margin_persen: margin, biaya_print_per_lembar: print, keuntungan_rim: untungRim, komposisi };
        const upd = await sbPatch('bahan_baku_config', { id: 'eq.default' }, row);
        if (upd.length) return res.status(200).json({ ok: true });
        await sbPost('bahan_baku_config', [row]);
        return res.status(200).json({ ok: true });
      }

      if (action === 'compute-hpp') {
        let overrides = null;
        if (b && (b.margin_persen !== undefined || b.biaya_print_per_lembar !== undefined || b.keuntungan_rim !== undefined || b.komposisi !== undefined || b.ambang_persen !== undefined)) {
          overrides = {};
          if (b.margin_persen !== undefined && b.margin_persen !== '') overrides.margin_persen = Number(b.margin_persen);
          if (b.biaya_print_per_lembar !== undefined && b.biaya_print_per_lembar !== '') overrides.biaya_print_per_lembar = Number(b.biaya_print_per_lembar);
          if (b.keuntungan_rim !== undefined && b.keuntungan_rim !== '') overrides.keuntungan_rim = Number(b.keuntungan_rim);
          if (b.komposisi !== undefined) {
            try { overrides.komposisi = parseKomposisiInput(b.komposisi); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
          }
          if (b.ambang_persen !== undefined && b.ambang_persen !== '') overrides.ambang_persen = Number(b.ambang_persen);
        }
        try {
          const hasil = await hitungHpp(overrides);
          return res.status(200).json({ ok: true, ...hasil });
        } catch (e) {
          return res.status(200).json({ ok: false, error: e.message, belumMigrasi: !!e.belumMigrasi });
        }
      }

      return res.status(400).json({ ok: false, error: 'Aksi tidak dikenal' });
    }

    return res.status(400).json({ ok: false, error: 'Aksi tidak dikenal' });
  } catch (e) {
    console.error('[dash-admin]', action, e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
