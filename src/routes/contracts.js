const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const email = require('../services/email');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ---------- shared helpers ----------
async function packageWithItems(packageId) {
  if (!packageId) return null;
  const pkg = await db.get('packages', packageId);
  if (!pkg) return null;
  const items = await db.list('package_items', { filters: { package_id: pkg.id }, orderBy: 'sort_order' });
  const products = await db.list('products', {});
  const pMap = Object.fromEntries(products.map(p => [p.id, p]));
  return {
    ...pkg,
    items: items.map(i => ({
      ...i,
      product: pMap[i.product_id] || null,
      effective_price: i.override_price ?? pMap[i.product_id]?.default_price ?? 0,
    })),
  };
}

function computeFinalPrice(contract, pkg) {
  let total = Number(contract.base_price) || 0;
  if (!pkg) return total;
  const selected = new Set(contract.selected_options || []);
  for (const item of pkg.items) {
    if (!item.included && selected.has(item.id)) total += Number(item.effective_price) || 0;
  }
  return total;
}

// substitute {{variables}} from the lead + extra fields into the body html
function renderBody(contract, lead) {
  let html = contract.body_html || '';
  const vars = {
    ...Object.fromEntries((contract.extra_fields || []).map(f => [f.key, f.value ?? ''])),
    name: lead?.name, contact_name: lead?.contact_name, event_date: lead?.event_date,
    event_location: lead?.event_location, event_type: lead?.event_type,
    email: lead?.email, phone1: lead?.phone1, phone2: lead?.phone2,
    proposed_price: lead?.proposed_price, package_type: lead?.package_type,
    relation: lead?.relation, referrer: lead?.referrer,
    final_price: contract.final_price, base_price: contract.base_price,
    today: new Date().toISOString().slice(0, 10),
  };
  return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : `—`);
}

async function fullContract(contract) {
  const lead = contract.lead_id ? await db.get('leads', contract.lead_id) : null;
  const pkg = await packageWithItems(contract.package_id);
  const final_price = computeFinalPrice(contract, pkg);
  if (final_price !== contract.final_price) {
    contract = await db.update('contracts', contract.id, { final_price }) || contract;
  }
  let mgmtSig = null;
  if (contract.management_signature_id) {
    mgmtSig = await db.get('management_signatures', contract.management_signature_id);
  }
  return {
    ...contract,
    lead: lead && { id: lead.id, name: lead.name, contact_name: lead.contact_name, email: lead.email, event_date: lead.event_date, event_location: lead.event_location, phone1: lead.phone1 },
    package: pkg,
    rendered_body: renderBody(contract, lead),
    management_signature: mgmtSig && { id: mgmtSig.id, name: mgmtSig.name, image_data: mgmtSig.image_data },
  };
}

// ---------- authenticated CRM routes ----------
const authed = express.Router();
authed.use(requireAuth);

authed.get('/', async (req, res) => {
  const filters = {};
  if (req.query.lead_id) filters.lead_id = req.query.lead_id;
  const contracts = await db.list('contracts', { filters, orderBy: 'created_at', asc: false });
  res.json({ contracts: await Promise.all(contracts.map(fullContract)) });
});

authed.get('/:id', async (req, res) => {
  const c = await db.get('contracts', req.params.id);
  if (!c) return res.status(404).json({ error: 'חוזה לא נמצא' });
  res.json({ contract: await fullContract(c) });
});

authed.post('/', async (req, res) => {
  const { lead_id, package_id, title, body_html } = req.body || {};
  const lead = await db.get('leads', lead_id);
  if (!lead) return res.status(400).json({ error: 'יש לשייך חוזה לליד קיים' });
  const pkg = await packageWithItems(package_id);
  const contract = await db.insert('contracts', {
    lead_id,
    package_id: pkg?.id || null,
    title: title || `חוזה הופעה — ${lead.name}`,
    body_html: body_html || defaultTemplate(),
    extra_fields: [],
    selected_options: [],
    base_price: pkg?.base_price || 0,
    final_price: pkg?.base_price || 0,
    status: 'draft',
    client_token: crypto.randomBytes(16).toString('hex'),
    created_by: req.user.id,
  });
  if (pkg) await db.update('leads', lead.id, { package_type: pkg.name });
  res.status(201).json({ contract: await fullContract(contract) });
});

authed.patch('/:id', async (req, res) => {
  const c = await db.get('contracts', req.params.id);
  if (!c) return res.status(404).json({ error: 'חוזה לא נמצא' });
  const patch = {};
  for (const f of ['title', 'body_html', 'extra_fields', 'selected_options', 'status', 'management_signature_id']) {
    if (f in (req.body || {})) patch[f] = req.body[f];
  }
  if ('package_id' in (req.body || {})) {
    const pkg = await packageWithItems(req.body.package_id);
    patch.package_id = pkg?.id || null;
    patch.base_price = pkg?.base_price || 0;
    patch.selected_options = [];
    if (pkg && c.lead_id) await db.update('leads', c.lead_id, { package_type: pkg.name });
  }
  if ('base_price' in (req.body || {})) patch.base_price = Number(req.body.base_price) || 0;
  if (patch.management_signature_id && !c.management_signed_at) {
    patch.management_signed_at = new Date().toISOString();
  }
  const updated = await db.update('contracts', req.params.id, patch);
  res.json({ contract: await fullContract(updated) });
});

