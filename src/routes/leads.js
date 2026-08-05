const express = require('express');
const db = require('../db');
const { todayISO } = require('../lib/dates');
const whatsapp = require('../services/whatsapp');
const { broadcast } = require('../lib/events');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const LEAD_FIELDS = [
  'name','contact_name','groom_name','bride_name','event_type','event_date','event_location','relation',
  'owner_id','team','email','phone1','phone2','id_number','address','proposed_price','deposit_amount','stage',
  'sale_status','next_action','package_type','date_status','hear_about_us',
  'referrer','came_to_see_event','seen_at_date','seen_at_place',
  'first_contact_date','close_date','lost_reason','lost_competitor',
  'source','source_ref','contract_link','creation_log','last_updated_log',
];

// Hebrew names for the merge audit line
const CHILD_LABELS = {
  lead_contacts: 'אנשי קשר', lead_updates: 'עדכונים', contracts: 'חוזים',
  reminders: 'תזכורות', calendar_events: 'אירועי יומן',
  whatsapp_messages: 'הודעות וואטסאפ', voice_notes: 'הקלטות', form_submissions: 'טפסים',
};

const pickLead = (body) => {
  const out = {};
  for (const f of LEAD_FIELDS) if (f in (body || {})) out[f] = body[f];
  return out;
};

// LOST reason + competitor are recommended, never required. Historical leads
// genuinely don't have them, and forcing a value only produced invented data.
// Kept as a function so the call sites stay unchanged (and a future soft warning
// has an obvious home).
function lostGuard() {
  return null;
}

// The board only needs a COUNT of updates, never their text. Pulling every
// message body (WhatsApp threads included) just to call .length made this the
// heaviest query on the board by far, so ask only for lead_id. Both child
// queries run in parallel — they don't depend on each other.
async function attachChildren(leads) {
  if (!leads.length) return [];
  const [contacts, updateRefs] = await Promise.all([
    db.list('lead_contacts', {}),
    db.list('lead_updates', { columns: 'lead_id' }),
  ]);
  const cMap = new Map();
  for (const c of contacts) {
    if (!cMap.has(c.lead_id)) cMap.set(c.lead_id, []);
    cMap.get(c.lead_id).push(c);
  }
  const uCount = new Map();
  for (const u of updateRefs) uCount.set(u.lead_id, (uCount.get(u.lead_id) || 0) + 1);

  return leads.map(l => ({
    ...l,
    contacts: cMap.get(l.id) || [],
    updates_count: uCount.get(l.id) || 0,
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
    first_contact_date: todayISO(),
    ...data,
    created_by: req.user.id,
  });
  res.status(201).json({ lead });
  notify(req, 'created', { lead });
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
      // reason/competitor are optional now — only mention the ones actually set
      body: `הסטטוס שונה ל-${label}` +
        (patch.sale_status === 'lost'
          ? [lead.lost_reason ? ` · סיבה: ${lead.lost_reason}` : '',
            lead.lost_competitor ? ` · מתחרה: ${lead.lost_competitor}` : ''].join('')
          : ''),
    });
  }
  res.json({ lead });
  // after the response: a slow or broken listener must never delay the save
  notify(req, 'updated', { lead });
});

router.delete('/:id', async (req, res) => {
  await db.remove('leads', req.params.id);
  res.json({ ok: true });
  notify(req, 'deleted', { id: req.params.id });
});

