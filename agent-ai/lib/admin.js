'use strict';
/**
 * lib/admin.js — MENU ADMIN, port 1:1 dari toko-bot/telegram.js (bot lama).
 * Satu bot, dua tampilan: modul ini KHUSUS owner (TELEGRAM_ALLOWED_ID).
 * - State: tabel admin_states (bukan memory, karena serverless)
 * - Profil toko: tabel store_profile (bukan JSON file)
 * - Kirim WA: tabel wa_outbox (panel/Baileys yang kirim)
 * - Teks & tombol dibuat SAMA PERSIS dengan bot lama.
 */

const tg = require('./telegram-api');
const { ocrImage } = require('./ocr');
const payinaja = require('./payinaja');

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
async function queueWA(toWa, kind, content, caption) {
  await sbPost('wa_outbox', [{
    to_wa: formatWA(toWa), kind, content, caption: caption || null, status: 'pending',
  }], 'return=minimal').catch((e) => console.error('[admin] queueWA gagal:', e.message));
}
async function logActivity(aksi, detail) {
  sbPost('agent_activity', [{ kategori: 'toko', aksi, detail: String(detail || '').slice(0, 500) }], 'return=minimal').catch(() => {});
}

const MD = { parse_mode: 'Markdown' };
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const BACK_HOME = [[{ text: '🔙 Kembali', callback_data: 'home' }]];
const BACK_MAIN = [[{ text: '🔙 Menu Utama', callback_data: 'home' }]];

// ---------- MENU UTAMA ----------
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
      [{ text: '➖', callback_data: `oqty_dec_${count}` }, { text: '📝 Generate Form', callback_data: `oqty_gen_${count}` }, { text: '➕', callback_data: `oqty_inc_${count}` }],
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
    return tg.sendMessage(chatId, `🏢 *EDIT PROFIL USAHA*\n\n📝 Kirimkan *Nama Usaha* Anda yang baru.\nSaat ini: ${profile.nama}\n_(💡 Ketik "-" jika tidak ingin mengubah ini)_`, MD);
  }

  if (data === 'home_produk') {
    return edit('📦 *KELOLA KATALOG PRODUK*\nSilakan pilih menu di bawah ini:',
      kb([[{ text: '➕ Tambah Produk Baru', callback_data: 'produk_tambah' }], [{ text: '✏️ Edit Produk', callback_data: 'produk_edit' }], BACK_HOME[0]]));
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
    return tg.sendMessage(chatId, `➕ *TAMBAH PRODUK BARU*\n\nSilakan ketik dan kirimkan *ID Produk* Anda.\n_(💡 Info: ID Terakhir di sheet adalah *${lastId}*)_\n\nKetik /batal jika ingin membatalkan.`, MD);
  }

  if (data === 'produk_edit') {
    await edit('⏳ _Membuka mode Edit Produk..._');
    await tg.deleteMessage(chatId, msgId);
    await setAdminState(chatId, 'edit_find', { temp: {} });
    return tg.sendMessage(chatId, '✏️ *EDIT PRODUK*\n\nSilakan ketik dan kirimkan *ID Produk* yang ingin diedit:\n\nKetik /batal jika ingin membatalkan.', MD);
  }

  if (data === 'home_order') return renderOrderQtyMenu(chatId, msgId, 1);
  if (data === 'home_market') return tg.sendMessage(chatId, `💡 *TIPS: PINTASAN MARKETPLACE*\nKetik pesan ke bot ini dengan format:\n!\n[Nomor Resi]\n[Nomor WA]`, MD);

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
    if (!st || st.step !== 'massal_select') return tg.answerCallbackQuery(queryId, { text: 'Sesi habis, ulangi dari menu.' });
    const d = st.data || { selected: [], list: [] };
    if (d.selected.includes(idPesanan)) d.selected = d.selected.filter((id) => id !== idPesanan);
    else d.selected.push(idPesanan);
    await setAdminState(chatId, 'massal_select', d);
    return renderMassalMenu(chatId, msgId, d);
  }

  if (data === 'massal_lanjut') {
    const st = await getAdminState(chatId);
    const d = (st && st.data) || { selected: [] };
    if (!d.selected || d.selected.length === 0) return tg.answerCallbackQuery(queryId, { text: '❌ Pilih minimal 1 resi!', show_alert: true });
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
  if (data === 'lap_7' || data === 'lap_30') return buatLaporan(chatId, parseInt(data.split('_')[1], 10));

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

  if (data.startsWith('oqty_')) {
    const parts = data.split('_'); const action = parts[1]; let count = parseInt(parts[2], 10);
    if (action === 'dec' && count > 1) count--;
    if (action === 'inc') count++;
    if (action === 'gen') {
      let txt = `📋 *TEMPLATE ORDER*\nNama Penerima: \nNomor wa Penerima: \nAlamat lengkap: \n`;
      for (let i = 0; i < count; i++) txt += `Detail Pesanan ${i + 1}\nNama Produk: \nqty: \nHarga satuan: \n`;
      return tg.sendMessage(chatId, txt, MD);
    }
    return renderOrderQtyMenu(chatId, msgId, count);
  }
}

