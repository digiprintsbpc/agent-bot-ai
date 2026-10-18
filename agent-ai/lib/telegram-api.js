'use strict';
/** Kirim pesan ke Telegram via Bot API. */

async function sendMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN belum diisi');
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
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Telegram sendMessage ${res.status}: ${t.slice(0, 200)}`);
    }
  }
}

module.exports = { sendMessage };
