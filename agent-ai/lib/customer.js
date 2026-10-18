'use strict';
/**
 * lib/customer.js — MODE PELANGGAN: pesan barang + QRIS + cek bayar.
 * Aktif untuk chat selain TELEGRAM_ALLOWED_ID (owner).
 * State machine disimpan di tabel order_sessions (Supabase).
 */

const { chat } = require('./llm');
const { sendMessage, sendPhoto } = require('./telegram-api');
const payinaja = require('./payinaja');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const OWNER_ID = String(process.env.TELEGRAM_ALLOWED_ID || '');

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
    method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table}: ${res.status}`);
  return true;
}

// ---------- Sesi ----------
async function getSession(userId) {
  try {
    const rows = await sbGet('order_sessions', { select: '*', user_id: `eq.${userId}` });
    return rows[0] || null;
  } catch { return null; }
}
async function saveSession(userId, step, draft) {
  try {
    await sbPost('order_sessions',
      [{ user_id: String(userId), step, draft, updated_at: new Date().toISOString() }],
      'resolution=merge-duplicates,return=minimal');
  } catch (e) { console.error('[session] save gagal:', e.message); }
}
async function clearSession(userId) {
  try {
    await fetch(`${SB_URL}/rest/v1/order_sessions?user_id=eq.${userId}`, {
      method: 'DELETE', headers: sbHeaders(),
    });
  } catch {}
}

// ---------- Produk ----------
async function getProducts() {
  const rows = await sbGet('products', { select: 'id,nama,harga', order: 'nama' });
  return rows;
}
const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
function catalogText(products) {
  return products.map((p) => `- ${p.nama} — ${rp(p.harga)}`).join('\n');
}
// Versi ringkas untuk ditampilkan ke pelanggan: dikelompokkan per ukuran
function catalogCompact(products) {
  const lines = [];
  for (const s of ['1/2', '1/3', '1/4', '1/6', '1/8', '1/10']) {
    const items = products.filter((p) => p.nama.startsWith(`Nota ${s} folio`));
    if (!items.length) continue;
    lines.push(`*${s} folio:*`);
    for (const ply of [1, 2, 3]) {
      const p50 = items.find((p) => p.nama.includes(`${ply}ply (50 lembar)`));
      const p100 = items.find((p) => p.nama.includes(`${ply}ply (100 lbr)`));
      lines.push(`• ${ply}ply — 50 lbr ${p50 ? rp(p50.harga) : '-'} | 100 lbr ${p100 ? rp(p100.harga) : '-'}`);
    }
  }
  const rims = products.filter((p) => p.kategori === 'Paket Rim');
  if (rims.length) {
    lines.push(`*Paket 1 rim (free ongkir Malang):*`);
    for (const r of rims) {
      const ply = r.nama.match(/(\d)ply/);
      lines.push(`• ${ply ? ply[1] + 'ply' : r.nama} — ${rp(r.harga)}`);
    }
  }
  return lines.join('\n');
}

// ---------- Parse LLM ----------
function parseJson(s) {
  try {
    const m = String(s).match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function parseMessage(text, products, session) {
  const d = session?.draft || {};
  const step = session?.step || 'idle';
  const missing = [];
  if (!d.product_id) missing.push('produk');
  if (!d.qty) missing.push('jumlah');
  if (!d.name) missing.push('nama');
  if (!d.phone) missing.push('no WA');
  if (!d.address) missing.push('alamat');

  const prompt = `Kamu asisten order toko cetak "Digiprint" (nota NCR, kwitansi). Bicara Bahasa Indonesia kasual & ramah.
Tugas: pahami pesan pelanggan, ekstrak info pesanan.

DAFTAR PRODUK (id | nama | harga):
${products.map((p) => `${p.id} | ${p.nama} | ${rp(p.harga)}`).join('\n')}

