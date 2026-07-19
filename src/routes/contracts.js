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

// lead columns a client-editable field may write back to (whitelist — guards
// against a poisoned contract writing arbitrary columns from the public portal)
const CLIENT_WRITABLE_LEAD_FIELDS = [
  'contact_name', 'email', 'phone1', 'phone2', 'event_date', 'event_location',
  'event_type', 'id_number', 'address',
];

// gather all fill-in field definitions — from every 'fields' section plus the
// legacy global contract.fields (older contracts)
function fieldDefs(contract) {
  const out = [];
  for (const s of (contract.sections || [])) {
    if (s.type === 'fields') for (const it of (s.items || [])) out.push(it);
  }
  for (const f of (contract.fields || [])) out.push(f);
  return out;
}

// resolve field definitions to their current values (lead-bound or contract-stored)
function resolveFieldList(defs, lead) {
  return (defs || []).map(f => ({
    id: f.id,
    key: f.key,
    label: f.label || f.key,
    source: f.source === 'lead' ? 'lead' : 'custom',
    lead_field: f.source === 'lead' ? f.lead_field || null : null,
    client_editable: !!f.client_editable,
    value: f.source === 'lead'
      ? (lead && f.lead_field ? (lead[f.lead_field] ?? '') : '')
      : (f.value ?? ''),
  }));
}

// build the {{variable}} substitution map (lead fields + fill-in fields + legacy extras)
function buildVars(contract, lead) {
  const fieldVars = Object.fromEntries(resolveFieldList(fieldDefs(contract), lead).map(f => [f.key, f.value]));
  const extraVars = Object.fromEntries((contract.extra_fields || []).map(f => [f.key, f.value ?? '']));
  return {
    ...extraVars, ...fieldVars,
    name: lead?.name, contact_name: lead?.contact_name, event_date: lead?.event_date,
    event_location: lead?.event_location, event_type: lead?.event_type,
    email: lead?.email, phone1: lead?.phone1, phone2: lead?.phone2,
    id_number: lead?.id_number, address: lead?.address,
    proposed_price: lead?.proposed_price, package_type: lead?.package_type,
    relation: lead?.relation, referrer: lead?.referrer,
    final_price: contract.final_price, base_price: contract.base_price,
    // מקדמה לשריון תאריך: הסכום שנקבע בליד, ואם ריק — 10% מהמחיר הסופי
    deposit: (lead && lead.deposit_amount != null && lead.deposit_amount !== '')
      ? lead.deposit_amount
      : Math.round((Number(contract.final_price) || 0) * 0.1),
    today: new Date().toISOString().slice(0, 10),
  };
}

// substitute {{variables}} into any text/html
function substitute(text, vars) {
  return String(text || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) =>
    vars[key] !== undefined && vars[key] !== null && vars[key] !== '' ? String(vars[key]) : '—');
}

function renderBody(contract, lead) {
  return substitute(contract.body_html || '', buildVars(contract, lead));
}

// resolve typed proposal sections for the portal. Types:
//   title    → { html }
//   text     → { html }
//   products → { title_html, items:[{ package_item_id, name_html, desc_html }] }
// product items are drawn from the contract's package; included items are shown
// as info, optional items as a selectable line with their (package) price.
function resolveSections(sections, pkg, vars, lead) {
  if (!Array.isArray(sections) || !sections.length) return [];
  const itemsById = Object.fromEntries((pkg?.items || []).map(i => [i.id, i]));
  return sections.map((s) => {
    if (s.type === 'title') return { id: s.id, type: 'title', html: substitute(s.html, vars), dir: s.dir || null };
    if (s.type === 'fields') {
      return {
        id: s.id, type: 'fields',
        title_html: substitute(s.title_html, vars), title_dir: s.title_dir || null,
        fields: resolveFieldList(s.items || [], lead),
      };
    }
    if (s.type === 'side') {
      return {
        id: s.id, type: 'side',
        title_html: substitute(s.title_html, vars), title_dir: s.title_dir || null,
        html: substitute(s.html, vars), dir: s.dir || null,
        cols: s.cols === 2 ? 2 : 1,
      };
    }
    if (s.type === 'product' || s.type === 'products') {
      const items = (s.items || []).map((it) => {
        const pi = itemsById[it.package_item_id];
        const prod = pi?.product || null;
        return {
          package_item_id: it.package_item_id || null,
          exists: !!pi,
          included: pi ? !!pi.included : false,
          price: pi ? Number(pi.effective_price) || 0 : 0,
          name_html: substitute(it.name_html || prod?.name || '', vars),
          name_dir: it.name_dir || null,
          desc_html: substitute(it.desc_html || prod?.description || '', vars),
          desc_dir: it.desc_dir || null,
        };
      });
      return { id: s.id, type: 'product', title_html: substitute(s.title_html, vars), title_dir: s.title_dir || null, cols: s.cols === 2 ? 2 : 1, items };
    }
    // 'text' and any legacy shape fall through to a text block (cols: 1 | 2)
    return { id: s.id, type: 'text', html: substitute(s.html || s.details || '', vars), dir: s.dir || null, cols: s.cols === 2 ? 2 : 1 };
  });
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
  const vars = buildVars(contract, lead);
  const header = contract.header || {};
  return {
    ...contract,
    lead: lead && {
      id: lead.id, name: lead.name, contact_name: lead.contact_name, email: lead.email,
      event_date: lead.event_date, event_location: lead.event_location, event_type: lead.event_type,
      phone1: lead.phone1, phone2: lead.phone2, id_number: lead.id_number, address: lead.address,
      relation: lead.relation,
    },
    package: pkg,
    rendered_body: renderBody(contract, lead),
    rendered_header: { title: substitute(header.title, vars), intro: substitute(header.intro, vars) },
    resolved_sections: resolveSections(contract.sections, pkg, vars, lead),
    client_fields: resolveFieldList(fieldDefs(contract), lead),
    language: contract.language || 'he',
    direction: contract.direction || 'rtl',
    require_client_signature: contract.require_client_signature !== false,
    management_signature: mgmtSig && { id: mgmtSig.id, name: mgmtSig.name, image_data: mgmtSig.image_data },
  };
}

