// In-memory database with JSON persistence — used when Supabase keys are not
// configured, so the whole app runs locally with realistic demo data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'mock-db.json');
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

let store = null;
let saveTimer = null;

function seed() {
  const uItamar = uuid(), uYaniv = uuid(), uNetanel = uuid();
  const hash = bcrypt.hashSync('kolot123', 10);
  const products = [
    { id: uuid(), name: 'הרכב בסיס (4 נגנים)', description: 'קלידים, גיטרה, תופים, זמר ראשי', default_price: 12000, active: true },
    { id: uuid(), name: 'גיטריסט', description: 'גיטרה חשמלית/אקוסטית', default_price: 1800, active: true },
    { id: uuid(), name: 'סקסופוניסט', description: 'סקסופון אלט/טנור', default_price: 1800, active: true },
    { id: uuid(), name: 'טריו ג׳אז לקבלת פנים', description: 'שעה של ג׳אז בקבלת פנים', default_price: 3500, active: true },
    { id: uuid(), name: 'זמרת אורחת', description: '', default_price: 2200, active: true },
    { id: uuid(), name: 'הגברה ותאורה', description: 'מערכת מלאה עד 300 אורחים', default_price: 4500, active: true },
  ].map(p => ({ ...p, created_at: now(), updated_at: now() }));

  const pkgStandard = { id: uuid(), name: 'STANDARD', description: 'החבילה הקלאסית של קולות', base_price: 16000, active: true, created_at: now(), updated_at: now() };
  const pkgPremium = { id: uuid(), name: 'PREMIUM', description: 'הרכב מורחב + קבלת פנים', base_price: 22000, active: true, created_at: now(), updated_at: now() };

  const package_items = [
    { id: uuid(), package_id: pkgStandard.id, product_id: products[0].id, included: true, override_price: null, sort_order: 0 },
    { id: uuid(), package_id: pkgStandard.id, product_id: products[5].id, included: true, override_price: null, sort_order: 1 },
    { id: uuid(), package_id: pkgStandard.id, product_id: products[2].id, included: false, override_price: 1500, sort_order: 2 },
    { id: uuid(), package_id: pkgStandard.id, product_id: products[3].id, included: false, override_price: null, sort_order: 3 },
    { id: uuid(), package_id: pkgPremium.id, product_id: products[0].id, included: true, override_price: null, sort_order: 0 },
    { id: uuid(), package_id: pkgPremium.id, product_id: products[1].id, included: true, override_price: null, sort_order: 1 },
    { id: uuid(), package_id: pkgPremium.id, product_id: products[3].id, included: true, override_price: null, sort_order: 2 },
    { id: uuid(), package_id: pkgPremium.id, product_id: products[5].id, included: true, override_price: null, sort_order: 3 },
    { id: uuid(), package_id: pkgPremium.id, product_id: products[4].id, included: false, override_price: 2000, sort_order: 4 },
  ];

  // demo leads mirroring the Monday board "מעקב זוגות"
  const L = (o) => ({
    id: uuid(), contact_name: null, event_type: 'חתונה', event_date: null, event_location: null,
    relation: null, owner_id: uYaniv, team: null, email: null, phone1: null, phone2: null,
    proposed_price: null, stage: 'לקוח משאלון', sale_status: 'open', next_action: 'עוד פרטים',
    package_type: 'STANDARD', date_status: null, hear_about_us: null, referrer: null,
    came_to_see_event: null, seen_at_date: null, seen_at_place: null,
    first_contact_date: null, close_date: null, lost_reason: null, lost_competitor: null,
    source: 'form', source_ref: null, created_by: uItamar,
    created_at: now(), updated_at: now(), ...o,
  });
  const leads = [
    L({ name: 'לילי', contact_name: 'לילי', relation: 'כלה', event_date: '2026-10-11', event_location: 'האחוזה, Beit Hanan', phone1: '0584849089', stage: 'לקוח חדש ידני', source: 'manual', first_contact_date: '2026-05-26' }),
    L({ name: 'חתונה של אלי והדס :)', contact_name: 'אלי', relation: 'כלה', event_date: '2026-09-23', event_location: 'מושב אורה, ישראל', phone1: '0507250700', hear_about_us: 'Instagram', first_contact_date: '2026-06-07' }),
    L({ name: 'דוד ועדי', contact_name: 'דוד', relation: 'כלה', event_date: '2026-09-16', event_location: 'גני הצבי, ברכיה', phone1: '0528000000', hear_about_us: 'Youtube', first_contact_date: '2026-06-16' }),
    L({ name: 'Wedding — Chaja Geismar', contact_name: 'Chaja Geismar', relation: 'כלה', event_date: '2026-10-18', event_location: 'Psagot Winery', phone1: '+41765303877', hear_about_us: 'ניגנתם אצל חברים', referrer: 'Witztum', first_contact_date: '2026-06-22', stage: 'לקוח משאלון' }),
    L({ name: 'פניה חדשה מהאתר: ליאורה', contact_name: 'ליאורה', relation: 'הורה', event_date: '2027-04-11', event_location: 'בע״ה יער במושב אורה', email: 'lioramorimail@gmail.com', phone1: '0542000000', owner_id: uNetanel, stage: 'לקוח חדש ידני', source: 'webhook', hear_about_us: 'ניגנתם אצל חברים', first_contact_date: '2026-06-22' }),
    L({ name: 'טליה וליאל', contact_name: 'טליה', relation: 'כלה', event_date: '2026-08-12', event_location: 'Shadal Street 5, Tel Aviv-Yafo', phone1: '0587000000', hear_about_us: 'Instagram', first_contact_date: '2026-06-26' }),
    L({ name: 'אליה', contact_name: 'אליה', relation: 'חתן', event_date: '2026-11-09', event_location: 'גן אירועים בצפון, Beit She\'an', phone1: '0509040996', stage: 'לקוח חדש ידני', first_contact_date: '2026-06-28' }),
    L({ name: 'Wedding — Rahamim Lellouche', contact_name: 'Rahamim Lellouche', relation: 'חתן', event_date: '2026-11-04', event_location: null, phone1: '0584000000', hear_about_us: 'ניגנתם אצל חברים', referrer: 'Rephael Chichportich', first_contact_date: '2026-06-30' }),
    L({ name: 'שלמה מנדל', contact_name: 'שלמה מנדל', relation: 'מפיק/ה', event_date: '2026-10-06', event_location: null, phone1: '0506000000', stage: 'לקוח חדש ידני', source: 'manual', first_contact_date: '2026-07-01' }),
  ];

  return {
    profiles: [
      { id: uItamar, email: 'itamar@kolotband.co.il', full_name: 'Itamar', avatar_url: null, role: 'admin', password_hash: hash, email_verified: true, created_at: now(), updated_at: now() },
      { id: uYaniv, email: 'yaniv@kolotband.co.il', full_name: 'יניב וסלי', avatar_url: null, role: 'member', password_hash: hash, email_verified: true, created_at: now(), updated_at: now() },
      { id: uNetanel, email: 'netanel@kolotband.co.il', full_name: 'Netanel Yosef', avatar_url: null, role: 'member', password_hash: hash, email_verified: true, created_at: now(), updated_at: now() },
    ],
    invitations: [],
    leads,
    lead_contacts: [
      { id: uuid(), lead_id: leads[1].id, name: 'הדס', role: 'כלה', phone: '0501111111', email: null, created_at: now() },
    ],
    lead_updates: [
      { id: uuid(), lead_id: leads[0].id, author_id: uItamar, body: 'דיברתי עם לילי, מחכה לתאריך סופי מהאולם.', kind: 'note', created_at: now() },
    ],
    competitors: [
      { id: uuid(), name: 'להקה אחרת', created_at: now() },
      { id: uuid(), name: 'DJ', created_at: now() },
      { id: uuid(), name: 'הרכב אקוסטי', created_at: now() },
      { id: uuid(), name: 'לא ידוע', created_at: now() },
    ],
    products,
    packages: [pkgStandard, pkgPremium],
    package_items,
    management_signatures: [],
    contracts: [],
    lead_forms: [],
    form_submissions: [],
    voice_notes: [],
    calendar_links: [],
    calendar_events: [],
    whatsapp_messages: [],
    otp_codes: [],
    reset_tokens: [],
  };
}

