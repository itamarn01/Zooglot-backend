// WhatsApp Business ingestion via OpenWA (https://github.com/open-wa/wa-automate-nodejs,
// referenced fork: rmyndharis/OpenWA). Optional: only starts when
// ENABLE_WHATSAPP=true and @open-wa/wa-automate is installed.
// Incoming messages to the band number (055-5081080) become leads.
const config = require('../config');
const db = require('../db');

let client = null;
// live pairing state, surfaced to the Settings screen so a user can link the
// band phone by scanning the QR in the app (no server-console access needed)
let state = { qr: null, connected: false, me: null, starting: false, error: null };

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

// Begin pairing. Returns immediately with the current state; the QR appears in
// `state.qr` a moment later (poll status()). Scanning it from the band's phone
// (WhatsApp → Linked devices) links the account. Safe to call repeatedly.
async function connect() {
  if (!config.whatsapp.enabled) throw new Error('וואטסאפ מושבת בשרת — יש להגדיר ENABLE_WHATSAPP=true');
  if (client || state.starting) return status();

  let wa;
  try {
    wa = require('@open-wa/wa-automate');
  } catch {
    state.error = 'החבילה @open-wa/wa-automate אינה מותקנת בשרת';
    throw new Error(state.error);
  }

  state = { qr: null, connected: false, me: null, starting: true, error: null };
  // don't await the full create() — it only resolves once paired, but we want to
  // hand the QR back to the UI while the user is still scanning
  wa.create({
    sessionId: config.whatsapp.sessionId,
    multiDevice: true,
    headless: true,
    qrTimeout: 0,
    authTimeout: 0,
    disableSpins: true,
    // OpenWA hands us the QR as a base64 PNG data URL — exactly what an <img> needs
    catchQR: (qrCode) => { state.qr = qrCode; state.connected = false; },
  }).then(async (c) => {
    client = c;
    state.connected = true; state.qr = null; state.starting = false;
    try { state.me = await c.getHostNumber?.(); } catch { /* best-effort */ }
    c.onMessage(handleIncoming);
    c.onStateChanged?.((s) => { if (s === 'UNPAIRED' || s === 'CONFLICT') { state.connected = false; client = null; } });
    console.log(`[whatsapp] connected${state.me ? ` as ${state.me}` : ''}, listening for messages`);
  }).catch((e) => {
    state.starting = false; state.error = e.message; state.qr = null;
    console.warn('[whatsapp] connect failed:', e.message);
  });

  return status();
}

async function disconnect() {
  if (client) { try { await (client.kill?.() || client.logout?.()); } catch { /* ignore */ } }
  client = null;
  state = { qr: null, connected: false, me: null, starting: false, error: null };
  return status();
}

function status() {
  return {
    enabled: config.whatsapp.enabled,
    installed: (() => { try { require.resolve('@open-wa/wa-automate'); return true; } catch { return false; } })(),
    connected: state.connected, starting: state.starting,
    qr: state.qr, me: state.me, error: state.error,
    bandNumber: config.whatsapp.bandNumber,
  };
}

// pairing no longer auto-starts at boot: a headless browser per deploy is heavy
// and, without a scanned session, pointless. The user links it from Settings.
async function start() {
  if (!config.whatsapp.enabled) {
    console.log('[whatsapp] disabled (set ENABLE_WHATSAPP=true to activate)');
    return;
  }
  console.log('[whatsapp] enabled — link the band phone from Settings → WhatsApp');
}

async function sendMessage(chatId, text) {
  if (!client) throw new Error('WhatsApp client is not running');
  return client.sendText(chatId, text);
}

// "0501234567" / "+972501234567" / "972501234567" -> "972501234567@c.us"
function toChatId(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) throw new Error('מספר טלפון ריק');
  const intl = digits.startsWith('972') ? digits : digits.replace(/^0/, '972');
  return `${intl}@c.us`;
}

async function sendToNumber(phone, text) {
  if (!client) {
    throw new Error('וואטסאפ אינו מחובר — יש להפעיל ENABLE_WHATSAPP=true בשרת');
  }
  return client.sendText(toChatId(phone), text);
}

const isReady = () => !!client;

module.exports = { start, connect, disconnect, status, sendMessage, sendToNumber, toChatId, isReady, handleIncoming };
