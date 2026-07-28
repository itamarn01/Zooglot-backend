const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { todayISO } = require('../lib/dates');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');

// Fields the form builder can bind to (columns of מעקב זוגות).
//
// `options` are the values actually stored on the lead — always Hebrew, so the
// board's chips/filters keep working whatever language the form is in.
// `options_en` are display labels for English forms, in the SAME order, so an
// English form shows "Bride" while the CRM still records "כלה".
// `label_en` does the same for the field's own label.
// `other_free_text` marks the select whose last option ("אחר") opens a free-text
// box. `show_when` hides a field until another field has a given value.
const BINDABLE_FIELDS = [
  { key: 'name', label: 'שם מלא / שם האירוע', label_en: 'Full name / event name', type: 'text' },
  { key: 'contact_name', label: 'איש קשר', label_en: 'Contact person', type: 'text' },
  {
    key: 'relation', label: 'קרבה לאירוע', label_en: 'Relation to the event', type: 'select',
    options: ['כלה', 'חתן', 'הורה', 'מפיק/ה', 'אחר'],
    options_en: ['Bride', 'Groom', 'Parent', 'Producer', 'Other'],
    other_free_text: true,
  },
  {
    key: 'event_type', label: 'סוג אירוע', label_en: 'Event type', type: 'select',
    options: ['חתונה', 'בר/בת מצווה', 'אירוע חברה', 'אחר'],
    options_en: ['Wedding', 'Bar/Bat Mitzvah', 'Corporate event', 'Other'],
    other_free_text: true,
  },
  { key: 'event_date', label: 'תאריך האירוע', label_en: 'Event date', type: 'date' },
  { key: 'event_location', label: 'מיקום האירוע', label_en: 'Event location', type: 'text' },
  { key: 'email', label: 'אימייל', label_en: 'Email', type: 'email' },
  { key: 'phone1', label: 'טלפון', label_en: 'Phone', type: 'tel' },
  {
    key: 'hear_about_us', label: 'איך שמעתם עלינו?', label_en: 'How did you hear about us?', type: 'select',
    options: ['Instagram', 'Youtube', 'ניגנתם אצל חברים', 'המלצה', 'גוגל', 'אחר'],
    options_en: ['Instagram', 'YouTube', 'You played at a friend\'s event', 'Recommendation', 'Google', 'Other'],
    other_free_text: true,
  },
  {
    key: 'referrer', label: 'מי המליץ?', label_en: 'Who recommended us?', type: 'text',
    // only relevant once "המלצה" / "Recommendation" was picked
    show_when: { field: 'hear_about_us', equals: 'המלצה' },
  },
  { key: 'notes', label: 'הערות / ספרו לנו על האירוע', label_en: 'Notes / tell us about the event', type: 'textarea' },
];

async function createLeadFromPayload(payload, source, sourceRef) {
  const known = {};
  for (const f of BINDABLE_FIELDS) {
    if (payload[f.key] !== undefined && payload[f.key] !== '') known[f.key] = payload[f.key];
  }
  const notes = known.notes; delete known.notes;
  const lead = await db.insert('leads', {
    name: known.name || known.contact_name || 'ליד חדש מטופס',
    stage: 'לקוח משאלון',
    sale_status: 'open',
    next_action: 'עוד פרטים',
    event_type: 'חתונה',
    first_contact_date: todayISO(),
    ...known,
    source,
    source_ref: sourceRef || null,
  });
  const extras = Object.entries(payload)
    .filter(([k]) => !BINDABLE_FIELDS.some(f => f.key === k))
    .map(([k, v]) => `${k}: ${v}`).join('\n');
  const bodyParts = [notes && `הערות הלקוח: ${notes}`, extras && `שדות נוספים:\n${extras}`].filter(Boolean);
  if (bodyParts.length) {
    await db.insert('lead_updates', { lead_id: lead.id, author_id: null, kind: 'system', body: `📨 ${bodyParts.join('\n\n')}` });
  }
  return lead;
}

// ---------- authenticated: form builder ----------
const authed = express.Router();
authed.use(requireAuth);

authed.get('/bindable-fields', (req, res) => res.json({ fields: BINDABLE_FIELDS }));

authed.get('/', async (req, res) => {
  res.json({ forms: await db.list('lead_forms', { orderBy: 'created_at', asc: false }) });
});

authed.post('/', async (req, res) => {
  const { name, intro_html, logo_url, colors, fields, language } = req.body || {};
  if (!name) return res.status(400).json({ error: 'שם הטופס הוא שדה חובה' });
  const slug = `${name.replace(/[^\w֐-׿]+/g, '-').slice(0, 30)}-${crypto.randomBytes(8).toString('hex')}`;
  const form = await db.insert('lead_forms', {
    name,
    slug,
    intro_html: intro_html || '',
    logo_url: logo_url || null,
    colors: colors || { primary: '#87cedf', bg: '#0e1b20', text: '#eef7fa' },
    fields: fields || [],
    language: language === 'en' ? 'en' : 'he',
    active: true,
    created_by: req.user.id,
  });
  res.status(201).json({ form, ...formLinks(form) });
});

authed.patch('/:id', async (req, res) => {
  const patch = {};
  for (const f of ['name', 'intro_html', 'logo_url', 'colors', 'fields', 'language', 'active']) {
    if (f in (req.body || {})) patch[f] = req.body[f];
  }
  const form = await db.update('lead_forms', req.params.id, patch);
  if (!form) return res.status(404).json({ error: 'טופס לא נמצא' });
  res.json({ form, ...formLinks(form) });
});

authed.delete('/:id', async (req, res) => {
  await db.remove('lead_forms', req.params.id);
  res.json({ ok: true });
});

function formLinks(form) {
  // form.html is a static page served by the frontend (Vercel), not this API — use frontendUrl.
  const publicUrl = `${config.frontendUrl}/form.html?f=${encodeURIComponent(form.slug)}`;
  return {
    public_url: publicUrl,
    webhook_url: `${config.appUrl}/api/public/forms/${form.slug}/submit`,
    embed_code: `<iframe src="${publicUrl}" style="width:100%;min-height:640px;border:0;border-radius:12px;" title="${form.name}"></iframe>`,
  };
}

// ---------- public: render + submit ----------
const publicRouter = express.Router();

publicRouter.get('/:slug', async (req, res) => {
  const form = await db.getBy('lead_forms', 'slug', req.params.slug);
  if (!form || !form.active) return res.status(404).json({ error: 'הטופס לא נמצא' });
  res.json({ form });
});

publicRouter.post('/:slug/submit', async (req, res) => {
  const form = await db.getBy('lead_forms', 'slug', req.params.slug);
  if (!form || !form.active) return res.status(404).json({ error: 'הטופס לא נמצא' });
  const payload = req.body || {};
  const lead = await createLeadFromPayload(payload, 'form', form.slug);
  await db.insert('form_submissions', { form_id: form.id, lead_id: lead.id, payload });
  res.status(201).json({ ok: true, message: form.language === 'en' ? 'Thank you! We will be in touch soon.' : 'תודה! ניצור קשר בהקדם.' });
});

module.exports = { authed, publicRouter, createLeadFromPayload, BINDABLE_FIELDS };
