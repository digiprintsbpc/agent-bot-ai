/**
 * whatsapp.js — WA panel TOKO (Baileys), mode TRANSASKIONAL SAJA, TANPA AI.
 *
 * Yang AKTIF:
 *   1. !cek <ID / no resi>   → self-service cek status pesanan
 *   2. !menu                 → daftar perintah
 *   3. Auto-cek pembayaran QRIS (PayinAja) tiap 10 detik
 *   4. Processor wa_outbox: Vercel tulis antrean, panel kirim via Baileys
 *   5. Auto-reply JAM TUTUP (21:00–08:00 WIB), sekali per nomor per malam
 *
 * Yang SUDAH DIHAPUS (keputusan user 19 Okt): forward chat AI ke Vercel (/api/wa),
 * ai_pause, dot-prefix pause, botSentIds. Semua chat non-perintah DIAM total.
 */
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const config = require('./config');

let waSocket = null;
let isFirstConnect = true;
let reconnectAttempt = 0; // untuk backoff reconnect
const RECONNECT_DELAYS = [5000, 15000, 30000, 60000]; // 5s → 15s → 30s → 60s (max)
let timersStarted = false;

// ---------- Supabase ----------
const SB_URL = (config.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = config.SUPABASE_SERVICE_KEY || '';

async function sbFetch(path, opts = {}) {
    const res = await fetch(`${SB_URL}${path}`, {
        ...opts,
        headers: {
            apikey: SB_KEY,
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
            ...(opts.headers || {}),
        },
        signal: AbortSignal.timeout(15000),
    });
    return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

async function kirimPesan(jid, content) {
    if (!waSocket) throw new Error('WA belum terhubung');
    return waSocket.sendMessage(jid, content);
}

// ===== 1. ANTREAN KIRIM WA (wa_outbox): Vercel tulis, panel kirim via Baileys =====
let outboxBusy = false;
async function prosesOutbox() {
    if (outboxBusy || !waSocket) return;
    outboxBusy = true;
    try {
        const r = await sbFetch('/rest/v1/wa_outbox?status=eq.pending&order=created_at&limit=10');
        if (!r.ok) return;
        const items = await r.json();
        for (const it of items) {
            try {
                const jid = String(it.to_wa).replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                const imgUrl = it.image_url || (it.kind === 'image' ? it.content : null);
                const docUrl = it.kind === 'document' ? it.content : null;
                if (docUrl) {
                    await kirimPesan(jid, {
                        document: { url: docUrl },
                        mimetype: 'application/pdf',
                        fileName: it.caption || 'invoice.pdf',
                    });
                } else if (imgUrl) {
                    await kirimPesan(jid, { image: { url: imgUrl }, caption: it.caption || it.content || '' });
                } else {
                    await kirimPesan(jid, { text: it.content });
                }
                await sbFetch(`/rest/v1/wa_outbox?id=eq.${it.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: 'sent' }),
                });
                console.log('[WA-OUTBOX] terkirim ke', it.to_wa);
                await sleep(2000); // jeda antar kirim, hindari blokir WA saat broadcast
            } catch (e) {
                console.error('[WA-OUTBOX] gagal ke', it.to_wa + ':', e.message);
                await sbFetch(`/rest/v1/wa_outbox?id=eq.${it.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: 'failed' }),
                }).catch(() => {});
            }
        }
    } catch (e) {
        console.error('[WA-OUTBOX]', e.message);
    } finally {
        outboxBusy = false;
    }
}

