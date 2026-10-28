'use strict';
/**
 * lib/penerjemah.js — LAPISAN PENERJEMAH untuk chat owner/admin SAJA.
 * Dipasang di api/telegram.js SETELAH admin.handleMessage dan SEBELUM
 * handleText general chat. Template order customer TIDAK disentuh di sini
 * (tetap berformat, sesuai keputusan pemilik).
 *
 * ARSITEKTUR (pemisah obrolan vs operasi — pelajaran kasus Rosita):
 *   1. klasifikasiMaksud(teks) -> perintah TERSTRUKTUR (pola deterministik).
 *   2. Perintah dieksekusi KODE via lib/orderLookup.js (query database).
 *   3. Jawaban disusun dari baris database nyata.
 * Tidak ada LLM di modul ini: klasifikasi berbasis pola, jadi maksud yang
 * tidak dikenali menghasilkan KLARIFIKASI, bukan karangan. Bila suatu saat
 * klasifikasi ingin memakai LLM, ia hanya boleh menggantikan langkah 1
 * (menghasilkan objek perintah yang sama) dan tetap wajib lewat validasi
 * allowlist + eksekusi deterministik di bawah — tidak boleh mengubah
 * langkah 2/3.
 *
 * KONTRAK RETURN (sama seperti admin.handleMessage):
 *   string -> kirim sebagai balasan; true -> sudah terkirim di dalam;
 *   null   -> tidak di-handle, lanjut ke handleText.
 *
 * ATURAN KERAS:
 * - Pertanyaan apa pun yang mengandung sinyal order (ID/pola order, status
 *   order, nomor/nama dalam konteks order) TIDAK PERNAH diteruskan ke chat AI:
 *   dijawab deterministik atau dijawab klarifikasi.
 * - AKSI TULIS/UBAH tidak pernah dieksekusi langsung dari bahasa bebas:
 *   selalu lewat DRAF + konfirmasi "YA" (state admin_states, step tr_draft).
 * - Semua ID order, resi, dan nomor WA ditulis sebagai kode tap-to-copy
 *   (backtick), mis. `INV-537328`.
 * - Hanya produk fisik. Nol referensi digital.
 */

const lookup = require('./orderLookup');
const admin = require('./admin');

const DRAFT_TTL_MS = 30 * 60 * 1000;
const CONFIRM_RE = /^(ya|iya|iya dong|oke|ok|lanjut|setuju|konfirmasi)[\s.!]*$/i;
const REJECT_RE = /^(tidak|gak|nggak|ga|batalkan|batal)[\s.!]*$/i;

const STATUS_WORDS = ['selesai', 'dikirim', 'diproses', 'dibatalkan', 'batal', 'pending'];
const STATUS_ALIAS = { dibatalkan: 'batal', 'belum bayar': 'pending', 'belum dibayar': 'pending', 'dalam proses': 'diproses', terkirim: 'dikirim' };

function normStatus(w) {
  const s = String(w || '').toLowerCase().trim();
  return STATUS_ALIAS[s] || s;
}

function cleanName(s) {
  return String(s || '')
    .replace(/[?.!,]+$/g, '')
    .replace(/^(tolong|mohon)\s+/i, '')
    .replace(/\s+(dong|ya|tolong)$/i, '')
    .trim();
}

/**
 * Klasifikasi deterministik: teks bebas -> perintah terstruktur.
 * Mengembalikan objek perintah atau null (tidak dikenali).
 */
