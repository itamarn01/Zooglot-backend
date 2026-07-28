// Voice-note pipeline: a recording in, lead fields out.
//
// Gemini Flash is the default engine. It reads audio directly, so one request
// both transcribes and extracts — where OpenAI needs Whisper and then GPT. Its
// free tier also needs no credit card, which is why it is preferred here.
// OpenAI remains as a fallback when only OPENAI_API_KEY is configured.
// With neither key, a deterministic mock keeps the whole UI flow exercisable.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { todayISO } = require('../lib/dates');

let openai = null;
if (config.openai.enabled) {
  const OpenAI = require('openai');
  openai = new OpenAI({ apiKey: config.openai.apiKey });
}

const engine = () => (config.gemini.enabled ? 'gemini' : config.openai.enabled ? 'openai' : 'mock');

// Every column a voice note can plausibly fill. Kept in sync with LEAD_KEYS in
// routes/voice.js — a field missing from either list is silently dropped.
const LEAD_FIELDS_SPEC = `
שדות אפשריים (החזר רק שדות שנאמרו במפורש בהקלטה):
- name: שם הליד/הזוג (טקסט)
- contact_name: שם איש הקשר
- groom_name: שם החתן
- bride_name: שם הכלה
- relation: קרבה — בדיוק אחד מ: כלה, חתן, הורה, מפיק/ה, אחר
- event_type: סוג אירוע — בדיוק אחד מ: חתונה, בר/בת מצווה, אירוע חברה, אחר
- event_date: תאריך האירוע בפורמט YYYY-MM-DD
- event_location: מיקום האירוע (אולם/גן אירועים + עיר)
- email: כתובת מייל
- phone1: טלפון ראשי
- phone2: טלפון נוסף
- id_number: תעודת זהות (9 ספרות)
- address: כתובת מגורים
- proposed_price: מחיר שהוצע (מספר בלבד, בש"ח — "18 אלף" => 18000)
- deposit_amount: סכום המקדמה לשריון התאריך (מספר בלבד)
- package_type: סוג החבילה / הרכב שהוצע
- date_status: סטטוס התאריך (למשל: אופציה, שריון, סגור)
- hear_about_us: איך שמעו עלינו — בדיוק אחד מ: Instagram, Youtube, Facebook, ניגנתם אצל חברים, המלצה, גוגל, אחר
- referrer: מי המליץ (רק אם hear_about_us הוא "המלצה")
- came_to_see_event: אירוע שבו ראו אותנו מנגנים
- seen_at_date: התאריך שבו ראו אותנו (YYYY-MM-DD) — זה תאריך בעבר
- seen_at_place: המקום שבו ראו אותנו
- next_action: הפעולה הבאה — בדיוק אחד מ: עוד פרטים, לקבוע פגישה, לשלוח הצעת מחיר, לשלוח חוזה, מעקב, אין פעולה
- team: הצוות/הרכב המשויך
- notes: כל מידע נוסף חשוב שנאמר`;

// Dates are where a model guesses worst: told "25 בספטמבר" with no year it
// happily returns a year from its training data. Two defences — tell it today's
// date, and then verify the answer in code (normalizeExtracted below).
const dateRules = () => `
היום הוא ${todayISO()}. אירועים של הלהקה הם תמיד בעתיד.
אם נאמר יום וחודש בלי שנה — בחר את השנה העתידית הקרובה ביותר.
לעולם אל תחזיר event_date שכבר עבר.
היוצא מן הכלל היחיד הוא seen_at_date, שהוא תמיד בעבר.`;

const MOCK_TRANSCRIPT =
  '[תמלול לדוגמה — הזן מפתח GEMINI_API_KEY לתמלול אמיתי] ' +
  'התקשרה כלה בשם נועה, החתונה בעשרים ביוני 2027 בגני הטבע בחדרה, ' +
  'הטלפון שלה 052-1234567, שמעה עלינו מאינסטגרם, הצעתי 18 אלף שקל, ' +
  'צריך לחזור אליה ביום ראשון עם הצעת מחיר מסודרת.';

const MOCK_FIELDS = {
  name: 'נועה — חתונה', contact_name: 'נועה', relation: 'כלה',
  event_type: 'חתונה', event_date: '2027-06-20', event_location: 'גני הטבע, חדרה',
  phone1: '0521234567', proposed_price: 18000, hear_about_us: 'Instagram',
  next_action: 'לחזור ביום ראשון עם הצעת מחיר',
  notes: 'חילוץ לדוגמה — הזן מפתח GEMINI_API_KEY לחילוץ אמיתי.',
};