async function buatLaporan(chatId, rentangHari) {
  await tg.sendMessage(chatId, '⏳ Merekap data...', MD);
  try {
    const res = await getAllData();
    const rows = res.data.slice(1);
    let csv = 'ID Pesanan,Tanggal,Nama,No WA,Total Tagihan,Status\n';
    rows.forEach((row) => {
      if (!String(row[7] || '').includes('Belum')) {
        csv += `${row[0]},${row[1]},"${String(row[2] || '').replace(/"/g, '')}",${row[3]},${row[6]},${String(row[7] || '').replace(/,/g, '')}\n`;
      }
    });
    await tg.sendDocument(chatId, Buffer.from(csv, 'utf8'), `Laporan_${rentangHari}hari_${Date.now()}.csv`, `📊 Laporan ${rentangHari} hari terakhir`);
    await logActivity('laporan', `Laporan ${rentangHari} hari dikirim ke admin.`);
  } catch (e) {
    await tg.sendMessage(chatId, `❌ Gagal membuat laporan: ${e.message}`);
  }
}

// ---------- PESAN ADMIN (state flows) ----------
async function handleMessage(chatId, msg) {
  const text = msg.caption || msg.text || '';
  const hasPhoto = !!(msg.photo && msg.photo.length);

  // /batal kapan saja saat ada state
  if (text === '/batal') {
    const st = await getAdminState(chatId);
    if (st) {
      await clearAdminState(chatId);
      return tg.sendMessage(chatId, '🚫 *Proses Dibatalkan.* Silakan kembali menggunakan /menu.', MD);
    }
    return null; // bukan dalam alur admin → biarkan asisten yang tangani
  }

  const st = await getAdminState(chatId);
  if (!st) {
    // Foto tanpa state → OCR resi otomatis (seperti bot lama)
    if (hasPhoto) return handleFotoOtomatis(chatId, msg, text);
    // Perintah cepat marketplace: !\n[resi]\n[wa]
    if (text.startsWith('!')) return handleMarketplace(chatId, text);
    // Template order terisi
    if (text.includes('TEMPLATE ORDER') || text.includes('FORM PEMESANAN')) return handleTemplateOrder(chatId, text);
    return null; // teks bebas → asisten AI
  }

  const step = st.step;
  const d = st.data || {};
  const input = text.trim();

  // --- Upload resi massal (OCR) ---
  if (step === 'massal_upload') {
    if (!hasPhoto) return tg.sendMessage(chatId, '❌ Harap kirimkan foto resi.');
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await tg.sendMessage(chatId, '⏳ _Menganalisis gambar dengan AI..._', { ...MD, reply_to_message_id: msg.message_id });
    const fileUrl = await tg.getFileUrl(fileId).catch(() => null);
    const ocr = fileUrl ? await ocrImage(fileUrl) : { ok: false };
    if (!ocr.ok) return tg.sendMessage(chatId, '❌ *GAGAL:* Gambar tidak terbaca oleh AI.', MD);
    const ocrText = ocr.text.toUpperCase();
    const matchId = (d.selected || []).find((id) => ocrText.includes(String(id).toUpperCase()));
    if (!matchId) return tg.sendMessage(chatId, '❌ *TIDAK COCOK:* AI salah baca atau nomor tidak ada di ceklistan.', MD);
    const hari = await kirimResiKeCustomer(chatId, matchId, fileUrl, true);
    d.selected = (d.selected || []).filter((id) => id !== matchId);
    if (d.selected.length === 0) {
      await clearAdminState(chatId);
      return tg.sendMessage(chatId, '🎉 *SEMUA RESI MASSAL TELAH TERKIRIM!*', { ...MD, ...kb([[ { text: '🔙 Kembali ke Menu Utama', callback_data: 'home' } ]]) });
    }
    await setAdminState(chatId, 'massal_upload', d);
    return tg.sendMessage(chatId, `✅ *BERHASIL: Resi ${matchId} terkirim!* Timer: ${hari} Hari. Sisa: ${d.selected.length}`, MD);
  }

  // --- Upload resi satu-satu (tombol) ---
  if (step === 'upload_resi_btn') {
    if (!hasPhoto) return tg.sendMessage(chatId, '❌ Harap *Upload Foto* resi, bukan teks.', MD);
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
    return;
  }

  // --- Kirim resi manual (foto + caption ID) ---
  if (step === 'input_paket_resi') {
    if (!hasPhoto) return tg.sendMessage(chatId, '❌ Harap *Upload Foto* dan ketik ID di Caption, bukan hanya mengirim teks.', MD);
    if (!text) return tg.sendMessage(chatId, "❌ Anda lupa mengetik ID Pesanan di Caption Foto. Silakan klik menu kembali dan ulangi.");
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
    return;
  }

  // --- Edit profil toko ---
  if (step === 'edit_profil_nama') {
    if (input !== '-') d.temp.nama = input;
    await setAdminState(chatId, 'edit_profil_alamat', d);
    return tg.sendMessage(chatId, `📍 Kirimkan *Alamat Usaha*.\nSaat ini: ${d.temp.alamat}\n_(Ketik "-" untuk skip)_`, MD);
  }
  if (step === 'edit_profil_alamat') {
    if (input !== '-') d.temp.alamat = input;
    await setAdminState(chatId, 'edit_profil_kontak', d);
    return tg.sendMessage(chatId, `📞 Kirimkan *Nomor Kontak (WA/Telp)*.\nSaat ini: ${d.temp.kontak}\n_(Ketik "-" untuk skip)_`, MD);
  }
  if (step === 'edit_profil_kontak') {
    if (input !== '-') d.temp.kontak = input;
    await setAdminState(chatId, 'edit_profil_logo', d);
    return tg.sendMessage(chatId, `📸 Terakhir, silakan Upload *Foto Logo Usaha*.\n_(Ketik "-" jika Anda tetap ingin menggunakan foto yang lama)_`, MD);
  }
  if (step === 'edit_profil_logo') {
    if (hasPhoto) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      d.temp.logo = await tg.getFileUrl(fileId).catch(() => d.temp.logo);
    } else if (input !== '-') {
      return tg.sendMessage(chatId, "❌ Harap kirimkan foto/logo yang valid, atau ketik '-' untuk melewati proses ini.");
    }
    await saveProfile(d.temp);
    await clearAdminState(chatId);
    return tg.sendMessage(chatId,
      `✅ *Profil Berhasil Disimpan!*\n\n🏢 ${d.temp.nama}\n📍 ${d.temp.alamat}\n📞 ${d.temp.kontak}`,
      { ...MD, ...kb(BACK_MAIN) });
  }

  // --- Tambah produk ---
  if (step === 'add_id') { d.temp.id = input; await setAdminState(chatId, 'add_nama', d); return tg.sendMessage(chatId, '📝 *Sip!* Sekarang kirimkan *Nama Produk* tersebut:', MD); }
  if (step === 'add_nama') { d.temp.nama = input; await setAdminState(chatId, 'add_kat', d); return tg.sendMessage(chatId, '🏷️ Kirimkan *Kategori* untuk produk ini:', MD); }
  if (step === 'add_kat') { d.temp.kat = input; await setAdminState(chatId, 'add_desc', d); return tg.sendMessage(chatId, '📜 Kirimkan *Deskripsi* panjang produknya:', MD); }
  if (step === 'add_desc') { d.temp.desc = input; await setAdminState(chatId, 'add_hrg', d); return tg.sendMessage(chatId, '💰 Kirimkan *Harga* (Contoh: 50000 atau Dapat 2: 25000):', MD); }
  if (step === 'add_hrg') { d.temp.hrg = input; await setAdminState(chatId, 'add_stok', d); return tg.sendMessage(chatId, '📦 Kirimkan jumlah *Stok*:', MD); }
  if (step === 'add_stok') { d.temp.stok = input; await setAdminState(chatId, 'add_foto', d); return tg.sendMessage(chatId, '📸 *Terakhir!* Silakan kirim (Upload) *FOTO PRODUK* tersebut ke sini:', MD); }
  if (step === 'add_foto') {
    if (!hasPhoto) return tg.sendMessage(chatId, '❌ Harap kirimkan gambar/foto yang valid.');
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
    return;
  }

  // --- Edit produk ---
  if (step === 'edit_find') {
    const wait = await tg.sendMessage(chatId, '⏳ _Mencari produk..._', MD);
    const prod = await getProduk(input);
    await tg.deleteMessage(chatId, wait.message_id);
    if (!prod) return tg.sendMessage(chatId, '❌ Produk tidak ditemukan. Silakan kirimkan ID yang benar, atau ketik /batal.');
    await setAdminState(chatId, 'edit_nama', { temp: prod });
    return tg.sendMessage(chatId, `Data ditemukan: *${prod.nama}*\n\n📝 Kirimkan *Nama Produk Baru*.\n_(💡 Ketik strip "-" jika tidak ingin mengubah ini)_`, MD);
  }
  if (step === 'edit_nama') { if (input !== '-') d.temp.nama = input; await setAdminState(chatId, 'edit_kat', d); return tg.sendMessage(chatId, `🏷️ Kirimkan *Kategori Baru*.\nSaat ini: ${d.temp.kat}\n_(Ketik "-" untuk skip)_`, MD); }
  if (step === 'edit_kat') { if (input !== '-') d.temp.kat = input; await setAdminState(chatId, 'edit_desc', d); return tg.sendMessage(chatId, `📜 Kirimkan *Deskripsi Baru*.\n_(Ketik "-" untuk skip)_`, MD); }
  if (step === 'edit_desc') { if (input !== '-') d.temp.desc = input; await setAdminState(chatId, 'edit_hrg', d); return tg.sendMessage(chatId, `💰 Kirimkan *Harga Baru*.\nSaat ini: ${d.temp.hrg}\n_(Ketik "-" untuk skip)_`, MD); }
  if (step === 'edit_hrg') { if (input !== '-') d.temp.hrg = input; await setAdminState(chatId, 'edit_stok', d); return tg.sendMessage(chatId, `📦 Kirimkan *Stok Baru*.\nSaat ini: ${d.temp.stok}\n_(Ketik "-" untuk skip)_`, MD); }
  if (step === 'edit_stok') { if (input !== '-') d.temp.stok = input; await setAdminState(chatId, 'edit_foto', d); return tg.sendMessage(chatId, `📸 Terakhir, Kirimkan *Foto Produk Baru*.\n_(💡 Ketik "-" jika Anda tetap ingin menggunakan foto yang lama)_`, MD); }
  if (step === 'edit_foto') {
    const wait = await tg.sendMessage(chatId, '⏳ _Memperbarui database..._', MD);
    try {
      if (hasPhoto) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        d.temp.link = await tg.getFileUrl(fileId);
      } else if (input !== '-') {
        await tg.editMessageText(chatId, wait.message_id, "❌ Harap kirimkan gambar/foto, atau ketik '-' untuk melewati proses edit foto.");
        return;
      }
      await saveProduk(d.temp);
      await logActivity('produk', `Produk ${d.temp.id} diperbarui: ${d.temp.nama}`);
      await tg.editMessageText(chatId, wait.message_id,
        `✅ *Produk Berhasil Diperbarui!*\n\n📦 ID: ${d.temp.id}\n🏷️ Nama: ${d.temp.nama}`,
        { ...MD, ...kb(BACK_MAIN) });
    } catch { await tg.editMessageText(chatId, wait.message_id, '❌ Gagal memperbarui database.'); }
    await clearAdminState(chatId);
    return;
  }

  // --- Cek pesanan ---
  if (step === 'input_cek') {
    const q = input.toLowerCase();
    const wait = await tg.sendMessage(chatId, '⏳ _Mencari data di database..._', MD);
    try {
      const res = await getAllData();
      const row = res.data.slice(1).find((r) =>
        String(r[0] || '').toLowerCase().includes(q) ||
        String(r[2] || '').toLowerCase().includes(q) ||
        String(r[3] || '').includes(q));
      if (row) {
        const items = await getOrderItems(row[0]);
        const pesanan = items.length ? items.map((i) => `• ${i.nama_produk} (${i.qty}x)`).join('\n') : '-';
        await tg.editMessageText(chatId, wait.message_id,
          `📦 *DETAIL (${row[0]})*\n👤 *Nama:* ${row[2]}\n📱 *WA:* ${row[3]}\n📍 *Alamat:* ${row[4]}\n🛒 *Pesanan:* \n${pesanan}\n💰 *Total:* ${rp(row[6])}\n🚦 *Status:* ${row[7]}`, MD);
      } else {
        await tg.editMessageText(chatId, wait.message_id, `❌ Data dengan kata kunci *${input}* tidak ditemukan.`, MD);
      }
    } catch (e) { await tg.editMessageText(chatId, wait.message_id, `❌ *Terjadi Error:* ${e.message}`, MD); }
    await clearAdminState(chatId);
    return;
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
    return;
  }

  // --- Edukasi: kirim form / produk ke WA pelanggan ---
  if (step.startsWith('input_wa_edu_')) {
    const wa = formatWA(input);
    const jenis = step.split('_')[3];
    if (jenis === 'prod') {
      await setAdminState(chatId, 'input_id_edu_prod', { tempWa: wa });
      return tg.sendMessage(chatId, `✅ Nomor WA tersimpan: *${wa}*\n\n📦 Sekarang ketikkan *Kode/ID Produk* dari katalog:`, MD);
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
    return tg.sendMessage(chatId, `✅ Form berhasil dikirim ke WA pelanggan (${wa}) dengan kop/profil Usaha Anda!`);
  }

  if (step === 'input_id_edu_prod') {
    const wa = d.tempWa;
    const idProduk = input.toUpperCase();
    const wait = await tg.sendMessage(chatId, '⏳ _Mencari data produk dan mengirim..._', MD);
    try {
      const prod = await getProduk(idProduk);
      if (!prod) {
        await tg.editMessageText(chatId, wait.message_id, `❌ Produk dengan ID *${idProduk}* tidak ditemukan. Silakan kirimkan ID yang benar atau ketik /batal.`, MD);
        return;
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
    return;
  }

  return null;
}

// ---------- Foto tanpa state: OCR resi otomatis ----------
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
  // Foto polos → OCR, cocokkan ID pesanan
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  await tg.sendMessage(chatId, '⏳ _Foto ditambahkan ke antrean AI (Otomatis)..._', { ...MD, reply_to_message_id: msg.message_id });
  const fileUrl = await tg.getFileUrl(fileId).catch(() => null);
  const ocr = fileUrl ? await ocrImage(fileUrl) : { ok: false };
  if (!ocr.ok) return tg.sendMessage(chatId, '❌ *GAGAL:* Gambar tidak terbaca oleh AI.', { ...MD, reply_to_message_id: msg.message_id });
  const ocrText = ocr.text.toUpperCase();
  const res = await getAllData();
  const orderMatch = res.data.slice(1).find((r) => {
    const idDb = String(r[0] || '').toUpperCase();
    return idDb.length > 3 && ocrText.includes(idDb);
  });
  if (!orderMatch) return tg.sendMessage(chatId, '❌ *TIDAK COCOK:* AI salah baca atau nomor tidak ada di database.', { ...MD, reply_to_message_id: msg.message_id });
  const hari = await kirimResiKeCustomer(chatId, orderMatch[0], fileUrl, true);
  return tg.sendMessage(chatId, `✅ *BERHASIL: Resi ${orderMatch[0]} terkirim!* Timer: ${hari} Hari.`, { ...MD, reply_to_message_id: msg.message_id });
}

// ---------- Pintasan marketplace: !\n[resi]\n[wa] ----------
async function handleMarketplace(chatId, text) {
  const parts = text.substring(1).trim().split(/\r?\n|\s+/);
  if (parts.length < 2) return null;
  const idPesanan = parts[0].trim().toUpperCase();
  const nowa = formatWA(parts.slice(1).join(''));
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const p = (n) => String(n).padStart(2, '0');
  const tglOrder = `${p(now.getDate())}/${p(now.getMonth() + 1)}/${now.getFullYear()}`;
  try {
    const res = await getAllData();
    const isExist = res.data.slice(1).find((r) => String(r[0]).toUpperCase() === idPesanan);
    if (isExist) return tg.sendMessage(chatId, `⚠️ *Gagal Menyimpan*\nNomor Pesanan/Resi *${idPesanan}* sudah ada di dalam database!`, MD);
    await sbPost('orders', [{
      id: idPesanan, nama_penerima: 'Customer MKT', nomor_wa: nowa, alamat_lengkap: 'Marketplace',
      total_harga: 0, status: 'diproses', nomor_resi: idPesanan,
    }], 'return=minimal');
    await logActivity('order', `Pesanan marketplace ${idPesanan}, WA ${nowa}. Status Diproses.`);
    return tg.sendMessage(chatId, `✅ *Data Marketplace Tersimpan!*\n📦 Resi: *${idPesanan}*\n📱 WA: *${nowa}*\n🚦 Status: *Diproses ⚙️*`, MD);
  } catch { return tg.sendMessage(chatId, '❌ Gagal.'); }
}

// ---------- Template order terisi → buat order + QRIS ----------
async function handleTemplateOrder(chatId, text) {
  const waMatch = text.match(/Nomor wa Penerima:\s*(.+)/i);
  if (!waMatch) return tg.sendMessage(chatId, '❌ WA wajib isi!');
  const namaMatch = text.match(/Nama Penerima:\s*(.+)/i);
  const alamatMatch = text.match(/Alamat lengkap:\s*(.+)/i);
  const namaPenerima = namaMatch ? namaMatch[1].trim() : 'Customer';
  const alamatPenerima = alamatMatch ? alamatMatch[1].trim() : '-';
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
  try {
    const qris = await payinaja.createQRIS(totalKeseluruhan, idPesanan, namaPenerima, nowa);
    if (!qris.ok) return tg.sendMessage(chatId, `❌ Gagal QRIS. Alasan dari Payinaja: ${qris.error}`);
    await sbPost('orders', [{
      id: idPesanan, nama_penerima: namaPenerima, nomor_wa: nowa, alamat_lengkap: alamatPenerima,
      total_harga: totalKeseluruhan, status: 'pending', payment_trx_id: qris.trx_id,
    }], 'return=minimal');
    for (let i = 0; i < prod.length; i++) {
      const q = parseInt(qty[i][1], 10) || 0; const h = parseInt(String(hrg[i][1]).replace(/[^0-9]/g, ''), 10) || 0;
      await sbPost('order_items', [{ order_id: idPesanan, nama_produk: prod[i][1].trim(), qty: q, harga_satuan: h }], 'return=minimal').catch(() => {});
    }
    await queueWA(nowa, 'image', qris.qr_image_url,
      `Halo kak *${namaPenerima}*!\nID: *${idPesanan}*\n\n${detailStruk}\n*TOTAL: ${rp(totalKeseluruhan)}*\nSilakan scan QRIS untuk membayar.`);
    await logActivity('order', `Pesanan baru ${idPesanan} (template admin): ${rp(totalKeseluruhan)}. QRIS terkirim.`);
    return tg.sendMessage(chatId, `✅ Sukses! QRIS terkirim untuk *${idPesanan}*.`, MD);
  } catch { return tg.sendMessage(chatId, '❌ Error jaringan saat menghubungi API.'); }
}

module.exports = { showHome, handleCallback, handleMessage, getAdminState, setAdminState, clearAdminState, queueWA, getProfile };
