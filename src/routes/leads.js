const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const LEAD_FIELDS = [
  'name','contact_name','event_type','event_date','event_location','relation',
  'owner_id','team','email','phone1','phone2','proposed_price','stage',
  'sale_status','next_action','package_type','date_status','hear_about_us',
  'referrer','came_to_see_event','seen_at_date','seen_at_place',
  'first_contact_date','close_date','lost_reason','lost_competitor',
  'source','source_ref',
];

const pickLead = (body) => {
  const out = {};
  for (const f of LEAD_FIELDS) if (f in (body || {})) out[f] = body[f];
  return out;
};

function lostGuard(current, patch) {
  const merged = { ...current, ...patch };
  if (merged.sale_status === 'lost' && (!merged.lost_reason || !merged.lost_competitor)) {
    return 'העברה ל-LOST מחייבת "סיבת הפסד" ו"מתחרה שזכה"';
  }
  return null;
}

async function attachChildren(leads) {
  const contacts = await db.list('lead_contacts', {});
  const updates = await db.list('lead_updates', {});
  const byLead = (rows) => rows.reduce((m, r) => ((m[r.lead_id] = m[r.lead_id] || []).push(r), m), {});
  const cMap = byLead(contacts), uMap = byLead(updates);
  return leads.map(l => ({
    ...l,
    contacts: cMap[l.id] || [],
    updates_count: (uMap[l.id] || []).length,
  }));
}

// ---- list / read ----
router.get('/', async (req, res) => {
  const filters = {};
  if (req.query.status) filters.sale_status = req.query.status;
  const leads = await db.list('leads', { filters, orderBy: 'created_at', asc: false });
  res.json({ leads: await attachChildren(leads) });
});