const MIME_BY_EXT = {
  '.mp3': 'audio/mp3', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.webm': 'audio/webm', '.flac': 'audio/flac', '.amr': 'audio/amr',
};
// browsers hand us "audio/webm;codecs=opus" — Gemini wants the bare type
const mimeFor = (originalName, fallback) => {
  const ext = path.extname(originalName || '').toLowerCase();
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  const clean = String(fallback || '').split(';')[0].trim();
  return clean.startsWith('audio/') || clean.startsWith('video/') ? clean : 'audio/webm';
};

// Google retires models from the free tier without renaming them, and such a
// model answers with "limit: 0" — which looks like an exhausted quota but means
// "not free any more". Rather than hard-fail on one name, walk a short list and
// remember whichever works, so a retirement degrades instead of breaking.
const modelChain = () => {
  const chain = [config.gemini.model, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];
  return [...new Set(chain.filter(Boolean))];
};
let workingModel = null;

// "limit: 0" / 404 mean *this model* is unusable; a real rate-limit (limit > 0)
// or a bad key must NOT trigger a fallback — retrying would only hide the cause.
const modelUnavailable = (status, msg) =>
  status === 404 || (status === 429 && /limit:\s*0\b/.test(msg));

async function callGemini(model, parts, json) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const rsp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: json
        ? { responseMimeType: 'application/json', temperature: 0.1 }
        : { temperature: 0.1 },
    }),
  });
  const data = await rsp.json().catch(() => null);
  return { ok: rsp.ok, status: rsp.status, data, msg: data?.error?.message || '' };
}

async function geminiGenerate(parts, { json = false } = {}) {
  const models = workingModel ? [workingModel, ...modelChain()] : modelChain();
  let last = null;

  for (const model of [...new Set(models)]) {
    const r = await callGemini(model, parts, json);
    if (r.ok) {
      if (workingModel !== model) {
        workingModel = model;
        if (model !== config.gemini.model) console.warn(`[ai] Gemini נופל למודל ${model}`);
      }
      const text = (r.data?.candidates?.[0]?.content?.parts || [])
        .map(p => p.text).filter(Boolean).join('').trim();
      if (!text) throw new Error('Gemini החזיר תשובה ריקה');
      return text;
    }
    last = r;
    if (workingModel === model) workingModel = null;
    if (!modelUnavailable(r.status, r.msg)) break;
  }

  // surface Google's own message — an exhausted quota and an invalid key need
  // very different fixes, and a generic error hides which one it is
  if (last && modelUnavailable(last.status, last.msg)) {
    throw new Error('Gemini: אף מודל זמין בחשבון. בדקו שהמפתח תקין וש-GEMINI_MODEL מצביע על מודל קיים.');
  }
  throw new Error(`Gemini: ${last?.msg || `שגיאה (${last?.status})`}`);
}

// Transcribe only. Kept as its own step so the transcript is stored and shown
// to the user even when field extraction later fails.
async function transcribe(filePath, originalName, mimeType) {
  if (engine() === 'mock') return MOCK_TRANSCRIPT;

  if (engine() === 'gemini') {
    const audio = fs.readFileSync(filePath).toString('base64');
    return geminiGenerate([
      { text: 'תמלל את ההקלטה הבאה במדויק לעברית. החזר אך ורק את התמלול, בלי הקדמה ובלי הערות.' },
      { inlineData: { mimeType: mimeFor(originalName, mimeType), data: audio } },
    ]);
  }

  const rsp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: config.openai.transcribeModel,
    language: 'he',
  });
  return rsp.text;
}

// ---- deterministic clean-up of whatever the model returned ----------------
// A prompt is a request, not a guarantee. These rules are cheap, and they make
// the result the same no matter which engine (or which model version) answered.