// ---------- authenticated CRM routes ----------
const authed = express.Router();
authed.use(requireAuth);

// reusable proposal design templates (shared across the team).
// Registered before the '/:id' routes so '/templates' isn't captured as an id.
authed.get('/templates', async (req, res) => {
  const templates = await db.list('contract_templates', { orderBy: 'created_at', asc: false });
  res.json({ templates });
});

authed.post('/templates', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'שם התבנית חובה' });
  const template = await db.insert('contract_templates', {
    name, data: req.body?.data || {}, created_by: req.user.id,
  });
  res.status(201).json({ template });
});

authed.delete('/templates/:tid', async (req, res) => {
  await db.remove('contract_templates', req.params.tid);
  res.json({ ok: true });
});

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
    title: title || `הצעת מחיר — ${lead.name}`,
    body_html: body_html || '',
    header: {},
    sections: [],
    fields: [],
    extra_fields: [],
    language: 'he',
    direction: 'rtl',
    require_client_signature: true,
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
  for (const f of ['title', 'body_html', 'header', 'sections', 'fields', 'extra_fields',
    'language', 'direction', 'require_client_signature', 'selected_options', 'status', 'management_signature_id']) {
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

// client edits fields the band marked as client-editable — writes straight back
// to the CRM (lead-bound fields) or to the contract (custom fields)
portal.patch('/:token/fields', async (req, res) => {
  const c = await byToken(req, res);
  if (!c) return;
  if (c.client_signed_at) return res.status(400).json({ error: 'החוזה כבר נחתם ולא ניתן לשינוי' });
  const edits = req.body?.values && typeof req.body.values === 'object' ? req.body.values : {};

  // fields live inside 'fields' sections (and legacy contract.fields). Mutate the
  // matching definitions in place: lead-bound → write back to the lead; custom → store.
  const leadPatch = {};
  const applyTo = (arr) => {
    for (const f of (arr || [])) {
      if (!f.client_editable || !(f.key in edits)) continue;
      const val = edits[f.key];
      if (f.source === 'lead' && CLIENT_WRITABLE_LEAD_FIELDS.includes(f.lead_field)) {
        leadPatch[f.lead_field] = val === '' ? null : val;
      } else {
        f.value = val;
      }
    }
  };
  for (const s of (c.sections || [])) if (s.type === 'fields') applyTo(s.items);
  applyTo(c.fields);

  await db.update('contracts', c.id, { sections: c.sections, fields: c.fields });
  if (Object.keys(leadPatch).length && c.lead_id) {
    await db.update('leads', c.lead_id, leadPatch);
    await db.insert('lead_updates', {
      lead_id: c.lead_id, author_id: null, kind: 'system',
      body: `✏️ הלקוח עדכן פרטים בהצעה: ${Object.keys(leadPatch).join(', ')}`,
    });
  }
  const updated = await db.get('contracts', c.id);
  res.json({ contract: await fullContract(updated) });
});

// client digital signature
portal.post('/:token/sign', async (req, res) => {
  const c = await byToken(req, res);
  if (!c) return;
  if (c.client_signed_at) return res.status(400).json({ error: 'החוזה כבר נחתם' });
  const { signature, signer_name } = req.body || {};
  const sigRequired = c.require_client_signature !== false;
  const hasSig = signature && signature.startsWith('data:image');
  if (sigRequired && !hasSig) {
    return res.status(400).json({ error: 'נדרשת חתימה' });
  }
  if (!signer_name || !signer_name.trim()) {
    return res.status(400).json({ error: 'נדרש שם החותם/המאשר' });
  }
  const updated = await db.update('contracts', c.id, {
    client_signature: hasSig ? signature : null,
    client_signer_name: signer_name.trim(),
    client_signed_at: new Date().toISOString(),
    status: c.management_signature_id ? 'completed' : 'client_signed',
  });
  if (c.lead_id) {
    await db.insert('lead_updates', {
      lead_id: c.lead_id, author_id: null, kind: 'system',
      body: `${hasSig ? '✍️ הלקוח חתם על ההצעה' : '✅ הלקוח אישר את ההצעה'} (${signer_name.trim()}) · מחיר סופי: ₪${updated.final_price}`,
    });
    await db.update('leads', c.lead_id, { sale_status: 'win', close_date: new Date().toISOString().slice(0, 10) });
  }
  res.json({ contract: await fullContract(updated) });
});

module.exports = { authed, portal };
