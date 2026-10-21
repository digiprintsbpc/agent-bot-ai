'use strict';
/**
 * lib/admin.js — MENU ADMIN, port 1:1 dari toko-bot/telegram-2.js (bot lama),
 * digabung dengan fitur baru (7 fitur admin + fitur jualan).
 * Satu bot, dua tampilan: modul ini KHUSUS owner (TELEGRAM_ALLOWED_ID).
 *
 * - State: tabel admin_states (bukan memory, karena serverless)
 * - Profil toko: tabel store_profile (bukan JSON file)
 * - Kirim WA: tabel wa_outbox (panel/Baileys yang kirim)
 * - Teks & tombol dibuat SAMA PERSIS dengan bot lama ("plek ketiplek").
 *
 * KONTRAK RETURN (dengan api/telegram.js):
 * - handleMessage → null   : TIDAK di-handle, lanjutkan ke asisten AI
 * - handleMessage → true   : sudah di-handle & pesan SUDAH terkirim di dalam
 * - handleMessage → string : sudah di-handle, kirim string ini sebagai balasan
 * PENTING: jangan pernah kembalikan objek message Telegram (menyebabkan
 * "[object Object]" terkirim ke owner). Semua handler command harus return
 * setelah kirim — jangan fallthrough ke AI.
 *
 * Menu utama (persis bot lama):
 *   🛍 Order WA | 🛒 Order Market | 🔍 Cek Pesanan | 📦 Update Paket
 *   📦 Kelola Produk | 📂 Edukasi & Promo | 📊 Laporan | ⚙️ Setting Toko
 *   💸 Tarik Dana (link payinaja)
 *
 * Status DB: pending|diproses|dikirim|selesai|batal
 * (bot lama menampilkan dengan emoji; DISP/dispStatus menangani konversinya)
 */

const tg = require('./telegram-api');
const { ocrImage, extractResiInfo, extractAllNumbers } = require('./ocr');
const payinaja = require('./payinaja');
const digital = require('./digital');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const OWNER_ID = String(process.env.TELEGRAM_ALLOWED_ID || '');

const sbHeaders = () => ({ apikey: SB_KEY, 'Content-Type': 'application/json' });
async function sbGet(table, params = {}) {
  const q = new URLSearchParams(params);
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`SB GET ${table} ${res.status}`);
  return res.json();
}
async function sbPost(table, rows, prefer = 'return=representation') {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST', headers: { ...sbHeaders(), Prefer: prefer }, body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`SB POST ${table} ${res.status}`);
  return prefer.includes('return=representation') ? res.json() : [];
}
async function sbPatch(table, params, body) {
  const q = new URLSearchParams(params);
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, {
    method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`SB PATCH ${table} ${res.status}`);
  return true;
}
async function sbDel(table, params) {
  const q = new URLSearchParams(params);
  await fetch(`${SB_URL}/rest/v1/${table}?${q}`, { method: 'DELETE', headers: sbHeaders() }).catch(() => {});
}

// ---------- State admin ----------
async function getAdminState(userId) {
  try {
    const rows = await sbGet('admin_states', { select: '*', user_id: `eq.${userId}` });
    return rows[0] || null;
  } catch { return null; }
}
async function setAdminState(userId, step, data = {}) {
  await sbPost('admin_states',
    [{ user_id: String(userId), step, data, updated_at: new Date().toISOString() }],
    'resolution=merge-duplicates,return=minimal').catch(() => {});
}
async function clearAdminState(userId) {
  await sbDel('admin_states', { user_id: `eq.${userId}` });
}

// ---------- Helpers (sama seperti bot lama) ----------
const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
function formatWA(wa) {
  let clean = String(wa).replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) clean = '62' + clean.substring(1);
  if (!clean.startsWith('62')) clean = '62' + clean;
  return clean;
}
function getEstimasi(alamat) {
  const str = String(alamat || '').toLowerCase();
  if (str.match(/jawa|jatim|jateng|jabar|jakarta|banten/)) return 3;
  if (str.match(/bali|sumatera|ntb/)) return 5;
  return 4;
}
function fmtTgl(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  } catch { return '-'; }
}
// status DB <-> tampilan (bot lama pakai emoji)
const DISP = { pending: 'Belum Bayar 🔴', diproses: 'Diproses ⚙️', dikirim: 'Dikirim 🚚', selesai: 'Selesai 🥰', batal: 'Batal ❌' };
const DBST = { 'belum': 'pending', 'diproses': 'diproses', 'dikirim': 'dikirim', 'selesai': 'selesai', 'batal': 'batal' };
function dispStatus(s) { return DISP[s] || s; }
function dbStatus(s) {
  s = String(s || '');
  if (DISP[s]) return s;
  for (const k of Object.keys(DBST)) if (s.toLowerCase().includes(k)) return DBST[k];
  return 'pending';
}
function csvEsc(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Baris order format bot lama: [id,tgl,nama,wa,alamat,pesanan,total,statusDisplay,resi]
function orderToRow(o) {
  return [o.id, fmtTgl(o.tanggal), o.nama_penerima, o.nomor_wa, o.alamat_lengkap,
    '', Number(o.total_harga), dispStatus(o.status), o.nomor_resi || ''];
}
async function getAllData() {
  const orders = await sbGet('orders', { select: 'id,tanggal,nama_penerima,nomor_wa,alamat_lengkap,nomor_resi,total_harga,status', order: 'tanggal.desc', limit: 500 });
  return { success: true, data: [['ID', 'Tanggal', 'Nama', 'WA', 'Alamat', 'Pesanan', 'Total', 'Status', 'Resi'], ...orders.map(orderToRow)] };
}
async function getOrderItems(orderId) {
  try {
    return await sbGet('order_items', { select: 'nama_produk,qty,harga_satuan', order_id: `eq.${orderId}` });
  } catch { return []; }
}
async function updateStatus(id, status) {
  await sbPatch('orders', { id: `eq.${id}` }, { status: dbStatus(status) });
}
async function updateResi(id, link) {
  await sbPatch('orders', { id: `eq.${id}` }, { nomor_resi: link });
}
async function getSemuaProduk() {
  const prods = await sbGet('products', { select: 'id,nama', order: 'id' });
  return { success: true, data: [['ID', 'Nama'], ...prods.map((p) => [p.id, p.nama])] };
}
async function getProduk(id) {
  const rows = await sbGet('products', { select: '*', id: `eq.${String(id).toUpperCase()}` });
  const p = rows[0];
  if (!p) return null;
  return { id: p.id, nama: p.nama, kat: p.kategori, desc: p.deskripsi, hrg: p.harga, stok: p.stok, link: p.link_gambar };
}
async function saveProduk(d) {
  await sbPost('products', [{
    id: String(d.id).toUpperCase(), nama: d.nama, kategori: d.kat, deskripsi: d.desc,
    harga: Number(String(d.hrg).replace(/[^0-9]/g, '')) || 0,
    stok: parseInt(d.stok, 10) || 0, link_gambar: d.link || null,
  }], 'resolution=merge-duplicates,return=minimal');
}
async function getProfile() {
  try {
    const rows = await sbGet('store_profile', { select: '*', id: 'eq.1' });
    if (rows[0]) return { nama: rows[0].nama, alamat: rows[0].alamat, kontak: rows[0].kontak, logo: rows[0].logo };
  } catch {}
  return { nama: 'Toko Cetak Custom', alamat: '-', kontak: '-', logo: '' };
}
async function saveProfile(p) {
  await sbPatch('store_profile', { id: 'eq.1' }, { nama: p.nama, alamat: p.alamat, kontak: p.kontak, logo: p.logo || '' });
}
// Antrekan WA: panel yang kirim via Baileys
async function queueWA(toWa, kind, content, caption, imageUrl) {
  const row = {
    to_wa: formatWA(toWa), kind, content, caption: caption || null, status: 'pending',
  };
  if (imageUrl) row.image_url = imageUrl;
  try {
    await sbPost('wa_outbox', [row], 'return=minimal');
    // Kirim log ke bot Telegram khusus log (jika dikonfigurasi)
    // Kirim konten asli: teks → teks, gambar → gambar, dokumen → dokumen
    try {
      const logToken = process.env.TELEGRAM_LOG_BOT_TOKEN;
      const logChatId = process.env.TELEGRAM_LOG_CHAT_ID || OWNER_ID;
      if (logToken) {
        const header = `📤 *WA terkirim*\nKe: \`${row.to_wa}\`\n${'-'.repeat(40)}`;
        if (kind === 'text') {
          await fetch(`https://api.telegram.org/bot${logToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: logChatId,
              text: header + '\n' + String(content),
              parse_mode: 'Markdown',
            }),
          }).catch(() => {});
        } else if (kind === 'image') {
          await fetch(`https://api.telegram.org/bot${logToken}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: logChatId,
              photo: content,
              caption: header + (caption ? '\n' + String(caption).slice(0, 200) : ''),
              parse_mode: 'Markdown',
            }),
          }).catch(() => {});
        } else if (kind === 'document') {
          await fetch(`https://api.telegram.org/bot${logToken}/sendDocument`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: logChatId,
              document: content,
              caption: header + (caption ? '\n' + String(caption).slice(0, 200) : ''),
              parse_mode: 'Markdown',
            }),
          }).catch(() => {});
        }
      }
    } catch (e) {}
    return true;
  } catch (e) {
    console.error('[admin] queueWA gagal:', e.message);
    return false;
  }
}
async function logActivity(aksi, detail) {
  sbPost('agent_activity', [{ kategori: 'toko', aksi, detail: String(detail || '').slice(0, 500) }], 'return=minimal').catch(() => {});
}

const MD = { parse_mode: 'Markdown' };
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const BACK_HOME = [[{ text: '🔙 Kembali', callback_data: 'home' }]];
const BACK_MAIN = [[{ text: '🔙 Menu Utama', callback_data: 'home' }]];

// ---------- MENU UTAMA (persis bot lama, plek ketiplek) ----------
async function showHome(chatId, messageId = null) {
  await clearAdminState(chatId);
  const text = `🏠 *MENU UTAMA SISTEM TOKO*`;
  const options = { ...MD, ...kb([
    [{ text: '🛍 Order WA', callback_data: 'home_order' }, { text: '🛒 Order Market', callback_data: 'home_market' }],
    [{ text: '🔍 Cek Pesanan', callback_data: 'home_cek' }, { text: '📦 Update Paket', callback_data: 'home_paket' }],
    [{ text: '📦 Kelola Produk', callback_data: 'home_produk' }, { text: '📂 Edukasi & Promo', callback_data: 'home_edukasi' }],
    [{ text: '📊 Laporan', callback_data: 'home_laporan' }, { text: '⚙️ Setting Toko', callback_data: 'home_setting' }],
    [{ text: '💸 Tarik Dana', url: 'https://payinaja.com/dashboard/withdraw' }],
  ]) };
  if (messageId) await tg.editMessageText(chatId, messageId, text, options);
  else await tg.sendMessage(chatId, text, options);
}

async function renderMassalMenu(chatId, msgId, state) {
  const keyboard = [];
  state.list.forEach((r) => {
    const isChecked = state.selected.includes(r[0]);
    keyboard.push([{ text: `${isChecked ? '✅' : '⬜️'} ${r[0]} (${r[2]})`, callback_data: `mtog_${r[0]}` }]);
  });
  keyboard.push([{ text: `🚀 Lanjut Upload Gambar (${state.selected.length} Dipilih)`, callback_data: 'massal_lanjut' }]);
  keyboard.push([{ text: '🔙 Kembali', callback_data: 'home_paket' }]);
  await tg.editMessageText(chatId, msgId,
    '📚 *PILIH PESANAN (MASSAL):*\nKlik untuk menceklis pesanan yang resinya siap diupload:',
    { ...MD, ...kb(keyboard) });
}

function renderOrderQtyMenu(chatId, messageId, count) {
  return tg.editMessageText(chatId, messageId, `🛍 *Total Produk: ${count}*`, {
    ...MD, ...kb([
      [{ text: '-', callback_data: `oqty_dec_${count}` }, { text: '📝 Generate Form', callback_data: `oqty_gen_${count}` }, { text: '+', callback_data: `oqty_inc_${count}` }],
      [{ text: '🔙 Kembali', callback_data: 'home' }],
    ]),
  });
}

// Kirim resi ke customer + update DB (dipakai beberapa alur)
async function kirimResiKeCustomer(chatId, idPesanan, fileLink, viaOCR) {
  const res = await getAllData();
  const order = res.data.slice(1).find((r) => String(r[0] || '').toUpperCase() === String(idPesanan).toUpperCase());
  if (!order) return null;
  await updateResi(idPesanan, fileLink);
  await updateStatus(idPesanan, 'Dikirim 🚚');
  const hari = getEstimasi(order[4]);
  await queueWA(order[3], 'image', fileLink,
    `🚚 *PAKET DIKIRIM (${idPesanan})*\nHalo kak! Paket sudah diserahkan ke kurir. (Otomatis selesai dlm ${hari} Hari).`);
  await logActivity('resi', `Resi dikirim ${idPesanan} (${viaOCR ? 'OCR otomatis' : 'manual'}). Estimasi ${hari} hari.`);
  return hari;
}