const isoDate = v => /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
const realDate = (y, md) => {
  const d = new Date(`${y}-${md}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === `${y}-${md}`;
};

// "25 בספטמבר" with no year must land on the next 25 September, not on whatever
// year the model felt like. Only ever moves a date forward, never backward.
function toFutureDate(v, today = todayISO()) {
  const m = isoDate(v);
  if (!m) return v;
  const md = `${m[2]}-${m[3]}`;
  let y = Number(m[1]);
  if (`${y}-${md}` >= today) return v;
  const limit = Number(today.slice(0, 4)) + 6; // 29 Feb needs a few hops to a leap year
  for (y = Number(today.slice(0, 4)); y <= limit; y++) {
    if (realDate(y, md) && `${y}-${md}` >= today) return `${y}-${md}`;
  }
  return v;
}

// "18 אלף" / "18,000 ₪" -> 18000
function toNumber(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/[,\s₪]/g, '').trim();
  if (!s) return v;
  const k = /^(\d+(?:\.\d+)?)(אלף|k)$/i.exec(s);
  if (k) return Math.round(Number(k[1]) * 1000);
  const n = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : v;
}

// +972-52-123-4567 -> 0521234567, so duplicate detection and WhatsApp both match
function toPhone(v) {
  let s = String(v ?? '').replace(/[^\d+]/g, '');
  if (!s) return v;
  s = s.replace(/^\+?972/, '0');
  if (!s.startsWith('0') && s.length === 9) s = '0' + s;
  return s;
}

// Snap free text onto the exact board values, or the chips render as raw text
const ENUMS = {
  relation: ['כלה', 'חתן', 'הורה', 'מפיק/ה', 'אחר'],
  event_type: ['חתונה', 'בר/בת מצווה', 'אירוע חברה', 'אחר'],
  hear_about_us: ['Instagram', 'Youtube', 'Facebook', 'ניגנתם אצל חברים', 'המלצה', 'גוגל', 'אחר'],
  next_action: ['עוד פרטים', 'לקבוע פגישה', 'לשלוח הצעת מחיר', 'לשלוח חוזה', 'מעקב', 'אין פעולה'],
};
const SYNONYMS = {
  hear_about_us: {
    'אינסטגרם': 'Instagram', 'אינסטה': 'Instagram', 'instagram': 'Instagram', 'ig': 'Instagram',
    'פייסבוק': 'Facebook', 'facebook': 'Facebook', 'fb': 'Facebook',
    'יוטיוב': 'Youtube', 'youtube': 'Youtube',
    'google': 'גוגל', 'חיפוש בגוגל': 'גוגל',
    'חבר המליץ': 'המלצה', 'המלצת חבר': 'המלצה', 'מפה לאוזן': 'המלצה',
  },
  relation: { 'מפיק': 'מפיק/ה', 'מפיקה': 'מפיק/ה', 'אמא': 'הורה', 'אבא': 'הורה', 'אם': 'הורה', 'אב': 'הורה' },
  event_type: { 'בר מצווה': 'בר/בת מצווה', 'בת מצווה': 'בר/בת מצווה', 'חתונת': 'חתונה' },
};
function toEnum(key, v) {
  const raw = String(v ?? '').trim();
  if (!raw) return v;
  const lower = raw.toLowerCase();
  const exact = ENUMS[key].find(o => o.toLowerCase() === lower);
  if (exact) return exact;
  const syn = SYNONYMS[key]?.[lower] || SYNONYMS[key]?.[raw];
  if (syn) return syn;
  return raw; // keep what was said — better a free-text value than a wrong enum
}

// dates:false when the value came from a human editing the review form — a date
// typed on purpose is a decision, not a guess, so it is left exactly as entered.
function normalizeExtracted(raw, { dates = true } = {}) {
  const out = { ...(raw || {}) };
  const drop = k => { delete out[k]; };

  for (const [k, v] of Object.entries(out)) {
    if (v === null || v === undefined || String(v).trim() === '' || v === 'null') drop(k);
  }
  if (dates && out.event_date) out.event_date = toFutureDate(out.event_date);
  for (const k of ['proposed_price', 'deposit_amount']) if (out[k]) out[k] = toNumber(out[k]);
  for (const k of ['phone1', 'phone2']) if (out[k]) out[k] = toPhone(out[k]);
  for (const k of Object.keys(ENUMS)) if (out[k]) out[k] = toEnum(k, out[k]);
  // a referrer only means anything alongside "המלצה"
  if (out.referrer && out.hear_about_us && out.hear_about_us !== 'המלצה') drop('referrer');
  if (out.id_number) out.id_number = String(out.id_number).replace(/\D/g, '');
  return out;
}

async function extractLeadFields(transcript) {
  if (engine() === 'mock') return normalizeExtracted(MOCK_FIELDS);

  const instruction =
    'אתה עוזר CRM של להקת חתונות ישראלית. חלץ מתמלול הודעה קולית שדות של ליד. ' +
    'החזר JSON בלבד עם השדות שנמצאו. אל תמציא מידע שלא נאמר.' +
    dateRules() + LEAD_FIELDS_SPEC;

  if (engine() === 'gemini') {
    const text = await geminiGenerate(
      [{ text: `${instruction}\n\n--- תמלול ---\n${transcript}` }], { json: true });
    try { return normalizeExtracted(JSON.parse(text)); } catch { return { notes: transcript }; }
  }

  const rsp = await openai.chat.completions.create({
    model: config.openai.extractModel,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: instruction },
      { role: 'user', content: transcript },
    ],
  });
  try {
    return normalizeExtracted(JSON.parse(rsp.choices[0].message.content));
  } catch {
    return { notes: transcript };
  }
}

module.exports = { transcribe, extractLeadFields, engine, normalizeExtracted, toFutureDate };
