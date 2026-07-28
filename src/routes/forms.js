const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { todayISO } = require('../lib/dates');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { countryFromTimezone, parseUserAgent } = require('../lib/visitor');

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
  const forms = await db.list('lead_forms', { orderBy: 'created_at', asc: false });
  // same enrichment as the public route, so the builder's preview matches what
  // the client will actually see
  res.json({ forms: forms.map(f => ({ ...f, fields: enrichFields(f.fields) })) });
});

const FORM_FIELDS = ['name', 'intro_html', 'logo_url', 'colors', 'fields', 'language',
  'active', 'form_type', 'submit_label', 'next_label', 'privacy_note', 'step_titles'];

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
    form_type: req.body?.form_type === 'steps' ? 'steps' : 'single',
    submit_label: req.body?.submit_label || null,
    next_label: req.body?.next_label || null,
    privacy_note: req.body?.privacy_note || null,
    step_titles: req.body?.step_titles || [],
    active: true,
    created_by: req.user.id,
  });
  res.status(201).json({ form, ...formLinks(form) });
});

authed.patch('/:id', async (req, res) => {
  const patch = {};
  for (const f of FORM_FIELDS) if (f in (req.body || {})) patch[f] = req.body[f];
  if (patch.form_type && !['single', 'steps'].includes(patch.form_type)) delete patch.form_type;
  const form = await db.update('lead_forms', req.params.id, patch);
  if (!form) return res.status(404).json({ error: 'טופס לא נמצא' });
  res.json({ form, ...formLinks(form) });
});

// ---- per-form analytics ----
// Everything is derived from form_views: one row per page view, flipped to
// submitted when it converts. That keeps views and submissions on the same
// row, so completion rate and average fill time are plain counts.
authed.get('/:id/analytics', async (req, res) => {
  const form = await db.get('lead_forms', req.params.id);
  if (!form) return res.status(404).json({ error: 'טופס לא נמצא' });

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 0, 0), 365);
  let views = await db.list('form_views', { filters: { form_id: form.id } });
  if (days) {
    const since = Date.now() - days * 86400000;
    views = views.filter(v => new Date(v.created_at).getTime() >= since);
  }

  const submissions = views.filter(v => v.submitted);
  const times = submissions.map(v => Number(v.duration_ms)).filter(n => Number.isFinite(n) && n > 0);
  // median as well as mean: one abandoned tab left open for an hour drags the
  // average far away from what a typical visitor actually experiences
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted.length
    ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : 0;

  const tally = (key) => {
    const m = new Map();
    for (const v of views) {
      const k = v[key] || 'אחר';
      if (!m.has(k)) m.set(k, { key: k, views: 0, submissions: 0 });
      const row = m.get(k);
      row.views++;
      if (v.submitted) row.submissions++;
    }
    return [...m.values()]
      .map(r => ({ ...r, rate: r.views ? Math.round(r.submissions / r.views * 1000) / 10 : 0 }))
      .sort((a, b) => b.views - a.views);
  };

  // step funnel: how many reached each step, so drop-off is visible
  const stepCount = Math.max(1, ...(form.fields || []).map(f => Number(f.step) || 1));
  const funnel = [];
  if (form.form_type === 'steps') {
    for (let s = 1; s <= stepCount; s++) {
      funnel.push({ step: s, title: (form.step_titles || [])[s - 1] || `שלב ${s}`,
        reached: views.filter(v => (v.max_step || 1) >= s).length });
    }
  }

  res.json({
    totals: {
      views: views.length,
      submissions: submissions.length,
      completion_rate: views.length ? Math.round(submissions.length / views.length * 1000) / 10 : 0,
      avg_ms: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
      median_ms: Math.round(median),
    },
    by_country: tally('country'),
    by_browser: tally('browser'),
    by_device: tally('device'),
    by_os: tally('os'),
    funnel,
  });
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