// ===== 2. AUTO-CEK PEMBAYARAN QRIS (PayinAja) tiap 10 detik =====
let qrisBusy = false;
async function cekPembayaranQRIS() {
    if (qrisBusy) return;
    qrisBusy = true;
    try {
        const payinajaKey = config.PAYINAJA_API_KEY || config.PAYINAJA_APIKEY || '';
        if (!payinajaKey) return;
        const r = await sbFetch(
            '/rest/v1/orders?status=eq.pending&payment_trx_id=not.is.null' +
            '&select=id,nama_penerima,nomor_wa,total_harga,payment_trx_id' +
            '&order=tanggal.desc&limit=5'
        );
        if (!r.ok) return;
        const orders = await r.json();
        for (const o of orders) {
            try {
                const cek = await fetch(
                    `https://payinaja.com/api/v1/transaction/${encodeURIComponent(o.payment_trx_id)}`,
                    {
                        headers: { 'x-api-key': payinajaKey },
                        signal: AbortSignal.timeout(15000),
                    }
                );
                const data = await cek.json().catch(() => ({}));
                const st = String(data?.data?.status || data?.status || '').toLowerCase();
                const lunas = st === 'success' || st === 'paid' || data?.data?.paid === true;
                if (lunas) {
                    console.log(`[QRIS-AUTO] ${o.id} LUNAS!`);
                    const nomor = String(o.nomor_wa || '').replace(/\D/g, '');
                    let digitalSelesai = false;
                    // === PRODUK DIGITAL: konten dikirim sekarang, status langsung selesai ===
                    try {
                        const rItems = await sbFetch(`/rest/v1/order_items?order_id=eq.${o.id}&select=produk_id,qty&produk_id=not.is.null`);
                        const itemsD = rItems.ok ? await rItems.json() : [];
                        if (itemsD.length) {
                            const idsD = [...new Set(itemsD.map((x) => x.produk_id))];
                            const rProd = await sbFetch(`/rest/v1/products?id=in.(${idsD.join(',')})&select=id,nama,tipe,template_kirim,durasi_hari`);
                            const prodsD = rProd.ok ? await rProd.json() : [];
                            if (prodsD.length && prodsD.every((p) => p.tipe === 'digital')) {
                                const rLock = await sbFetch(`/rest/v1/stok_digital?order_id=eq.${o.id}&status=eq.dikunci&select=id,produk_id,isi,isi2&order=created_at.asc`);
                                const locked = rLock.ok ? await rLock.json() : [];
                                if (locked.length && nomor.length >= 10) {
                                    const byP = {};
                                    for (const it of locked) (byP[it.produk_id] = byP[it.produk_id] || []).push(it);
                                    const kirim = [];
                                    for (const p of prodsD) {
                                        const list = byP[p.id] || [];
                                        if (!list.length) continue;
                                        const tpl = p.template_kirim || '{ISI}';
                                        const teks = list.map((it) => tpl.split('{ISI2}').join(it.isi2 || '').split('{ISI}').join(it.isi || '')).join('\n\n———\n\n');
                                        kirim.push({ product: p, teks, list });
                                    }
                                    if (kirim.length) {
                                        const rowsOut = [{
                                            to_wa: nomor, kind: 'text', status: 'pending',
                                            content: `✅ *PEMBAYARAN DITERIMA (${o.id})*\n\nHalo kak ${o.nama_penerima}! Pembayaran ${rp(o.total_harga)} sudah kami terima.\n\nPesanan digital kakak langsung kami kirim di bawah ini 👇`,
                                        }];
                                        for (const k of kirim) rowsOut.push({ to_wa: nomor, kind: 'text', status: 'pending', content: k.teks });
                                        await sbFetch('/rest/v1/wa_outbox', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rowsOut) });
                                        const nowIso = new Date().toISOString();
                                        for (const k of kirim) {
                                            const exp = k.product.durasi_hari > 0 ? new Date(Date.now() + k.product.durasi_hari * 24 * 3600 * 1000).toISOString() : null;
                                            for (const it of k.list) {
                                                await sbFetch(`/rest/v1/stok_digital?id=eq.${it.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'terjual', nomor_wa: nomor, dikirim_at: nowIso, kedaluwarsa_at: exp }) });
                                            }
                                            const rSisa = await sbFetch(`/rest/v1/stok_digital?produk_id=eq.${k.product.id}&status=eq.tersedia&select=id`);
                                            if (rSisa.ok) {
                                                const sisa = (await rSisa.json()).length;
                                                await sbFetch(`/rest/v1/products?id=eq.${k.product.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ stok: sisa }) });
                                            }
                                        }
                                        await sbFetch(`/rest/v1/orders?id=eq.${o.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'selesai' }) });
                                        console.log(`[DIGITAL] ${o.id} konten terkirim, order selesai.`);
                                        try {
                                            const logToken = config.TELEGRAM_LOG_BOT_TOKEN;
                                            if (logToken) {
                                                await fetch(`https://api.telegram.org/bot${logToken}/sendMessage`, {
                                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ chat_id: config.TELEGRAM_LOG_CHAT_ID || '5623579506', text: `📤 *WA terkirim*\nKe: \`${nomor}\`\n${'-'.repeat(40)}\n✅ PEMBAYARAN DITERIMA + KONTEN DIGITAL (${o.id})`, parse_mode: 'Markdown' }),
                                                }).catch(() => {});
                                            }
                                        } catch (e) {}
                                        digitalSelesai = true;
                                    }
                                } else if (locked.length) {
                                    console.log(`[DIGITAL] ${o.id} nomor WA tidak valid — fallback alur biasa.`);
                                } else {
                                    console.log(`[DIGITAL] ${o.id} order digital tanpa stok terkunci — fallback alur biasa.`);
                                }
                            }
                        }
                    } catch (e) { console.error(`[DIGITAL] ${o.id} gagal:`, e.message); }
                    if (!digitalSelesai) {
                    await sbFetch(`/rest/v1/orders?id=eq.${o.id}`, {
                        method: 'PATCH',
                        headers: { Prefer: 'return=minimal' },
                        body: JSON.stringify({ status: 'diproses' }),
                    });
                    if (nomor.length >= 10) {
                        await sbFetch('/rest/v1/wa_outbox', {
                            method: 'POST',
                            headers: { Prefer: 'return=minimal' },
                            body: JSON.stringify([{
                                to_wa: nomor,
                                kind: 'text',
                                status: 'pending',
                                content:
                                    `✅ *PEMBAYARAN DITERIMA (${o.id})*\n\n` +
                                    `Halo kak ${o.nama_penerima}! Pembayaran ${rp(o.total_harga)} sudah kami terima.\n\n` +
                                    `Pesanan sedang diproses. Invoice akan dikirim menyusul 🙏`,
                            }]),
                        });
                        // Log ke bot Telegram
                        try {
                            const logToken = config.TELEGRAM_LOG_BOT_TOKEN;
                            if (logToken) {
                                await fetch(`https://api.telegram.org/bot${logToken}/sendMessage`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        chat_id: config.TELEGRAM_LOG_CHAT_ID || '5623579506',
                                        text: `📤 *WA terkirim*\nKe: \`${nomor}\`\n${'-'.repeat(40)}\n✅ PEMBAYARAN DITERIMA (${o.id})`,
                                        parse_mode: 'Markdown',
                                    }),
                                }).catch(() => {});
                            }
                        } catch (e) {}
                    }
                    }
                }
            } catch (e) {
                console.error(`[QRIS-AUTO] ${o.id} gagal:`, e.message);
            }
            await sleep(1000); // jeda antar cek, hindari rate limit PayinAja
        }
    } catch (e) {
        console.error('[QRIS-AUTO]', e.message);
    } finally {
        qrisBusy = false;
    }
}

