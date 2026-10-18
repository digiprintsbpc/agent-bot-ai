'use strict';
/**
 * GET /api/dash-data — data dashboard toko untuk public/dash/.
 * Proteksi: query ?pin= harus cocok dengan env DASHBOARD_PIN (default "1234").
 *
 * Response JSON:
 * {
 *   omset: { hariIni, mingguIni, bulanIni, totalOrder },
 *   grafik: [{ tanggal, total }],       // 7 hari terakhir
 *   orders: [...],                        // 10 order terbaru
 *   products: [...],                      // semua produk + stok
 * }
 */

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const PIN = process.env.DASHBOARD_PIN || '1234';

const H = { apikey: SB_KEY, 'Content-Type': 'application/json' };

async function sbGet(table, params) {
  const q = new URLSearchParams(params);
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, { headers: { apikey: SB_KEY } });
  if (!r.ok) throw new Error(`Supabase ${table}: ${r.status}`);
  return r.json();
}

// Awal hari WIB dalam ISO (UTC)
function wibDayStart(daysAgo = 0) {
  const now = new Date();
  // WIB = UTC+7 → cari jam 00:00 WIB
  const wib = new Date(now.getTime() + 7 * 3600 * 1000);
  wib.setUTCHours(0, 0, 0, 0);
  wib.setUTCDate(wib.getUTCDate() - daysAgo);
  return new Date(wib.getTime() - 7 * 3600 * 1000).toISOString();
}

function wibMonthStart() {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 3600 * 1000);
  wib.setUTCDate(1);
  wib.setUTCHours(0, 0, 0, 0);
  return new Date(wib.getTime() - 7 * 3600 * 1000).toISOString();
}

module.exports = async (req, res) => {
  // ---- Auth PIN ----
  const pin = String(req.query?.pin || '');
  if (pin !== PIN) {
    return res.status(401).json({ ok: false, error: 'PIN salah' });
  }
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase belum dikonfigurasi' });
  }

  try {
    const hariIni = wibDayStart(0);
    const mingguIni = wibDayStart(6);
    const bulanIni = wibMonthStart();

    // Ambil order 30 hari terakhir (cukup untuk semua agregasi)
    const orders30 = await sbGet('orders', {
      select: 'id,tanggal,nama_penerima,total_harga,status,nomor_wa',
      tanggal: `gte.${wibDayStart(30)}`,
      order: 'tanggal.desc',
      limit: '500',
    });

    const valid = orders30.filter((o) => o.status !== 'batal');
    const sum = (arr) => arr.reduce((a, o) => a + Number(o.total_harga || 0), 0);

    const omset = {
      hariIni: sum(valid.filter((o) => o.tanggal >= hariIni)),
      mingguIni: sum(valid.filter((o) => o.tanggal >= mingguIni)),
      bulanIni: sum(valid.filter((o) => o.tanggal >= bulanIni)),
      totalOrder: valid.length,
      orderHariIni: valid.filter((o) => o.tanggal >= hariIni).length,
    };

    // Grafik 7 hari terakhir
    const grafik = [];
    for (let i = 6; i >= 0; i--) {
      const start = wibDayStart(i);
      const end = wibDayStart(i - 1); // i=0 → besok (batas atas hari ini)
      const dayOrders = valid.filter((o) => o.tanggal >= start && o.tanggal < end);
      const d = new Date(start);
      // Label: nama hari singkat Indonesia
      const label = d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', timeZone: 'Asia/Jakarta' });
      grafik.push({ tanggal: label, total: sum(dayOrders), order: dayOrders.length });
    }

    // 10 order terbaru
    const orders = orders30.slice(0, 10).map((o) => ({
      id: o.id,
      tanggal: o.tanggal,
      nama: o.nama_penerima,
      total: Number(o.total_harga || 0),
      status: o.status,
    }));

    // Produk + stok
    const products = await sbGet('products', {
      select: 'id,nama,harga,stok,kategori',
      order: 'nama.asc',
      limit: '100',
    });

    return res.status(200).json({
      ok: true,
      omset,
      grafik,
      orders,
      products: products.map((p) => ({
        id: p.id,
        nama: p.nama,
        harga: Number(p.harga || 0),
        stok: Number(p.stok || 0),
        kategori: p.kategori,
      })),
    });
  } catch (e) {
    console.error('[dash-data]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
