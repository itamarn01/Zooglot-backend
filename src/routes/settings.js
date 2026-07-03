const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const email = require('../services/email');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ---- profile ----
router.patch('/profile', async (req, res) => {
  const patch = {};
  if (req.body?.full_name) patch.full_name = req.body.full_name;
  if (req.body?.avatar_url !== undefined) patch.avatar_url = req.body.avatar_url; // data URL or storage URL
  if (req.body?.new_password) {
    if (req.body.new_password.length < 8) return res.status(400).json({ error: 'סיסמה חייבת להיות באורך 8 תווים לפחות' });
    if (!req.body.current_password || !bcrypt.compareSync(req.body.current_password, req.user.password_hash || '')) {
      return res.status(400).json({ error: 'הסיסמה הנוכחית שגויה' });
    }
    patch.password_hash = bcrypt.hashSync(req.body.new_password, 10);
  }
  const p = await db.update('profiles', req.user.id, patch);
  res.json({ user: { id: p.id, email: p.email, full_name: p.full_name, avatar_url: p.avatar_url, role: p.role, email_verified: !!p.email_verified } });
});

// ---- team & invitations (invite-only registration) ----
router.get('/team', async (req, res) => {
  const profiles = await db.list('profiles', { orderBy: 'created_at' });
  res.json({
    team: profiles.map(p => ({ id: p.id, email: p.email, full_name: p.full_name, avatar_url: p.avatar_url, role: p.role })),
  });
});

router.get('/invitations', requireAdmin, async (req, res) => {
  res.json({ invitations: await db.list('invitations', { orderBy: 'created_at', asc: false }) });
});

router.post('/invitations', requireAdmin, async (req, res) => {
  const emailAddr = (req.body?.email || '').toLowerCase().trim();
  if (!/^\S+@\S+\.\S+$/.test(emailAddr)) return res.status(400).json({ error: 'כתובת מייל לא תקינה' });
  if (await db.getBy('profiles', 'email', emailAddr)) return res.status(400).json({ error: 'משתמש עם המייל הזה כבר קיים' });

  const token = crypto.randomBytes(20).toString('hex');
  const invite = await db.insert('invitations', {
    email: emailAddr, token, invited_by: req.user.id, accepted_at: null,
  });
  const link = `${config.appUrl}/#invite=${token}`;
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

module.exports = router;