STATUS: step=${step}
SUDAH TERKUMPUL: produk=${d.product_nama || d.product_hint || '-'} qty=${d.qty || '-'} nama=${d.name || '-'} wa=${d.phone || '-'} alamat=${d.address || '-'}
MASIH KURANG: ${missing.join(', ') || 'lengkap'}

ATURAN:
- Cocokkan produk yang dimaksud ke salah satu ID (fuzzy: "nota setengah folio 2 ply" → produk nota 1/2 folio 2ply). Kalau tipe produk jelas tapi varian belum (mis. "1/4 2ply" bisa 50 atau 100 lembar) → product_id null TAPI isi product_hint dengan tipe-nya ("1/4 2ply"). Kalau tidak jelas sama sekali → keduanya null.
- qty: angka jumlah. null bila tidak disebut.
- intent: order (mau pesan), ask (tanya produk/harga), track (tanya status pesanan / menyebut INV-), paid (bilang sudah bayar/lunas), cancel (batal), greeting (salam), other.
- confirmed: true bila pelanggan menyetujui ("ya", "oke", "setuju"), false bila menolak ("tidak", "batal"), null bila tidak ada.
- reply: balasan natural 1-3 kalimat. Bila masih ada yang kurang dan step collecting/idle, tanyakan SATU hal yang paling penting berikutnya. Jangan mengarang harga.

Balas HANYA JSON valid:
{"intent":"order","product_id":null,"product_hint":null,"qty":null,"name":null,"phone":null,"address":null,"confirmed":null,"reply":"..."}

