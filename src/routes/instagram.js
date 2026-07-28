// Instagram / Facebook Messenger → leads.
//
// Meta delivers Instagram DMs to a webhook on this server. Each new sender
// becomes a lead in מעקב זוגות with their message as the first update, so a DM
// asking about a wedding lands on the board like any other enquiry.
//
// Meta requires two things of this endpoint:
//   GET  — one-time verification handshake echoing hub.challenge
//   POST — the events themselves, signed with the app secret (X-Hub-Signature-256)
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { todayISO } = require('../lib/dates');

const router = express.Router();

// ---- verification handshake (Meta calls this when you save the webhook URL) ----
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.instagram.verifyToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Meta signs every delivery. Without an app secret configured we accept the
// request (so the flow can be tried before everything is wired), but once a
// secret IS set a bad signature is rejected — otherwise anyone who learns the
// URL could inject leads.
function signatureValid(req) {
  if (!config.instagram.appSecret) return true;
  const header = req.get('x-hub-signature-256') || '';
  const raw = req.rawBody;
  if (!raw) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.instagram.appSecret)
    .update(raw).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch { return false; }
}

// Ask the Graph API who this sender is, so the lead carries a real name instead
// of a numeric id. Best-effort: a missing name must not block the lead.
async function fetchProfile(senderId) {
  if (!config.instagram.pageToken) return null;
  try {
    const url = `https://graph.facebook.com/v21.0/${senderId}` +
      `?fields=name,username&access_token=${encodeURIComponent(config.instagram.pageToken)}`;
    const rsp = await fetch(url);
    if (!rsp.ok) return null;
    return await rsp.json();
  } catch { return null; }
}

async function handleMessage(entry, platform) {
  const senderId = entry?.sender?.id;
  const text = (entry?.message?.text || '').trim();
  if (!senderId || entry?.message?.is_echo) return;      // ignore our own replies

  const sourceRef = `${platform}:${senderId}`;
  let lead = await db.getBy('leads', 'source_ref', sourceRef);

  if (!lead) {
    const profile = await fetchProfile(senderId);
    const name = profile?.name || (profile?.username ? `@${profile.username}` : null);
    lead = await db.insert('leads', {
      name: name || `פנייה מ${platform === 'instagram' ? 'אינסטגרם' : 'פייסבוק'}`,
      contact_name: name || null,
      stage: 'לקוח חדש ידני',
      sale_status: 'open',
      next_action: 'עוד פרטים',
      event_type: 'חתונה',
      hear_about_us: platform === 'instagram' ? 'Instagram' : 'Facebook',
      first_contact_date: todayISO(),
      source: 'webhook',
      source_ref: sourceRef,
    });
    await db.insert('lead_updates', {
      lead_id: lead.id, author_id: null, kind: 'system',
      body: `📷 ליד חדש מ${platform === 'instagram' ? 'אינסטגרם' : 'פייסבוק'}${name ? ` — ${name}` : ''}`,
    });
  }

  if (text) {
    await db.insert('lead_updates', {
      lead_id: lead.id, author_id: null, kind: 'note',
      body: `💬 ${platform === 'instagram' ? 'אינסטגרם' : 'פייסבוק'}: ${text}`,
    });
  }
}

router.post('/webhook', async (req, res) => {
  // Answer Meta immediately: it retries anything slower than a few seconds, and
  // a retry would duplicate the lead. Process after responding.
  res.sendStatus(200);

  if (!signatureValid(req)) {
    console.warn('[instagram] rejected a delivery with a bad signature');
    return;
  }
  const body = req.body || {};
  const platform = body.object === 'instagram' ? 'instagram' : 'facebook';
  try {
    for (const entry of (body.entry || [])) {
      for (const ev of (entry.messaging || [])) {
        if (ev.message) await handleMessage(ev, platform);
      }
    }
  } catch (e) {
    console.warn('[instagram] failed to process delivery:', e.message);
  }
});

module.exports = router;