// ===== 3. AUTO-REPLY JAM TUTUP (21:00–08:00 WIB), sekali per nomor per malam =====
const jamTutupTerkirim = new Map(); // nomor -> nightKey

function infoJamTutup() {
    const fmt = (d, withTime) => new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric', month: '2-digit', day: '2-digit',
        ...(withTime ? { hour: '2-digit', hour12: false } : {}),
    }).formatToParts(d);
    const nowParts = fmt(new Date(), true);
    const val = (p, t) => p.find((x) => x.type === t)?.value;
    let hour = parseInt(val(nowParts, 'hour'), 10);
    if (hour === 24) hour = 0;
    const tutup = hour >= 21 || hour < 8;
    // nightKey: tanggal "malam ini" — kalau 00:00–07:59, milik malam kemarin
    const d = hour < 8 ? new Date(Date.now() - 24 * 3600 * 1000) : new Date();
    const dp = fmt(d, false);
    const nightKey = `${val(dp, 'year')}-${val(dp, 'month')}-${val(dp, 'day')}`;
    return { tutup, nightKey };
}

async function autoReplyJamTutup(jid, nomor) {
    const { tutup, nightKey } = infoJamTutup();
    if (!tutup) return false;
    if (jamTutupTerkirim.get(nomor) === nightKey) return true; // sudah dibalas malam ini
    jamTutupTerkirim.set(nomor, nightKey);
    console.log(`[JAM-TUTUP] auto-reply ke ${nomor}`);
    await kirimPesan(jid, {
        text:
            'Halo kak! Toko kami tutup jam 21:00–08:00. ' +
            'Pesan kakak akan kami balas pagi hari ya 🙏\n\n' +
            'Untuk cek status pesanan, ketik:\n' +
            '!cek INV-xxxxxx',
    }).catch((e) => console.error('[JAM-TUTUP] gagal kirim:', e.message));
    return true;
}

// Bersihkan penanda malam yang sudah lewat (jalan tiap jam)
setInterval(() => {
    const { nightKey } = infoJamTutup();
    for (const [nomor, key] of jamTutupTerkirim) {
        if (key !== nightKey) jamTutupTerkirim.delete(nomor);
    }
}, 3600 * 1000);