// ---------- CALLBACK QUERY ----------
// Semua callback dijawab (answerCallbackQuery) agar tombol tidak loading terus.
async function handleCallback(chatId, msgId, data, queryId) {
  await tg.answerCallbackQuery(queryId).catch(() => {});
  const edit = (text, extra = {}) => tg.editMessageText(chatId, msgId, text, { ...MD, ...extra });

  if (data === 'home') return showHome(chatId, msgId);

  if (data === 'home_setting') {
    const profile = await getProfile();
    const txt = `⚙️ *PENGATURAN PROFIL TOKO*\n\n🏢 *Nama:* ${profile.nama}\n📍 *Alamat:* ${profile.alamat}\n📞 *Kontak:* ${profile.kontak}\n📸 *Logo:* ${profile.logo ? '✅ Sudah Ada' : '❌ Belum Ada'}\n\nSilakan pilih menu di bawah ini:`;
    return edit(txt, kb([[{ text: '✏️ Edit Profil Toko', callback_data: 'setting_edit' }], BACK_HOME[0]]));
  }

  if (data === 'setting_edit') {
    await edit('⏳ _Menyiapkan form profil..._');
    await tg.deleteMessage(chatId, msgId);
    const profile = await getProfile();
    await setAdminState(chatId, 'edit_profil_nama', { temp: profile });
    await tg.sendMessage(chatId, `🏢 *EDIT PROFIL USAHA*\n\n📝 Kirimkan *Nama Usaha* Anda yang baru.\nSaat ini: ${profile.nama}\n_(💡 Ketik "-" jika tidak ingin mengubah ini)_`, MD);
    return true;
  }

  if (data === 'home_produk') {
    return edit('📦 *KELOLA KATALOG PRODUK*\nSilakan pilih menu di bawah ini:',
      kb([
        [{ text: '📋 Lihat Produk', callback_data: 'produk_lihat' }],
        [{ text: '➕ Tambah Produk Baru', callback_data: 'produk_tambah' }, { text: '✏️ Edit Produk', callback_data: 'produk_edit' }],
        [{ text: '🗑️ Hapus Produk', callback_data: 'produk_hapus' }],
        BACK_HOME[0],
      ]));
  }

  if (data === 'produk_tambah') {
    await edit('⏳ _Memeriksa ID Produk terakhir..._');
    let lastId = 'Belum ada produk';
    try {
      const res = await getSemuaProduk();
      if (res.success && res.data.length > 1) lastId = res.data[res.data.length - 1][0];
    } catch {}
    await tg.deleteMessage(chatId, msgId);
    await setAdminState(chatId, 'add_id', { temp: {} });
    await tg.sendMessage(chatId, `➕ *TAMBAH PRODUK BARU*\n\nSilakan ketik dan kirimkan *ID Produk* Anda.\n_(💡 Info: ID Terakhir di sheet adalah *${lastId}*)_\n\nKetik /batal jika ingin membatalkan.`, MD);
    return true;
  }

  if (data === 'produk_edit') {
    await edit('⏳ _Membuka mode Edit Produk..._');
    await tg.deleteMessage(chatId, msgId);
    await setAdminState(chatId, 'edit_find', { temp: {} });
    await tg.sendMessage(chatId, '✏️ *EDIT PRODUK*\n\nSilakan ketik dan kirimkan *ID Produk* yang ingin diedit:\n\nKetik /batal jika ingin membatalkan.', MD);
    return true;
  }

  if (data === 'home_order') return renderOrderQtyMenu(chatId, msgId, 1);
  if (data === 'home_market') {
    await tg.sendMessage(chatId, `💡 *TIPS: PINTASAN MARKETPLACE*\nKetik pesan ke bot ini dengan format:\n!\n[Nomor Resi]\n[Nomor WA]`, MD);
    return true;
  }

  if (data === 'home_cek') return edit('📋 *MENU CEK PESANAN*',
    kb([[{ text: '📊 Cek Status Massal', callback_data: 'cek_massal' }], [{ text: '🔍 Cari Detail', callback_data: 'cek_detail' }], BACK_HOME[0]]));
  if (data === 'cek_massal') return edit('🚦 *PILIH STATUS:*',
    kb([[{ text: '🔴 Belum Bayar', callback_data: 'list_Belum' }], [{ text: '⚙️ Sedang Diproses', callback_data: 'list_Diproses' }], [{ text: '🚚 Sedang Dikirim', callback_data: 'list_Dikirim' }], [{ text: '🔙 Kembali', callback_data: 'home_cek' }]]));
  if (data.startsWith('list_')) {
    const statusReq = data.split('_')[1];
    await edit('⏳ Mencari data...');
    try {
      const res = await getAllData();
      const list = res.data.slice(1).filter((r) => String(r[7] || '').includes(statusReq));
      let txt = `📋 *DAFTAR (${statusReq.toUpperCase()})*\n\n`;
      if (list.length === 0) txt += '_Tidak ada pesanan._';
      else list.slice(0, 15).forEach((r) => { txt += `• *${r[0]}* - ${r[2]}\n`; });
      return edit(txt, kb([[{ text: '🔙 Kembali', callback_data: 'cek_massal' }]]));
    } catch { return edit('❌ Gagal.'); }
  }
  if (data === 'cek_detail') {
    await setAdminState(chatId, 'input_cek', {});
    return edit('🔍 *PENCARIAN PINTAR*\nKetik *ID, No WA, atau sebagian Nama*.',
      kb([[{ text: '🔙 Batal', callback_data: 'home' }]]));
  }

  if (data === 'home_paket') {
    return edit('📦 *UPDATE PAKET*', kb([
      [{ text: '📦 Kirim Paket (Satu-satu)', callback_data: 'paket_kirim' }],
      [{ text: '📚 Kirim Paket Massal (Ceklis)', callback_data: 'paket_massal' }],
      [{ text: '⚙️ Ubah Status', callback_data: 'paket_status' }, { text: '🧾 Kirim Manual', callback_data: 'paket_resi' }],
      BACK_HOME[0],
    ]));
  }

  if (data === 'paket_kirim') {
    await edit('⏳ _Mencari pesanan yang diproses..._');
    try {
      const res = await getAllData();
      const list = res.data.slice(1).filter((r) => String(r[7] || '').includes('Diproses'));
      if (list.length === 0) {
        return edit('❌ *Kosong*\nTidak ada pesanan dengan status *Diproses* saat ini.',
          kb([[{ text: '🔙 Kembali', callback_data: 'home_paket' }]]));
      }
      const keyboard = [];
      list.slice(0, 15).forEach((r) => keyboard.push([{ text: `📦 ${r[0]} (${r[2]})`, callback_data: `sr_${r[0]}` }]));
      keyboard.push([{ text: '🔙 Kembali', callback_data: 'home_paket' }]);
      return edit('📦 *PILIH PESANAN UNTUK DIKIRIM:*\n_(Maksimal menampilkan 15 antrean)_', kb(keyboard));
    } catch (e) { return edit(`❌ *Terjadi Error:* ${e.message}`); }
  }

  if (data === 'paket_massal') {
    await edit('⏳ _Mencari data pesanan..._');
    try {
      const res = await getAllData();
      const list = res.data.slice(1).filter((r) => String(r[7] || '').includes('Diproses'));
      if (list.length === 0) {
        return edit('❌ *Kosong*\nTidak ada pesanan untuk dikirim.',
          kb([[{ text: '🔙 Kembali', callback_data: 'home_paket' }]]));
      }
      const st = { step: 'massal_select', list: list.slice(0, 15), selected: [] };
      await setAdminState(chatId, 'massal_select', st);
      return renderMassalMenu(chatId, msgId, st);
    } catch (e) { return edit(`❌ Error: ${e.message}`); }
  }

  if (data.startsWith('mtog_')) {
    const idPesanan = data.split('_')[1];
    const st = await getAdminState(chatId);
    if (!st || st.step !== 'massal_select') {
      await tg.answerCallbackQuery(queryId, { text: 'Sesi habis, ulangi dari menu.' });
      return true;
    }
    const d = st.data || { selected: [], list: [] };
    if (d.selected.includes(idPesanan)) d.selected = d.selected.filter((id) => id !== idPesanan);
    else d.selected.push(idPesanan);
    await setAdminState(chatId, 'massal_select', d);
    return renderMassalMenu(chatId, msgId, d);
  }

  if (data === 'massal_lanjut') {
    const st = await getAdminState(chatId);
    const d = (st && st.data) || { selected: [] };
    if (!d.selected || d.selected.length === 0) {
      await tg.answerCallbackQuery(queryId, { text: '❌ Pilih minimal 1 resi!', show_alert: true });
      return true;
    }
    await setAdminState(chatId, 'massal_upload', d);
    return edit(`📸 *UPLOAD RESI MASSAL*\n\nAnda telah memilih *${d.selected.length} pesanan*. \nSilakan upload (kirim) foto-foto resi sekaligus sebagai album di obrolan ini.\n\nAI akan mencocokkannya satu per satu.\n\nKetik /batal jika ingin berhenti.`);
  }

  if (data.startsWith('sr_')) {
    const idPesanan = data.split('_')[1];
    await setAdminState(chatId, 'upload_resi_btn', { temp: { id: idPesanan } });
    return edit(`📸 *KIRIM RESI KEPADA PELANGGAN*\n\nPesanan Terpilih: *${idPesanan}*\n\nSilakan *Upload Foto Resi* ke obrolan ini sekarang.\n_(Anda tidak perlu mengetik caption apa-apa lagi)_`,
      kb([[{ text: '🔙 Batal', callback_data: 'paket_kirim' }]]));
  }

  if (data === 'paket_status') {
    await setAdminState(chatId, 'input_paket_status', {});
    return edit('⚙️ *UBAH STATUS*\nKetik *ID Pesanan*.', kb([[{ text: '🔙 Batal', callback_data: 'home' }]]));
  }
  if (data === 'paket_resi') {
    await setAdminState(chatId, 'input_paket_resi', {});
    return edit('🧾 *KIRIM BUKTI PENGIRIMAN (Ketik ID)*\nSilakan *Upload Foto Resi* dan ketik *ID Pesanan* di bagian Caption foto.',
      kb([[{ text: '🔙 Batal', callback_data: 'home' }]]));
  }

  if (data === 'home_laporan') return edit('📊 *LAPORAN PENJUALAN*\n(Bisa di-Export ke CSV/Excel)',
    kb([[{ text: '📅 7 Hari Terakhir', callback_data: 'lap_7' }, { text: '📅 30 Hari Terakhir', callback_data: 'lap_30' }], BACK_HOME[0]]));
  if (data === 'lap_7' || data === 'lap_30') {
    await buatLaporan(chatId, parseInt(data.split('_')[1], 10));
    return true;
  }

  if (data === 'home_edukasi') return edit('📂 *KIRIM EDUKASI/FORM*', kb([
    [{ text: '📝 Form Kwitansi', callback_data: 'edu_kwi' }, { text: '📝 Form Nota', callback_data: 'edu_not' }],
    [{ text: '📦 Kirim Produk Katalog', callback_data: 'edu_prod' }],
    BACK_HOME[0],
  ]));

  if (data === 'edu_kwi' || data === 'edu_not' || data === 'edu_prod') {
    await setAdminState(chatId, `input_wa_edu_${data.split('_')[1]}`, {});
    return edit('📱 Ketik *Nomor WA* pelanggan tujuan:');
  }

  if (data.startsWith('setstatus_')) {
    const parts = data.split('_');
    const idPesanan = parts[1]; const statusBaru = parts[2]; const wa = parts[3];
    await updateStatus(idPesanan, statusBaru);
    let txt = `📦 *UPDATE PESANAN (${idPesanan})*\nHalo kak! Pesanan kakak saat ini `;
    if (statusBaru === 'Dikirim') txt += 'sedang *DIKIRIM* 🚚';
    else if (statusBaru === 'Diproses') txt += 'sedang *DIPROSES* ⚙️';
    else txt += 'sudah *SELESAI* 🥰';
    await queueWA(wa, 'text', txt);
    await logActivity('status', `Status ${idPesanan} → ${statusBaru} oleh admin.`);
    return edit(`✅ Status diubah menjadi ${statusBaru}`);
  }

  // ===== FITUR ADMIN: Dashboard omset (via perintah /dashboard) =====
  if (data === 'home_dashboard') {
    await handleDashboard(chatId, msgId);
    return true;
  }

  // ===== FITUR ADMIN: Keuangan (via perintah /keluar, /rekap, /export) =====
  if (data === 'home_keuangan') {
    return edit('💸 *KEUANGAN TOKO*\n\nCatat pengeluaran: `/keluar 50000 beli tinta`\n_(bisa juga pakai | : `/keluar 25000|parkir`)_',
      kb([
        [{ text: '📝 Rekap Pengeluaran', callback_data: 'keu_rekap' }],
        [{ text: '📥 Export Data', callback_data: 'keu_export' }],
        BACK_HOME[0],
      ]));
  }
  if (data === 'keu_rekap') {
    await handleRekap(chatId, msgId);
    return true;
  }
  if (data === 'keu_export') {
    return edit('📥 *EXPORT DATA*\nPilih data yang mau di-export ke CSV (bisa dibuka di Excel):',
      kb([
        [{ text: '🛍️ Order', callback_data: 'exp_orders' }],
        [{ text: '📦 Produk', callback_data: 'exp_products' }],
        [{ text: '👥 Customer', callback_data: 'exp_customers' }],
        [{ text: '🔙 Kembali', callback_data: 'home_keuangan' }],
      ]));
  }
  if (data === 'exp_orders' || data === 'exp_products' || data === 'exp_customers') {
    await handleExport(chatId, data.split('_')[1]);
    return true;
  }

  // ===== FITUR ADMIN: Lihat & hapus produk =====
  if (data === 'produk_lihat') {
    try {
      const prods = await sbGet('products', { select: 'id,nama,harga,stok', order: 'id', limit: 100 });
      if (!prods.length) return edit('📦 Katalog kosong.', kb([BACK_HOME[0]]));
      const lines = prods.map((p) => `• *${p.id}* — ${p.nama}\n  ${rp(p.harga)} | stok: ${p.stok ?? 0}`);
      return edit(`📋 *DAFTAR PRODUK (${prods.length})*\n\n${lines.join('\n')}`, kb([BACK_HOME[0]]));
    } catch (e) { return edit(`❌ Gagal: ${e.message}`, kb([BACK_HOME[0]])); }
  }
  if (data === 'produk_hapus') {
    await tg.deleteMessage(chatId, msgId).catch(() => {});
    await setAdminState(chatId, 'prod_del_find', {});
    await tg.sendMessage(chatId, '🗑️ *HAPUS PRODUK*\n\nKetik *ID produk* yang mau dihapus:\n\nKetik /batal untuk membatalkan.', MD);
    return true;
  }
  if (data.startsWith('produk_del_ya_')) {
    const pid = data.replace('produk_del_ya_', '');
    try {
      await sbDel('products', { id: `eq.${pid}` });
      await logActivity('produk', `Produk ${pid} dihapus.`);
      return edit(`✅ Produk *${pid}* dihapus dari katalog.`, kb([[{ text: '🔙 Kelola Produk', callback_data: 'home_produk' }]]));
    } catch (e) { return edit(`❌ Gagal hapus: ${e.message}`, kb([[{ text: '🔙 Kelola Produk', callback_data: 'home_produk' }]])); }
  }
  if (data === 'produk_del_batal') {
    return edit('🚫 Hapus produk dibatalkan.', kb([[{ text: '🔙 Kelola Produk', callback_data: 'home_produk' }]]));
  }

  // Order WA: template order generator (➖/➕ jumlah produk → Generate Form)
  if (data.startsWith('oqty_')) {
    const parts = data.split('_'); const action = parts[1]; let count = parseInt(parts[2], 10);
    if (action === 'dec' && count > 1) count--;
    if (action === 'inc') count++;
    if (action === 'gen') {
      let txt = `📋 *TEMPLATE ORDER*\nNama Penerima: \nNomor wa Penerima: \nAlamat lengkap: \n`;
      for (let i = 0; i < count; i++) txt += `Detail Pesanan ${i + 1}\nNama Produk: \nqty: \nHarga satuan: \n`;
      await tg.sendMessage(chatId, txt, MD);
      return true;
    }
    return renderOrderQtyMenu(chatId, msgId, count);
  }
}