// ---- contacts (אנשי קשר נוספים) ----
router.post('/:id/contacts', async (req, res) => {
  const lead = await db.get('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'ליד לא נמצא' });
  const { name, role, phone, email, id_number, address } = req.body || {};
  if (!name) return res.status(400).json({ error: 'שם איש הקשר הוא שדה חובה' });
  const contact = await db.insert('lead_contacts', { lead_id: lead.id, name, role, phone, email, id_number, address });
  res.status(201).json({ contact });
});

router.patch('/:id/contacts/:contactId', async (req, res) => {
  const patch = {};
  for (const f of ['name', 'role', 'phone', 'email', 'id_number', 'address']) {
    if (f in (req.body || {})) patch[f] = req.body[f];
  }
  const contact = await db.update('lead_contacts', req.params.contactId, patch);
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

// ---- WhatsApp thread (chat view per lead) ----
router.get('/:id/messages', async (req, res) => {
  const messages = await db.list('whatsapp_messages', {
    filters: { lead_id: req.params.id }, orderBy: 'created_at', asc: true,
  });
  const st = whatsapp.status();
  res.json({ messages, wa: { connected: st.connected, enabled: st.enabled } });
});

router.post('/:id/messages', async (req, res) => {
  const lead = await db.get('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'ליד לא נמצא' });
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'הודעה ריקה' });
  // A lead can hold more than one conversation once other people have been
  // absorbed into it as contacts; the reply belongs to the thread being read.
  const to = (req.body?.to || '').trim() || null;
  if (!to && !lead.phone1 && !(lead.source_ref || '').includes('@')) {
    return res.status(400).json({ error: 'אין מספר טלפון לליד' });
  }
  let sent;
  try { sent = await whatsapp.sendToLead(lead, body, to); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // Baileys also echoes our own send back via messages.upsert (fromMe) — store
  // the message id here so that echo dedupes against this row instead of doubling
  const waId = sent?.id || null;
  if (waId) {
    const existing = await db.getBy('whatsapp_messages', 'wa_message_id', waId);
    if (existing) return res.status(201).json({ message: existing });
  }
  let message;
  try {
    message = await db.insert('whatsapp_messages', {
      wa_chat_id: sent?.jid || null, wa_message_id: waId,
      from_number: null, from_name: req.user.full_name || req.user.email,
      body, lead_id: lead.id, direction: 'out',
    });
  } catch {
    // the echo won the race and inserted first — return that row
    message = waId ? await db.getBy('whatsapp_messages', 'wa_message_id', waId) : null;
  }
  res.status(201).json({ message });
});

// ---- reminders (email / whatsapp to whoever handles the event) ----
router.get('/:id/reminders', async (req, res) => {
  const reminders = await db.list('reminders', {
    filters: { lead_id: req.params.id }, orderBy: 'remind_at', asc: true,
  });
  const profiles = await db.list('profiles', {});
  const names = Object.fromEntries(profiles.map(p => [p.id, p.full_name || p.email]));
  res.json({
    reminders: reminders.map(r => ({ ...r, recipient_name: names[r.recipient_id] || null })),
  });
});

router.post('/:id/reminders', async (req, res) => {
  const lead = await db.get('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'ליד לא נמצא' });

  const { channel, remind_at, message, recipient_id } = req.body || {};
  if (!['email', 'whatsapp'].includes(channel)) {
    return res.status(400).json({ error: 'יש לבחור ערוץ: מייל או וואטסאפ' });
  }
  if (!remind_at || isNaN(new Date(remind_at))) {
    return res.status(400).json({ error: 'יש לבחור תאריך ושעה לתזכורת' });
  }
  const recipient = recipient_id || lead.owner_id;
  if (!recipient) {
    return res.status(400).json({ error: 'אין איש צוות מטפל לליד — בחרו נמען לתזכורת' });
  }
  const person = await db.get('profiles', recipient);
  if (!person) return res.status(400).json({ error: 'איש הצוות לא נמצא' });
  if (channel === 'whatsapp' && !person.phone) {
    return res.status(400).json({ error: `ל-${person.full_name || person.email} אין מספר וואטסאפ בפרופיל (הגדרות → פרופיל)` });
  }

  const reminder = await db.insert('reminders', {
    lead_id: lead.id,
    channel,
    remind_at: new Date(remind_at).toISOString(),
    message: (message || '').trim() || null,
    recipient_id: recipient,
    status: 'pending',
    created_by: req.user.id,
  });
  res.status(201).json({ reminder: { ...reminder, recipient_name: person.full_name || person.email } });
});

router.delete('/:id/reminders/:reminderId', async (req, res) => {
  await db.remove('reminders', req.params.reminderId);
  res.json({ ok: true });
});

// Tell every other open browser what just changed. `by` is the author, so a
// client can ignore the echo of its own edit instead of fighting itself.
function notify(req, action, payload) {
  try {
    broadcast('lead', action, {
      ...payload,
      by: req.user?.id,
      by_name: req.user?.full_name || req.user?.email || '',
    });
  } catch { /* the feed is a convenience; it must never break a write */ }
}

// Every table that carries a lead_id. Anything left off this list is either
// destroyed (reminders / calendar_events cascade) or orphaned
// (whatsapp_messages / voice_notes / form_submissions are set null) whenever a
// lead is merged or purged. Keep it in step with the schema.
const CHILD_TABLES = [
  'lead_contacts', 'lead_updates', 'contracts', 'reminders',
  'calendar_events', 'whatsapp_messages', 'voice_notes', 'form_submissions',
];

// ---- empty a whole pipeline ----
// Deliberately hostile to accidents: admin only, and the caller must send the
// row count it just saw. If the real count differs — someone else added leads,
// or the screen was stale — nothing is deleted. That is the exact failure mode
// that turns "delete the 5,100 LOST rows" into "delete rows I never looked at".
router.post('/purge', requireAdmin, async (req, res) => {
  const scope = req.body?.sale_status;
  if (!['open', 'win', 'lost', 'all'].includes(scope)) {
    return res.status(400).json({ error: 'יש לבחור צינור למחיקה' });
  }
  const filters = scope === 'all' ? {} : { sale_status: scope };
  const victims = await db.list('leads', { filters, columns: 'id' });
  const ids = victims.map(l => l.id);

  const expected = Number(req.body?.confirm_count);
  if (!Number.isInteger(expected) || expected !== ids.length) {
    return res.status(409).json({
      error: `המספר לא תואם: במערכת יש ${ids.length} רשומות ולא ${req.body?.confirm_count}. רעננו ונסו שוב.`,
      actual: ids.length,
    });
  }
  if (!ids.length) return res.json({ deleted: 0, children: {} });

  // children first, in id batches — a single .in() with thousands of UUIDs
  // makes a URL no proxy will accept
  const BATCH = 200;
  const children = {};
  for (const t of CHILD_TABLES) {
    let n = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      n += await db.removeWhere(t, 'lead_id', ids.slice(i, i + BATCH));
    }
    if (n) children[t] = n;
  }
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    deleted += await db.removeWhere('leads', 'id', ids.slice(i, i + BATCH));
  }
  console.warn(`[purge] ${req.user.email} deleted ${deleted} leads (${scope})`);
  res.json({ deleted, children, scope });
  notify(req, 'bulk', { count: deleted, reason: 'purge' });
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

  // Move EVERY child row before the duplicate is deleted (see CHILD_TABLES).
  const moved = {};
  for (const t of CHILD_TABLES) {
    const rows = await db.list(t, { filters: { lead_id: dup.id } });
    if (!rows.length) continue;
    await Promise.all(rows.map(r => db.update(t, r.id, { lead_id: primary.id })));
    moved[t] = rows.length;
  }

  const lead = await db.update('leads', primary.id, patch);
  await db.remove('leads', dup.id);
  await db.insert('lead_updates', {
    lead_id: primary.id, author_id: req.user.id, kind: 'system',
    body: `🔀 מוזג עם הליד "${dup.name}" (הכפיל נמחק)`
      + (Object.keys(moved).length
        ? ` · הועברו: ${Object.entries(moved).map(([t, n]) => `${CHILD_LABELS[t] || t} ${n}`).join(', ')}`
        : ''),
  });
  res.json({ lead, moved });
  notify(req, 'bulk', { count: 1, reason: 'merge' });
});

// ---- absorb a lead into another one as an extra contact ----
// The bride, the groom and the groom's father each write in separately, so one
// wedding arrives as three leads. A merge would flatten them into a single
// record and lose who is who; this keeps the second record's identity as a
// contact of the first, and brings its WhatsApp conversation along with it.
router.post('/:id/absorb', async (req, res) => {
  const sourceId = req.body?.lead_id;
  if (!sourceId || sourceId === req.params.id) {
    return res.status(400).json({ error: 'יש לבחור ליד אחר לצירוף' });
  }
  const [target, source] = await Promise.all([
    db.get('leads', req.params.id), db.get('leads', sourceId),
  ]);
  if (!target || !source) return res.status(404).json({ error: 'אחד הלידים לא נמצא' });

  const contact = await db.insert('lead_contacts', {
    lead_id: target.id,
    name: source.contact_name || source.name,
    role: (req.body?.role || '').trim() || source.relation || null,
    phone: source.phone1 || source.phone2 || null,
    email: source.email || null,
    id_number: source.id_number || null,
    address: source.address || null,
  });

  // Everything the absorbed record accumulated moves across — including its
  // WhatsApp messages, which keep their own wa_chat_id and so stay readable as
  // a separate conversation rather than being interleaved into one thread.
  const moved = {};
  for (const t of CHILD_TABLES) {
    const rows = await db.list(t, { filters: { lead_id: source.id } });
    if (!rows.length) continue;
    await Promise.all(rows.map(r => db.update(t, r.id, { lead_id: target.id })));
    moved[t] = rows.length;
  }

  // only blanks — the surviving lead's own answers are never overwritten by a
  // record that was demoted to a contact
  const patch = {};
  for (const f of LEAD_FIELDS) {
    const cur = target[f];
    if ((cur === null || cur === undefined || cur === '') && source[f] != null && source[f] !== '') {
      patch[f] = source[f];
    }
  }
  // identity fields belong to the contact now, not to the surviving lead
  for (const f of ['name', 'contact_name', 'sale_status', 'source', 'source_ref']) delete patch[f];

  const lead = Object.keys(patch).length ? await db.update('leads', target.id, patch) : target;
  await db.remove('leads', source.id);
  await db.insert('lead_updates', {
    lead_id: target.id, author_id: req.user.id, kind: 'system',
    body: `👥 הליד "${source.name}" צורף כאיש קשר (${contact.name}${contact.role ? ` · ${contact.role}` : ''})`
      + (Object.keys(moved).length
        ? ` · הועברו: ${Object.entries(moved).map(([t, n]) => `${CHILD_LABELS[t] || t} ${n}`).join(', ')}`
        : ''),
  });
  res.status(201).json({ lead, contact, moved });
  notify(req, 'bulk', { count: 1, reason: 'absorb' });
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

// ---- duplicate review: phone numbers approved as "not a duplicate" ----
// One producer books many weddings, so the same number legitimately appears on
// several leads. Approving is a shared judgement about the number, so it lives
// server-side rather than per-browser — and it is always reversible.
router.get('/meta/duplicate-dismissals', async (req, res) => {
  res.json({ dismissals: await db.list('duplicate_dismissals', { orderBy: 'created_at', asc: false }) });
});

router.post('/meta/duplicate-dismissals', async (req, res) => {
  const phone_key = String(req.body?.phone_key || '').trim();
  if (!phone_key) return res.status(400).json({ error: 'חסר מספר טלפון' });
  const existing = await db.getBy('duplicate_dismissals', 'phone_key', phone_key);
  if (existing) return res.json({ dismissal: existing });
  const dismissal = await db.insert('duplicate_dismissals', {
    phone_key,
    note: (req.body?.note || '').trim() || null,
    dismissed_by: req.user.id,
  });
  res.status(201).json({ dismissal });
});

// undo — the number goes back into the duplicate review
router.delete('/meta/duplicate-dismissals/:phoneKey', async (req, res) => {
  const existing = await db.getBy('duplicate_dismissals', 'phone_key', req.params.phoneKey);
  if (existing) await db.remove('duplicate_dismissals', existing.id);
  res.json({ ok: true });
});

module.exports = router;
