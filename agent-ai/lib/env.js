'use strict';
/** Helper baca environment variable. */

function opt(key, dflt) {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : dflt;
}

function req(key) {
  const v = opt(key, '');
  if (!v) throw new Error(`ENV ${key} belum diisi (cek Vercel > Settings > Environment Variables)`);
  return v;
}

module.exports = { opt, req };