// ---------- LAPORAN: 7 / 30 hari terakhir (omset + jumlah order per status) + CSV ----------
async function buatLaporan(chatId, rentangHari) {
  await tg.sendMessage(chatId, '⏳ Merekap data...', MD);
  try {
    const cutoff = new Date(Date.now() - rentangHari * 24 * 3600 * 1000).toISOString();
    const orders = await sbGet('orders', {
      select: 'id,tanggal,nama_penerima,nomor_wa,total_harga,status',
      tanggal: `gte.${cutoff}`, order: 'tanggal.desc', limit: 2000,
    });
    const valid = orders.filter((o) => o.status !== 'batal');
    const sum = (list) => list.reduce((a, o) => a + Number(o.total_harga || 0), 0);
    const cnt = (s) => orders.filter((o) => o.status === s).length;
    const omset = sum(valid);
    const txt =
      `📊 *LAPORAN ${rentangHari} HARI TERAKHIR*\n\n` +
      `💰 *Omset:* ${rp(omset)} (${valid.length} order)\n\n` +
      `🚦 *Jumlah order per status:*\n` +
      `🔴 Belum bayar: ${cnt('pending')}\n` +
      `⚙️ Diproses: ${cnt('diproses')}\n` +
      `🚚 Dikirim: ${cnt('dikirim')}\n` +
      `🥰 Selesai: ${cnt('selesai')}\n` +
      `❌ Batal: ${cnt('batal')}`;
    await tg.sendMessage(chatId, txt, MD);
    // CSV detail (tanpa yang batal)
    let csv = 'ID Pesanan,Tanggal,Nama,No WA,Total Tagihan,Status\n';
    valid.forEach((o) => {
      csv += [o.id, fmtTgl(o.tanggal), o.nama_penerima, o.nomor_wa, o.total_harga, dispStatus(o.status)]
        .map(csvEsc).join(',') + '\n';
    });
    await tg.sendDocument(chatId, Buffer.from(csv, 'utf8'), `Laporan_${rentangHari}hari_${Date.now()}.csv`, `📊 Detail laporan ${rentangHari} hari terakhir`);
    await logActivity('laporan', `Laporan ${rentangHari} hari dikirim ke admin.`);
  } catch (e) {
    await tg.sendMessage(chatId, `❌ Gagal membuat laporan: ${e.message}`);
  }
}

