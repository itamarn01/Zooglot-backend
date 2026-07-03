const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

function sign(profile) {
  return jwt.sign({ sub: profile.id, email: profile.email }, config.jwtSecret, { expiresIn: '30d' });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'נדרשת התחברות' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const profile = await db.get('profiles', payload.sub);
    if (!profile) return res.status(401).json({ error: 'משתמש לא נמצא' });
    req.user = profile;
    next();
  } catch {
    return res.status(401).json({ error: 'טוקן לא תקין או שפג תוקפו' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'נדרשות הרשאות אדמין' });
  next();
}

module.exports = { sign, requireAuth, requireAdmin };
