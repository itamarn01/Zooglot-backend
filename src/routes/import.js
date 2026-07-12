// Excel / CSV import for מעקב זוגות — a Monday-style flow:
//   1) POST /import/parse  — upload .xlsx/.xls/.csv, get columns + rows back
//   2) POST /import/leads  — commit mapped rows as leads (add / skip / update)
//   3) POST /import/updates — import a Monday "Updates" export into lead threads
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// keep uploads in memory — these files are small and we only read them once
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ---- importable lead fields (target columns) ----
const RELATIONS = ['כלה', 'חתן', 'הורה', 'מפיק/ה', 'אחר'];
const EVENT_TYPES = ['חתונה', 'בר/בת מצווה', 'אירוע חברה', 'אחר'];
const HEAR = ['Instagram', 'Youtube', 'ניגנתם אצל חברים', 'המלצה', 'גוגל', 'אחר'];

const LEAD_TARGETS = [
  { key: 'name', label: 'שם', type: 'text', required: true },
  { key: 'contact_name', label: 'איש קשר', type: 'text' },
  { key: 'relation', label: 'קרבה', type: 'select' },
  { key: 'event_type', label: 'סוג אירוע', type: 'select' },
  { key: 'event_date', label: 'תאריך אירוע', type: 'date' },
  { key: 'event_location', label: 'מיקום האירוע', type: 'text' },
  { key: 'owner_id', label: 'בטיפול', type: 'owner' },
  { key: 'email', label: 'מייל', type: 'text' },
  { key: 'phone1', label: 'טלפון 1', type: 'phone' },
  { key: 'phone2', label: 'טלפון 2', type: 'phone' },
  { key: 'proposed_price', label: 'מחיר שהוצע', type: 'number' },
  { key: 'stage', label: 'שלב', type: 'text' },
  { key: 'sale_status', label: 'סטאטוס מכירה', type: 'status' },
  { key: 'next_action', label: 'פעולה הבאה', type: 'text' },
  { key: 'team', label: 'צוות', type: 'text' },
  { key: 'hear_about_us', label: 'איך שמעו עלינו', type: 'text' },
  { key: 'referrer', label: 'מי המליץ', type: 'text' },
  { key: 'came_to_see_event', label: 'באו לראות באירוע', type: 'text' },
  { key: 'seen_at_date', label: 'הגיעו בתאריך', type: 'date' },
  { key: 'seen_at_place', label: 'מקום שראו', type: 'text' },
  { key: 'first_contact_date', label: 'תאריך התקשרות', type: 'date' },
  { key: 'close_date', label: 'תאריך סגירה', type: 'date' },
  { key: 'lost_reason', label: 'למה לא?', type: 'text' },
  { key: 'lost_competitor', label: 'מתחרה שזכה', type: 'text' },
  { key: 'package_type', label: 'סוג חבילה', type: 'text' },
  { key: 'date_status', label: 'סטטוס תאריך', type: 'text' },
  { key: 'source_ref', label: 'מזהה חיצוני (Item ID)', type: 'text' },
  { key: 'notes', label: 'הערות (יתווספו כעדכון)', type: 'notes' },
];