function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    store = seed();
    persist();
  }
  return store;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 1));
  }, 150);
}

function table(name) {
  const s = load();
  if (!s[name]) s[name] = [];
  return s[name];
}

module.exports = {
  isMock: true,

  async list(name, opts = {}) {
    let rows = [...table(name)];
    if (opts.filters) {
      for (const [k, v] of Object.entries(opts.filters)) {
        if (v === undefined) continue;
        rows = rows.filter(r => Array.isArray(v) ? v.includes(r[k]) : r[k] === v);
      }
    }
    if (opts.orderBy) {
      const dir = opts.asc === false ? -1 : 1;
      rows.sort((a, b) => {
        const x = a[opts.orderBy], y = b[opts.orderBy];
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return rows;
  },

  async get(name, id) {
    return table(name).find(r => r.id === id) || null;
  },

  async getBy(name, col, val) {
    return table(name).find(r => r[col] === val) || null;
  },

  async insert(name, row) {
    const rec = { id: uuid(), created_at: now(), ...row };
    if (['leads', 'products', 'packages', 'contracts', 'profiles'].includes(name)) {
      rec.updated_at = rec.updated_at || now();
    }
    table(name).push(rec);
    persist();
    return rec;
  },

  async update(name, id, patch) {
    const rows = table(name);
    const i = rows.findIndex(r => r.id === id);
    if (i === -1) return null;
    rows[i] = { ...rows[i], ...patch };
    if ('updated_at' in rows[i]) rows[i].updated_at = now();
    persist();
    return rows[i];
  },

  async remove(name, id) {
    const rows = table(name);
    const i = rows.findIndex(r => r.id === id);
    if (i === -1) return false;
    rows.splice(i, 1);
    // naive cascade for lead children
    if (name === 'leads') {
      for (const child of ['lead_contacts', 'lead_updates', 'calendar_events']) {
        const s = load();
        s[child] = (s[child] || []).filter(r => r.lead_id !== id);
      }
    }
    persist();
    return true;
  },
};
