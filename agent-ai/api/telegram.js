'use strict';
/**
 * Webhook Telegram -> Vercel Serverless Function.
 * Alur: verifikasi -> allowlist -> command/skill routing -> LLM (failover) -> balas.
 *
 * Pasang webhook sekali (ganti TOKEN & URL):
 * https://api.telegram.org/botTOKEN/setWebhook?url=https://PROJECT.vercel.app/api/telegram&secret_token=RAHASIA
 */

const { opt } = require('../lib/env');
const { sendMessage } = require('../lib/telegram-api');
const { chat } = require('../lib/llm');
const memory = require('../lib/memory');
const toko = require('../lib/toko');
const security = require('../lib/security');
const customer = require('../lib/customer');

const GREETING_RE = /^(halo+|hallo+|hai+|hello+|hi+|pagi+|siang+|sore+|malam+|assalamu\s*alaikum|tes|test)(\s+k[ak]+)?[!?.\s]*$/i;
const GREETINGS = [
  'Halo juga Kak! Ada yang bisa saya bantu? 😊',
  'Halo Kak, selamat datang! Mau tanya apa hari ini? 😊',
  'Hai Kak! Ada yang bisa saya bantu? 😊',
];

const PERSONA = `Kamu adalah asisten pribadi Rizal yang ramah dan santai, bicara Bahasa Indonesia kasual.
Kamu ingat percakapan sebelumnya (diberi sebagai riwayat) dan catatan penting tentang Rizal.
Jawab singkat dan natural seperti chat, jangan kaku. Jika tidak tahu, katakan terus terang.`;

async function handleText(userId, text) {
  const q = text.trim();

  // --- Command ---
  if (q === '/start') {
    return 'Halo Kak! Saya asisten pribadimu. Bisa ngobrol, bantu jawab soal toko (stok, pesanan, omset), ingat catatan, dan review keamanan kode.\n\nPerintah:\n/ingat <teks> — simpan catatan\n/catatan — lihat semua catatan\n/toko <tanya> — tanya soal toko\n/audit <tanya/kode> — review keamanan';
  }
  const ingatMatch = q.match(/^(?:\/ingat|ingat(?: bahwa)?)\s+(.+)/i);
  if (ingatMatch) {
    await memory.saveNote(userId, ingatMatch[1]);
    await memory.logActivity(userId, 'note', `Catatan disimpan: ${ingatMatch[1].slice(0, 80)}`);
    return 'Siap, sudah saya ingat. 👍';
  }
  if (/^\/catatan|^(apa (saja )?yang kamu ingat|lihat catatan)/i.test(q)) {
    const notes = await memory.getNotes(userId);
    if (!notes.length) return 'Belum ada catatan yang tersimpan.';
    return 'Yang saya ingat:\n' + notes.map((n, i) => `${i + 1}. ${n.note}`).join('\n');
  }

  // --- Sapaan: tanpa API call (hemat kuota) ---
  if (GREETING_RE.test(q)) {
    return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  }

  // --- Skill TOKO ---
  const tokoMatch = q.match(/^\/toko\s+(.+)/i);
  try {
    const res = await toko.answer(tokoMatch ? tokoMatch[1] : q);
    if (res.usedDb) {
      await memory.logActivity(userId, 'toko', q.slice(0, 80));
      return res.answer;
    }
  } catch (e) {
    console.error('[toko] gagal:', e.message);
    if (tokoMatch) return `Skill toko lagi bermasalah: ${e.message}`;
    // tanpa /toko: lanjut ke general chat
  }

  // --- Skill SECURITY-AUDIT ---
  const auditMatch = q.match(/^\/audit\s+(.+)/is);
  if (auditMatch || security.isSecurityQuestion(q)) {
    const target = auditMatch ? auditMatch[1] : q;
    const answer = await chat(
      [
        { role: 'system', content: security.SYSTEM },
        { role: 'user', content: target },
      ],
      { maxTokens: 1500, temperature: 0.2 }
    );
    await memory.logActivity(userId, 'security', q.slice(0, 80));
    return answer;
  }

  // --- General chat + memory (obsidian-mind: ingatan menumpuk) ---
  const history = await memory.getHistory(userId, 20);
  const notes = await memory.getNotes(userId, 10);
  const context = notes.length
    ? `Catatan tentang Rizal:\n${notes.map((n) => `- ${n.note}`).join('\n')}\n\n`
    : '';
  const answer = await chat(
    [
      { role: 'system', content: `${PERSONA}\n\n${context}Jawab berdasarkan riwayat di bawah bila relevan.` },
      ...history,
      { role: 'user', content: q },
    ],
    { maxTokens: 800, temperature: 0.4 }
  );
  await memory.logActivity(userId, 'chat', q.slice(0, 80));
  return answer;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(200).send('agent-ai ok');

    // Verifikasi secret webhook (opsional tapi disarankan)
    const secret = opt('WEBHOOK_SECRET', '');
    if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
      return res.status(401).send('unauthorized');
    }

    const update = req.body || {};
    const msg = update.message;
    if (!msg) return res.status(200).send('ok');

    const userId = String(msg.chat.id);
    const allowed = opt('TELEGRAM_ALLOWED_ID', '');
    const isOwner = !allowed || userId === allowed;

    // Pelanggan kirim foto (tanpa teks) → minta teks
    if (!isOwner && msg.photo && !msg.text) {
      await sendMessage(userId, 'Untuk pesan barang, kirim dalam bentuk teks ya kak 😊').catch(() => {});
      return res.status(200).send('ok');
    }
    if (!msg.text) return res.status(200).send('ok');

    const text = String(msg.text);
    console.log(`[msg] ${userId}${isOwner ? ' (owner)' : ' (customer)'}: ${text.slice(0, 80)}`);

    // ---------- MODE PELANGGAN ----------
    if (!isOwner) {
      let reply;
      try {
        reply = await customer.handleCustomer(userId, text);
      } catch (e) {
        console.error('[customer] error:', e.message);
        reply = 'Maaf kak, ada gangguan sebentar. Coba lagi ya.';
      }
      // reply null = sudah dibalas di dalam (mis. foto QRIS)
      if (reply) await sendMessage(userId, reply).catch((e) => console.error('[send] gagal:', e.message));
      else await memory.logActivity('customer', 'toko', `Pesanan pelanggan ${userId}: ${text.slice(0, 60)}`).catch(() => {});
      return res.status(200).send('ok');
    }

    // ---------- MODE OWNER (asisten pribadi) ----------
    await memory.saveMessage(userId, 'user', text);
    let reply;
    try {
      reply = await handleText(userId, text);
    } catch (e) {
      console.error('[handler] error:', e.message);
      reply = e.message.includes('429') || e.message.includes('quota')
        ? 'AI-nya lagi kena batas pemakaian gratis, coba lagi sebentar ya 🙏'
        : 'Maaf, ada gangguan sebentar. Coba lagi ya.';
    }
    await memory.saveMessage(userId, 'assistant', reply);
    await sendMessage(userId, reply);

    return res.status(200).send('ok');
  } catch (e) {
    console.error('[webhook] fatal:', e.message);
    return res.status(200).send('ok'); // selalu 200 agar Telegram tidak retry membabi-buta
  }
};
