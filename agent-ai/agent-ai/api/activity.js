'use strict';
/** API untuk dashboard 3D: aktivitas terakhir agent. */
const memory = require('../lib/memory');

module.exports = async (req, res) => {
  try {
    const items = await memory.recentActivity(30);
    res.status(200).json({ ok: true, activity: items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
