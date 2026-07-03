const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');
const google = require('../services/google');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// public OAuth callback (Google redirects the browser here)
router.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const payload = jwt.verify(state, config.jwtSecret); // state carries the user id
    const tokens = await google.exchangeCode(code);
    if (!tokens.refresh_token) throw new Error('לא התקבל refresh token — נסה שוב עם prompt=consent');

    let googleEmail = null;
    if (tokens.id_token) {
      try {
        googleEmail = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString()).email;
      } catch { /* optional */ }
    }
    const existing = await db.getBy('calendar_links', 'user_id', payload.sub);
    if (existing) {
      await db.update('calendar_links', existing.id, {
        google_refresh_token: tokens.refresh_token, google_email: googleEmail,
      });
    } else {
      await db.insert('calendar_links', {
        user_id: payload.sub, google_refresh_token: tokens.refresh_token,
        google_email: googleEmail, calendar_id: 'primary',
      });
    }
    res.redirect('/#tab=settings&calendar=connected');
  } catch (e) {
    res.redirect(`/#tab=settings&calendar=error&msg=${encodeURIComponent(e.message)}`);
  }
});

router.use(requireAuth);

router.get('/status', async (req, res) => {
  const link = await db.getBy('calendar_links', 'user_id', req.user.id);
  res.json({
    configured: config.google.enabled,
    connected: !!link,
    google_email: link?.google_email || null,
  });
});

router.get('/connect', (req, res) => {
  if (!config.google.enabled) {
    return res.status(400).json({ error: 'Google OAuth לא מוגדר — הזן GOOGLE_CLIENT_ID/SECRET ב-.env' });
  }
  const state = jwt.sign({ sub: req.user.id }, config.jwtSecret, { expiresIn: '15m' });
  res.json({ url: google.authUrl(state) });
});

router.delete('/disconnect', async (req, res) => {
  const link = await db.getBy('calendar_links', 'user_id', req.user.id);
  if (link) await db.remove('calendar_links', link.id);
  res.json({ ok: true });
});

// push one lead to Google Calendar
router.post('/sync/:leadId', async (req, res) => {
  try {
    const lead = await db.get('leads', req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'ליד לא נמצא' });
    const result = await google.pushLead(req.user.id, lead);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// push all open/win leads with a date, then pull remote edits back
router.post('/sync-all', async (req, res) => {
  try {
    const leads = await db.list('leads', { filters: { sale_status: ['open', 'win'] } });
    let pushed = 0;
    for (const lead of leads) {
      if (!lead.event_date) continue;
      await google.pushLead(req.user.id, lead);
      pushed++;
    }
    const pullResult = await google.pull(req.user.id);
    res.json({ ok: true, pushed, pulled: pullResult.updated ?? 0 });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
