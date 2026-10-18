'use strict';
/** Kirim/ubah/hapus pesan Telegram via Bot API. */

const token = () => {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN belum diisi');
  return t;
};

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) {
    throw new Error(`Telegram ${method} ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j.result;
}

/** Kirim pesan teks. opts: { parse_mode, reply_markup, reply_to_message_id, disable_web_page_preview } */
async function sendMessage(chatId, text, opts = {}) {
  // Batas Telegram 4096 karakter — potong jadi beberapa pesan bila perlu
  const chunks = [];
  let rest = String(text);
  while (rest.length > 4000) {
    let cut = rest.lastIndexOf('\n', 4000);
    if (cut < 2000) cut = 4000;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  let last = null;
  for (const chunk of chunks) {
    last = await api('sendMessage', { chat_id: chatId, text: chunk, ...opts });
  }
  return last;
}

/** Kirim foto (bisa URL publik atau file_id). */
async function sendPhoto(chatId, photo, caption, opts = {}) {
  return api('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'Markdown', ...opts });
}

/** Jawab callback query (tutup loading / tampilkan alert). */
async function answerCallbackQuery(id, opts = {}) {
  return api('answerCallbackQuery', { callback_query_id: id, ...opts });
}

/** Ubah teks pesan yang sudah terkirim (untuk menu inline). */
async function editMessageText(chatId, messageId, text, opts = {}) {
  return api('editMessageText', { chat_id: chatId, message_id: messageId, text, ...opts });
}

/** Hapus pesan. */
async function deleteMessage(chatId, messageId) {
  try { return await api('deleteMessage', { chat_id: chatId, message_id: messageId }); }
  catch { return null; }
}

/** Kirim dokumen (dipakai untuk laporan CSV). */
async function sendDocument(chatId, buffer, filename, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([buffer]), filename);
  if (caption) form.append('caption', caption);
  const res = await fetch(`https://api.telegram.org/bot${token()}/sendDocument`, { method: 'POST', body: form });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(`Telegram sendDocument ${res.status}`);
  return j.result;
}

/** Ambil URL file Telegram dari file_id (untuk OCR / teruskan gambar). */
async function getFileUrl(fileId) {
  const f = await api('getFile', { file_id: fileId });
  return `https://api.telegram.org/file/bot${token()}/${f.file_path}`;
}

module.exports = { sendMessage, sendPhoto, answerCallbackQuery, editMessageText, deleteMessage, sendDocument, getFileUrl };