authed.post('/:id/send', async (req, res) => {
  const c = await db.get('contracts', req.params.id);
  if (!c) return res.status(404).json({ error: 'חוזה לא נמצא' });
  const lead = await db.get('leads', c.lead_id);
  const token = c.client_token || crypto.randomBytes(16).toString('hex');
  const updated = await db.update('contracts', c.id, { status: 'sent', client_token: token });
  const link = `${config.frontendUrl}/portal.html?t=${encodeURIComponent(token)}`;
  const to = req.body?.email || lead?.email;
  if (to) await email.contractReady(to, link, lead?.contact_name || lead?.name);
  await db.insert('lead_updates', {
    lead_id: c.lead_id, author_id: req.user.id, kind: 'system',
    body: `📄 החוזה נשלח ללקוח${to ? ` (${to})` : ''} · ${link}`,
  });
  res.json({ contract: await fullContract(updated), portal_link: link, emailed: !!to });
});

authed.delete('/:id', async (req, res) => {
  await db.remove('contracts', req.params.id);
  res.json({ ok: true });
});

// ---------- public client portal (token access, no auth) ----------
const portal = express.Router();

async function byToken(req, res) {
  const c = await db.getBy('contracts', 'client_token', req.params.token);
  if (!c || c.status === 'cancelled') {
    res.status(404).json({ error: 'החוזה לא נמצא או שאינו זמין' });
    return null;
  }
  return c;
}

portal.get('/:token', async (req, res) => {
  const c = await byToken(req, res);
  if (!c) return;
  const full = await fullContract(c);
  // hide internal-only fields from clients
  delete full.created_by;
  res.json({ contract: full });
});

// client toggles optional products — price updates live
portal.patch('/:token/options', async (req, res) => {
  const c = await byToken(req, res);
  if (!c) return;
  if (c.client_signed_at) return res.status(400).json({ error: 'החוזה כבר נחתם ולא ניתן לשינוי' });
  const selected = Array.isArray(req.body?.selected_options) ? req.body.selected_options : [];
  const updated = await db.update('contracts', c.id, { selected_options: selected });
  res.json({ contract: await fullContract(updated) });
});

// client digital signature
portal.post('/:token/sign', async (req, res) => {
  const c = await byToken(req, res);
  if (!c) return;
  if (c.client_signed_at) return res.status(400).json({ error: 'החוזה כבר נחתם' });
  const { signature, signer_name } = req.body || {};
  if (!signature || !signature.startsWith('data:image')) {
    return res.status(400).json({ error: 'נדרשת חתימה' });
  }
  const updated = await db.update('contracts', c.id, {
    client_signature: signature,
    client_signer_name: signer_name || '',
    client_signed_at: new Date().toISOString(),
    status: c.management_signature_id ? 'completed' : 'client_signed',
  });
  if (c.lead_id) {
    await db.insert('lead_updates', {
      lead_id: c.lead_id, author_id: null, kind: 'system',
      body: `✍️ הלקוח חתם על החוזה (${signer_name || 'ללא שם'}) · מחיר סופי: ₪${updated.final_price}`,
    });
    await db.update('leads', c.lead_id, { sale_status: 'win', close_date: new Date().toISOString().slice(0, 10) });
  }
  res.json({ contract: await fullContract(updated) });
});

function defaultTemplate() {
  return `<h2 style="text-align:center">חוזה התקשרות — להקת קולות</h2>
<p>שנחתם ביום {{today}} בין <b>להקת קולות</b> (להלן: "הלהקה") לבין <b>{{contact_name}}</b> (להלן: "הלקוח").</p>
<h3>פרטי האירוע</h3>
<p>סוג האירוע: {{event_type}} · תאריך: {{event_date}} · מיקום: {{event_location}}</p>
<h3>התמורה</h3>
<p>סך התמורה עבור השירותים המפורטים בחבילה: <b>₪{{final_price}}</b>.</p>
<h3>תנאים כלליים</h3>
<p>1. הלהקה תגיע למקום האירוע לפחות שעתיים לפני תחילת ההופעה לצורך התארגנות והתקנת ציוד.</p>
<p>2. ביטול עד 60 יום לפני האירוע — ללא חיוב. ביטול מאוחר יותר — לפי מדיניות הביטולים של הלהקה.</p>
<p>3. כל שינוי בהרכב או בתכולת החבילה יסוכם בכתב בין הצדדים.</p>`;
}

module.exports = { authed, portal };
