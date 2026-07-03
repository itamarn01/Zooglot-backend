const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const email = require('../services/email');
const { sign, requireAuth } = require('../middleware/auth');

const router = express.Router();
const publicProfile = (p) => ({
  id: p.id, email: p.email, full_name: p.full_name,
  avatar_url: p.avatar_url, role: p.role, email_verified: !!p.email_verified,
});

const genCode = () => String(crypto.randomInt(100000, 999999));

async function issueCode(emailAddr, purpose, ttlMinutes, code) {
  const rec = await db.insert('otp_codes', {
    email: emailAddr.toLowerCase(),
    code: code || genCode(),
    purpose,
    expires_at: new Date(Date.now() + ttlMinutes * 60000).toISOString(),
    used: false,
  });
  return rec.code;
}

async function consumeCode(emailAddr, code, purpose) {
  const rows = await db.list('otp_codes', {
    filters: { email: emailAddr.toLowerCase(), purpose },
    orderBy: 'created_at', asc: false,
  });
  const match = rows.find(r => r.code === code && !r.used);
  if (!match) return false;
  if (new Date(match.expires_at) < new Date()) return false;
  await db.update('otp_codes', match.id, { used: true });
  return true;
}

// ---- sign up (invite-only) ----
router.post('/register', async (req, res) => {
  const { invite_token, full_name, password } = req.body || {};
  if (!invite_token || !password || !full_name) {
    return res.status(400).json({ error: 'חסרים פרטים: טוקן הזמנה, שם מלא וסיסמה' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'סיסמה חייבת להיות באורך 8 תווים לפחות' });

  const invite = await db.getBy('invitations', 'token', invite_token);
  if (!invite || invite.accepted_at) return res.status(400).json({ error: 'הזמנה לא תקינה או שכבר נוצלה' });

  const emailAddr = invite.email.toLowerCase();
  if (await db.getBy('profiles', 'email', emailAddr)) {
    return res.status(400).json({ error: 'משתמש עם המייל הזה כבר קיים' });
  }

  const profile = await db.insert('profiles', {
    email: emailAddr,
    full_name,
    role: 'member',
    password_hash: bcrypt.hashSync(password, 10),
    email_verified: false,
    avatar_url: null,
  });
  await db.update('invitations', invite.id, { accepted_at: new Date().toISOString() });

  const code = await issueCode(emailAddr, 'verify', 15);
  await email.verifyEmail(emailAddr, code);

  res.json({ token: sign(profile), user: publicProfile(profile), verification_sent: true });
});

// ---- verify email ----
router.post('/verify-email', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!await consumeCode(req.user.email, code, 'verify')) {
    return res.status(400).json({ error: 'קוד אימות שגוי או שפג תוקפו' });
  }
  const updated = await db.update('profiles', req.user.id, { email_verified: true });
  res.json({ user: publicProfile(updated) });
});

router.post('/resend-verification', requireAuth, async (req, res) => {
  const code = await issueCode(req.user.email, 'verify', 15);
  await email.verifyEmail(req.user.email, code);
  res.json({ ok: true });
});

// ---- login: email + password ----
router.post('/login', async (req, res) => {
  const { email: emailAddr, password } = req.body || {};
  const profile = await db.getBy('profiles', 'email', (emailAddr || '').toLowerCase());
  if (!profile || !profile.password_hash || !bcrypt.compareSync(password || '', profile.password_hash)) {
    return res.status(401).json({ error: 'מייל או סיסמה שגויים' });
  }
  res.json({ token: sign(profile), user: publicProfile(profile) });
});

// ---- login: OTP (magic code) ----
router.post('/otp/request', async (req, res) => {
  const emailAddr = (req.body?.email || '').toLowerCase();
  const profile = await db.getBy('profiles', 'email', emailAddr);
  // do not reveal whether the account exists
  if (profile) {
    const code = await issueCode(emailAddr, 'login', 10);
    await email.otpLogin(emailAddr, code);
  }
  res.json({ ok: true });
});

router.post('/otp/verify', async (req, res) => {
  const emailAddr = (req.body?.email || '').toLowerCase();
  const profile = await db.getBy('profiles', 'email', emailAddr);
  if (!profile || !await consumeCode(emailAddr, req.body?.code, 'login')) {
    return res.status(401).json({ error: 'קוד שגוי או שפג תוקפו' });
  }
  res.json({ token: sign(profile), user: publicProfile(profile) });
});

// ---- forgot / reset password ----
router.post('/forgot', async (req, res) => {
  const emailAddr = (req.body?.email || '').toLowerCase();
  const profile = await db.getBy('profiles', 'email', emailAddr);
  if (profile) {
    const token = crypto.randomBytes(24).toString('hex');
    await issueCode(emailAddr, 'reset', 60, token);
    await email.passwordReset(emailAddr, `${config.appUrl}/#reset=${token}&email=${encodeURIComponent(emailAddr)}`);
  }
  res.json({ ok: true });
});

router.post('/reset', async (req, res) => {
  const { email: emailAddr, token, password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: 'סיסמה חייבת להיות באורך 8 תווים לפחות' });
  const profile = await db.getBy('profiles', 'email', (emailAddr || '').toLowerCase());
  if (!profile || !await consumeCode(emailAddr, token, 'reset')) {
    return res.status(400).json({ error: 'קישור איפוס לא תקין או שפג תוקפו' });
  }
  await db.update('profiles', profile.id, { password_hash: bcrypt.hashSync(password, 10) });
  res.json({ ok: true });
});

// ---- session ----
router.get('/me', requireAuth, (req, res) => res.json({ user: publicProfile(req.user) }));

module.exports = router;
