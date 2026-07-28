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

let openai = null;
if (config.openai.enabled) {
  const OpenAI = require('openai');
  openai = new OpenAI({ apiKey: config.openai.apiKey });
}

const engine = () => (config.gemini.enabled ? 'gemini' : config.openai.enabled ? 'openai' : 'mock');

const LEAD_FIELDS_SPEC = `
שדות אפשריים (החזר רק שדות שנאמרו במפורש בהקלטה):
- name: שם הליד/הזוג (טקסט)
- contact_name: שם איש הקשר
- groom_name: שם החתן
- bride_name: שם הכלה
- relation: קרבה — אחד מ: כלה, חתן, הורה, מפיק/ה, אחר
- event_type: סוג אירוע (חתונה, בר מצווה, אירוע חברה...)
- event_date: תאריך האירוע בפורמט YYYY-MM-DD
- event_location: מיקום האירוע
- email: כתובת מייל
- phone1: טלפון
- proposed_price: מחיר שהוצע (מספר בלבד, בש"ח)
- hear_about_us: איך שמעו עלינו
- referrer: מי המליץ
- next_action: הפעולה הבאה לביצוע
- notes: כל מידע נוסף חשוב שנאמר`;

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

async function geminiGenerate(parts, { json = false } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent`;
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
  if (!rsp.ok) {
    // surface Google's own message — "quota exceeded" and "invalid key" need
    // very different fixes and a generic error hides which one it is
    const msg = data?.error?.message || `שגיאת Gemini (${rsp.status})`;
    throw new Error(`Gemini: ${msg}`);
  }
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map(p => p.text).filter(Boolean).join('').trim();
  if (!text) throw new Error('Gemini החזיר תשובה ריקה');
  return text;
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

async function extractLeadFields(transcript) {
  if (engine() === 'mock') return MOCK_FIELDS;

  const instruction =
    'אתה עוזר CRM של להקת חתונות ישראלית. חלץ מתמלול הודעה קולית שדות של ליד. ' +
    'החזר JSON בלבד עם השדות שנמצאו. אל תמציא מידע שלא נאמר.' + LEAD_FIELDS_SPEC;

  if (engine() === 'gemini') {
    const text = await geminiGenerate(
      [{ text: `${instruction}\n\n--- תמלול ---\n${transcript}` }], { json: true });
    try { return JSON.parse(text); } catch { return { notes: transcript }; }
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
    return JSON.parse(rsp.choices[0].message.content);
  } catch {
    return { notes: transcript };
  }
}

module.exports = { transcribe, extractLeadFields, engine };
