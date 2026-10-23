const { Genesis, pull } = require('../lib/genesis');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { user, pass } = req.body || {};
  if (typeof user !== 'string' || typeof pass !== 'string' || !user.trim() || !pass) {
    return res.status(401).json({ error: 'Session is not available. Sign in again.' });
  }
  try {
    const g = new Genesis();
    await g.login(user.trim(), pass);
    return res.status(200).json(await pull(g));
  } catch (e) {
    return res.status(/rejected the login/i.test(String(e?.message)) ? 401 : 502)
      .json({ error: String(e?.message || 'Could not sync grades'), ...(process.env.DEBUG === '1' && e?.debug ? { debug: e.debug } : {}) });
  }
};
