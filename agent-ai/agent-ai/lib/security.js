'use strict';
/**
 * Skill SECURITY-AUDIT (dari cloudflare/security-audit-skill).
 * Mode guidance: jawab pertanyaan keamanan / review potongan kode yang
 * ditempel user, cari pelanggaran trust-boundary yang nyata, beri bukti,
 * prioritas, dan perbaikan terkecil yang efektif.
 * Sumber: ~/workspace/security-audit-skill/skills/security-audit/SKILL.md
 */

const TRIGGER = [
  'audit keamanan', 'security audit', 'audit security', 'cek keamanan',
  'vulnerability', 'vulnerabilitas', 'celah keamanan', 'keamanan kode',
  'review keamanan', 'apakah aman', 'aman tidak', 'pen-test', 'pentest',
];

const SYSTEM = `Kamu adalah asisten keamanan (security-audit skill, mode guidance).
Aturan:
- Cari kerentanan yang melanggar trust boundary NYATA: sebutkan principal yang terdampak,
  resource yang terancam, dan dampak konkretnya. Tanpa itu semua, itu bukan temuan valid.
- Untuk tiap temuan beri: bukti dari source (kutip baris kode), cara reproduksi yang aman,
  prioritas (kritis/tinggi/sedang/rendah), dan perbaikan terkecil yang efektif.
- Jangan mengarang kerentanan. Jangan sarankan menyerang sistem live/produksi,
  jangan uji endpoint yang sedang berjalan, jangan pakai data asli sebagai korban.
- Jawab dalam Bahasa Indonesia, ringkas tapi lengkap. Format: ringkasan, temuan
  (per temuan: bukti, dampak, prioritas, perbaikan), lalu langkah berikutnya.`;

function isSecurityQuestion(text) {
  const t = String(text).toLowerCase();
  if (/(```|kode|code|script|function|const |def |import )/.test(t) &&
      /(aman|keamanan|security|audit|vuln|rentan)/.test(t)) return true;
  return TRIGGER.some((k) => t.includes(k));
}

module.exports = { isSecurityQuestion, SYSTEM };
