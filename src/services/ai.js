// Voice-note pipeline: Whisper transcription + GPT field extraction.
// Without an OpenAI key it returns a deterministic mock so the UI flow
// can be exercised end to end.
const fs = require('fs');
const config = require('../config');

let openai = null;
if (config.openai.enabled) {
  const OpenAI = require('openai');
  openai = new OpenAI({ apiKey: config.openai.apiKey });
}

const LEAD_FIELDS_SPEC = `
שדות אפשריים (החזר רק שדות שנאמרו במפורש בהקלטה):
- name: שם הליד/הזוג (טקסט)
- contact_name: שם איש הקשר
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

async function transcribe(filePath, originalName) {
  if (!openai) {
    return '[תמלול לדוגמה — הזן מפתח OPENAI_API_KEY לתמלול אמיתי] ' +
      'התקשרה כלה בשם נועה, החתונה בעשרים ביוני 2027 בגני הטבע בחדרה, ' +
      'הטלפון שלה 052-1234567, שמעה עלינו מאינסטגרם, הצעתי 18 אלף שקל, ' +
      'צריך לחזור אליה ביום ראשון עם הצעת מחיר מסודרת.';
  }
  const rsp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: config.openai.transcribeModel,
    language: 'he',
  });
  return rsp.text;
}

async function extractLeadFields(transcript) {
  if (!openai) {
    return {
      name: 'נועה — חתונה', contact_name: 'נועה', relation: 'כלה',
      event_type: 'חתונה', event_date: '2027-06-20', event_location: 'גני הטבע, חדרה',
      phone1: '0521234567', proposed_price: 18000, hear_about_us: 'Instagram',
      next_action: 'לחזור ביום ראשון עם הצעת מחיר',
      notes: 'חילוץ לדוגמה — הזן מפתח OPENAI_API_KEY לחילוץ אמיתי.',
    };
  }
  const rsp = await openai.chat.completions.create({
    model: config.openai.extractModel,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'אתה עוזר CRM של להקת חתונות ישראלית. חלץ מתמלול הודעה קולית שדות של ליד. ' +
          'החזר JSON בלבד עם השדות שנמצאו. אל תמציא מידע שלא נאמר.' + LEAD_FIELDS_SPEC,
      },
      { role: 'user', content: transcript },
    ],
  });
  try {
    return JSON.parse(rsp.choices[0].message.content);
  } catch {
    return { notes: transcript };
  }
}

module.exports = { transcribe, extractLeadFields };
