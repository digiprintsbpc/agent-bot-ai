'use strict';
/**
 * Memory agent di Supabase (konsep obsidian-mind: ingatan yang menumpuk).
 * - agent_memory: riwayat percakapan per user (untuk konteks)
 * - agent_notes: catatan penting yang diminta diingat ("ingat bahwa ...")
 * - agent_activity: log aktivitas untuk dashboard 3D
 */

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

function sbHeaders() {
  return { apikey: SB_KEY, 'Content-Type': 'application/json' };
}

async function sbGet(table, params = {}) {
  const q = new URLSearchParams(params);
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase GET ${table}: ${res.status}`);
  return res.json();
}

async function sbPost(table, rows) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase POST ${table}: ${res.status} ${t.slice(0, 150)}`);
  }
  return res.json();
}

function configured() {
  return Boolean(SB_URL && SB_KEY && !SB_KEY.includes('___ISI'));
}

/** Ambil N pesan terakhir sebagai konteks [{role, content}]. */
async function getHistory(userId, limit = 20) {
  if (!configured()) return [];
  try {
    const rows = await sbGet('agent_memory', {
      select: 'role,content',
      user_id: `eq.${userId}`,
      order: 'created_at.desc',
      limit: String(limit),
    });
    return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  } catch (e) {
    console.error('[memory] getHistory gagal:', e.message);
    return [];
  }
}

async function saveMessage(userId, role, content) {
  if (!configured()) return;
  try {
    await sbPost('agent_memory', [{ user_id: String(userId), role, content: String(content).slice(0, 4000) }]);
  } catch (e) {
    console.error('[memory] saveMessage gagal:', e.message);
  }
}

async function saveNote(userId, note) {
  if (!configured()) throw new Error('Supabase belum dikonfigurasi');
  await sbPost('agent_notes', [{ user_id: String(userId), note: String(note).slice(0, 2000) }]);
}

async function getNotes(userId, limit = 20) {
  if (!configured()) return [];
  const rows = await sbGet('agent_notes', {
    select: 'note,created_at',
    user_id: `eq.${userId}`,
    order: 'created_at.desc',
    limit: String(limit),
  });
  return rows;
}

async function logActivity(userId, kind, summary) {
  if (!configured()) return;
  try {
    await sbPost('agent_activity', [{ user_id: String(userId), kind, summary: String(summary).slice(0, 500) }]);
  } catch (e) {
    console.error('[memory] logActivity gagal:', e.message);
  }
}

async function recentActivity(limit = 30) {
  if (!configured()) return [];
  return sbGet('agent_activity', { select: '*', order: 'created_at.desc', limit: String(limit) });
}

module.exports = { configured, getHistory, saveMessage, saveNote, getNotes, logActivity, recentActivity };