PESAN PELANGGAN: """${text}"""`;

  try {
    const out = await chat([{ role: 'user', content: prompt }], { maxTokens: 600, temperature: 0.2 });
    return parseJson(out) || { intent: 'other', reply: 'Maaf kak, bisa diulangi? 😊' };
  } catch (e) {
    console.error('[customer] parse gagal:', e.message);
    return { intent: 'other', reply: 'Maaf kak, ada gangguan sebentar. Coba lagi ya.' };
  }
}

// ---------- Buat pesanan ----------
function genOrderId() {
  return 'INV-' + Math.floor(100000 + Math.random() * 900000);
}

async function createOrder(draft) {
  const orderId = genOrderId();
  const total = Math.round(Number(draft.harga) * Number(draft.qty));

  // customer: cari by WA, buat bila belum ada
  let customerId = null;
  try {
    const found = await sbGet('customers', { select: 'id', nomor_wa: `eq.${draft.phone}`, limit: 1 });
    customerId = found[0]?.id || null;
  } catch {}
  if (!customerId) {
    try {
      const created = await sbPost('customers', [{ nama: draft.name, nomor_wa: draft.phone, alamat_lengkap: draft.address }]);
      customerId = created[0]?.id || null;
    } catch (e) { console.error('[customer] buat customer gagal:', e.message); }
  }

  await sbPost('orders', [{
    id: orderId,
    customer_id: customerId,
    nama_penerima: draft.name,
    nomor_wa: draft.phone,
    alamat_lengkap: draft.address,
    total_harga: total,
    status: 'pending',
  }]);
  await sbPost('order_items', [{
    order_id: orderId,
    product_id: draft.product_id,
    nama_produk: draft.product_nama,
    qty: Number(draft.qty),
    harga_satuan: Number(draft.harga),
  }]);

  // QRIS PayinAja
  let trxId = null;
  let qrUrl = null;
  const qris = await payinaja.createQRIS(total, orderId, draft.name, draft.phone);
  if (qris.ok) {
    trxId = qris.trx_id;
    qrUrl = qris.qr_image_url;
    await sbPatch('orders', { id: `eq.${orderId}` }, { payment_trx_id: trxId }).catch(() => {});
  }
  return { orderId, total, trxId, qrUrl, qrisError: qris.ok ? null : qris.error };
}

function orderSummary(d) {
  const sub = Math.round(Number(d.harga) * Number(d.qty));
  return `📝 *Ringkasan pesanan:*\n• ${d.product_nama} — ${d.qty} × ${rp(d.harga)} = ${rp(sub)}\n• Nama: ${d.name}\n• WA: ${d.phone}\n• Alamat: ${d.address}\n\n*Total: ${rp(sub)}*`;
}

// ---------- Handler utama ----------
// onPhoto(url, caption): bila diisi, foto QRIS diserahkan ke pemanggil
// (dipakai channel WA); bila kosong, dikirim via Telegram dan return null.
async function handleCustomer(userId, text, onPhoto) {
  const q = String(text || '').trim();
  let session = await getSession(userId);
  if (!session) session = { user_id: String(userId), step: 'idle', draft: {} };
  const d = session.draft || {};

  // Perintah global: batal
  if (/^(batal|gak jadi|nggak jadi|cancel)$/i.test(q)) {
    if (d.order_id && session.step === 'awaiting_payment') {
      await sbPatch('orders', { id: `eq.${d.order_id}` }, { status: 'batal' }).catch(() => {});
    }
    await clearSession(userId);
    return 'Baik kak, pesanan dibatalkan. Kalau butuh apa-apa, chat lagi aja ya 😊';
  }

  // Lacak pesanan: sebut INV-xxxxxx
  const invMatch = q.match(/INV-\d{6}/i);
  if (invMatch) {
    try {
      const rows = await sbGet('orders', { select: 'id,total_harga,status,tanggal,payment_trx_id', id: `eq.${invMatch[0].toUpperCase()}` });
      if (rows[0]) {
        const o = rows[0];
        // Bila masih pending & ada trx QRIS (mis. order dari template admin) → cek pembayaran otomatis
        if (o.status === 'pending' && o.payment_trx_id) {
          const cek = await payinaja.checkTransaction(o.payment_trx_id).catch(() => ({ ok: false }));
          if (cek.ok && cek.paid) {
            await sbPatch('orders', { id: `eq.${o.id}` }, { status: 'diproses' }).catch(() => {});
            o.status = 'diproses';
            if (OWNER_ID) {
              await sendMessage(OWNER_ID, `💰 *PEMBAYARAN MASUK!*\nInvoice: ${o.id}\nTotal: ${rp(o.total_harga)}\n🚦 Status: Diproses ⚙️`).catch(() => {});
            }
          }
        }
        const stMap = { pending: 'Belum Bayar 🔴', diproses: 'Diproses ⚙️', dikirim: 'Dikirim 🚚', selesai: 'Selesai 🥰', batal: 'Batal ❌' };
        return `📦 *${o.id}*\nTotal: ${rp(o.total_harga)}\nStatus: ${stMap[o.status] || o.status}`;
      }
      return 'Nomor pesanan tidak ditemukan. Cek lagi ya kak.';
    } catch {
      return 'Maaf, tidak bisa cek status saat ini.';
    }
  }

  // Step: QRIS gagal dibuat sebelumnya → bisa coba lagi
  if (session.step === 'qris_failed') {
    if (/dari awal|mulai lagi|ulang/i.test(q)) {
      await clearSession(userId);
      return 'Baik kak, kita mulai dari awal ya. Mau pesan produk apa? 😊';
    }
    if (/coba lagi|buat qris|ulangi|retry/i.test(q)) {
      const qris = await payinaja.createQRIS(d.amount, d.order_id, d.name, d.phone);
      if (qris.ok && qris.qr_image_url) {
        await sbPatch('orders', { id: `eq.${d.order_id}` }, { payment_trx_id: qris.trx_id }).catch(() => {});
        await saveSession(userId, 'awaiting_payment', { ...d, trx_id: qris.trx_id });
        const caption = `🧾 *Pesanan ${d.order_id}*\n${d.product_nama} × ${d.qty}\n*Total: ${rp(d.amount)}*\n\nSilakan scan QRIS di atas untuk membayar. Setelah bayar, ketik *SUDAH BAYAR*.`;
        if (onPhoto) { await onPhoto(qris.qr_image_url, caption); return null; }
        await sendPhoto(userId, qris.qr_image_url, caption);
        return null;
      }
      return `QRIS masih gagal dibuat (${(qris && qris.error) || 'unknown'}). Admin akan menghubungimu ya kak.`;
    }
    return `Pesanan *${d.order_id}* sudah tercatat. Ketik *COBA LAGI* untuk coba buat QRIS ulang, atau tunggu admin menghubungimu ya kak.`;
  }

  // Step: menunggu pembayaran
  if (session.step === 'awaiting_payment') {
    if (!d.trx_id) {
      // Pengaman: tidak ada QRIS tapi nyasar ke sini → arahkan ke coba lagi
      await saveSession(userId, 'qris_failed', d);
      return `QRIS untuk pesanan *${d.order_id}* belum tersedia. Ketik *COBA LAGI* untuk coba lagi ya kak.`;
    }
    if (/sudah bayar|udah bayar|sudah lunas|udah lunas|lunas/i.test(q)) {
      if (!d.trx_id) return 'Pesananmu belum ada QRIS-nya kak. Hubungi admin ya.';
      const res = await payinaja.checkTransaction(d.trx_id);
      if (res.ok && res.paid) {
        await sbPatch('orders', { id: `eq.${d.order_id}` }, { status: 'diproses' }).catch(() => {});
        await clearSession(userId);
        if (OWNER_ID) {
          await sendMessage(OWNER_ID,
            `💰 *PEMBAYARAN MASUK!*\nInvoice: ${d.order_id}\nTotal: ${rp(d.amount)}\nPelanggan: ${d.name} (${d.phone})`).catch(() => {});
        }
        return `✅ Pembayaran *${d.order_id}* diterima! Pesananmu sedang diproses ya kak. Terima kasih 🙏`;
      }
      if (!res.ok) return `Belum bisa cek pembayaran: ${res.error}. Coba lagi sebentar ya kak.`;
      return 'Pembayarannya belum terdeteksi kak. Pastikan sudah scan QR & bayar, lalu ketik *SUDAH BAYAR* lagi.';
    }
    return 'Silakan scan QRIS di atas untuk membayar ya kak. Setelah bayar, ketik *SUDAH BAYAR*.';
  }

  // Step: konfirmasi
  if (session.step === 'confirm') {
    if (/^(ya|iya|oke|ok|setuju|lanjut|betul|benar)$/i.test(q)) {
      try {
        const r = await createOrder(d);
        if (OWNER_ID) {
          await sendMessage(OWNER_ID,
            `🛒 *PESANAN BARU* (via Agent)\nInvoice: ${r.orderId}\n${d.product_nama} × ${d.qty} = ${rp(r.total)}\nPelanggan: ${d.name} (${d.phone})\nStatus: Belum Bayar 🔴`).catch(() => {});
        }
        if (r.qrUrl) {
          const newDraft = { ...d, order_id: r.orderId, trx_id: r.trxId, amount: r.total };
          await saveSession(userId, 'awaiting_payment', newDraft);
          const caption = `🧾 *Pesanan ${r.orderId}*\n${d.product_nama} × ${d.qty}\n*Total: ${rp(r.total)}*\n\nSilakan scan QRIS di atas untuk membayar. Setelah bayar, ketik *SUDAH BAYAR*.`;
          if (onPhoto) {
            await onPhoto(r.qrUrl, caption);
            return null; // pemanggil (WA) yang mengirim fotonya
          }
          await sendPhoto(userId, r.qrUrl, caption);
          return null; // foto sudah terkirim sebagai balasan
        }
        // QRIS gagal → JANGAN masuk awaiting_payment, beri opsi coba lagi
        await saveSession(userId, 'qris_failed', { ...d, order_id: r.orderId, amount: r.total });
        return `Pesanan *${r.orderId}* sudah tercatat, tapi QRIS gagal dibuat (${r.qrisError || 'unknown'}).\nKetik *COBA LAGI* untuk coba lagi, atau admin akan menghubungimu ya kak.`;
      } catch (e) {
        console.error('[customer] createOrder gagal:', e.message);
        return 'Maaf kak, pesanan gagal dibuat. Coba lagi atau hubungi admin ya.';
      }
    }
    if (/^(tidak|nggak|ga|batal)$/i.test(q)) {
      await saveSession(userId, 'collecting', {});
      return 'Baik, diulang dari awal ya kak. Mau pesan produk apa?';
    }
    return 'Ketik *YA* untuk lanjut buat pesanan, atau *BATAL* untuk membatalkan.';
  }

  // Step: idle / collecting / done → parse dengan LLM
  let products = [];
  try { products = await getProducts(); } catch (e) {
    return 'Maaf kak, katalog sedang tidak bisa diakses. Coba lagi sebentar ya.';
  }
  if (!products.length) return 'Maaf kak, katalog produk sedang kosong.';

  // Sapaan pertama pelanggan baru: natural, JANGAN langsung sodorkan katalog
  if (session.step === 'idle' && !d.product_id && /^(halo+|hai+|hello+|hi+|pagi+|siang+|sore+|malam+|tes|test|assalamu\s*alaikum)(\s+k[ak]+)?[!?.\s]*$/i.test(q)) {
    const greets = [
      'Halo kak! Selamat datang di Digiprint 😊\nMau pesan nota atau kwitansi custom? Atau mau tanya-tanya dulu juga boleh.',
      'Halo juga kak! Ada yang bisa saya bantu? 😊\nKami bisa bantu pesankan nota NCR & kwitansi custom.',
      'Hai kak, selamat datang! 😊\nMau order apa hari ini?',
    ];
    return greets[Math.floor(Math.random() * greets.length)];
  }

  const p = await parseMessage(q, products, session);

  // Terapkan slot ke draft
  if (p.product_id) {
    const prod = products.find((x) => x.id === p.product_id);
    if (prod) { d.product_id = prod.id; d.product_nama = prod.nama; d.harga = Number(prod.harga); d.product_hint = null; }
  }
  if (p.product_hint && !d.product_id) d.product_hint = String(p.product_hint).slice(0, 60);
  if (p.qty && Number(p.qty) > 0) d.qty = Math.floor(Number(p.qty));
  if (p.name) d.name = String(p.name).slice(0, 80);
  if (p.phone) d.phone = String(p.phone).replace(/\D/g, '').slice(0, 16);
  if (p.address) d.address = String(p.address).slice(0, 200);

  if (p.intent === 'cancel') {
    await clearSession(userId);
    return 'Baik kak, dibatalkan. Chat lagi aja kalau butuh 😊';
  }
  if (p.intent === 'paid') {
    return 'Kakak belum punya pesanan aktif. Mau buat pesanan dulu?';
  }

  // Tentukan kelengkapan
  const missing = [];
  if (!d.product_id) missing.push('produk');
  if (!d.qty) missing.push('jumlah');
  if (!d.name) missing.push('nama');
  if (!d.phone) missing.push('no WA');
  if (!d.address) missing.push('alamat');

  if (!missing.length) {
    await saveSession(userId, 'confirm', d);
    return `${orderSummary(d)}\n\nKetik *YA* untuk buat pesanan & tampilkan QRIS, atau *BATAL* untuk membatalkan.`;
  }

  await saveSession(userId, 'collecting', d);
  // Pakai balasan LLM bila sudah menanyakan hal yang kurang; kalau tidak, fallback template
  const needWords = {
    produk: ['produk', 'paket', 'nota', 'kwitansi', 'barang'],
    jumlah: ['jumlah', 'lembar', 'berapa', 'banyak'],
    nama: ['nama'],
    'no WA': ['wa', 'nomor', 'telepon', 'hp'],
    alamat: ['alamat', 'kirim', 'lokasi']
  };
  const replyLower = (p.reply || '').toLowerCase();
  const asksMissing = missing.some((m) => (needWords[m] || [m]).some((w) => replyLower.includes(w)));
  if (p.reply && (asksMissing || p.intent === 'ask' || p.intent === 'greeting' || p.intent === 'other')) {
    // Katalog HANYA bila diminta eksplisit, atau saat mau pesan tapi produknya belum jelas.
    // Selain itu (mis. tanya ukuran, tanya harga satuan) → jawab saja, tanpa katalog.
    const wantsCatalog = /katalog|daftar harga|price list|jualan apa|jual apa|produk apa|semua produk/i.test(q);
    if (!d.product_id && (wantsCatalog || p.intent === 'order')) {
      return `${p.reply}\n\nDaftar harga kami kak:\n${catalogCompact(products)}`;
    }
    return p.reply;
  }
  const labels = { produk: 'mau pesan produk apa', jumlah: 'berapa jumlahnya', nama: 'siapa nama kakak', 'no WA': 'nomor WA kakak berapa', alamat: 'alamat lengkapnya di mana' };
  return `${p.reply ? p.reply + '\n\n' : ''}Boleh info ${labels[missing[0]]}? 😊`;
}

// ---------- Bukti transfer dari customer (foto) → OCR ----------
// Dipakai saat customer kirim foto di Telegram. Untuk WA, foto bukti
// ditangani terpisah (panel teruskan file ke endpoint ini bila diperlukan).
async function handleCustomerPhoto(userId, fileId) {
  const { getFileUrl, sendPhoto } = require('./telegram-api');
  const { ocrImage, extractAmounts } = require('./ocr');
  const session = await getSession(userId);
  const d = (session && session.draft) || {};
  if (!session || session.step !== 'awaiting_payment' || !d.order_id) {
    return 'Untuk pesan barang, kirim dalam bentuk teks ya kak 😊';
  }
  const fileUrl = await getFileUrl(fileId).catch(() => null);
  const ocr = fileUrl ? await ocrImage(fileUrl) : { ok: false };
  if (!ocr.ok) return 'Maaf kak, fotonya tidak terbaca. Coba kirim ulang dengan gambar yang lebih jelas ya.';
  const amounts = extractAmounts(ocr.text);
  const read = amounts[0] || 0;
  const total = Math.round(Number(d.amount) || 0);
  const cocok = read && Math.abs(read - total) <= 1000;
  // Teruskan foto + hasil OCR ke owner untuk verifikasi
  if (OWNER_ID) {
    const cap = `🧾 *BUKTI TRANSFER*\nPesanan: ${d.order_id}\nPelanggan: ${d.name} (${d.phone})\nTotal tagihan: ${rp(total)}\nTerbaca OCR: ${read ? rp(read) : 'tidak terbaca'} ${cocok ? '✅ COCOK' : '⚠️ BEDA'}\n\nTeks OCR:\n${ocr.text.slice(0, 500)}`;
    await sendPhoto(OWNER_ID, fileId, cap).catch(() => {});
  }
  await logActivitySafe('bukti', `Bukti transfer ${d.order_id}: terbaca ${rp(read)} ${cocok ? '(cocok)' : '(beda)'}`);
  if (cocok) {
    return `Bukti transfer diterima kak (terbaca ${rp(read)} ✅). Admin akan verifikasi sebentar ya 🙏`;
  }
  return `Bukti diterima kak, tapi nominal yang terbaca (${read ? rp(read) : 'tidak jelas'}) berbeda dengan total ${rp(total)}. Admin akan cek manual ya kak 🙏`;
}

async function logActivitySafe(aksi, detail) {
  try {
    const SB_URL2 = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const SB_KEY2 = process.env.SUPABASE_SERVICE_KEY || '';
    await fetch(`${SB_URL2}/rest/v1/agent_activity`, {
      method: 'POST',
      headers: { apikey: SB_KEY2, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify([{ kategori: 'toko', aksi, detail: String(detail).slice(0, 500) }]),
    });
  } catch {}
}

module.exports = { handleCustomer, handleCustomerPhoto, getSession, clearSession };