function klasifikasiMaksud(text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  const digits = lookup.extractOrderDigits(t);
  const phoneMatch = t.match(/\b(62\d{9,}|08\d{8,})\b/);

  // ---- AKSI TULIS: draf ubah status ----
  const writeVerb = /(rubah|ubah|ganti|jadikan|tandai|set|update)\b/i.test(t);
  const sudahTarget = t.match(/\bsudah\s+(selesai|dikirim|diproses|dibatalkan|batal|pending)\b/i);
  const targetWord = sudahTarget
    ? sudahTarget[1]
    : (t.match(/\b(selesai|dikirim|diproses|dibatalkan|batal|pending)\b/i) || [])[1];
  if (writeVerb && targetWord && digits) {
    return { intent: 'draft_status', digits, target: normStatus(targetWord) };
  }
  if (writeVerb && targetWord && !digits) {
    return { intent: 'butuh_id', aksi: 'ubah status', target: normStatus(targetWord) };
  }

  // ---- AKSI TULIS: draf kirim QRIS ulang (frasa bebas; bentuk eksak sudah ditangani admin) ----
  if (/(kirim|buatkan|buatin|minta)\b[^.]{0,40}\bqris\b/i.test(t) && digits) {
    return { intent: 'draft_qris', digits };
  }

  // ---- PERTANYAAN FIELD ORDER (butuh kandidat ID) ----
  if (digits) {
    if (/\bnama(nya)?\b/i.test(t) && /(siapa|nya|pemilik|penerima|dong)/i.test(t)) {
      return { intent: 'order_field', digits, field: 'nama' };
    }
    if (/\b(nomor|no\.?)\s*(wa|hp|telepon|telp|telfon|penerima)\b/i.test(t)) {
      return { intent: 'order_field', digits, field: 'nomor' };
    }
    if (/\balamat\b/i.test(t)) {
      return { intent: 'order_field', digits, field: 'alamat' };
    }
    if (/\bresi\b/i.test(t)) {
      return { intent: 'order_field', digits, field: 'resi' };
    }
    if (/\b(total|harga|nominal)\b/i.test(t)) {
      return { intent: 'order_field', digits, field: 'total' };
    }
    if (/\bstatus\b/i.test(t)) {
      return { intent: 'order_field', digits, field: 'status' };
    }
    // Kandidat ID + konteks order lain -> template lengkap.
    if (/\b(invoice|pesanan|order|tagihan|cek|lihat|gimana|bagaimana|mana|dong)\b/i.test(t) || /^\s*\d/.test(t)) {
      return { intent: 'order_full', digits };
    }
  }

  // ---- RIWAYAT BERDASARKAN NOMOR WA ----
  if (phoneMatch && /\b(pesanan|pesan|order|riwayat|belanja|cek|history|customer)\b/i.test(t)) {
    return { intent: 'wa_history', wa: phoneMatch[1] };
  }

  // ---- DAFTAR ORDER PER STATUS ----
  const aliasStatus = low.match(/belum\s+(bayar|dibayar)/) ? 'pending'
    : low.match(/dalam\s+proses/) ? 'diproses'
    : null;
  const statusWord = aliasStatus
    || (low.match(/\b(pending|diproses|dikirim|selesai|batal)\b/) || [])[1];
  if (statusWord && !digits && (
    /\b(ada|daftar|list|tampilkan|lihat|yang|apa|masih|kah|dong|lah|kan)\b/i.test(t)
    || /\bpesanan\s+(pending|diproses|dikirim|selesai|batal)\b/i.test(t)
    || /\border\s+(pending|diproses|dikirim|selesai|batal|belum\s+(bayar|dibayar))\b/i.test(t)
    || /\bstatus(nya)?\s+(diproses|dikirim|selesai|pending|batal)\b/i.test(t)
    || (aliasStatus && /\b(order|pesanan)\b/i.test(t))
  )) {
    return { intent: 'status_list', status: normStatus(statusWord), todayOnly: /hari ini/i.test(t) };
  }

  // ---- OMSET DETERMINISTIK ----
  if (/\bomset\b/i.test(t)) {
    const period = /kemarin/i.test(t) ? 'kemarin'
      : /minggu ini/i.test(t) ? 'minggu'
      : /bulan lalu/i.test(t) ? 'bulan_lalu'
      : /hari ini/i.test(t) ? 'hari'
      : 'bulan';
    return { intent: 'omset', period };
  }

  // ---- KATALOG PRODUK DENGAN FILTER ----
  if (/\b(produk|katalog|nota)\b/i.test(t) && /\b(ply|1\/\d+|daftar|list|harga|katalog|produk|nota)\b/i.test(t)) {
    const plyMatch = t.match(/([123])\s*ply/i);
    const ukuranMatch = t.match(/(1\/\d+)/);
    const explicit = /^\s*(katalog|daftar harga)\s*$/i.test(t)
      || /\bsemua produk\b/i.test(t)
      || /\btampilkan semua\b/i.test(t)
      || /\bdaftar harga lengkap\b/i.test(t);
    return {
      intent: 'catalog',
      ply: plyMatch ? plyMatch[1] : null,
      ukuran: ukuranMatch ? ukuranMatch[1] : null,
      explicit,
    };
  }

  // ---- CARI CUSTOMER / RIWAYAT BELANJA (dari tabel orders, BUKAN customers) ----
  const cariMatch = t.match(/(?:cari\s+customer|riwayat\s+belanja|pesanan\s+(?:atas\s+nama|punya|si|dari)|^customer\s+)(.+)/i);
  if (cariMatch) {
    const name = cleanName(cariMatch[1]);
    if (name && name.length >= 2 && !/^(saya|aku|gue|kakak|kemarin|hari ini)$/i.test(name)) {
      return { intent: 'name_history', name };
    }
  }
  const looseName = t.match(/^pesanan\s+([a-zA-ZÀ-ÿ ]{3,})$/i);
  if (looseName) {
    const name = cleanName(looseName[1]);
    if (name && !/^(saya|aku|gue|kakak|kemarin|hari ini|pending|diproses|dikirim|selesai|batal)$/i.test(name)) {
      return { intent: 'name_history', name };
    }
  }

  // ---- DAFTAR NOMOR WA PENERIMA (tanpa kualifikasi) ----
  if (/^\s*(daftar\s+)?nomor\s+(wa\s+)?penerima\s*[?.!]*$/i.test(t)
    || /^\s*nomor\s+penerima\s*[?.!]*$/i.test(t)) {
    return { intent: 'wa_list' };
  }

  return null;
}