// A form stores a snapshot of its fields from when it was built, so forms saved
// before a capability existed (English option labels, "other" free text,
// conditional visibility) would never gain it. Re-attach the canonical metadata
// by key at render time — the builder's own choices (label, description,
// required) always win, only the behavioural bits are refreshed.
function enrichFields(fields) {
  return (fields || []).map((f) => {
    const def = BINDABLE_FIELDS.find(b => b.key === f.key);
    if (!def) return f;
    // NB: `label` is deliberately untouched — the builder lets the band write
    // the wording themselves (often already in the form's language), and
    // replacing it with the generic default would undo their copy.
    return {
      ...f,
      options: f.options || def.options,
      options_en: def.options_en,
      other_free_text: def.other_free_text,
      show_when: def.show_when,
    };
  });
}

// ---------- public: render + submit ----------
const publicRouter = express.Router();

publicRouter.get('/:slug', async (req, res) => {
  const form = await db.getBy('lead_forms', 'slug', req.params.slug);
  if (!form || !form.active) return res.status(404).json({ error: 'הטופס לא נמצא' });
  res.json({ form: { ...form, fields: enrichFields(form.fields) } });
});

// ---- analytics tracking (public, unauthenticated) ----
// Called once when the form is painted. Returns a view id the page keeps, so the
// later step/submit calls update THIS view instead of creating new rows. Never
// fails the page: tracking problems must not stop someone leaving their details.
publicRouter.post('/:slug/view', async (req, res) => {
  try {
    const form = await db.getBy('lead_forms', 'slug', req.params.slug);
    if (!form || !form.active) return res.status(404).json({ error: 'הטופס לא נמצא' });
    const { browser, os, device } = parseUserAgent(req.get('user-agent'));
    const view = await db.insert('form_views', {
      form_id: form.id,
      country: countryFromTimezone(req.body?.tz),
      // the client knows about touch/iPadOS better than the UA string does
      device: ['mobile', 'tablet', 'desktop'].includes(req.body?.device) ? req.body.device : device,
      browser, os,
      referrer: (req.body?.referrer || '').slice(0, 300) || null,
      submitted: false,
      max_step: 1,
    });
    res.status(201).json({ view_id: view.id });
  } catch {
    res.json({ view_id: null });   // tracking is best-effort
  }
});

// furthest step reached — this is what turns "40 submissions" into "where do
// people give up", which is the whole point of splitting the form into steps
publicRouter.post('/:slug/step', async (req, res) => {
  try {
    const id = req.body?.view_id;
    const step = parseInt(req.body?.step, 10);
    if (!id || !Number.isFinite(step)) return res.json({ ok: true });
    const view = await db.get('form_views', id);
    if (view && step > (view.max_step || 0)) await db.update('form_views', id, { max_step: step });
  } catch { /* best-effort */ }
  res.json({ ok: true });
});

publicRouter.post('/:slug/submit', async (req, res) => {
  const form = await db.getBy('lead_forms', 'slug', req.params.slug);
  if (!form || !form.active) return res.status(404).json({ error: 'הטופס לא נמצא' });
  const payload = { ...(req.body || {}) };
  // tracking metadata travels with the submission — strip it before it can be
  // mistaken for a form answer and land in the lead's notes
  const viewId = payload.__view_id; delete payload.__view_id;
  const durationMs = parseInt(payload.__duration_ms, 10); delete payload.__duration_ms;

  const lead = await createLeadFromPayload(payload, 'form', form.slug);
  await db.insert('form_submissions', { form_id: form.id, lead_id: lead.id, payload });

  try {
    if (viewId) {
      await db.update('form_views', viewId, {
        submitted: true,
        submitted_at: new Date().toISOString(),
        duration_ms: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
      });
    } else {
      // submitted without a tracked view (tracking blocked / old cached page) —
      // still record it, otherwise the completion rate would read too low
      const { browser, os, device } = parseUserAgent(req.get('user-agent'));
      await db.insert('form_views', {
        form_id: form.id, submitted: true, submitted_at: new Date().toISOString(),
        browser, os, device, max_step: 1,
      });
    }
  } catch { /* never fail a real submission over analytics */ }

  res.status(201).json({ ok: true, message: form.language === 'en' ? 'Thank you! We will be in touch soon.' : 'תודה! ניצור קשר בהקדם.' });
});

module.exports = { authed, publicRouter, createLeadFromPayload, BINDABLE_FIELDS };
