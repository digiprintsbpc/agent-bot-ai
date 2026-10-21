'use strict';
/**
 * lib/digital.js — PRODUK DIGITAL: stok unik (link/akun), kunci stok,
 * pengiriman otomatis setelah bayar, dan pencocokan produk (kode/fuzzy).
 *
 * Model:
 *  - products.tipe = 'digital', products.id = KODE (mis. CC1B, GEM1B)
 *  - products.template_kirim berisi placeholder {ISI} dan {ISI2}
 *  - stok_digital: 1 baris = 1 item. status: tersedia → dikunci → terjual
 */

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const sbHeaders = () => ({ apikey: SB_KEY, 'Content-Type': 'application/json' });

async function sbGet(table, params = {}) {
  const q = new URLSearchParams(params);
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase GET ${table}: ${res.status}`);
  return res.json();
}
async function sbPost(table, rows, prefer = 'return=representation') {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST', headers: { ...sbHeaders(), Prefer: prefer }, body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase POST ${table}: ${res.status} ${t.slice(0, 120)}`);
  }
  return prefer.includes('return=representation') ? res.json() : [];
}
async function sbPatch(table, params, body) {
  const q = new URLSearchParams(params);
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, {
    method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table}: ${res.status}`);
  return true;
}

// ---------- Produk ----------
async function getDigitalProducts() {
  return sbGet('products', {
    select: 'id,nama,harga,tipe,template_kirim,durasi_hari,garansi_hari',
    tipe: 'eq.digital', order: 'id',
  });
}
async function getDigitalProduct(id) {
  const all = await getDigitalProducts();
  return all.find((p) => p.id.toUpperCase() === String(id).toUpperCase()) || null;
}
/** Resolusi ke id kanonis produk (persis seperti tersimpan di DB). */
async function canonicalId(produkId) {
  const p = await getDigitalProduct(produkId).catch(() => null);
  return p ? p.id : String(produkId);
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}
/**
 * Cari produk digital dari teks bebas (kode atau nama, toleran salah ketik).
 * Return: { product, ambiguous: [..] } — product null bila tidak ketemu.
 */
async function matchDigital(text) {
  const products = await getDigitalProducts();
  if (!products.length) return { product: null, ambiguous: [] };
  const raw = String(text || '').trim();
  const upper = raw.toUpperCase();
  // 1) kode persis (satu token sama dengan id, tidak peka huruf)
  for (const p of products) {
    if (upper === p.id.toUpperCase() || upper.split(/\s+/).includes(p.id.toUpperCase())) return { product: p, ambiguous: [] };
  }
  const n = norm(raw);
  if (!n) return { product: null, ambiguous: [] };
  // 2) nama mengandung / terkandung
  let hits = products.filter((p) => norm(p.nama) === n || norm(p.nama).includes(n) || n.includes(norm(p.nama)));
  if (hits.length === 1) return { product: hits[0], ambiguous: [] };
  if (hits.length > 1) return { product: null, ambiguous: hits };
  // 3) fuzzy per kata (jarak edit kecil)
  let best = null; let bestD = 99;
  for (const p of products) {
    const cand = [norm(p.id), norm(p.nama), ...norm(p.nama).split(/(?=[0-9])|(?<=[a-z])(?=[0-9])/).filter(Boolean)];
    for (const c of cand) {
      if (!c) continue;
      const dd = lev(n, c);
      if (dd < bestD) { bestD = dd; best = p; }
    }
  }
  if (best && bestD <= 2) return { product: best, ambiguous: [] };
  return { product: null, ambiguous: [] };
}

// ---------- Stok ----------
async function countStock(produkId, status = 'tersedia') {
  const pid = await canonicalId(produkId);
  const rows = await sbGet('stok_digital', {
    select: 'id', produk_id: `eq.${pid}`, status: `eq.${status}`, limit: 1000,
  });
  return rows.length;
}
async function syncProductStock(produkId) {
  try {
    const pid = await canonicalId(produkId);
    const n = await countStock(pid);
    await sbPatch('products', { id: `eq.${pid}` }, { stok: n });
  } catch {}
}

/**
 * Kunci stok untuk sebuah order. Return jumlah yang berhasil dikunci.
 * Bila kurang dari qty → kunci dilepas lagi semua (return 0).
 */
async function lockStock(orderId, produkId, qty) {
  const pid = await canonicalId(produkId);
  const rows = await sbGet('stok_digital', {
    select: 'id', produk_id: `eq.${pid}`, status: 'eq.tersedia',
    order: 'created_at.asc', limit: qty,
  });
  if (rows.length < qty) return 0;
  for (const r of rows) {
    await sbPatch('stok_digital', { id: `eq.${r.id}`, status: 'eq.tersedia' },
      { status: 'dikunci', order_id: orderId });
  }
  // verifikasi: pastikan tepat qty terkunci atas nama order ini
  const locked = await sbGet('stok_digital', {
    select: 'id', order_id: `eq.${orderId}`, produk_id: `eq.${pid}`, status: 'eq.dikunci',
  });
  if (locked.length < qty) {
    await releaseLock(orderId);
    return 0;
  }
  return locked.length;
}

async function releaseLock(orderId) {
  try {
    await sbPatch('stok_digital', { order_id: `eq.${orderId}`, status: 'eq.dikunci' },
      { status: 'tersedia', order_id: null });
  } catch {}
}

async function getLockedItems(orderId) {
  return sbGet('stok_digital', {
    select: 'id,produk_id,isi,isi2', order_id: `eq.${orderId}`, status: 'eq.dikunci', order: 'created_at.asc',
  });
}

/** Susun teks pengiriman dari template produk + item stok. */
function composeDelivery(product, items) {
  const tpl = product.template_kirim || '{ISI}';
  return items.map((it) => tpl.replaceAll('{ISI2}', it.isi2 || '').replaceAll('{ISI}', it.isi || '')).join('\n\n———\n\n');
}

/**
 * Selesaikan pengiriman digital untuk order yang SUDAH dibayar:
 * tandai item terjual + catat kedaluwarsa. Return daftar pesan per produk.
 * Return null bila order ini tidak punya item digital terkunci.
 */
async function deliverLocked(orderId, nomorWa) {
  const items = await getLockedItems(orderId);
  if (!items.length) return null;
  const byProduct = new Map();
  for (const it of items) {
    if (!byProduct.has(it.produk_id)) byProduct.set(it.produk_id, []);
    byProduct.get(it.produk_id).push(it);
  }
  const out = [];
  const now = new Date();
  for (const [pid, list] of byProduct) {
    const product = await getDigitalProduct(pid);
    if (!product) continue;
    const kedaluwarsa = product.durasi_hari > 0
      ? new Date(now.getTime() + product.durasi_hari * 24 * 3600 * 1000).toISOString()
      : null;
    for (const it of list) {
      await sbPatch('stok_digital', { id: `eq.${it.id}` }, {
        status: 'terjual', nomor_wa: nomorWa || null,
        dikirim_at: now.toISOString(), kedaluwarsa_at: kedaluwarsa,
      });
    }
    await syncProductStock(pid);
    out.push({ product, message: composeDelivery(product, list), kedaluwarsa });
  }
  return out.length ? out : null;
}

/** Input stok baru (dengan deteksi duplikat). Return {added, dupes}. */
async function addStock(produkId, entries) {
  const pid = await canonicalId(produkId);
  const existing = await sbGet('stok_digital', {
    select: 'isi,isi2', produk_id: `eq.${pid}`, status: 'neq.terjual', limit: 1000,
  });
  const seen = new Set(existing.map((e) => `${e.isi}||${e.isi2 || ''}`));
  const rows = [];
  let dupes = 0;
  for (const e of entries) {
    const key = `${e.isi}||${e.isi2 || ''}`;
    if (seen.has(key)) { dupes++; continue; }
    seen.add(key);
    rows.push({ produk_id: pid, isi: e.isi, isi2: e.isi2 || null, status: 'tersedia' });
  }
  if (rows.length) await sbPost('stok_digital', rows, 'return=minimal');
  await syncProductStock(pid);
  return { added: rows.length, dupes };
}

module.exports = {
  sbGet, sbPost, sbPatch,
  getDigitalProducts, getDigitalProduct, matchDigital,
  countStock, syncProductStock, lockStock, releaseLock,
  getLockedItems, composeDelivery, deliverLocked, addStock,
};