/** Sinyal order: pertanyaan yang menyangkut order -> tidak boleh ke chat AI. */
function orderSignal(text) {
  const t = String(text || '');
  if (/(inv|nv)\s*-?\s*\d/i.test(t)) return true;
  if (/\b(invoice|pesanan|order|resi|penerima|tagihan)\b/i.test(t) && /\d{3,}/.test(t)) return true;
  if (/\bstatus\s+pesanan\b/i.test(t)) return true;
  if (/\bnomor\s+(wa|hp|penerima)\b/i.test(t) && /\d/.test(t)) return true;
  if (/\b(rubah|ubah|ganti|jadikan|tandai)\b/i.test(t) && /\b(status|menjadi|jadi)\b/i.test(t)) return true;
  return false;
}

async function resolveOrExplain(digits) {
  try {
    const r = await lookup.resolveOrder(digits);
    if (r.status === 'found') {
      const full = await lookup.fetchOrderFull(r.order.id);
      return { ok: true, order: full ? full.order : r.order, items: full ? full.items : [] };
    }
    if (r.status === 'multi') {
      return {
        ok: false,
        reply: `Ada *${r.candidates.length}* order yang cocok dengan pola "${digits}":\n`
          + r.candidates.map((o) => `- ${lookup.code(o.id)} — ${o.nama_penerima || '-'} (${o.status})`).join('\n')
          + `\nSebutkan nomor lengkapnya, contoh: ${lookup.code(r.candidates[0].id)}.`,
      };
    }
    return { ok: false, reply: lookup.NOT_FOUND };
  } catch (e) {
    console.error('[penerjemah] resolve gagal:', e.message);
    return { ok: false, reply: 'Maaf, database sedang tidak bisa diakses untuk cek order. Coba lagi nanti ya.' };
  }
}

