'use strict';
module.exports = async (req, res) => {
  res.status(200).json({ ok: true, service: 'agent-ai', time: new Date().toISOString() });
};
