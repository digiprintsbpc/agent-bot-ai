'use strict';
/**
 * GET /api/kantor-state — state kantor 3D (kontrak frontend kantor-agent),
 * dibangun dari tabel agent_activity di Supabase.
 *
 * Pemetaan tim:
 *   Ketua  : Lexa (sang agent)
 *   Tim    : Ngobrol (chat), Toko (toko), Security (security), Catatan (note)
 */

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const KETUA = { name: 'Lexa', role: 'Ketua', color: '#6a55c9' };
const TEAM = [
  { kind: 'chat', name: 'Ngobrol', role: 'Asisten pribadi', color: '#3f6fd1' },
  { kind: 'toko', name: 'Toko', role: 'Stok & pesanan', color: '#2f9a6d' },
  { kind: 'security', name: 'Security', role: 'Audit keamanan', color: '#d9772f' },
  { kind: 'note', name: 'Catatan', role: 'Ingatan penting', color: '#c2417a' },
];
const ACTIVE_MS = 10 * 60 * 1000; // anggota dianggap bekerja 10 mnt setelah aktivitas
const KETUA_ACTIVE_MS = 5 * 60 * 1000;

async function getActivities(limit = 80) {
  if (!SB_URL || !SB_KEY || SB_KEY.includes('___ISI')) return [];
  try {
    const q = new URLSearchParams({
      select: 'kind,summary,created_at',
      order: 'created_at.desc',
      limit: String(limit),
    });
    const res = await fetch(`${SB_URL}/rest/v1/agent_activity?${q}`, {
      headers: { apikey: SB_KEY },
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

const memberOf = (kind) => TEAM.find((m) => m.kind === kind) || TEAM[0];

// Hitungan order untuk animasi status kantor (mode penuh SAJA).
// Isinya HANYA angka — tanpa nama, nominal, ID, atau data customer apa pun.
// selesaiBaru: order selesai yang updated_at-nya dalam 3 hari terakhir,
// supaya animasi "mobil sampai" mencerminkan penyelesaian baru, bukan riwayat.
const ORDER_COUNTS_ZERO = { pending: 0, diproses: 0, dikirim: 0, selesaiBaru: 0 };
const SELESAI_BARU_MS = 3 * 24 * 3600 * 1000;

async function getOrderCounts() {
  if (!SB_URL || !SB_KEY || SB_KEY.includes('___ISI')) return { ...ORDER_COUNTS_ZERO };
  try {
    const q = new URLSearchParams({
      select: 'status,updated_at',
      order: 'updated_at.desc',
      limit: '200',
    });
    const res = await fetch(`${SB_URL}/rest/v1/orders?${q}`, {
      headers: { apikey: SB_KEY },
    });
    if (!res.ok) return { ...ORDER_COUNTS_ZERO };
    const rows = await res.json();
    const counts = { ...ORDER_COUNTS_ZERO };
    const cutoff = Date.now() - SELESAI_BARU_MS;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r.status === 'pending') counts.pending++;
      else if (r.status === 'diproses') counts.diproses++;
      else if (r.status === 'dikirim') counts.dikirim++;
      else if (r.status === 'selesai' && r.updated_at && Date.parse(r.updated_at) >= cutoff) counts.selesaiBaru++;
    }
    return counts;
  } catch {
    return { ...ORDER_COUNTS_ZERO };
  }
}

function buildState(events, orderCounts = ORDER_COUNTS_ZERO) {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const asc = [...events].reverse(); // tertua -> terbaru

  const team = TEAM.map((m, i) => {
    const mine = asc.filter((e) => e.kind === m.kind);
    const last = mine[mine.length - 1];
    const working = !!last && now - Date.parse(last.created_at) < ACTIVE_MS;
    return {
      key: `tim-${i}`,
      name: m.name,
      label: `${m.name} · ${m.role}`,
      role: m.role,
      color: m.color,
      kind: 'tim',
      slot: i,
      desk: i,
      state: working ? 'bekerja' : 'santai',
      run: working
        ? {
            id: `ev-${asc.indexOf(last)}`,
            agent_type: last.kind,
            task: last.summary,
            status: 'bekerja',
            reason: null,
            segment: 1,
            started: last.created_at,
            ended: null,
            updated: last.created_at,
            last: mine.slice(-8).reverse().map((e) => ({
              t: e.created_at, kind: 'tool', text: e.summary, tool: e.kind,
            })),
            files: [],
            tools: mine.length,
            tokens: 0,
          }
        : null,
    };
  });

  const lastEv = asc[asc.length - 1];
  const ketuaActive = !!lastEv && now - Date.parse(lastEv.created_at) < KETUA_ACTIVE_MS;
  const ketua = {
    key: 'ketua',
    name: KETUA.name,
    label: KETUA.name,
    role: KETUA.role,
    kind: 'ketua',
    color: KETUA.color,
    state: ketuaActive ? 'bekerja' : 'santai',
    activity: ketuaActive ? 'aktif' : null,
    session: 'agent',
    updated: lastEv ? lastEv.created_at : null,
    last: [],
    tools: asc.length,
    tokens: 0,
    waiting_on: team.filter((t) => t.state === 'bekerja').length,
    other_sessions: 0,
    sessions: 1,
    todos: null,
  };

  const feed = asc.slice(-60).reverse().map((e) => {
    const m = memberOf(e.kind);
    return { t: e.created_at, who: `tim-${TEAM.indexOf(m)}`, name: m.name, color: m.color, kind: 'tool', text: e.summary, tool: e.kind };
  });

  const runs = asc.slice(-40).reverse().map((e, k) => {
    const m = memberOf(e.kind);
    return {
      id: `ev-${k}`,
      who: `tim-${TEAM.indexOf(m)}`,
      name: m.name,
      label: `${m.name} · ${m.role}`,
      color: m.color,
      kind: 'tim',
      agent_type: e.kind,
      task: e.summary,
      status: now - Date.parse(e.created_at) < ACTIVE_MS ? 'bekerja' : 'selesai',
      started: e.created_at,
      ended: null,
      tools: 1,
    };
  });

  return {
    app: 'kantor-agent',
    version: '1.0.0-agent-ai',
    now: iso,
    project: 'Digiprint Agent AI',
    names: [KETUA.name, ...TEAM.map((m) => m.name)].join('|'),
    transcripts: true,
    ketua,
    team,
    freelancers: [],
    feed,
    runs,
    stats: {
      active: team.filter((t) => t.state === 'bekerja').length,
      freelancers: 0,
      total: asc.length,
      recent_starts: asc.slice(-10).map((e) => e.created_at),
      sessions_active: 1,
    },
    spare_desks: 0,
    public_url: null,
    // Hanya angka (lihat getOrderCounts); dihapus eksplisit di buildStatePublik().
    orderCounts: { ...orderCounts },
  };
}

/**
 * State PUBLIK untuk mode tamu (kantor 3D yang dimasuki customer):
 * bentuk sama persis, tapi TANPA data aktivitas nyata apa pun —
 * semua task generik, feed & runs kosong. Toko dibuat "bekerja"
 * (duduk di mejanya) agar siap melayani tamu; lainnya santai.
 */
function buildStatePublik() {
  const base = buildState([]);
  const iso = new Date().toISOString();
  base.team = base.team.map((m) => {
    if (m.name !== 'Toko') return { ...m, state: 'santai', run: null };
    return {
      ...m, state: 'bekerja',
      run: {
        id: 'publik-toko', agent_type: 'toko', task: 'Melayani pelanggan',
        status: 'bekerja', reason: null, segment: 1,
        started: iso, ended: null, updated: iso, last: [], files: [], tools: 0, tokens: 0,
      },
    };
  });
  base.ketua = { ...base.ketua, state: 'santai', activity: null, waiting_on: 1 };
  base.feed = [];
  base.runs = [];
  base.stats = { active: 1, freelancers: 0, total: 0, recent_starts: [], sessions_active: 1 };
  // Mode tamu tidak boleh menerima data order sama sekali — hapus hitungannya.
  delete base.orderCounts;
  return base;
}

module.exports = async (req, res) => {
  try {
    if (String(req.query?.publik || '') === '1') {
      return res.status(200).json(buildStatePublik());
    }
    // Mode PENUH berisi potongan aktivitas privat (isi catatan, potongan pesan) —
    // wajib PIN dashboard. Tanpa PIN yang benar: tolak, jangan bocorkan.
    const pinBenar = process.env.DASHBOARD_PIN || '1234';
    if (String(req.query?.pin || '') !== pinBenar) {
      return res.status(401).json({ ok: false, error: 'PIN diperlukan untuk mode penuh' });
    }
    const events = await getActivities(80);
    const orderCounts = await getOrderCounts();
    res.status(200).json(buildState(events, orderCounts));
  } catch (e) {
    res.status(200).json(buildState([]));
  }
};

// untuk tes lokal
module.exports.buildState = buildState;
module.exports.buildStatePublik = buildStatePublik;
module.exports.TEAM = TEAM;
module.exports.KETUA = KETUA;
