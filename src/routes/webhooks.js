// Inbound webhook — replaces the Monday.com board integration.
// Point the band website (and the existing wkf.ms forms) at:
//   POST {APP_URL}/api/webhooks/lead?key={WEBHOOK_SECRET}
// Accepts flexible JSON: native Zooglot fields, Monday.com webhook payloads,
// or arbitrary form-field names (mapped heuristically).
const express = require('express');
const db = require('../db');
const config = require('../config');
const { createLeadFromPayload } = require('./forms');

const router = express.Router();

const ALIASES = {
  name: ['name', 'full_name', 'fullname', 'שם', 'שם מלא', 'pulseName'],
  contact_name: ['contact', 'contact_name', 'איש קשר'],
  email: ['email', 'mail', 'מייל', 'אימייל'],
  phone1: ['phone', 'phone1', 'tel', 'טלפון', 'טלפון 1'],
  phone2: ['phone2', 'טלפון 2'],
  event_date: ['event_date', 'date', 'תאריך', 'תאריך האירוע'],
  event_location: ['event_location', 'location', 'venue', 'מיקום', 'מקום האירוע'],
  event_type: ['event_type', 'type', 'סוג אירוע'],
  relation: ['relation', 'קרבה'],
  hear_about_us: ['hear_about_us', 'source', 'איך שמעתם עלינו'],
  referrer: ['referrer', 'מי המליץ'],
  notes: ['notes', 'message', 'הערות', 'הודעה'],
};

function normalize(raw) {
  // Monday webhook envelope: { event: { pulseName, columnValues... } }
  if (raw && typeof raw.event === 'object') {
    raw = { pulseName: raw.event.pulseName, ...flattenMondayColumns(raw.event), ...raw.event };
  }
  const lower = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (v === null || typeof v === 'object') continue;
    lower[String(k).trim().toLowerCase()] = v;
  }
  const out = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const a of aliases) {
      const hit = lower[a.toLowerCase()];
      if (hit !== undefined && hit !== '') { out[field] = hit; break; }
    }
  }
  // keep unmapped keys so nothing is lost (they land in the lead's update log)
  for (const [k, v] of Object.entries(lower)) {
    const mapped = Object.values(ALIASES).some(list => list.some(a => a.toLowerCase() === k));
    if (!mapped) out[k] = v;
  }
  return out;
}

function flattenMondayColumns(event) {
  const out = {};
  for (const cv of event.columnValues ? Object.values(event.columnValues) : []) {
    if (cv && cv.label) out[cv.title || cv.id || 'col'] = cv.label;
  }
  return out;
}

router.post('/lead', async (req, res) => {
  const key = req.query.key || req.headers['x-webhook-key'];
  if (key !== config.webhookSecret) return res.status(401).json({ error: 'invalid webhook key' });

  // Monday webhook handshake support
  if (req.body && req.body.challenge) return res.json({ challenge: req.body.challenge });

  const payload = normalize(req.body);
  if (!payload.name && !payload.contact_name && !payload.phone1 && !payload.email) {
    return res.status(400).json({ error: 'payload has no identifiable lead fields' });
  }
  const lead = await createLeadFromPayload(payload, 'webhook', req.headers.referer || 'webhook');
  res.status(201).json({ ok: true, lead_id: lead.id });
});

module.exports = router;
