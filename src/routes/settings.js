const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const email = require('../services/email');
const whatsapp = require('../services/whatsapp');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ---- profile ----
router.patch('/profile', async (req, res) => {
  const patch = {};
  if (req.body?.full_name) patch.full_name = req.body.full_name;
  if (req.body?.phone !== undefined) patch.phone = req.body.phone || null; // WhatsApp reminders
  if (req.body?.avatar_url !== undefined) patch.avatar_url = req.body.avatar_url; // data URL or storage URL
  if (req.body?.new_password) {
    if (req.body.new_password.length < 8) return res.status(400).json({ error: 'סיסמה חייבת להיות באורך 8 תווים לפחות' });
    if (!req.body.current_password || !bcrypt.compareSync(req.body.current_password, req.user.password_hash || '')) {
      return res.status(400).json({ error: 'הסיסמה הנוכחית שגויה' });
    }
    patch.password_hash = bcrypt.hashSync(req.body.new_password, 10);
  }
  const p = await db.update('profiles', req.user.id, patch);
  res.json({ user: { id: p.id, email: p.email, full_name: p.full_name, phone: p.phone || null, avatar_url: p.avatar_url, role: p.role, email_verified: !!p.email_verified } });
});

// ---- team & invitations (invite-only registration) ----
router.get('/team', async (req, res) => {
  const profiles = await db.list('profiles', { orderBy: 'created_at' });
  res.json({
    team: profiles.map(p => ({
      id: p.id, email: p.email, full_name: p.full_name, avatar_url: p.avatar_url,
      phone: p.phone || null, role: p.role, email_verified: !!p.email_verified, created_at: p.created_at,
    })),
  });
});

// edit a team member (name / role) — admin only, can't demote yourself (avoid lockout)
router.patch('/team/:id', requireAdmin, async (req, res) => {
  const target = await db.get('profiles', req.params.id);
  if (!target) return res.status(404).json({ error: 'משתמש לא נמצא' });
  const patch = {};
  if (typeof req.body?.full_name === 'string' && req.body.full_name.trim()) patch.full_name = req.body.full_name.trim();
  if (req.body?.role && ['admin', 'member'].includes(req.body.role)) {
    if (target.id === req.user.id && req.body.role !== 'admin') {
      return res.status(400).json({ error: 'אי אפשר להסיר לעצמך הרשאת אדמין' });
    }
    patch.role = req.body.role;
  }
  const p = await db.update('profiles', target.id, patch);
  res.json({ member: { id: p.id, email: p.email, full_name: p.full_name, avatar_url: p.avatar_url, role: p.role, email_verified: !!p.email_verified } });
});

// remove a team member — admin only, can't delete yourself
router.delete('/team/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'אי אפשר למחוק את המשתמש שלך' });
  const target = await db.get('profiles', req.params.id);
  if (!target) return res.status(404).json({ error: 'משתמש לא נמצא' });
  await db.remove('profiles', req.params.id);
  res.json({ ok: true });
});

router.get('/invitations', requireAdmin, async (req, res) => {
  res.json({ invitations: await db.list('invitations', { orderBy: 'created_at', asc: false }) });
});

// resend an existing invitation email
router.post('/invitations/:id/resend', requireAdmin, async (req, res) => {
  const invite = await db.get('invitations', req.params.id);
  if (!invite) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
  if (invite.accepted_at) return res.status(400).json({ error: 'ההזמנה כבר מומשה' });
  const link = `${config.frontendUrl}/#invite=${invite.token}`;
  await email.invitation(invite.email, link, req.user.full_name);
  res.json({ ok: true, link });
});

router.post('/invitations', requireAdmin, async (req, res) => {
  const emailAddr = (req.body?.email || '').toLowerCase().trim();
  if (!/^\S+@\S+\.\S+$/.test(emailAddr)) return res.status(400).json({ error: 'כתובת מייל לא תקינה' });
  if (await db.getBy('profiles', 'email', emailAddr)) return res.status(400).json({ error: 'משתמש עם המייל הזה כבר קיים' });

  const token = crypto.randomBytes(20).toString('hex');
  const invite = await db.insert('invitations', {
    email: emailAddr, token, invited_by: req.user.id, accepted_at: null,
  });
  const link = `${config.frontendUrl}/#invite=${token}`;
  await email.invitation(emailAddr, link, req.user.full_name);
  res.status(201).json({ invitation: invite, link });
});

router.delete('/invitations/:id', requireAdmin, async (req, res) => {
  await db.remove('invitations', req.params.id);
  res.json({ ok: true });
});

// ---- management signatures (for contracts) ----
router.get('/signatures', async (req, res) => {
  res.json({ signatures: await db.list('management_signatures', { orderBy: 'created_at', asc: false }) });
});

router.post('/signatures', async (req, res) => {
  const { name, image_data } = req.body || {};
  if (!name || !image_data || !image_data.startsWith('data:image')) {
    return res.status(400).json({ error: 'נדרשים שם ותמונת חתימה' });
  }
  const signature = await db.insert('management_signatures', {
    name, image_data, created_by: req.user.id,
  });
  res.status(201).json({ signature });
});

router.delete('/signatures/:id', async (req, res) => {
  await db.remove('management_signatures', req.params.id);
  res.json({ ok: true });
});

// ---- integration status (for the settings screen) ----
router.get('/integrations', async (req, res) => {
  res.json({
    supabase: config.supabase.enabled,
    resend: config.resend.enabled,
    openai: config.openai.enabled,
    google: config.google.enabled,
    whatsapp: config.whatsapp.enabled,
    mock_db: config.mockDb,
    webhook_url: `${config.appUrl}/api/webhooks/lead?key=${config.webhookSecret}`,
  });
});

// ---- WhatsApp linking (scan the QR from the band phone to connect) ----
router.get('/whatsapp', (req, res) => res.json(whatsapp.status()));
router.post('/whatsapp/connect', requireAdmin, async (req, res) => {
  try { res.json(await whatsapp.connect()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/whatsapp/disconnect', requireAdmin, async (req, res) => {
  res.json(await whatsapp.disconnect());
});

module.exports = router;