async function handleTranslator(userId, text, msg) {
  const t = String(text || '').trim();
  if (!t) return null;

  // ---- DRAF TERTUNDA: konfirmasi / penolakan / kedaluwarsa ----
  let st = null;
  try { st = await admin.getAdminState(userId); } catch { st = null; }
  if (st && st.step === 'tr_draft') {
    const d = st.data || {};
    const expired = !d.createdAt || (Date.now() - Number(d.createdAt) > DRAFT_TTL_MS);
    if (CONFIRM_RE.test(t) && !expired) {
      await admin.clearAdminState(userId);
      try {
        const r = await admin.handleMessage(userId, { text: d.canonical });
        if (typeof r === 'string' && r) return r;
        return true; // sudah terkirim di dalam handler admin
      } catch (e) {
        return `❌ Gagal menjalankan draf: ${e.message}. Tidak ada perubahan di database.`;
      }
    }
    if (REJECT_RE.test(t) || expired) {
      await admin.clearAdminState(userId);
      return expired
        ? 'Draf perintah sudah kedaluwarsa (lebih dari 30 menit). Silakan ulangi perintahnya.'
        : 'Draf dibatalkan. Tidak ada perubahan di database.';
    }
    // Pesan baru lain -> draf lama diganti oleh maksud baru di bawah.
    await admin.clearAdminState(userId);
  }

  const cmd = klasifikasiMaksud(t);
  if (!cmd) {
    if (orderSignal(t)) {
      return 'Saya belum bisa memastikan order yang dimaksud. Kirim nomor INV lengkap (contoh: `INV-537328`), atau sebutkan nama/statusnya — saya tidak mau menebak dari data yang tidak lengkap.';
    }
    return null;
  }

  try {
    switch (cmd.intent) {
      case 'butuh_id':
        return `Siap — ubah status jadi *${cmd.target}* untuk order yang mana? Kirim ID-nya, contoh: \`rubah status INV-123456 menjadi ${cmd.target}\`.`;

      case 'order_full': {
        const r = await resolveOrExplain(cmd.digits);
        if (!r.ok) return r.reply;
        return lookup.formatOrderFull(r.order, r.items);
      }

      case 'order_field': {
        const r = await resolveOrExplain(cmd.digits);
        if (!r.ok) return r.reply;
        return lookup.formatField(r.order, cmd.field);
      }

      case 'status_list':
        return await lookup.listByStatus(cmd.status, { todayOnly: cmd.todayOnly });

      case 'wa_history':
        return await lookup.historyByWA(cmd.wa);

      case 'name_history':
        return await lookup.historyByName(cmd.name);

      case 'wa_list':
        return await lookup.distinctWAList();

      case 'omset':
        return await lookup.omset(cmd.period);

      case 'catalog':
        return await lookup.catalogFilter({ ply: cmd.ply, ukuran: cmd.ukuran, explicit: cmd.explicit });

      case 'draft_status': {
        const r = await resolveOrExplain(cmd.digits);
        if (!r.ok) return r.reply;
        if (r.order.status === cmd.target) {
          return `Status ${lookup.code(r.order.id)} sudah *${cmd.target}*. Tidak ada yang diubah.`;
        }
        const canonical = `rubah status ${r.order.id} menjadi ${cmd.target}`;
        await admin.setAdminState(userId, 'tr_draft', {
          aksi: 'ubah_status', orderId: r.order.id, target: cmd.target,
          canonical, createdAt: Date.now(),
        });
        return `📝 *DRAF PERINTAH — perlu konfirmasi*\n`
          + `Aksi: Ubah status ${lookup.code(r.order.id)} (${r.order.nama_penerima || '-'}) dari *${r.order.status}* menjadi *${cmd.target}*.\n`
          + `Ketik *YA* untuk menjalankan, atau */batal* untuk membatalkan.`;
      }

      case 'draft_qris': {
        const r = await resolveOrExplain(cmd.digits);
        if (!r.ok) return r.reply;
        if (r.order.status !== 'pending') {
          return `Order ${lookup.code(r.order.id)} statusnya *${r.order.status}*, bukan pending — QRIS tidak dibuat ulang.`;
        }
        const canonical = `kirim qris ${r.order.id}`;
        await admin.setAdminState(userId, 'tr_draft', {
          aksi: 'kirim_qris', orderId: r.order.id,
          canonical, createdAt: Date.now(),
        });
        return `📝 *DRAF PERINTAH — perlu konfirmasi*\n`
          + `Aksi: Buat QRIS baru untuk ${lookup.code(r.order.id)} (${r.order.nama_penerima || '-'}, ${lookup.rp(r.order.total_harga)}). QRIS lama tidak berlaku lagi.\n`
          + `Ketik *YA* untuk menjalankan, atau */batal* untuk membatalkan.`;
      }

      default:
        return null;
    }
  } catch (e) {
    console.error('[penerjemah] eksekusi gagal:', e.message);
    return 'Maaf, database sedang tidak bisa diakses. Coba lagi nanti ya.';
  }
}

module.exports = { handleTranslator, klasifikasiMaksud, orderSignal };