router.get('/:id', async (req, res) => {
  const lead = await db.get('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'ליד לא נמצא' });
  const [withChildren] = await attachChildren([lead]);
  res.json({ lead: withChildren });
});

// ---- create ----
router.post('/', async (req, res) => {
  const data = pickLead(req.body);
  if (!data.name) return res.status(400).json({ error: 'שם הליד הוא שדה חובה' });
  const err = lostGuard({}, data);
  if (err) return res.status(400).json({ error: err });
  const lead = await db.insert('leads', {
    sale_status: 'open', source: 'manual', stage: 'לקוח חדש ידני',
    next_action: 'עוד פרטים', event_type: 'חתונה',
    first_contact_date: new Date().toISOString().slice(0, 10),
    ...data,
    created_by: req.user.id,
  });
  res.status(201).json({ lead });
});

// ---- inline update (autosave) ----
router.patch('/:id', async (req, res) => {
  const current = await db.get('leads', req.params.id);
  if (!current) return res.status(404).json({ error: 'ליד לא נמצא' });
  const patch = pickLead(req.body);
  const err = lostGuard(current, patch);
  if (err) return res.status(400).json({ error: err });

  const statusChanged = patch.sale_status && patch.sale_status !== current.sale_status;
  const lead = await db.update('leads', req.params.id, patch);
  if (statusChanged) {
    const label = { open: 'צינור ראשי', win: 'WIN 🎉', lost: 'LOST' }[patch.sale_status] || patch.sale_status;
    await db.insert('lead_updates', {
      lead_id: lead.id, author_id: req.user.id, kind: 'system',
      body: `הסטטוס שונה ל-${label}` +
        (patch.sale_status === 'lost' ? ` · סיבה: ${lead.lost_reason} · מתחרה: ${lead.lost_competitor}` : ''),
    });
  }
  res.json({ lead });
});

router.delete('/:id', async (req, res) => {
  await db.remove('leads', req.params.id);
  res.json({ ok: true });
});

// ---- contacts (אנשי קשר נוספים) ----
router.post('/:id/contacts', async (req, res) => {
  const lead = await db.get('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'ליד לא נמצא' });
  const { name, role, phone, email } = req.body || {};
  if (!name) return res.status(400).json({ error: 'שם איש הקשר הוא שדה חובה' });
  const contact = await db.insert('lead_contacts', { lead_id: lead.id, name, role, phone, email });
  res.status(201).json({ contact });
});

router.patch('/:id/contacts/:contactId', async (req, res) => {
  const { name, role, phone, email } = req.body || {};
  const contact = await db.update('lead_contacts', req.params.contactId, { name, role, phone, email });
  if (!contact) return res.status(404).json({ error: 'איש קשר לא נמצא' });
  res.json({ contact });
});

router.delete('/:id/contacts/:contactId', async (req, res) => {
  await db.remove('lead_contacts', req.params.contactId);
  res.json({ ok: true });
});

// ---- updates thread (אזור עדכונים) ----
router.get('/:id/updates', async (req, res) => {
  const updates = await db.list('lead_updates', {
    filters: { lead_id: req.params.id }, orderBy: 'created_at', asc: false,
  });
  const profiles = await db.list('profiles', {});
  const names = Object.fromEntries(profiles.map(p => [p.id, p.full_name || p.email]));
  res.json({ updates: updates.map(u => ({ ...u, author_name: names[u.author_id] || 'מערכת' })) });
});

router.post('/:id/updates', async (req, res) => {
  const lead = await db.get('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'ליד לא נמצא' });
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'תוכן העדכון ריק' });
  const update = await db.insert('lead_updates', {
    lead_id: lead.id, author_id: req.user.id, body, kind: 'note',
  });
  res.status(201).json({ update: { ...update, author_name: req.user.full_name || req.user.email } });
});

// ---- merge duplicates ----
// body: { primary_id, duplicate_id, resolutions: { field: chosenValue } }
router.post('/merge', async (req, res) => {
  const { primary_id, duplicate_id, resolutions = {} } = req.body || {};
  if (!primary_id || !duplicate_id || primary_id === duplicate_id) {
    return res.status(400).json({ error: 'יש לבחור שני לידים שונים למיזוג' });
  }
  const primary = await db.get('leads', primary_id);
  const dup = await db.get('leads', duplicate_id);
  if (!primary || !dup) return res.status(404).json({ error: 'אחד הלידים לא נמצא' });

  // fill empty fields from duplicate; conflicts resolved by explicit choices
  const patch = {};
  for (const f of LEAD_FIELDS) {
    if (f in resolutions) patch[f] = resolutions[f];
    else if ((primary[f] === null || primary[f] === undefined || primary[f] === '') && dup[f] != null) {
      patch[f] = dup[f];
    }
  }
  const err = lostGuard(primary, patch);
  if (err) return res.status(400).json({ error: err });

  // move children
  for (const c of await db.list('lead_contacts', { filters: { lead_id: dup.id } })) {
    await db.update('lead_contacts', c.id, { lead_id: primary.id });
  }
  for (const u of await db.list('lead_updates', { filters: { lead_id: dup.id } })) {
    await db.update('lead_updates', u.id, { lead_id: primary.id });
  }
  for (const c of await db.list('contracts', { filters: { lead_id: dup.id } })) {
    await db.update('contracts', c.id, { lead_id: primary.id });
  }

  const lead = await db.update('leads', primary.id, patch);
  await db.remove('leads', dup.id);
  await db.insert('lead_updates', {
    lead_id: primary.id, author_id: req.user.id, kind: 'system',
    body: `🔀 מוזג עם הליד "${dup.name}" (הכפיל נמחק)`,
  });
  res.json({ lead });
});

// ---- competitors dropdown ----
router.get('/meta/competitors', async (req, res) => {
  res.json({ competitors: await db.list('competitors', { orderBy: 'name' }) });
});
router.post('/meta/competitors', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'שם מתחרה ריק' });
  const existing = await db.getBy('competitors', 'name', name);
  if (existing) return res.json({ competitor: existing });
  res.status(201).json({ competitor: await db.insert('competitors', { name }) });
});

module.exports = router;