// aliases → target key, for auto-mapping columns by their header name
const norm = (s) => String(s || '').trim().toLowerCase().replace(/[?:.]/g, '').replace(/\s+/g, ' ');
const ALIASES = {
  name: 'name', 'שם': 'name', 'item name': 'name', 'שם מלא': 'name', 'שם האירוע': 'name',
  contact: 'contact_name', 'איש קשר': 'contact_name', 'contact name': 'contact_name',
  'קרבה': 'relation', relation: 'relation', 'קרבה לאירוע': 'relation',
  'סוג אירוע': 'event_type', 'event type': 'event_type',
  'event date': 'event_date', 'תאריך אירוע': 'event_date', 'תאריך האירוע': 'event_date', date: 'event_date',
  'event location': 'event_location', 'מיקום האירוע': 'event_location', 'מיקום': 'event_location', location: 'event_location',
  'בטיפול': 'owner_id', owner: 'owner_id', 'assigned to': 'owner_id',
  email: 'email', 'מייל': 'email', 'אימייל': 'email', mail: 'email',
  'טלפון 1': 'phone1', 'טלפון': 'phone1', phone: 'phone1', 'phone 1': 'phone1', 'טלפון1': 'phone1',
  'טלפון 2': 'phone2', 'phone 2': 'phone2', 'טלפון2': 'phone2',
  'מחיר שהוצע': 'proposed_price', 'proposed price': 'proposed_price', price: 'proposed_price', 'מחיר': 'proposed_price',
  'שלב': 'stage', stage: 'stage',
  'סטאטוס מכירה': 'sale_status', 'סטטוס מכירה': 'sale_status', 'sale status': 'sale_status', status: 'sale_status',
  'פעולה הבאה': 'next_action', 'next action': 'next_action',
  'צוות': 'team', team: 'team',
  'איך שמעו עלינו': 'hear_about_us', "how'd you hear about us": 'hear_about_us', 'how did you hear about us': 'hear_about_us', 'איך שמעתם עלינו': 'hear_about_us',
  'מי המליץ': 'referrer', referrer: 'referrer', 'who referred': 'referrer',
  'באו לראות באירוע': 'came_to_see_event',
  'הגיעו בתאריך': 'seen_at_date',
  'מקום שראו': 'seen_at_place', 'באיזה מקום ראו': 'seen_at_place',
  'תאריך התקשרות': 'first_contact_date',
  'תאריך סגירה': 'close_date', 'close date': 'close_date',
  'למה לא': 'lost_reason',
  'מתחרה שזכה': 'lost_competitor',
  'סוג חבילה': 'package_type',
  'סטטוס תאריך': 'date_status',
  'item id': 'source_ref', 'item id (auto generated)': 'source_ref',
  'הערות': 'notes', notes: 'notes',
};

function autoMap(columns, targets) {
  const used = new Set();
  const mapping = {};
  for (const col of columns) {
    const key = ALIASES[norm(col)];
    if (key && targets.some(t => t.key === key) && !used.has(key)) {
      mapping[col] = key;
      used.add(key);
    }
  }
  return mapping;
}

// ---- value coercion helpers ----
function toDateStr(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  // already ISO-ish
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
function toPhone(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return String(Math.round(v));
  return String(v).trim();
}
function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return isNaN(n) ? null : n;
}
function toStatus(v) {
  const s = norm(v);
  if (['win', 'won', 'זכייה', 'נסגר', 'סגור'].includes(s)) return 'win';
  if (['lost', 'lose', 'הפסד', 'אבוד'].includes(s)) return 'lost';
  return 'open';
}
const closest = (val, options) => {
  const s = norm(val);
  return options.find(o => norm(o) === s) || options.find(o => norm(o).includes(s) || s.includes(norm(o))) || null;
};

// map a raw source value to a normalized lead value for a target key
function coerce(key, raw, profileByName) {
  const target = LEAD_TARGETS.find(t => t.key === key);
  if (!target) return undefined;
  switch (target.type) {
    case 'date': return toDateStr(raw);
    case 'phone': return toPhone(raw);
    case 'number': return toNumber(raw);
    case 'status': return toStatus(raw);
    case 'owner': {
      const p = profileByName(raw);
      return p ? p.id : undefined; // unknown owner → leave unset (keep raw name in team if desired)
    }
    default: {
      const s = raw == null ? '' : String(raw).trim();
      if (s === '') return null;
      if (key === 'relation') return closest(s, RELATIONS) || s;
      if (key === 'event_type') return closest(s, EVENT_TYPES) || s;
      if (key === 'hear_about_us') return closest(s, HEAR) || s;
      return s;
    }
  }
}

// ---- parse an uploaded workbook into columns + rows ----
router.post('/parse', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא התקבל קובץ' });
  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  } catch {
    return res.status(400).json({ error: 'קובץ לא תקין — יש להעלות קובץ Excel או CSV' });
  }
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  if (!matrix.length) return res.status(400).json({ error: 'הגיליון ריק' });

  // first non-empty row = headers; dedupe blank/duplicate header names
  const rawHeaders = matrix[0].map((h, i) => (String(h).trim() || `עמודה ${i + 1}`));
  const seen = {};
  const columns = rawHeaders.map(h => {
    if (seen[h]) { seen[h]++; return `${h} (${seen[h]})`; }
    seen[h] = 1; return h;
  });
  const rows = matrix.slice(1).map(r => {
    const o = {};
    columns.forEach((c, i) => { o[c] = r[i] === undefined ? '' : r[i]; });
    return o;
  }).filter(o => Object.values(o).some(v => v !== '' && v != null));

  res.json({
    sheet_names: wb.SheetNames,
    columns,
    rows,
    total: rows.length,
    suggested_mapping: autoMap(columns, LEAD_TARGETS),
  });
});

