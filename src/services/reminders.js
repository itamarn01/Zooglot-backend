// Lead reminders — delivered by email (Resend) or WhatsApp (OpenWA) to whoever
// handles the event (the lead's owner, or an explicitly chosen team member).
// A single in-process scheduler polls for due reminders once a minute.
const db = require('../db');
const email = require('./email');
const whatsapp = require('./whatsapp');

const TICK_MS = 60 * 1000;
const CHANNEL_LABEL = { email: 'מייל', whatsapp: 'וואטסאפ' };

async function dueReminders() {
  const pending = await db.list('reminders', { filters: { status: 'pending' } });
  const now = Date.now();
  return pending.filter(r => new Date(r.remind_at).getTime() <= now);
}

async function deliver(r) {
  const lead = await db.get('leads', r.lead_id);
  if (!lead) {
    await db.update('reminders', r.id, { status: 'cancelled', error: 'הליד נמחק' });
    return;
  }
  const recipientId = r.recipient_id || lead.owner_id;
  const person = recipientId ? await db.get('profiles', recipientId) : null;
  const message = (r.message || '').trim() || `תזכורת לגבי הליד "${lead.name}"`;

  try {
    if (!person) throw new Error('לא הוגדר איש צוות מטפל (בטיפול) לליד');

    if (r.channel === 'email') {
      if (!person.email) throw new Error('לאיש הצוות אין כתובת מייל');
      await email.reminder(person.email, lead, message);
    } else {
      if (!person.phone) throw new Error('לאיש הצוות אין מספר וואטסאפ בפרופיל (הגדרות → פרופיל)');
      const lines = [
        `⏰ תזכורת — ${lead.name}`,
        message,
        lead.event_date ? `📅 ${lead.event_date}` : null,
        lead.phone1 ? `📞 ${lead.phone1}` : null,
      ].filter(Boolean);
      await whatsapp.sendToNumber(person.phone, lines.join('\n'));
    }

    await db.update('reminders', r.id, {
      status: 'sent', sent_at: new Date().toISOString(), error: null,
    });
    await db.insert('lead_updates', {
      lead_id: lead.id, author_id: null, kind: 'system',
      body: `⏰ נשלחה תזכורת ב${CHANNEL_LABEL[r.channel]} ל-${person.full_name || person.email}: ${message}`,
    });
    console.log(`[reminders] sent ${r.channel} reminder for lead ${lead.id}`);
  } catch (e) {
    await db.update('reminders', r.id, { status: 'failed', error: e.message });
    console.warn(`[reminders] failed for lead ${r.lead_id}: ${e.message}`);
  }
}

async function tick() {
  for (const r of await dueReminders()) await deliver(r);
}

function start() {
  setInterval(() => tick().catch(e => console.error('[reminders]', e.message)), TICK_MS);
  tick().catch(() => { /* first run may race startup */ });
  console.log('[reminders] scheduler running (checks every minute)');
}

module.exports = { start, tick, deliver };