// ---------- PESAN ADMIN (state flows) ----------
// Return: null = tidak di-handle (lanjut ke AI); true = sudah di-handle & terkirim.
async function handleMessage(chatId, msg) {
  const text = msg.caption || msg.text || '';
  const hasPhoto = !!(msg.photo && msg.photo.length);

  // /batal kapan saja saat ada state
  if (text === '/batal') {
    const st = await getAdminState(chatId);
    if (st) {
      await clearAdminState(chatId);
      await tg.sendMessage(chatId, '🚫 *Proses Dibatalkan.* Silakan kembali menggunakan /menu.', MD);
      return true;
    }
    return null; // bukan dalam alur admin → biarkan asisten yang tangani
  }

  const st = await getAdminState(chatId);
  if (!st) {
    // ===== PERCAKAPAN: edit/hapus/status massal =====
    if (/^(edit|hapus|status|ubah)\s+massal$/i.test(text.trim())) {
      const aksi = text.trim().toLowerCase().split(' ')[0];
      await setAdminState(chatId, 'massal_ids', { aksi });
      await tg.sendMessage(chatId,
        `📝 *${aksi.toUpperCase()} MASSAL*\n\nKirim ID order (pisahkan koma):\nContoh: \`INV-100300, INV-100301\``, MD);
      return true;
    }

    // ===== FITUR JUALAN: /invoice =====
    const invMatch = text.match(/^\/invoice\s+(INV-\d{6})/i);
    if (invMatch) {
      await handleInvoice(chatId, invMatch[1].toUpperCase());
      return true;
    }

    // ===== HAPUS MASSAL: /hapusmassal INV-001,INV-002 YA =====
    const hapusMassalMatch = text.match(/^\/hapusmassal\s+([INV\-\d,\s]+)(\s+YA)?/i);
    if (hapusMassalMatch) {
      const ids = hapusMassalMatch[1].toUpperCase().match(/INV-\d{6}/g) || [];
      const confirmed = !!hapusMassalMatch[2];
      if (!ids.length) {
        await tg.sendMessage(chatId, '❌ Format: `/hapusmassal INV-001,INV-002 YA`', MD);
        return true;
      }
      if (!confirmed) {
        await tg.sendMessage(chatId,
          `⚠️ *HAPUS ${ids.length} ORDER?*\n\n${ids.join('\n')}\n\nKetik \`/hapusmassal ${ids.join(',')} YA\` untuk hapus permanen.`, MD);
        return true;
      }
      let ok = 0;
      for (const id of ids) {
        try {
          await sbDel('order_items', `order_id=eq.${id}`);
          await sbDel('orders', `id=eq.${id}`);
          ok++;
        } catch (e) {}
      }
      await tg.sendMessage(chatId, `✅ ${ok}/${ids.length} order dihapus.`, MD);
      await logActivity('hapusmassal', `${ok} order dihapus via /hapusmassal.`);
      return true;
    }

    // ===== STATUS MASSAL: /statusmassal dikirim INV-001,INV-002 =====
    const statusMassalMatch = text.match(/^\/statusmassal\s+(pending|diproses|dikirim|selesai|batal)\s+([INV\-\d,\s]+)/i);
    if (statusMassalMatch) {
      const newStatus = statusMassalMatch[1].toLowerCase();
      const ids = statusMassalMatch[2].toUpperCase().match(/INV-\d{6}/g) || [];
      if (!ids.length) {
        await tg.sendMessage(chatId, '❌ Format: `/statusmassal dikirim INV-001,INV-002`', MD);
        return true;
      }
      let ok = 0;
      for (const id of ids) {
        try {
          await sbPatch('orders', `id=eq.${id}`, { status: newStatus });
          ok++;
        } catch (e) {}
      }
      await tg.sendMessage(chatId, `✅ ${ok}/${ids.length} order → *${newStatus}*.`, MD);
      await logActivity('statusmassal', `${ok} order → ${newStatus} via /statusmassal.`);
      return true;
    }

    // ===== HAPUS ORDER (konfirmasi YA) — hapus order_items dulu, baru orders =====
    const hapusMatch = text.match(/^\/hapus\s+(INV-\d{6})(\s+YA)?/i);
    if (hapusMatch) {
      const delId = hapusMatch[1].toUpperCase();
      const confirmed = !!hapusMatch[2];
      if (!confirmed) {
        const rows = await sbGet('orders', { select: 'id,nama_penerima,total_harga,status', id: `eq.${delId}`, limit: 1 }).catch(() => []);
        if (!rows[0]) {
          await tg.sendMessage(chatId, `❌ Order *${delId}* tidak ditemukan.`, MD);
          return true;
        }
        const o = rows[0];
        await tg.sendMessage(chatId,
          `⚠️ *HAPUS ORDER?*\n\nID: ${o.id}\nCustomer: ${o.nama_penerima}\nTotal: Rp ${Number(o.total_harga || 0).toLocaleString('id-ID')}\nStatus: ${o.status}\n\nKetik \`/hapus ${delId} YA\` untuk hapus permanen.`,
          MD);
        return true;
      }
      await sbDel('order_items', { order_id: `eq.${delId}` }).catch(() => {});
      await sbDel('orders', { id: `eq.${delId}` }).catch(() => {});
      await logActivity('hapus', `Order ${delId} dihapus via /hapus.`);
      await tg.sendMessage(chatId, `✅ Order *${delId}* dihapus.`, MD);
      return true;
    }

    // ===== FITUR JUALAN: /broadcast =====
    if (text.startsWith('/broadcast ')) {
      const pesan = text.substring(11).trim();
      if (!pesan) {
        await tg.sendMessage(chatId, '❌ Format: `/broadcast <pesan>`', MD);
        return true;
      }
      await handleBroadcastConfirm(chatId, pesan);
      return true;
    }

    // ===== FITUR ADMIN: /dashboard =====
    if (text === '/dashboard') {
      await handleDashboard(chatId);
      return true;
    }

    // ===== FITUR ADMIN: /keluar =====
    if (text.startsWith('/keluar')) {
      await handleKeluar(chatId, text);
      return true;
    }

    // ===== FITUR ADMIN: /rekap =====
    if (text === '/rekap') {
      await handleRekap(chatId);
      return true;
    }

    // ===== FITUR ADMIN: /export =====
    if (text === '/export') {
      await tg.sendMessage(chatId, '📥 *EXPORT DATA*\nPilih data yang mau di-export ke CSV (bisa dibuka di Excel):',
        { ...MD, ...kb([
          [{ text: '🛍️ Order', callback_data: 'exp_orders' }],
          [{ text: '📦 Produk', callback_data: 'exp_products' }],
          [{ text: '👥 Customer', callback_data: 'exp_customers' }],
        ]) });
      return true;
    }

    // ===== FITUR JUALAN: foto + caption /kirim =====
    if (hasPhoto && /^\/kirim\s+/i.test(text)) {
      await handleKirimGambar(chatId, msg, text);
      return true;
    }

    // Foto tanpa state → OCR resi otomatis (seperti bot lama)
    if (hasPhoto) {
      await handleFotoOtomatis(chatId, msg, text);
      return true;
    }
    // ===== PRODUK DIGITAL: perintah chat (tanpa tombol) =====
    if (/^tambah produk digital$/i.test(text)) {
      await setAdminState(chatId, 'dig_nama', {});
      await tg.sendMessage(chatId, '🆕 *TAMBAH PRODUK DIGITAL*\nNama produknya apa?', MD);
      return true;
    }
    let mDig = text.match(/^tambah stok\s+(.+)$/i);
    if (mDig) {
      const { product, ambiguous } = await digital.matchDigital(mDig[1]).catch(() => ({ product: null, ambiguous: [] }));
      if (ambiguous.length) {
        await tg.sendMessage(chatId, 'Ada beberapa produk mirip:\n' + ambiguous.map((p) => `• \`${p.id}\` ${p.nama}`).join('\n') + '\n\nPakai kodenya ya, contoh: `tambah stok cc1b`', MD);
        return true;
      }
      if (!product) {
        await tg.sendMessage(chatId, `❌ Produk digital "${mDig[1]}" tidak ditemukan. Ketik "stok digital" untuk lihat daftar produk.`, MD);
        return true;
      }
      await setAdminState(chatId, 'dig_stok', { produk_id: product.id });
      const pakaiDua = /\{ISI2\}/.test(product.template_kirim || '');
      await tg.sendMessage(chatId, `📥 *TAMBAH STOK ${product.id}* — ${product.nama}\nKirim stoknya, 1 baris = 1 item.${pakaiDua ? '\nFormat: email | password' : '\nFormat: 1 link per baris'}`, MD);
      return true;
    }
    if (/^stok digital$/i.test(text)) {
      const prods = await digital.getDigitalProducts().catch(() => []);
      if (!prods.length) {
        await tg.sendMessage(chatId, 'Belum ada produk digital. Ketik "tambah produk digital" untuk membuat.', MD);
        return true;
      }
      let msgStok = '📦 *STOK PRODUK DIGITAL*';
      for (const p of prods) {
        const n = await digital.countStock(p.id).catch(() => 0);
        msgStok += `\n• \`${p.id}\` ${p.nama} — stok: *${n}*`;
      }
      await tg.sendMessage(chatId, msgStok, MD);
      return true;
    }
    mDig = text.match(/^stok\s+(.+)$/i);
    if (mDig) {
      const { product, ambiguous } = await digital.matchDigital(mDig[1]).catch(() => ({ product: null, ambiguous: [] }));
      if (ambiguous.length) {
        await tg.sendMessage(chatId, 'Ada beberapa produk mirip:\n' + ambiguous.map((p) => `• \`${p.id}\` ${p.nama}`).join('\n') + '\n\nPakai kodenya ya.', MD);
        return true;
      }
      if (!product) {
        await tg.sendMessage(chatId, `❌ Produk digital "${mDig[1]}" tidak ditemukan.`, MD);
        return true;
      }
      const n = await digital.countStock(product.id).catch(() => 0);
      await tg.sendMessage(chatId, `📦 \`${product.id}\` ${product.nama}\nStok tersedia: *${n}*`, MD);
      return true;
    }
    mDig = text.match(/^edit template\s+(.+)$/i);
    if (mDig) {
      const { product, ambiguous } = await digital.matchDigital(mDig[1]).catch(() => ({ product: null, ambiguous: [] }));
      if (ambiguous.length) {
        await tg.sendMessage(chatId, 'Ada beberapa produk mirip:\n' + ambiguous.map((p) => `• \`${p.id}\` ${p.nama}`).join('\n') + '\n\nPakai kodenya ya.', MD);
        return true;
      }
      if (!product) {
        await tg.sendMessage(chatId, `❌ Produk digital "${mDig[1]}" tidak ditemukan.`, MD);
        return true;
      }
      await setAdminState(chatId, 'dig_template_edit', { produk_id: product.id });
      await tg.sendMessage(chatId, `✏️ *EDIT TEMPLATE ${product.id}*\nTemplate saat ini:\n\n${product.template_kirim || '(kosong)'}\n\nKirim template barunya (utuh). Jaga penanda {ISI} / {ISI2}.`, MD);
      return true;
    }

    // Perintah cepat marketplace: !\n[resi]\n[wa]
    if (text.startsWith('!')) {
      const r = await handleMarketplace(chatId, text);
      return r === null ? null : true;
    }
    // Template order terisi
    if (text.includes('TEMPLATE ORDER') || text.includes('FORM PEMESANAN')) {
      await handleTemplateOrder(chatId, text);
      return true;
    }

    // ===== FITUR JUALAN: kirim PDF/invoice ke customer (bahasa natural) =====
    // Cth: "bisakah kamu kirimkan ke customer format pdf?", "kirim invoice ke wa customer", "generate pdf"
    if (/kirim.*(pdf|invoice|struk|nota|kwitansi)|(pdf|invoice|struk|nota|kwitansi).*(kirim|customer|pelanggan)|generate.*(pdf|invoice|struk)|(pdf|invoice|struk).*(generate)/i.test(text)) {
      let orderId = (text.match(/INV-\d{6}/i) || [])[0];
      if (!orderId) {
        const st2 = await getAdminState(chatId).catch(() => null);
        orderId = st2?.data?.lastOrderId || null;
      }
      if (!orderId) {
        await tg.sendMessage(chatId,
          '📄 *Kirim PDF ke customer*\n\nNomor pesanannya yang mana? (cth: `INV-123456`)', MD);
        return true;
      }
      await handleInvoiceToWA(chatId, orderId.toUpperCase());
      return true;
    }

    // ===== Minta form/template order via bahasa natural =====
    // Cth: "minta formnya", "ada yang mau pesan 2 produk minta form"
    // Template diambil dari database (tabel templates), bisa diedit via Supabase
    const formMatch = text.match(/minta\s+(form|template|formulir)|form.*pesan|template.*order/i);
    if (formMatch) {
      // Cari angka jumlah produk (default 1)
      const numMatch = text.match(/(\d+)\s*(produk|item|pesanan)/i);
      const count = numMatch ? Math.min(10, Math.max(1, parseInt(numMatch[1], 10))) : 1;
      // Ambil template dari database
      let template = null;
      try {
        const rows = await sbGet('templates', { select: 'isi', id: 'eq.order_form', limit: 1 });
        if (rows[0]) template = rows[0].isi;
      } catch (e) { console.error('[template] gagal ambil:', e.message); }
      // Fallback jika tabel belum ada
      if (!template) {
        template = `📋 *TEMPLATE ORDER*\nNama Penerima: \nNomor wa Penerima: \nAlamat lengkap: \nDetail Pesanan 1\nNama Produk: \nqty: \nHarga satuan: `;
      }
      // Jika minta >1 produk, duplikat bagian detail
      let txt = template;
      if (count > 1) {
        const detailRe = /Detail Pesanan \d+\nNama Produk: \nqty: \nHarga satuan: */;
        const m = template.match(detailRe);
        if (m) {
          for (let i = 2; i <= count; i++) {
            txt += `\nDetail Pesanan ${i}\nNama Produk: \nqty: \nHarga satuan: `;
          }
        } else {
          // Fallback: tambah manual jika format beda
          for (let i = 2; i <= count; i++) {
            txt += `\nDetail Pesanan ${i}\nNama Produk: \nqty: \nHarga satuan: `;
          }
        }
      }
      txt += `\n\n_Salin, isi, lalu kirim kembali ke sini._`;
      await tg.sendMessage(chatId, txt, MD);
      return true;
    }

    return null; // teks bebas → asisten AI
  }

  const step = st.step;
  const d = st.data || {};
  const input = text.trim();

  // --- FITUR JUALAN: Konfirmasi broadcast ---
  if (step === 'broadcast_confirm') {
    if (/^(ya|iya|oke|ok|lanjut|kirim)$/i.test(input)) {
      await handleBroadcastExec(chatId, d.pesan || '');
    }

  // --- PRODUK DIGITAL: tambah produk (berjenjang) ---
  if (step === 'dig_nama') {
    await setAdminState(chatId, 'dig_kode', { nama: input });
    await tg.sendMessage(chatId, 'Kode produknya apa? (pendek, huruf kecil, tanpa spasi — contoh: ccp1)', MD);
    return true;
  }
  if (step === 'dig_kode') {
    const kode = input.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!kode) { await tg.sendMessage(chatId, '❌ Kode tidak valid. Coba lagi:', MD); return true; }
    const semuaId = await sbGet('products', { select: 'id' }).catch(() => []);
    const ada = semuaId.some((p) => String(p.id).toUpperCase() === kode.toUpperCase());
    if (ada) { await tg.sendMessage(chatId, `❌ Kode ${kode} sudah dipakai produk lain. Kirim kode lain:`, MD); return true; }
    await setAdminState(chatId, 'dig_harga', { ...d, kode });
    await tg.sendMessage(chatId, 'Harganya berapa? (angka saja, contoh: 15000)', MD);
    return true;
  }
  if (step === 'dig_harga') {
    const hrgD = parseInt(input.replace(/[^0-9]/g, ''), 10) || 0;
    await setAdminState(chatId, 'dig_durasi', { ...d, hrg: hrgD });
    await tg.sendMessage(chatId, 'Masa aktifnya berapa hari? (contoh: 30 — ketik 0 bila tanpa batas)', MD);
    return true;
  }
  if (step === 'dig_durasi') {
    const durD = parseInt(input.replace(/[^0-9]/g, ''), 10) || 0;
    await setAdminState(chatId, 'dig_garansi', { ...d, durasi: durD });
    await tg.sendMessage(chatId, 'Garansinya berapa hari? (ketik 0 bila tanpa garansi)', MD);
    return true;
  }
  if (step === 'dig_garansi') {
    const garD = parseInt(input.replace(/[^0-9]/g, ''), 10) || 0;
    await setAdminState(chatId, 'dig_template', { ...d, garansi: garD });
    await tg.sendMessage(chatId, 'Terakhir — kirim template pengirimannya.\nPakai {ISI} untuk link/email dan {ISI2} untuk password.', MD);
    return true;
  }
  if (step === 'dig_template') {
    try {
      await sbPost('products', [{
        id: d.kode, nama: d.nama, kategori: 'Digital', deskripsi: '', harga: d.hrg || 0,
        stok: 0, link_gambar: null, tipe: 'digital', template_kirim: input,
        durasi_hari: d.durasi || 0, garansi_hari: d.garansi || 0,
      }], 'resolution=merge-duplicates,return=minimal');
      await clearAdminState(chatId);
      await tg.sendMessage(chatId, `✅ Produk digital *${d.nama}* (\`${d.kode}\`) ditambahkan.\nStok masih 0 — ketik "tambah stok ${String(d.kode).toLowerCase()}" untuk isi stok.`, MD);
    } catch (e) {
      await tg.sendMessage(chatId, '❌ Gagal menyimpan produk: ' + e.message, MD);
    }
    return true;
  }
  // --- PRODUK DIGITAL: input stok ---
  if (step === 'dig_stok') {
    const entries = input.split('\n').map((s) => s.trim()).filter(Boolean)
      .map((ln) => { const parts = ln.split('|').map((s) => s.trim()); return { isi: parts[0], isi2: parts[1] || '' }; })
      .filter((e) => e.isi);
    if (!entries.length) { await tg.sendMessage(chatId, '❌ Tidak ada stok terbaca. Kirim ulang, 1 baris = 1 item.', MD); return true; }
    try {
      const { added, dupes } = await digital.addStock(d.produk_id, entries);
      const sisa = await digital.countStock(d.produk_id);
      await clearAdminState(chatId);
      await tg.sendMessage(chatId, `✅ ${added} stok ditambahkan${dupes ? ` (${dupes} duplikat dilewati)` : ''}.\nStok \`${d.produk_id}\` sekarang: *${sisa}*`, MD);
    } catch (e) {
      await tg.sendMessage(chatId, '❌ Gagal menyimpan stok: ' + e.message, MD);
    }
    return true;
  }
  // --- PRODUK DIGITAL: edit template ---
  if (step === 'dig_template_edit') {
    try {
      await sbPatch('products', { id: `eq.${d.produk_id}` }, { template_kirim: input });
      await clearAdminState(chatId);
      await tg.sendMessage(chatId, `✅ Template \`${d.produk_id}\` diperbarui.`, MD);
    } catch (e) {
      await tg.sendMessage(chatId, '❌ Gagal memperbarui template: ' + e.message, MD);
    }
    return true;
  }

  // --- MASSAL: input IDs ---
  if (step === 'massal_ids') {
    const ids = input.toUpperCase().match(/INV-\d{6}/g) || [];
    if (!ids.length) {
      await tg.sendMessage(chatId, '❌ Tidak ada ID valid. Contoh: `INV-100300, INV-100301`', MD);
      return true;
    }
    const aksi = d.aksi;
    if (aksi === 'hapus') {
      await setAdminState(chatId, 'massal_confirm', { aksi, ids });
      await tg.sendMessage(chatId,
        `⚠️ *HAPUS ${ids.length} ORDER?*\n\n${ids.map(id => `\`${id}\``).join('\n')}\n\nKetik *YA* untuk hapus permanen.`, MD);
    } else {
      await setAdminState(chatId, 'massal_status', { aksi, ids });
      await tg.sendMessage(chatId,
        `📝 ${ids.length} order dipilih.\n\nStatus baru? (pending/diproses/dikirim/selesai/batal)`, MD);
    }
    return true;
  }

  // --- MASSAL: input status baru ---
  if (step === 'massal_status') {
    const newStatus = input.toLowerCase();
    if (!/^(pending|diproses|dikirim|selesai|batal)$/.test(newStatus)) {
      await tg.sendMessage(chatId, '❌ Status tidak valid. Pilih: pending/diproses/dikirim/selesai/batal', MD);
      return true;
    }
    const ids = d.ids || [];
    let ok = 0;
    for (const id of ids) {
      try { await sbPatch('orders', `id=eq.${id}`, { status: newStatus }); ok++; } catch (e) {}
    }
    await clearAdminState(chatId);
    await tg.sendMessage(chatId, `✅ ${ok}/${ids.length} order → *${newStatus}*.`, MD);
    await logActivity('statusmassal', `${ok} order → ${newStatus} via percakapan.`);
    return true;
  }

  // --- MASSAL: konfirmasi hapus ---
  if (step === 'massal_confirm') {
    if (/^(ya|iya|oke|ok)$/i.test(input)) {
      const ids = d.ids || [];
      let ok = 0;
      for (const id of ids) {
        try {
          await sbDel('order_items', `order_id=eq.${id}`);
          await sbDel('orders', `id=eq.${id}`);
          ok++;
        } catch (e) {}
      }
      await tg.sendMessage(chatId, `✅ ${ok}/${ids.length} order dihapus.`, MD);
      await logActivity('hapusmassal', `${ok} order dihapus via percakapan.`);
    } else {
      await tg.sendMessage(chatId, '🚫 Dibatalkan.', MD);
    }
    await clearAdminState(chatId);
    return true;
  } else {
      await clearAdminState(chatId);
      await tg.sendMessage(chatId, '🚫 *Broadcast dibatalkan.*', MD);
    }
    return true;
  }

  // --- Upload resi massal (OCR) ---
  if (step === 'massal_upload') {
    if (!hasPhoto) {
      await tg.sendMessage(chatId, '❌ Harap kirimkan foto resi.');
      return true;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await tg.sendMessage(chatId, '⏳ _Menganalisis gambar dengan AI..._', { ...MD, reply_to_message_id: msg.message_id });
    const fileUrl = await tg.getFileUrl(fileId).catch(() => null);
    const ocr = fileUrl ? await ocrImage(fileUrl) : { ok: false };
    if (!ocr.ok) {
      await tg.sendMessage(chatId, '❌ *GAGAL:* Gambar tidak terbaca oleh AI.', MD);
      return true;
    }
    const ocrText = ocr.text.toUpperCase();
    const matchId = (d.selected || []).find((id) => ocrText.includes(String(id).toUpperCase()));
    if (!matchId) {
      await tg.sendMessage(chatId, '❌ *TIDAK COCOK:* AI salah baca atau nomor tidak ada di ceklistan.', MD);
      return true;
    }
    const hari = await kirimResiKeCustomer(chatId, matchId, fileUrl, true);
    d.selected = (d.selected || []).filter((id) => id !== matchId);
    if (d.selected.length === 0) {
      await clearAdminState(chatId);
      await tg.sendMessage(chatId, '🎉 *SEMUA RESI MASSAL TELAH TERKIRIM!*', { ...MD, ...kb([[{ text: '🔙 Kembali ke Menu Utama', callback_data: 'home' }]]) });
      return true;
    }
    await setAdminState(chatId, 'massal_upload', d);
    await tg.sendMessage(chatId, `✅ *BERHASIL: Resi ${matchId} terkirim!* Timer: ${hari} Hari. Sisa: ${d.selected.length}`, MD);
    return true;
  }

  // --- Upload resi satu-satu (tombol) ---
  if (step === 'upload_resi_btn') {
    if (!hasPhoto) {
      await tg.sendMessage(chatId, '❌ Harap *Upload Foto* resi, bukan teks.', MD);
      return true;
    }
    const idPesanan = d.temp && d.temp.id;
    const wait = await tg.sendMessage(chatId, `⏳ _Mengirim resi untuk ${idPesanan}..._`, MD);
    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await tg.getFileUrl(fileId);
      const hari = await kirimResiKeCustomer(chatId, idPesanan, fileLink, false);
      if (hari === null) {
        await tg.editMessageText(chatId, wait.message_id, `❌ ID Pesanan *${idPesanan}* tidak ditemukan di database.`, MD);
      } else {
        await tg.editMessageText(chatId, wait.message_id,
          `✅ *SUKSES*\nResi terkirim untuk *${idPesanan}*. Timer: ${hari} Hari`,
          { ...MD, ...kb(BACK_MAIN) });
      }
    } catch (e) { await tg.editMessageText(chatId, wait.message_id, `❌ *Gagal:* ${e.message}`, MD); }
    await clearAdminState(chatId);
    return true;
  }

  // --- Kirim resi manual (foto + caption ID) ---
  if (step === 'input_paket_resi') {
    if (!hasPhoto) {
      await tg.sendMessage(chatId, '❌ Harap *Upload Foto* dan ketik ID di Caption, bukan hanya mengirim teks.', MD);
      return true;
    }
    if (!text) {
      await tg.sendMessage(chatId, "❌ Anda lupa mengetik ID Pesanan di Caption Foto. Silakan klik menu kembali dan ulangi.");
      return true;
    }
    const idPesanan = text.toUpperCase();
    const wait = await tg.sendMessage(chatId, '⏳ _Mengirim resi manual..._', MD);
    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await tg.getFileUrl(fileId);
      const hari = await kirimResiKeCustomer(chatId, idPesanan, fileLink, false);
      if (hari === null) await tg.editMessageText(chatId, wait.message_id, `❌ ID Pesanan *${idPesanan}* tidak ditemukan di database.`, MD);
      else await tg.editMessageText(chatId, wait.message_id, `✅ *SUKSES*\nResi manual terkirim. Timer: ${hari} Hari`, MD);
    } catch (e) { await tg.editMessageText(chatId, wait.message_id, `❌ *Gagal:* ${e.message}`, MD); }
    await clearAdminState(chatId);
    return true;
  }

  // --- Edit profil toko (Setting Toko → tabel store_profile) ---
  if (step === 'edit_profil_nama') {
    if (input !== '-') d.temp.nama = input;
    await setAdminState(chatId, 'edit_profil_alamat', d);
    await tg.sendMessage(chatId, `📍 Kirimkan *Alamat Usaha*.\nSaat ini: ${d.temp.alamat}\n_(Ketik "-" untuk skip)_`, MD);
    return true;
  }
  if (step === 'edit_profil_alamat') {
    if (input !== '-') d.temp.alamat = input;
    await setAdminState(chatId, 'edit_profil_kontak', d);
    await tg.sendMessage(chatId, `📞 Kirimkan *Nomor Kontak (WA/Telp)*.\nSaat ini: ${d.temp.kontak}\n_(Ketik "-" untuk skip)_`, MD);
    return true;
  }
  if (step === 'edit_profil_kontak') {
    if (input !== '-') d.temp.kontak = input;
    await setAdminState(chatId, 'edit_profil_logo', d);
    await tg.sendMessage(chatId, `📸 Terakhir, silakan Upload *Foto Logo Usaha*.\n_(Ketik "-" jika Anda tetap ingin menggunakan foto yang lama)_`, MD);
    return true;
  }
  if (step === 'edit_profil_logo') {
    if (hasPhoto) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      d.temp.logo = await tg.getFileUrl(fileId).catch(() => d.temp.logo);
    } else if (input !== '-') {
      await tg.sendMessage(chatId, "❌ Harap kirimkan foto/logo yang valid, atau ketik '-' untuk melewati proses ini.");
      return true;
    }
    await saveProfile(d.temp);
    await clearAdminState(chatId);
    await tg.sendMessage(chatId,
      `✅ *Profil Berhasil Disimpan!*\n\n🏢 ${d.temp.nama}\n📍 ${d.temp.alamat}\n📞 ${d.temp.kontak}`,
      { ...MD, ...kb(BACK_MAIN) });
    return true;
  }

  // --- Tambah produk (step-by-step: id→nama→kategori→deskripsi→harga→stok→foto) ---
  if (step === 'add_id') { d.temp.id = input; await setAdminState(chatId, 'add_nama', d); await tg.sendMessage(chatId, '📝 *Sip!* Sekarang kirimkan *Nama Produk* tersebut:', MD); return true; }
  if (step === 'add_nama') { d.temp.nama = input; await setAdminState(chatId, 'add_kat', d); await tg.sendMessage(chatId, '🏷️ Kirimkan *Kategori* untuk produk ini:', MD); return true; }
  if (step === 'add_kat') { d.temp.kat = input; await setAdminState(chatId, 'add_desc', d); await tg.sendMessage(chatId, '📜 Kirimkan *Deskripsi* panjang produknya:', MD); return true; }
  if (step === 'add_desc') { d.temp.desc = input; await setAdminState(chatId, 'add_hrg', d); await tg.sendMessage(chatId, '💰 Kirimkan *Harga* (Contoh: 50000 atau Dapat 2: 25000):', MD); return true; }
  if (step === 'add_hrg') { d.temp.hrg = input; await setAdminState(chatId, 'add_stok', d); await tg.sendMessage(chatId, '📦 Kirimkan jumlah *Stok*:', MD); return true; }
  if (step === 'add_stok') { d.temp.stok = input; await setAdminState(chatId, 'add_foto', d); await tg.sendMessage(chatId, '📸 *Terakhir!* Silakan kirim (Upload) *FOTO PRODUK* tersebut ke sini:', MD); return true; }
  if (step === 'add_foto') {
    if (!hasPhoto) {
      await tg.sendMessage(chatId, '❌ Harap kirimkan gambar/foto yang valid.');
      return true;
    }
    const wait = await tg.sendMessage(chatId, '⏳ _Menyimpan ke database..._', MD);
    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      d.temp.link = await tg.getFileUrl(fileId);
      await saveProduk(d.temp);
      await logActivity('produk', `Produk ${d.temp.id} ditambahkan: ${d.temp.nama}`);
      await tg.editMessageText(chatId, wait.message_id,
        `✅ *Produk Berhasil Ditambahkan!*\n\n📦 ID: ${d.temp.id}\n🏷️ Nama: ${d.temp.nama}`,
        { ...MD, ...kb(BACK_MAIN) });
    } catch { await tg.editMessageText(chatId, wait.message_id, '❌ Gagal menyimpan database.'); }
    await clearAdminState(chatId);
    return true;
  }

  // --- Edit produk (cari ID → edit per field, "-" = skip) ---
  if (step === 'edit_find') {
    const wait = await tg.sendMessage(chatId, '⏳ _Mencari produk..._', MD);
    const prod = await getProduk(input);
    await tg.deleteMessage(chatId, wait.message_id);
    if (!prod) {
      await tg.sendMessage(chatId, '❌ Produk tidak ditemukan. Silakan kirimkan ID yang benar, atau ketik /batal.');
      return true;
    }
    await setAdminState(chatId, 'edit_nama', { temp: prod });
    await tg.sendMessage(chatId, `Data ditemukan: *${prod.nama}*\n\n📝 Kirimkan *Nama Produk Baru*.\n_(💡 Ketik strip "-" jika tidak ingin mengubah ini)_`, MD);
    return true;
  }
  if (step === 'edit_nama') { if (input !== '-') d.temp.nama = input; await setAdminState(chatId, 'edit_kat', d); await tg.sendMessage(chatId, `🏷️ Kirimkan *Kategori Baru*.\nSaat ini: ${d.temp.kat}\n_(Ketik "-" untuk skip)_`, MD); return true; }
  if (step === 'edit_kat') { if (input !== '-') d.temp.kat = input; await setAdminState(chatId, 'edit_desc', d); await tg.sendMessage(chatId, `📜 Kirimkan *Deskripsi Baru*.\n_(Ketik "-" untuk skip)_`, MD); return true; }
  if (step === 'edit_desc') { if (input !== '-') d.temp.desc = input; await setAdminState(chatId, 'edit_hrg', d); await tg.sendMessage(chatId, `💰 Kirimkan *Harga Baru*.\nSaat ini: ${d.temp.hrg}\n_(Ketik "-" untuk skip)_`, MD); return true; }
  if (step === 'edit_hrg') { if (input !== '-') d.temp.hrg = input; await setAdminState(chatId, 'edit_stok', d); await tg.sendMessage(chatId, `📦 Kirimkan *Stok Baru*.\nSaat ini: ${d.temp.stok}\n_(Ketik "-" untuk skip)_`, MD); return true; }
  if (step === 'edit_stok') { if (input !== '-') d.temp.stok = input; await setAdminState(chatId, 'edit_foto', d); await tg.sendMessage(chatId, `📸 Terakhir, Kirimkan *Foto Produk Baru*.\n_(💡 Ketik "-" jika Anda tetap ingin menggunakan foto yang lama)_`, MD); return true; }
  if (step === 'edit_foto') {
    const wait = await tg.sendMessage(chatId, '⏳ _Memperbarui database..._', MD);
    try {
      if (hasPhoto) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        d.temp.link = await tg.getFileUrl(fileId);
      } else if (input !== '-') {
        await tg.editMessageText(chatId, wait.message_id, "❌ Harap kirimkan gambar/foto, atau ketik '-' untuk melewati proses edit foto.");
        return true;
      }
      await saveProduk(d.temp);
      await logActivity('produk', `Produk ${d.temp.id} diperbarui: ${d.temp.nama}`);
      await tg.editMessageText(chatId, wait.message_id,
        `✅ *Produk Berhasil Diperbarui!*\n\n📦 ID: ${d.temp.id}\n🏷️ Nama: ${d.temp.nama}`,
        { ...MD, ...kb(BACK_MAIN) });
    } catch { await tg.editMessageText(chatId, wait.message_id, '❌ Gagal memperbarui database.'); }
    await clearAdminState(chatId);
    return true;
  }

  // --- FITUR ADMIN: Hapus produk (konfirmasi) ---
  if (step === 'prod_del_find') {
    const prod = await getProduk(input);
    if (!prod) {
      await tg.sendMessage(chatId, '❌ Produk tidak ditemukan. Kirim ID yang benar, atau /batal.');
      return true;
    }
    await setAdminState(chatId, 'prod_del_confirm', { temp: { id: prod.id, nama: prod.nama } });
    await tg.sendMessage(chatId,
      `⚠️ *Yakin hapus produk ini?*\n\n📦 *${prod.id}* — ${prod.nama}\n💰 ${rp(prod.hrg)} | stok: ${prod.stok}\n\nKetik *YA* untuk hapus, atau /batal.`, MD);
    return true;
  }
  if (step === 'prod_del_confirm') {
    if (!/^(ya|iya|oke|ok|hapus|yes)$/i.test(input)) {
      await clearAdminState(chatId);
      await tg.sendMessage(chatId, '🚫 Hapus produk dibatalkan.', { ...MD, ...kb(BACK_MAIN) });
      return true;
    }
    try {
      await sbDel('products', { id: `eq.${d.temp.id}` });
      await logActivity('produk', `Produk ${d.temp.id} dihapus.`);
      await clearAdminState(chatId);
      await tg.sendMessage(chatId, `✅ Produk *${d.temp.id}* (${d.temp.nama}) dihapus.`, { ...MD, ...kb(BACK_MAIN) });
    } catch (e) {
      await clearAdminState(chatId);
      await tg.sendMessage(chatId, `❌ Gagal hapus: ${e.message}`, MD);
    }
    return true;
  }

  // --- Cek pesanan: cari detail (ID / WA / nama, pakai ilike Supabase) ---
  if (step === 'input_cek') {
    // Sanitasi: buang karakter yang merusak sintaks or= ; escape wildcard ilike
    const q = input.replace(/[*(),]/g, '').replace(/[%_]/g, (c) => '\\' + c).trim().slice(0, 40);
    const wait = await tg.sendMessage(chatId, '⏳ _Mencari data di database..._', MD);
    try {
      let rows = [];
      if (q) {
        rows = await sbGet('orders', {
          select: 'id,tanggal,nama_penerima,nomor_wa,alamat_lengkap,total_harga,status',
          or: `(id.ilike.*${q}*,nama_penerima.ilike.*${q}*,nomor_wa.ilike.*${q}*)`,
          order: 'tanggal.desc', limit: 5,
        }).catch(() => []);
      }
      if (!rows.length) {
        await tg.editMessageText(chatId, wait.message_id, `❌ Data dengan kata kunci *${input}* tidak ditemukan.`, MD);
      } else {
        const blocks = [];
        for (const r of rows) {
          const items = await getOrderItems(r.id);
          const pesanan = items.length ? items.map((i) => `• ${i.nama_produk} (${i.qty}x)`).join('\n') : '-';
          blocks.push(`📦 *DETAIL (${r.id})*\n👤 *Nama:* ${r.nama_penerima}\n📱 *WA:* ${r.nomor_wa}\n📍 *Alamat:* ${r.alamat_lengkap}\n🛒 *Pesanan:*\n${pesanan}\n💰 *Total:* ${rp(r.total_harga)}\n🚦 *Status:* ${dispStatus(r.status)}`);
        }
        await tg.editMessageText(chatId, wait.message_id, blocks.join('\n\n━━━━━━━━━━━━\n\n'), MD);
      }
    } catch (e) { await tg.editMessageText(chatId, wait.message_id, `❌ *Terjadi Error:* ${e.message}`, MD); }
    await clearAdminState(chatId);
    return true;
  }

  // --- Ubah status ---
  if (step === 'input_paket_status') {
    const wait = await tg.sendMessage(chatId, '⏳ _Mencari data..._', MD);
    try {
      const res = await getAllData();
      const row = res.data.slice(1).find((r) =>
        String(r[0] || '').toUpperCase() === input.toUpperCase() ||
        String(r[8] || '').toUpperCase() === input.toUpperCase());
      if (row) {
        await tg.editMessageText(chatId, wait.message_id, `📦 *ID Pesanan:* ${row[0]}\nSilakan pilih status baru:`, {
          ...kb([
            [{ text: 'Diproses', callback_data: `setstatus_${row[0]}_Diproses_${row[3]}` }, { text: 'Dikirim', callback_data: `setstatus_${row[0]}_Dikirim_${row[3]}` }],
            [{ text: 'Selesai', callback_data: `setstatus_${row[0]}_Selesai_${row[3]}` }],
          ]),
        });
      } else {
        await tg.editMessageText(chatId, wait.message_id, `❌ ID Pesanan *${input}* tidak ditemukan.`, MD);
      }
    } catch (e) { await tg.editMessageText(chatId, wait.message_id, `❌ *Terjadi Error:* ${e.message}`, MD); }
    await clearAdminState(chatId);
    return true;
  }

  // --- Edukasi & Promo: input nomor WA dulu, lalu kirim form/produk katalog ---
  if (step.startsWith('input_wa_edu_')) {
    const wa = formatWA(input);
    const jenis = step.split('_')[3];
    if (jenis === 'prod') {
      await setAdminState(chatId, 'input_id_edu_prod', { tempWa: wa });
      await tg.sendMessage(chatId, `✅ Nomor WA tersimpan: *${wa}*\n\n📦 Sekarang ketikkan *Kode/ID Produk* dari katalog:`, MD);
      return true;
    }
    const profile = await getProfile();
    let teks = '';
    if (jenis === 'kwi') teks = `📝 *Template Kwitansi*\nNomor pesanan: \nNama Usaha: ${profile.nama}\nAlamat: ${profile.alamat}\nKontak: ${profile.kontak}\nCatatan:\n\n_(Logo Tersedia di Sistem)_`;
    if (jenis === 'not') teks = `📝 *Template Nota*\nNama Usaha: ${profile.nama}\nJenis Usaha:\nAlamat: ${profile.alamat}\nKontak: ${profile.kontak}\nPilihan Model: Landscape / Portrait\nCatatan:`;
    if (teks) {
      if (profile.logo) await queueWA(wa, 'image', profile.logo, teks);
      else await queueWA(wa, 'text', teks);
    }
    await clearAdminState(chatId);
    await tg.sendMessage(chatId, `✅ Form berhasil dikirim ke WA pelanggan (${wa}) dengan kop/profil Usaha Anda!`);
    return true;
  }

  if (step === 'input_id_edu_prod') {
    const wa = d.tempWa;
    const idProduk = input.toUpperCase();
    const wait = await tg.sendMessage(chatId, '⏳ _Mencari data produk dan mengirim..._', MD);
    try {
      const prod = await getProduk(idProduk);
      if (!prod) {
        await tg.editMessageText(chatId, wait.message_id, `❌ Produk dengan ID *${idProduk}* tidak ditemukan. Silakan kirimkan ID yang benar atau ketik /batal.`, MD);
        return true;
      }
      let displayHarga = prod.hrg;
      if (!isNaN(prod.hrg) && String(prod.hrg).trim() !== '') displayHarga = 'Rp ' + parseInt(prod.hrg, 10).toLocaleString('id-ID');
      const teksProduk = `✨ *DETAIL PRODUK KAMI*\n\n📦 *ID:* ${prod.id}\n🏷️ *Nama:* ${prod.nama}\n📂 *Kategori:* ${prod.kat}\n\n📜 *Deskripsi:*\n${prod.desc}\n\n💰 *Harga:* ${displayHarga}\n📊 *Sisa Stok:* ${prod.stok}\n\n_Berminat? Silakan balas pesan ini ya kak!_`;
      if (prod.link) await queueWA(wa, 'image', prod.link, teksProduk);
      else await queueWA(wa, 'text', teksProduk);
      await tg.editMessageText(chatId, wait.message_id,
        `✅ *BERHASIL!*\nDetail produk *${prod.nama}* telah dikirim ke WA pelanggan: ${wa}`,
        { ...MD, ...kb([[{ text: '🔙 Kembali ke Menu', callback_data: 'home' }]]) });
    } catch (e) { await tg.editMessageText(chatId, wait.message_id, `❌ *Terjadi Kesalahan:* ${e.message}`, MD); }
    await clearAdminState(chatId);
    return true;
  }

  return null;
}

// ---------- FITUR JUALAN: Kirim gambar manual via /kirim ----------
// Format caption: /kirim 62812xxxx  atau  /kirim INV-xxxxxx
// Foto diteruskan ke WA customer via wa_outbox (image_url).
async function handleKirimGambar(chatId, msg, captionText) {
  const arg = captionText.replace(/^\/kirim\s+/i, '').trim();
  if (!arg) {
    await tg.sendMessage(chatId, '❌ Format: kirim foto dengan caption `/kirim 62812xxxx` atau `/kirim INV-xxxxxx`', MD);
    return;
  }
  const waitMsg = await tg.sendMessage(chatId, '⏳ _Mengirim gambar..._', MD);
  try {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const fileUrl = await tg.getFileUrl(fileId);
    if (!fileUrl) throw new Error('Gagal dapat URL file');

    let toWa = null;
    let orderId = null;

    const invM = arg.match(/INV-\d{6}/i);
    if (invM) {
      orderId = invM[0].toUpperCase();
      const orders = await sbGet('orders', { select: 'nomor_wa,nama_penerima', id: `eq.${orderId}`, limit: 1 });
      if (!orders[0] || !orders[0].nomor_wa) {
        await tg.editMessageText(chatId, waitMsg.message_id, `❌ Order *${orderId}* tidak ditemukan / tidak ada nomor WA.`, MD);
        return;
      }
      toWa = orders[0].nomor_wa;
    } else {
      toWa = formatWA(arg);
      if (toWa.length < 10) {
        await tg.editMessageText(chatId, waitMsg.message_id, '❌ Nomor WA tidak valid.', MD);
        return;
      }
    }

    await queueWA(toWa, 'image', fileUrl, captionText.replace(/^\/kirim\s+\S+\s*/i, '').trim() || null, fileUrl);
    await logActivity('kirim_gambar', `Gambar dikirim ke ${toWa}${orderId ? ` (${orderId})` : ''} via WA.`);
    await tg.editMessageText(chatId, waitMsg.message_id,
      `✅ *Gambar masuk antrean WA*\nTujuan: ${toWa}${orderId ? `\nOrder: ${orderId}` : ''}`, MD);
  } catch (e) {
    await tg.editMessageText(chatId, waitMsg.message_id, `❌ *Gagal:* ${e.message}`, MD).catch(() => {});
  }
}

// ---------- FITUR JUALAN: /invoice ----------
async function handleInvoice(chatId, orderId) {
  const waitMsg = await tg.sendMessage(chatId, '⏳ _Membuat invoice..._', MD);
  try {
    const { generateInvoice } = require('./invoice');
    const orders = await sbGet('orders', {
      select: 'id,tanggal,nama_penerima,nomor_wa,alamat_lengkap,total_harga,status',
      id: `eq.${orderId}`, limit: 1,
    });
    if (!orders[0]) {
      await tg.editMessageText(chatId, waitMsg.message_id, `❌ Order *${orderId}* tidak ditemukan.`, MD);
      return;
    }
    const items = await sbGet('order_items', {
      select: 'nama_produk,qty,harga_satuan', order_id: `eq.${orderId}`,
    }).catch(() => []);
    const profile = await getProfile().catch(() => ({}));
    const pdfBuffer = await generateInvoice({ ...orders[0], items, _profile: profile });

    // Upload ke Storage untuk dapat link publik
    let publicUrl = null;
    try {
      const fileName = `Invoice-${orderId}-${Date.now()}.pdf`;
      const upRes = await fetch(`${SB_URL}/storage/v1/object/invoices/${fileName}`, {
        method: 'POST',
        headers: { ...sbHeaders(), 'Content-Type': 'application/pdf' },
        body: pdfBuffer,
      });
      if (upRes.ok) publicUrl = `${SB_URL}/storage/v1/object/public/invoices/${fileName}`;
    } catch (e) { console.error('[invoice] upload gagal:', e.message); }

    const caption = `🧾 *Invoice ${orderId}*\nTotal: ${rp(orders[0].total_harga)}` +
      (publicUrl ? `\n\n🔗 *Link publik (forward ke customer):*\n${publicUrl}` : '');
    await tg.sendDocument(chatId, pdfBuffer, `Invoice-${orderId}.pdf`, caption);
    await tg.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    await logActivity('invoice', `Invoice ${orderId} dibuat & dikirim ke admin.`);
  } catch (e) {
    await tg.editMessageText(chatId, waitMsg.message_id, `❌ *Gagal buat invoice:* ${e.message}`, MD).catch(() => {});
  }
}

// ---------- FITUR JUALAN: kirim invoice PDF ke WA customer (bahasa natural) ----------
// generate PDF → upload Storage bucket 'invoices' (public) → queueWA kind='document'
async function handleInvoiceToWA(chatId, orderId) {
  const waitMsg = await tg.sendMessage(chatId, '⏳ _Membuat invoice & mengirim ke WA customer..._', MD);
  try {
    const { generateInvoice } = require('./invoice');
    const orders = await sbGet('orders', {
      select: 'id,tanggal,nama_penerima,nomor_wa,alamat_lengkap,total_harga,status',
      id: `eq.${orderId}`, limit: 1,
    });
    if (!orders[0]) {
      await tg.editMessageText(chatId, waitMsg.message_id, `❌ Order *${orderId}* tidak ditemukan.`, MD);
      return;
    }
    const order = orders[0];
    const toWa = formatWA(order.nomor_wa);
    if (!toWa || toWa.length < 10) {
      await tg.editMessageText(chatId, waitMsg.message_id, `❌ Nomor WA customer tidak valid.`, MD);
      return;
    }
    const items = await sbGet('order_items', {
      select: 'nama_produk,qty,harga_satuan', order_id: `eq.${orderId}`,
    }).catch(() => []);
    const profile2 = await getProfile().catch(() => ({}));
    const pdfBuffer = await generateInvoice({ ...order, items, _profile: profile2 });

    const fileName = `Invoice-${orderId}-${Date.now()}.pdf`;
    const upRes = await fetch(`${SB_URL}/storage/v1/object/invoices/${fileName}`, {
      method: 'POST',
      headers: { ...sbHeaders(), 'Content-Type': 'application/pdf' },
      body: pdfBuffer,
    });
    if (!upRes.ok) {
      const t = await upRes.text().catch(() => '');
      throw new Error(`Upload storage gagal (${upRes.status}): ${t.slice(0, 120)}`);
    }
    const publicUrl = `${SB_URL}/storage/v1/object/public/invoices/${fileName}`;

    await queueWA(toWa, 'document', publicUrl, `Invoice-${orderId}.pdf`);
    await logActivity('invoice_wa', `Invoice ${orderId} dikirim ke WA ${toWa}.`);
    await tg.editMessageText(chatId, waitMsg.message_id,
      `✅ *Invoice ${orderId} masuk antrean WA*\nTujuan: ${order.nama_penerima} (${toWa})\nPanel akan mengirim PDF-nya via WhatsApp.`, MD);
  } catch (e) {
    await tg.editMessageText(chatId, waitMsg.message_id, `❌ *Gagal:* ${e.message}`, MD).catch(() => {});
  }
}

// ---------- FITUR JUALAN: /broadcast ----------
async function handleBroadcastConfirm(chatId, pesan) {
  let total = 0;
  try {
    const rows = await sbGet('customers', { select: 'nomor_wa', limit: 1000 });
    const unik = new Set(rows.map((r) => String(r.nomor_wa || '').replace(/\D/g, '')).filter((n) => n.length >= 10));
    total = unik.size;
  } catch {}
  await setAdminState(chatId, 'broadcast_confirm', { pesan });
  await tg.sendMessage(chatId,
    `📢 *KONFIRMASI BROADCAST*\n\nPesan:\n${pesan.slice(0, 300)}\n\nAkan dikirim ke *${total} customer* via WA.\n\nKetik *YA* untuk lanjut, atau */batal* untuk batalkan.`,
    MD);
}

async function handleBroadcastExec(chatId, pesan) {
  await clearAdminState(chatId);
  const waitMsg = await tg.sendMessage(chatId, '⏳ _Menyiapkan broadcast..._', MD);
  try {
    const rows = await sbGet('customers', { select: 'nomor_wa,nama', limit: 1000 });
    const seen = new Set();
    let count = 0;
    for (const r of rows) {
      const wa = String(r.nomor_wa || '').replace(/\D/g, '');
      if (wa.length < 10 || seen.has(wa)) continue;
      seen.add(wa);
      await queueWA(wa, 'text', pesan);
      count++;
      // Rate limit: jeda sudah ditangani di poller panel (2 detik antar kirim)
    }
    await tg.editMessageText(chatId, waitMsg.message_id,
      `✅ *Broadcast masuk antrean!*\n${count} pesan akan dikirim via WA (jeda 2 detik per pesan).`, MD);
    await logActivity('broadcast', `Broadcast ke ${count} customer: ${pesan.slice(0, 100)}`);
  } catch (e) {
    await tg.editMessageText(chatId, waitMsg.message_id, `❌ *Gagal:* ${e.message}`, MD).catch(() => {});
  }
}

// ---------- Upload resi: OCR cocokkan ke order ----------
// Prioritas: INV-xxxxxx di gambar → nama penerima → fallback cocokkan SEMUA
// angka (min 6 digit, anti false-positive) ke ID order / nomor WA.
async function handleFotoOtomatis(chatId, msg, captionText) {
  // Foto + caption ID → kirim resi manual langsung
  if (captionText) {
    const idPesanan = captionText.trim().toUpperCase();
    const wait = await tg.sendMessage(chatId, '⏳ _Mengirim Resi..._', MD);
    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await tg.getFileUrl(fileId);
      const hari = await kirimResiKeCustomer(chatId, idPesanan, fileLink, false);
      if (hari === null) await tg.editMessageText(chatId, wait.message_id, `❌ ID *${idPesanan}* tidak ditemukan di Database.`, MD);
      else await tg.editMessageText(chatId, wait.message_id, `✅ *SUKSES*\nResi *${idPesanan}* terkirim. Timer: ${hari} Hari`, MD);
    } catch (e) { await tg.editMessageText(chatId, wait.message_id, `❌ *Gagal:* ${e.message}`, MD); }
    return;
  }
  // Foto polos (atau caption bebas) → OCR otomatis: ekstrak INV, no resi, penerima
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  await tg.sendMessage(chatId, '⏳ _Menganalisis resi dengan AI..._', { ...MD, reply_to_message_id: msg.message_id });
  const fileUrl = await tg.getFileUrl(fileId).catch(() => null);
  const ocr = fileUrl ? await ocrImage(fileUrl) : { ok: false };
  if (!ocr.ok) {
    await tg.sendMessage(chatId, '❌ *GAGAL:* Gambar tidak terbaca oleh AI.\nCoba kirim dengan caption `/kirim INV-xxxxxx`', { ...MD, reply_to_message_id: msg.message_id });
    return;
  }

  const info = extractResiInfo(ocr.text);
  console.log('[ocr-resi]', JSON.stringify(info));

  // Cari order: prioritaskan INV, fallback ke nama penerima
  let order = null;
  if (info.inv) {
    const rows = await sbGet('orders', { select: 'id,nama_penerima,nomor_wa,alamat_lengkap,status', id: `eq.${info.inv}`, limit: 1 }).catch(() => []);
    if (rows[0]) order = rows[0];
  }
  if (!order && info.penerima) {
    // Cari by nama (fuzzy: cocokkan 5 huruf awal)
    const rows = await sbGet('orders', { select: 'id,nama_penerima,nomor_wa,alamat_lengkap,status', order: 'tanggal.desc', limit: 50 }).catch(() => []);
    const key = info.penerima.toLowerCase().slice(0, 5);
    order = rows.find((r) => String(r.nama_penerima || '').toLowerCase().includes(key));
  }
  if (!order) {
    // Fallback: cocokkan SEMUA angka di gambar dengan database (ID order, no WA).
    // Anti false-positive: abaikan angka < 6 digit.
    const nums = extractAllNumbers(ocr.text);
    if (nums.length) {
      const rows = await sbGet('orders', { select: 'id,nama_penerima,nomor_wa,alamat_lengkap,status', order: 'tanggal.desc', limit: 100 }).catch(() => []);
      for (const num of nums) {
        if (num.length < 6) continue;
        // Cek: cocok dengan bagian ID order (INV-xxxxxx → xxxxxx), minimal 6 digit penuh
        order = rows.find((r) => { const idD = String(r.id || '').replace(/\D/g, ''); return idD.length >= 6 && (idD === num || (num.length >= 8 && idD.includes(num)) || (idD.length >= 8 && num.includes(idD))); });
        if (order) { console.log('[ocr-resi] cocok via ID:', num); break; }
        // Cek: cocok dengan nomor WA (10 digit terakhir)
        const waDigits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
        order = rows.find((r) => { const w = waDigits(r.nomor_wa); return w.length >= 6 && (w.includes(num.slice(-10)) || num.slice(-10).includes(w)); });
        if (order) { console.log('[ocr-resi] cocok via WA:', num); break; }
      }
    }
  }

  if (!order) {
    await tg.sendMessage(chatId,
      '❌ *Nomor pesanan tidak terbaca / tidak ketemu.*\nCoba kirim dengan caption `/kirim INV-xxxxxx`',
      { ...MD, reply_to_message_id: msg.message_id });
    return;
  }

  // Update order: status dikirim + nomor resi (bila terbaca)
  const patchData = { status: 'dikirim' };
  if (info.resi) patchData.nomor_resi = info.resi;
  await sbPatch('orders', { id: `eq.${order.id}` }, patchData).catch((e) => console.error('[ocr-resi] patch gagal:', e.message));

  // Antrekan foto resi + notifikasi ke WA customer
  const hari = getEstimasi(order.alamat_lengkap);
  const pesanWA = `📦 *PESANAN DIKIRIM (${order.id})*\n\nHalo kak ${order.nama_penerima}! Paket sudah diserahkan ke kurir. 🚚\n${info.resi ? `*No. Resi:* ${info.resi}${info.resiKurir ? ` (${info.resiKurir})` : ''}\n` : ''}(Otomatis selesai dalam ${hari} hari)`;
  if (order.nomor_wa) {
    // Upload foto ke Storage dulu (URL Telegram kedaluwarsa cepat)
    let imgPublicUrl = fileUrl;
    try {
      const imgRes = await fetch(fileUrl);
      if (imgRes.ok) {
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        const imgName = `resi-${order.id}-${Date.now()}.jpg`;
        const upImg = await fetch(`${SB_URL}/storage/v1/object/invoices/${imgName}`, {
          method: 'POST',
          headers: { ...sbHeaders(), 'Content-Type': 'image/jpeg' },
          body: imgBuf,
        });
        if (upImg.ok) imgPublicUrl = `${SB_URL}/storage/v1/object/public/invoices/${imgName}`;
      }
    } catch (e) { console.error('[ocr-resi] upload img gagal:', e.message); }
    await queueWA(order.nomor_wa, 'image', imgPublicUrl, pesanWA, imgPublicUrl);
  }
  await logActivity('resi', `Resi ${order.id} terkirim via OCR otomatis. Resi: ${info.resi || '-'}. Estimasi ${hari} hari.`);

  await tg.sendMessage(chatId,
    `✅ *Resi terkirim ke ${order.nama_penerima} via WA.*\nStatus → Dikirim 🚚\n${info.resi ? `No. Resi: ${info.resi}` : ''}`,
    { ...MD, reply_to_message_id: msg.message_id });
}

// ---------- Pintasan marketplace: !\n[resi]\n[wa] ----------
async function handleMarketplace(chatId, text) {
  const parts = text.substring(1).trim().split(/\r?\n|\s+/);
  if (parts.length < 2) return null;
  const idPesanan = parts[0].trim().toUpperCase();
  const nowa = formatWA(parts.slice(1).join(''));
  try {
    const res = await getAllData();
    const isExist = res.data.slice(1).find((r) => String(r[0]).toUpperCase() === idPesanan);
    if (isExist) {
      await tg.sendMessage(chatId, `⚠️ *Gagal Menyimpan*\nNomor Pesanan/Resi *${idPesanan}* sudah ada di dalam database!`, MD);
      return true;
    }
    await sbPost('orders', [{
      id: idPesanan, nama_penerima: 'Customer MKT', nomor_wa: nowa, alamat_lengkap: 'Marketplace',
      total_harga: 0, status: 'diproses', nomor_resi: idPesanan,
    }], 'return=minimal');
    await logActivity('order', `Pesanan marketplace ${idPesanan}, WA ${nowa}. Status Diproses.`);
    await tg.sendMessage(chatId, `✅ *Data Marketplace Tersimpan!*\n📦 Resi: *${idPesanan}*\n📱 WA: *${nowa}*\n🚦 Status: *Diproses ⚙️*`, MD);
    return true;
  } catch {
    await tg.sendMessage(chatId, '❌ Gagal.');
    return true;
  }
}

// ---------- Template order terisi → buat order + QRIS ----------
async function handleTemplateOrder(chatId, text) {
  const waMatch = text.match(/Nomor wa Penerima:\s*(.+)/i);
  if (!waMatch) {
    await tg.sendMessage(chatId, '❌ WA wajib isi!');
    return;
  }
  const namaMatch = text.match(/Nama Penerima:\s*(.+)/i);
  const alamatMatch = text.match(/Alamat lengkap:\s*(.+)/i);
  const bayarMatch = text.match(/Metode Pembayaran:\s*([^\n]+)/i);
  const namaPenerima = namaMatch ? namaMatch[1].trim() : 'Customer';
  const alamatPenerima = alamatMatch ? alamatMatch[1].trim() : '-';
  const metodeBayar = bayarMatch ? bayarMatch[1].trim().toLowerCase() : '';
  // Deteksi bayar di toko: dari field ATAU dari seluruh teks (mis. "sudah bayar di toko")
  const bayarDiToko = /toko|cash|tunai|sudah bayar|lunas/i.test(metodeBayar) || /bayar di toko/i.test(text);
  const nowa = formatWA(waMatch[1]);
  const idPesanan = 'INV-' + Math.floor(100000 + Math.random() * 900000);
  const prod = [...text.matchAll(/Nama Produk:\s*(.+)/gi)];
  const qty = [...text.matchAll(/qty:\s*(.+)/gi)];
  const hrg = [...text.matchAll(/Harga satuan:\s*(.+)/gi)];
  let totalKeseluruhan = 0; let detailStruk = '';
  for (let i = 0; i < prod.length; i++) {
    const q = parseInt(qty[i][1], 10) || 0; const h = parseInt(String(hrg[i][1]).replace(/[^0-9]/g, ''), 10) || 0;
    const subtotal = q * h; totalKeseluruhan += subtotal;
    detailStruk += `• ${prod[i][1].trim()} (${q}x) = ${rp(subtotal)}\n`;
  }
  // --- PRODUK DIGITAL: deteksi & normalisasi dari katalog ---
  let digItems = null; // [{product, qty}] bila order ini digital murni
  {
    const matches = [];
    for (let i = 0; i < prod.length; i++) {
      const m = await digital.matchDigital(prod[i][1].trim()).catch(() => ({ product: null }));
      matches.push(m.product);
    }
    const jmlDigital = matches.filter(Boolean).length;
    if (jmlDigital > 0 && jmlDigital < prod.length) {
      await tg.sendMessage(chatId, '⚠️ Order campuran digital & fisik — pisahkan jadi 2 order ya (digital sendiri, fisik sendiri).', MD);
      return;
    }
    if (prod.length > 0 && jmlDigital === prod.length) {
      digItems = matches.map((p, i) => ({ product: p, qty: parseInt(qty[i][1], 10) || 0 }));
      // pakai harga katalog digital (abaikan harga ketikan di form)
      totalKeseluruhan = 0; detailStruk = '';
      for (const di of digItems) {
        const sub = di.qty * Number(di.product.harga || 0); totalKeseluruhan += sub;
        detailStruk += `• ${di.product.nama} (${di.qty}x) = ${rp(sub)}\n`;
      }
      if (totalKeseluruhan <= 0) {
        await tg.sendMessage(chatId, '❌ Harga produk digital masih 0 di katalog. Atur dulu harganya, baru buat order.', MD);
        return;
      }
      for (const di of digItems) {
        const adaStok = await digital.countStock(di.product.id).catch(() => 0);
        if (adaStok < di.qty) {
          await tg.sendMessage(chatId, `❌ Stok ${di.product.nama} tidak cukup (tersedia ${adaStok}, diminta ${di.qty}). QRIS tidak dibuat.`, MD);
          return;
        }
      }
    }
  }
  try {
    // Jika bayar di toko: langsung diproses, kirim invoice PDF (tanpa QRIS)
    if (bayarDiToko) {
      await sbPost('orders', [{
        id: idPesanan, nama_penerima: namaPenerima, nomor_wa: nowa, alamat_lengkap: alamatPenerima,
        total_harga: totalKeseluruhan, status: 'diproses',
      }], 'return=minimal');
      for (let i = 0; i < prod.length; i++) {
        const q = parseInt(qty[i][1], 10) || 0; const h = parseInt(String(hrg[i][1]).replace(/[^0-9]/g, ''), 10) || 0;
        const diIt = digItems ? digItems[i] : null;
        await sbPost('order_items', [{ order_id: idPesanan, product_id: diIt ? diIt.product.id : undefined, nama_produk: diIt ? diIt.product.nama : prod[i][1].trim(), qty: diIt ? diIt.qty : q, harga_satuan: diIt ? Number(diIt.product.harga || 0) : h }], 'return=minimal').catch(() => {});
      }
      // Generate & kirim invoice PDF
      try {
        const { generateInvoice } = require('./invoice');
        const profile = await getProfile().catch(() => ({}));
        const items = prod.map((p, i) => ({
          nama_produk: p[1].trim(),
          qty: parseInt(qty[i][1], 10) || 0,
          harga_satuan: parseInt(String(hrg[i][1]).replace(/[^0-9]/g, ''), 10) || 0,
        }));
        const pdfBuffer = await generateInvoice({
          id: idPesanan, tanggal: new Date().toISOString(), nama_penerima: namaPenerima,
          nomor_wa: nowa, alamat_lengkap: alamatPenerima, total_harga: totalKeseluruhan,
          status: 'diproses', items, _profile: profile,
        });
        const fileName = `Invoice-${idPesanan}-${Date.now()}.pdf`;
        const upR = await fetch(`${SB_URL}/storage/v1/object/invoices/${fileName}`, {
          method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/pdf' }, body: pdfBuffer,
        });
        if (upR.ok) {
          const publicUrl = `${SB_URL}/storage/v1/object/public/invoices/${fileName}`;
          await queueWA(nowa, 'document', publicUrl, `Invoice-${idPesanan}.pdf`);
        }
      } catch (e) { console.error('[bayar-toko] invoice gagal:', e.message); }
      // Produk digital + bayar di toko = sudah lunas → kunci stok & kirim konten sekarang
      let digTerkirim = false;
      if (digItems) {
        for (const di of digItems) await digital.lockStock(idPesanan, di.product.id, di.qty).catch(() => 0);
        const terkirim = await digital.deliverLocked(idPesanan, nowa).catch(() => null);
        if (terkirim) {
          digTerkirim = true;
          await sbPatch('orders', { id: `eq.${idPesanan}` }, { status: 'selesai' }).catch(() => {});
          for (const t of terkirim) {
            await queueWA(nowa, 'text', `✅ *PESANAN SELESAI (${idPesanan})*\n\nBerikut pesanan digital kakak:\n\n${t.message}`);
          }
        }
      }
      await logActivity('order', `Pesanan ${idPesanan} (bayar di toko): ${rp(totalKeseluruhan)}. Invoice dikirim.${digItems ? (digTerkirim ? ' Konten digital terkirim.' : ' Konten digital GAGAL terkirim.') : ''}`);
      await tg.sendMessage(chatId, digItems
        ? (digTerkirim
          ? `✅ Sukses! Order digital *${idPesanan}* SELESAI — akun/link sudah dikirim ke WA customer.`
          : `⚠️ Order *${idPesanan}* tersimpan, tapi pengiriman konten digital GAGAL. Cek stok digital.`)
        : `✅ Sukses! Order *${idPesanan}* (bayar di toko). Invoice PDF dikirim ke WA customer.`, MD);
      return;
    }
    // Jika bayar QRIS: generate QRIS seperti biasa
    const qris = await payinaja.createQRIS(totalKeseluruhan, idPesanan, namaPenerima, nowa);
    if (!qris.ok) {
      await tg.sendMessage(chatId, `❌ Gagal QRIS. Alasan dari Payinaja: ${qris.error}`);
      return;
    }
    await sbPost('orders', [{
      id: idPesanan, nama_penerima: namaPenerima, nomor_wa: nowa, alamat_lengkap: alamatPenerima,
      total_harga: totalKeseluruhan, status: 'pending', payment_trx_id: qris.trx_id,
    }], 'return=minimal');
    for (let i = 0; i < prod.length; i++) {
      const q = parseInt(qty[i][1], 10) || 0; const h = parseInt(String(hrg[i][1]).replace(/[^0-9]/g, ''), 10) || 0;
      const diIt = digItems ? digItems[i] : null;
      await sbPost('order_items', [{ order_id: idPesanan, product_id: diIt ? diIt.product.id : undefined, nama_produk: diIt ? diIt.product.nama : prod[i][1].trim(), qty: diIt ? diIt.qty : q, harga_satuan: diIt ? Number(diIt.product.harga || 0) : h }], 'return=minimal').catch(() => {});
    }
    // Produk digital: kunci stok utk order ini (konten dikirim panel begitu bayar terdeteksi)
    if (digItems) {
      let kunciOk = true;
      for (const di of digItems) {
        const nK = await digital.lockStock(idPesanan, di.product.id, di.qty).catch(() => 0);
        if (!nK) kunciOk = false;
      }
      if (!kunciOk) {
        await digital.releaseLock(idPesanan);
        await sbPatch('orders', { id: `eq.${idPesanan}` }, { status: 'batal' }).catch(() => {});
        await tg.sendMessage(chatId, `❌ Stok digital berubah saat order dibuat — order *${idPesanan}* dibatalkan & QRIS tidak dikirim. Cek stok lalu buat ulang.`, MD);
        return;
      }
    }
    const qrisOk = await queueWA(nowa, 'image', qris.qr_image_url,
      `Halo kak *${namaPenerima}*!\nID: *${idPesanan}*\n\n${detailStruk}\n*TOTAL: ${rp(totalKeseluruhan)}*\nSilakan scan QRIS untuk membayar.`);
    await logActivity('order', `Pesanan baru ${idPesanan} (template admin): ${rp(totalKeseluruhan)}. QRIS ${qrisOk ? 'terkirim' : 'GAGAL dikirim'}.`);
    if (qrisOk) {
      await tg.sendMessage(chatId, `✅ Sukses! QRIS terkirim untuk *${idPesanan}*.${digItems ? '\n📩 Produk digital: akun/link terkirim otomatis begitu pembayaran terdeteksi.' : ''}`, MD);
    } else {
      await tg.sendMessage(chatId, `⚠️ Order *${idPesanan}* tersimpan, tapi QRIS *gagal* dikirim ke WA. Cek koneksi database lalu kirim manual.`, MD);
    }
  } catch {
    await tg.sendMessage(chatId, '❌ Error jaringan saat menghubungi API.');
  }
}

// ---------- FITUR ADMIN: Dashboard omset ----------
function wibDayStart(offsetDays = 0) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  now.setDate(now.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T00:00:00+07:00`;
}
function wibMonthStart() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-01T00:00:00+07:00`;
}
async function handleDashboard(chatId, msgId = null) {
  const send = msgId
    ? (t, o) => tg.editMessageText(chatId, msgId, t, { ...MD, ...(o || {}) })
    : (t, o) => tg.sendMessage(chatId, t, { ...MD, ...(o || {}) });
  await send('⏳ _Menghitung dashboard..._');
  try {
    const rows = await sbGet('orders', { select: 'tanggal,total_harga,status', order: 'tanggal.desc', limit: 2000 });
    const valid = rows.filter((o) => o.status !== 'batal');
    const sum = (list) => list.reduce((a, o) => a + Number(o.total_harga || 0), 0);
    const gte = (iso) => valid.filter((o) => o.tanggal >= iso);
    const hariIni = gte(wibDayStart(0));
    const mingguIni = gte(wibDayStart(-6));
    const bulanIni = gte(wibMonthStart());
    const cnt = (s) => valid.filter((o) => o.status === s).length;
    // Rata-rata order/hari bulan ini
    const tgl = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const hariBerjalan = Math.max(1, tgl.getDate());
    const rataHari = Math.round(sum(bulanIni) / hariBerjalan);
    // Pengeluaran hari ini (untuk profit)
    let keluarHari = 0;
    try {
      const k = await sbGet('pengeluaran', { select: 'nominal', tanggal: `gte.${wibDayStart(0)}`, limit: 500 });
      keluarHari = k.reduce((a, x) => a + Number(x.nominal || 0), 0);
    } catch {}
    const namaBulan = tgl.toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
    const tglStr = tgl.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' });
    const txt =
      `📊 *DASHBOARD OMSET*\n🗓️ ${tglStr}\n\n` +
      `💰 *Hari ini:* ${rp(sum(hariIni))} (${hariIni.length} order)\n` +
      `💰 *7 hari terakhir:* ${rp(sum(mingguIni))} (${mingguIni.length} order)\n` +
      `💰 *Bulan ${namaBulan}:* ${rp(sum(bulanIni))} (${bulanIni.length} order)\n` +
      `📉 *Rata-rata:* ${rp(rataHari)}/hari\n\n` +
      `🚦 *Status pesanan:*\n` +
      `🔴 Belum bayar: ${cnt('pending')}\n` +
      `⚙️ Diproses: ${cnt('diproses')}\n` +
      `🚚 Dikirim: ${cnt('dikirim')}\n` +
      `🥰 Selesai: ${cnt('selesai')}\n\n` +
      `💸 Pengeluaran hari ini: ${rp(keluarHari)}\n` +
      `💵 *Profit hari ini:* ${rp(sum(hariIni) - keluarHari)}`;
    await send(txt, kb(BACK_HOME));
    await logActivity('dashboard', 'Dashboard omset dibuka.');
  } catch (e) {
    await send(`❌ Gagal hitung dashboard: ${e.message}`);
  }
}

// ---------- FITUR ADMIN: Catat pengeluaran ----------
async function handleKeluar(chatId, text) {
  const arg = text.replace(/^\/keluar\s*/i, '').trim();
  if (!arg) {
    await tg.sendMessage(chatId,
      '💸 *CATAT PENGELUARAN*\n\nFormat:\n`/keluar 50000 beli tinta`\n`/keluar 25000|parkir`\n\nLihat rekap: /rekap', MD);
    return;
  }
  let nominalRaw, ket;
  if (arg.includes('|')) { [nominalRaw, ket] = arg.split('|').map((s) => s.trim()); }
  else {
    const parts = arg.split(/\s+/);
    nominalRaw = parts.shift();
    ket = parts.join(' ');
  }
  const nominal = Number(String(nominalRaw).replace(/[^0-9]/g, '')) || 0;
  if (!nominal) {
    await tg.sendMessage(chatId, '❌ Nominal tidak valid. Contoh: `/keluar 50000 beli tinta`', MD);
    return;
  }
  try {
    await sbPost('pengeluaran', [{ nominal, keterangan: ket || '-' }], 'return=minimal');
    await logActivity('pengeluaran', `Keluar ${rp(nominal)}: ${ket || '-'}`);
    await tg.sendMessage(chatId, `✅ *Pengeluaran tercatat*\n\n💸 ${rp(nominal)}\n📝 ${ket || '-'}\n\nLihat rekap: /rekap`, MD);
  } catch (e) {
    await tg.sendMessage(chatId, `❌ Gagal simpan: ${e.message}\n\nPastikan tabel *pengeluaran* sudah dibuat (jalankan migrasi SQL).`, MD);
  }
}

// ---------- FITUR ADMIN: Rekap pengeluaran ----------
async function handleRekap(chatId, msgId = null) {
  const send = msgId
    ? (t, o) => tg.editMessageText(chatId, msgId, t, { ...MD, ...(o || {}) })
    : (t, o) => tg.sendMessage(chatId, t, { ...MD, ...(o || {}) });
  try {
    const rows = await sbGet('pengeluaran', { select: 'tanggal,nominal,keterangan', order: 'tanggal.desc', limit: 500 });
    const sum = (list) => list.reduce((a, x) => a + Number(x.nominal || 0), 0);
    const gte = (iso) => rows.filter((x) => x.tanggal >= iso);
    const hari = gte(wibDayStart(0));
    const minggu = gte(wibDayStart(-6));
    const bulan = gte(wibMonthStart());
    const fmtRow = (x) => {
      const d = new Date(x.tanggal).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' });
      return `• ${d} — ${rp(x.nominal)} (${x.keterangan || '-'})`;
    };
    const txt =
      `💸 *REKAP PENGELUARAN*\n\n` +
      `📅 Hari ini: *${rp(sum(hari))}*\n` +
      `📅 7 hari: *${rp(sum(minggu))}*\n` +
      `📅 Bulan ini: *${rp(sum(bulan))}*\n\n` +
      `*5 terakhir:*\n${rows.slice(0, 5).map(fmtRow).join('\n') || '-'}`;
    await send(txt, kb(BACK_HOME));
  } catch (e) {
    await send(`❌ Gagal: ${e.message}\n\nPastikan tabel *pengeluaran* sudah dibuat (jalankan migrasi SQL).`);
  }
}

// ---------- FITUR ADMIN: Export CSV (kirim via sendDocument) ----------
async function handleExport(chatId, kind) {
  const wait = await tg.sendMessage(chatId, '⏳ _Menyiapkan file export..._', MD);
  try {
    let csv = '', fname = '';
    if (kind === 'orders') {
      const rows = await sbGet('orders', { select: 'id,tanggal,nama_penerima,nomor_wa,alamat_lengkap,total_harga,status,nomor_resi', order: 'tanggal.desc', limit: 2000 });
      csv = 'ID,Tanggal,Nama,No WA,Alamat,Total,Status,Resi\n';
      for (const o of rows) {
        csv += [o.id, fmtTgl(o.tanggal), o.nama_penerima, o.nomor_wa, o.alamat_lengkap, o.total_harga, o.status, o.nomor_resi || '']
          .map(csvEsc).join(',') + '\n';
      }
      fname = `export-orders-${Date.now()}.csv`;
    } else if (kind === 'products') {
      const rows = await sbGet('products', { select: 'id,nama,kategori,harga,stok', order: 'id', limit: 500 });
      csv = 'ID,Nama,Kategori,Harga,Stok\n';
      for (const p of rows) csv += [p.id, p.nama, p.kategori || '', p.harga, p.stok ?? ''].map(csvEsc).join(',') + '\n';
      fname = `export-products-${Date.now()}.csv`;
    } else {
      const rows = await sbGet('customers', { select: 'nama,nomor_wa,alamat_lengkap', order: 'nama', limit: 2000 });
      csv = 'Nama,No WA,Alamat\n';
      for (const c of rows) csv += [c.nama, c.nomor_wa, c.alamat_lengkap || ''].map(csvEsc).join(',') + '\n';
      fname = `export-customers-${Date.now()}.csv`;
    }
    await tg.sendDocument(chatId, Buffer.from(csv, 'utf8'), fname, `📥 Export ${kind} (${csv.split('\n').length - 2} baris)`);
    await tg.deleteMessage(chatId, wait.message_id).catch(() => {});
    await logActivity('export', `Export ${kind} dikirim ke admin.`);
  } catch (e) {
    await tg.editMessageText(chatId, wait.message_id, `❌ Gagal export: ${e.message}`, MD).catch(() => {});
  }
}

module.exports = { showHome, handleCallback, handleMessage, getAdminState, setAdminState, clearAdminState, queueWA, getProfile };