// ===== 4. PERINTAH: !cek & !menu =====
async function handleCek(jid, queryRaw) {
    const q = queryRaw.trim().replace(/[^\w-]/g, '').toUpperCase();
    if (!q) {
        await kirimPesan(jid, { text: 'Contoh: *!cek INV-123456*' });
        return;
    }
    try {
        const r = await sbFetch(
            '/rest/v1/orders?select=id,status,total_harga,nomor_resi,tanggal,nama_penerima,nama_produk,qty' +
            `&or=(id.ilike.*${encodeURIComponent(q)}*,nomor_resi.ilike.*${encodeURIComponent(q)}*)` +
            '&order=tanggal.desc&limit=3'
        );
        if (!r.ok) throw new Error('DB ' + r.status);
        const rows = await r.json();
        if (!rows.length) {
            await kirimPesan(jid, { text: `❌ ID/Resi *${q}* tidak ditemukan.` });
            return;
        }
        const d = rows[0];
        const note = rows.length > 1 ? `\n\n_(ditemukan ${rows.length}, ditampilkan yang terbaru)_` : '';
        await kirimPesan(jid, {
            text:
                `📦 *INFO PESANAN (${d.id})*\n\n` +
                `*Status:* ${d.status || '-'}\n` +
                `*Tanggal:* ${d.tanggal || '-'}\n` +
                `*Produk:* ${d.nama_produk || '-'}${d.qty ? ` (${d.qty})` : ''}\n` +
                `*Total:* ${rp(d.total_harga)}\n` +
                `*Resi:* ${d.nomor_resi || 'Belum ada resi'}` + note,
        });
        console.log('[WA] !cek', q, '→', d.id);
    } catch (e) {
        console.error('[WA] !cek gagal:', e.message);
        await kirimPesan(jid, { text: '❌ Database sibuk, coba sesaat lagi.' });
    }
}

async function handleMenu(jid) {
    await kirimPesan(jid, {
        text:
            '📋 *MENU BANTUAN*\n\n' +
            '*Perintah yang tersedia:*\n' +
            '• *!cek INV-xxxxxx* — cek status pesanan / nomor resi\n' +
            '• *!menu* — tampilkan daftar perintah ini\n\n' +
            'Untuk pertanyaan lain, silakan chat di jam buka (08:00–21:00) 🙏',
    });
}

// ===== KONEKSI dengan backoff (tanpa rekursi langsung) =====
async function connectWA(bot) {
    reconnectAttempt = 0;
    const { state, saveCreds } = await useMultiFileAuthState('sesi_wa');
    waSocket = makeWASocket({ auth: state });

    waSocket.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) {
            console.log('\n[WA] 📱 SILAKAN SCAN QR CODE INI DI APLIKASI WHATSAPP ANDA:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            console.log('[WA] ✅ WhatsApp Terhubung!');
            reconnectAttempt = 0;
            if (isFirstConnect) {
                isFirstConnect = false;
                if (bot && config.ADMIN_ID) {
                    bot.sendMessage(config.ADMIN_ID, '✅ *WA Panel (Transaksional) Siap!*', { parse_mode: 'Markdown' })
                        .catch(() => {});
                }
            }
        } else if (connection === 'close') {
            // Backoff: 5s → 15s → 30s → 60s (max), tanpa rekursi langsung
            const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
            reconnectAttempt++;
            console.log(`[WA] ⚠️ koneksi terputus, reconnect dalam ${delay / 1000}s (percobaan ${reconnectAttempt})`);
            waSocket = null;
            setTimeout(() => connectWA(bot).catch((e) => console.error('[WA] reconnect gagal:', e.message)), delay);
        }
    });

    waSocket.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg?.message) return;

        const remoteJid = msg.key.remoteJid || '';

        // Abaikan: pesan sendiri, grup, status broadcast, newsletter
        if (msg.key.fromMe) return;
        if (remoteJid.endsWith('@g.us')) return;
        if (remoteJid === 'status@broadcast') return;
        if (remoteJid.includes('@newsletter')) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const cleanText = text.trim().toLowerCase();
        const nomor = remoteJid.replace(/@.*$/, '').replace(/\D/g, '');

        try {
            // Perintah !cek → jawab kapan pun (termasuk jam tutup)
            if (cleanText === '!cek' || cleanText.startsWith('!cek ')) {
                await handleCek(remoteJid, text.trim().substring(4));
                return;
            }
            // Perintah !menu
            if (cleanText === '!menu') {
                await handleMenu(remoteJid);
                return;
            }
            // Pesan biasa di jam tutup → auto-reply sekali per malam
            const { tutup } = infoJamTutup();
            if (tutup && text.trim()) {
                await autoReplyJamTutup(remoteJid, nomor);
                return;
            }
            // Jam buka + bukan perintah → DIAM TOTAL (tanpa AI)
        } catch (e) {
            console.error('[WA] handler pesan gagal:', e.message);
        }
    });

    waSocket.ev.on('creds.update', saveCreds);
}

module.exports = {
    init: async (bot) => {
        await connectWA(bot);
        // Job terjadwal (sekali saja, bukan tiap init ulang)
        if (!timersStarted) {
            timersStarted = true;
            if (config.WA_OUTBOX_ENABLED !== false) {
                setInterval(prosesOutbox, 10000);
                setInterval(cekPembayaranQRIS, 10000);
                // Jalankan sekali di awal (tidak blokir)
                prosesOutbox().catch(() => {});
                cekPembayaranQRIS().catch(() => {});
            } else {
                console.log('[WA] WA_OUTBOX_ENABLED=false — job outbox & QRIS-auto dimatikan.');
            }
        }
    },
    getSocket: () => waSocket,
};