router.get('/fields', async (req, res) => {
  const profiles = await db.list('profiles', {});
  res.json({
    targets: LEAD_TARGETS,
    team: profiles.map(p => ({ id: p.id, name: p.full_name || p.email })),
  });
});

// ---- commit mapped rows as leads ----
// body: { rows, mapping: {sourceCol: targetKey}, match_strategy: 'add'|'skip'|'update', match_field: 'name'|'source_ref' }
router.post('/leads', async (req, res) => {
  const { rows = [], mapping = {}, match_strategy = 'add', match_field = 'name' } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'אין שורות לייבוא' });
  if (!Object.values(mapping).includes('name')) return res.status(400).json({ error: 'חובה למפות עמודה לשדה "שם"' });

  const profiles = await db.list('profiles', {});
  const profileByName = (raw) => {
    const s = norm(raw);
    if (!s) return null;
    return profiles.find(p => norm(p.full_name) === s || norm(p.email) === s || norm(p.email).split('@')[0] === s) || null;
  };
  const existing = await db.list('leads', {});
  const findMatch = (val) => {
    const s = norm(val);
    if (!s) return null;
    return existing.find(l => norm(l[match_field]) === s) || null;
  };

  let created = 0, updated = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    const data = {};
    let notes = null;
    for (const [col, key] of Object.entries(mapping)) {
      if (!key) continue;
      const val = coerce(key, row[col], profileByName);
      if (val === undefined) continue;
      if (key === 'notes') { notes = row[col]; continue; }
      data[key] = val;
    }
    if (!data.name) { failed++; continue; }

    try {
      const match = (match_strategy !== 'add') ? findMatch(data[match_field]) : null;
      if (match && match_strategy === 'skip') { skipped++; continue; }

      let lead;
      if (match && match_strategy === 'update') {
        lead = await db.update('leads', match.id, { ...data, updated_at: new Date().toISOString() });
        updated++;
      } else {
        lead = await db.insert('leads', {
          sale_status: 'open', source: 'import', stage: 'לקוח חדש ידני',
          next_action: 'עוד פרטים', event_type: 'חתונה',
          ...data,
          created_by: req.user.id,
        });
        created++;
      }
      if (notes && String(notes).trim()) {
        await db.insert('lead_updates', {
          lead_id: lead.id, author_id: req.user.id, kind: 'system',
          body: `📥 יובא מאקסל: ${String(notes).trim()}`,
        });
      }
    } catch { failed++; }
  }
  res.json({ created, updated, skipped, failed, total: rows.length });
});

// ---- import a Monday "Updates" export into lead update threads ----
// body: { rows, mapping: { match:'colName', content:'colName', author?:'colName', date?:'colName' },
//         match_field: 'name'|'source_ref' }
router.post('/updates', async (req, res) => {
  const { rows = [], mapping = {}, match_field = 'name' } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'אין שורות לייבוא' });
  if (!mapping.match || !mapping.content) return res.status(400).json({ error: 'יש למפות עמודת זיהוי ליד ועמודת תוכן העדכון' });

  const profiles = await db.list('profiles', {});
  const profileByName = (raw) => {
    const s = norm(raw);
    return profiles.find(p => norm(p.full_name) === s || norm(p.email).split('@')[0] === s) || null;
  };
  const leads = await db.list('leads', {});
  const leadBy = (val) => {
    const s = norm(val);
    if (!s) return null;
    return leads.find(l => norm(l[match_field]) === s) || null;
  };

  let imported = 0, unmatched = 0, empty = 0;
  const missing = new Set();
  for (const row of rows) {
    const content = String(row[mapping.content] ?? '').trim();
    if (!content) { empty++; continue; }
    const lead = leadBy(row[mapping.match]);
    if (!lead) { unmatched++; missing.add(String(row[mapping.match] ?? '').trim()); continue; }
    const author = mapping.author ? profileByName(row[mapping.author]) : null;
    const createdAt = mapping.date ? toDateStr(row[mapping.date]) : null;
    await db.insert('lead_updates', {
      lead_id: lead.id,
      author_id: author ? author.id : null,
      kind: 'note',
      body: content,
      ...(createdAt ? { created_at: new Date(createdAt).toISOString() } : {}),
    });
    imported++;
  }
  res.json({ imported, unmatched, empty, total: rows.length, missing: [...missing].slice(0, 20) });
});

module.exports = router;
