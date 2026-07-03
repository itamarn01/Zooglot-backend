// WhatsApp Business ingestion via OpenWA (https://github.com/open-wa/wa-automate-nodejs,
// referenced fork: rmyndharis/OpenWA). Optional: only starts when
// ENABLE_WHATSAPP=true and @open-wa/wa-automate is installed.
// Incoming messages to the band number (055-5081080) become leads.
const config = require('../config');
const db = require('../db');

let client = null;

async function handleIncoming(message) {
  const chatId = message.from;                       // e.g. 9725...@c.us
  const fromNumber = chatId.replace(/@.*$/, '');
  const body = (message.body || '').trim();
  if (!body || message.isGroupMsg) return;

  // dedupe by wa message id
  if (message.id && await db.getBy('whatsapp_messages', 'wa_message_id', message.id)) return;

  // attach to an existing open lead from the same number, else create one
  let lead = (await db.list('leads', { filters: { source: 'whatsapp', source_ref: chatId } }))[0];
  if (!lead) {
    lead = await db.insert('leads', {
      name: `וואטסאפ: ${message.sender?.pushname || fromNumber}`,
      contact_name: message.sender?.pushname || null,
      phone1: fromNumber.replace(/^972/, '0'),
      stage: 'לקוח חדש ידני',
      sale_status: 'open',
      next_action: 'עוד פרטים',
      source: 'whatsapp',
      source_ref: chatId,
      first_contact_date: new Date().toISOString().slice(0, 10),
    });
  }

  await db.insert('whatsapp_messages', {
    wa_chat_id: chatId,
    wa_message_id: message.id || null,
    from_number: fromNumber,
    from_name: message.sender?.pushname || null,
    body,
    lead_id: lead.id,
  });
  await db.insert('lead_updates', {
    lead_id: lead.id, author_id: null, kind: 'system',
    body: `📱 הודעת וואטסאפ נכנסת:\n${body}`,
  });
  console.log(`[whatsapp] message from ${fromNumber} -> lead ${lead.id}`);
}

async function start() {
  if (!config.whatsapp.enabled) {
    console.log('[whatsapp] disabled (set ENABLE_WHATSAPP=true to activate)');
    return;
  }
  let wa;
  try {
    wa = require('@open-wa/wa-automate');
  } catch {
    console.warn('[whatsapp] @open-wa/wa-automate is not installed — run: npm i @open-wa/wa-automate');
    return;
  }
  client = await wa.create({
    sessionId: config.whatsapp.sessionId,
    multiDevice: true,
    headless: true,
    qrTimeout: 0,
  });
  client.onMessage(handleIncoming);
  console.log(`[whatsapp] connected, listening on band number ${config.whatsapp.bandNumber}`);
}

async function sendMessage(chatId, text) {
  if (!client) throw new Error('WhatsApp client is not running');
  return client.sendText(chatId, text);
}

module.exports = { start, sendMessage, handleIncoming };
