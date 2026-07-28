// WhatsApp integration via Baileys (https://github.com/WhiskeySockets/Baileys).
// Baileys talks to WhatsApp over a plain WebSocket — no Chromium/Puppeteer — so
// it runs on Railway where the OpenWA/headless-Chrome approach failed to launch.
//
// Flow: connect() opens a socket and emits a QR (as a data-URL image) that the
// band phone scans (WhatsApp → Linked devices). Auth is persisted in the DB, so
// the link survives redeploys and reconnects automatically at boot. Incoming
// messages become / attach to leads; the thread is viewable per lead.
const config = require('../config');
const db = require('../db');
const { todayISO } = require('../lib/dates');

let sock = null;
let baileys = null;
let reconnectTimer = null;
// live pairing state surfaced to the Settings screen
let state = { qr: null, connected: false, me: null, starting: false, error: null };

const SESSION_ID = config.whatsapp.sessionId || 'kolot';

function isInstalled() {
  try { require.resolve('@whiskeysockets/baileys'); return true; }
  catch { return false; }
}

async function loadBaileys() {
  if (!baileys) baileys = await import('@whiskeysockets/baileys');
  return baileys;
}

// ---- DB-backed auth store (survives Railway's ephemeral filesystem) ----
async function loadSessionRow() {
  const rows = await db.list('whatsapp_sessions', { filters: { session_id: SESSION_ID } });
  return rows[0] || null;
}
async function saveSessionBlob(blob) {
  const row = await loadSessionRow();
  if (row) await db.update('whatsapp_sessions', row.id, { data: blob });
  else await db.insert('whatsapp_sessions', { session_id: SESSION_ID, data: blob });
}
async function clearSession() {
  const row = await loadSessionRow();
  if (row) await db.remove('whatsapp_sessions', row.id);
}

// mirrors Baileys' useMultiFileAuthState, but stores the whole state as one blob
async function useDbAuthState() {
  const { initAuthCreds, BufferJSON, proto } = baileys;
  const row = await loadSessionRow();
  let parsed = null;
  if (row?.data) {
    try {
      const raw = typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
      parsed = JSON.parse(raw, BufferJSON.reviver);
    } catch { /* corrupt — start fresh */ }
  }
  const creds = parsed?.creds || initAuthCreds();
  const keys = parsed?.keys || {};
  const save = () => saveSessionBlob(JSON.stringify({ creds, keys }, BufferJSON.replacer));

  return {
    saveCreds: save,
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = keys[`${type}-${id}`];
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: (data) => {
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              const k = `${type}-${id}`;
              if (value) keys[k] = value; else delete keys[k];
            }
          }
          return save();
        },
      },
    },
  };
}

// ---- incoming messages → leads ----
// unwrap ephemeral / view-once envelopes, then read the text out of any of the
// text-bearing message types
function extractText(msg) {
  if (!msg) return '';
  const inner = msg.ephemeralMessage?.message
    || msg.viewOnceMessage?.message
    || msg.viewOnceMessageV2?.message
    || msg.documentWithCaptionMessage?.message
    || msg;
  return inner.conversation
    || inner.extendedTextMessage?.text
    || inner.imageMessage?.caption
    || inner.videoMessage?.caption
    || inner.documentMessage?.caption
    || inner.buttonsResponseMessage?.selectedDisplayText
    || inner.listResponseMessage?.title
    || '';
}

// a phone-number JID looks like 9725...@s.whatsapp.net; a @lid is WhatsApp's
// privacy identifier and is NOT a phone number
function pnFromJid(jid) {
  if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null;
  const n = jid.replace(/@.*$/, '').replace(/:.*$/, '').replace(/\D/g, '');
  return n || null;
}

// resolve the sender's real phone number even when the chat is addressed by @lid
async function resolvePhone(m) {
  const key = m.key || {};
  // WhatsApp/Baileys expose the phone-number JID alongside the @lid in several places
  for (const j of [key.remoteJid, key.remoteJidAlt, key.participant, key.participantAlt, key.senderPn, key.participantPn]) {
    const n = pnFromJid(j);
    if (n) return n;
  }
  // last resort: ask the LID→PN mapping if this build has one
  const jid = key.remoteJid;
  if (jid && jid.endsWith('@lid')) {
    try {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      const n = pnFromJid(pn);
      if (n) return n;
    } catch { /* mapping unavailable — leave the phone blank rather than a LID */ }
  }
  return null;
}

async function handleIncoming(m) {
  const remoteJid = m.key?.remoteJid || '';
  if (!m.message) return;
  // accept only 1:1 personal chats — skip groups, status, broadcasts, newsletters
  if (/@(g\.us|newsletter|broadcast)$/.test(remoteJid) || remoteJid === 'status@broadcast') return;
  if (!remoteJid) return;

  const body = extractText(m.message).trim();
  if (!body) return;

  const waId = m.key.id || null;
  try {
    if (waId && await db.getBy('whatsapp_messages', 'wa_message_id', waId)) return; // dedupe (also our own app-sends)
  } catch { /* dedupe is best-effort */ }

  const fromMe = !!m.key.fromMe;

  // A message the band sent from their own phone → mirror it as outgoing, but
  // only onto a conversation we already track (don't spawn leads from the band's
  // own outgoing/personal chats).
  if (fromMe) {
    const lead = (await db.list('leads', { filters: { source: 'whatsapp', source_ref: remoteJid } }))[0];
    if (!lead) return;
    try {
      await db.insert('whatsapp_messages', {
        wa_chat_id: remoteJid, wa_message_id: waId,
        from_number: null, from_name: null,
        body, lead_id: lead.id, direction: 'out',
      });
      console.log(`[whatsapp] out (from phone) -> lead ${lead.id}`);
    } catch (e) { console.warn('[whatsapp] outgoing store failed:', e.message); }
    return;
  }

  // real phone if we can resolve it; never store a @lid as the phone number
  const phone = await resolvePhone(m);
  const localPhone = phone ? phone.replace(/^972/, '0') : null;
  const fromNumber = phone || remoteJid.replace(/@.*$/, '');
  const pushName = m.pushName || null;

  // create/attach the lead FIRST so a downstream write failure can't lose it
  let lead;
  try {
    lead = (await db.list('leads', { filters: { source: 'whatsapp', source_ref: remoteJid } }))[0];
    if (!lead) {
      lead = await db.insert('leads', {
        name: pushName || localPhone || 'לקוח וואטסאפ',
        contact_name: pushName || null,
        phone1: localPhone, // null rather than a @lid — a real number or nothing
        stage: 'לקוח חדש ידני',
        sale_status: 'open',
        next_action: 'עוד פרטים',
        source: 'whatsapp',
        source_ref: remoteJid, // thread key (may be @s.whatsapp.net or @lid)
        first_contact_date: todayISO(),
      });
      console.log(`[whatsapp] NEW lead ${lead.id} from ${fromNumber} (${pushName || '—'})`);
    } else if (!lead.phone1 && localPhone) {
      // backfill the phone once we can resolve it
      try { await db.update('leads', lead.id, { phone1: localPhone }); lead.phone1 = localPhone; } catch { /* non-critical */ }
    }
  } catch (e) {
    console.warn('[whatsapp] lead upsert failed:', e.message);
    return;
  }

  try {
    await db.insert('whatsapp_messages', {
      wa_chat_id: remoteJid, wa_message_id: waId,
      from_number: fromNumber, from_name: pushName,
      body, lead_id: lead.id, direction: 'in',
    });
  } catch (e) { console.warn('[whatsapp] message store failed:', e.message); }

  try {
    await db.insert('lead_updates', {
      lead_id: lead.id, author_id: null, kind: 'system',
      body: `📱 וואטסאפ נכנס:\n${body}`,
    });
  } catch (e) { console.warn('[whatsapp] update store failed:', e.message); }

  console.log(`[whatsapp] in from ${fromNumber} -> lead ${lead.id}`);
}

// ---- connection lifecycle ----
async function connect() {
  if (!config.whatsapp.enabled) throw new Error('וואטסאפ מושבת בשרת — יש להגדיר ENABLE_WHATSAPP=true');
  if (sock || state.starting) return status();
  if (!isInstalled()) {
    state.error = 'החבילה @whiskeysockets/baileys אינה מותקנת בשרת';
    throw new Error(state.error);
  }
  clearTimeout(reconnectTimer);
  await loadBaileys();
  const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = baileys;
  const QRCode = require('qrcode');

  state = { qr: null, connected: false, me: null, starting: true, error: null };
  const { state: authState, saveCreds } = await useDbAuthState();
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use bundled */ }

  sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    browser: ['Zooglot.DB', 'Chrome', '1.0.0'],
    logger: quietLogger(),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      try { state.qr = await QRCode.toDataURL(qr); } catch { state.qr = null; }
      state.connected = false;
    }
    if (connection === 'open') {
      state.connected = true; state.starting = false; state.qr = null; state.error = null;
      state.me = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;
      console.log(`[whatsapp] connected${state.me ? ' as ' + state.me : ''}`);
    }
    if (connection === 'close') {
      state.connected = false; state.starting = false; state.qr = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      sock = null;
      if (code === DisconnectReason.loggedOut) {
        await clearSession().catch(() => {});
        state.error = 'החיבור נותק (Logged out) — יש לסרוק שוב';
        console.warn('[whatsapp] logged out — session cleared');
      } else if (code === DisconnectReason.connectionReplaced) {
        // the same session was opened elsewhere; reconnecting would fight it
        state.error = 'נפתח חיבור וואטסאפ במקום אחר';
        console.warn('[whatsapp] connection replaced elsewhere');
      } else {
        // transient drop → auto-reconnect with the saved session (no re-scan)
        console.warn('[whatsapp] connection closed, reconnecting…', code || '');
        reconnectTimer = setTimeout(() => connect().catch(e => console.warn('[whatsapp] reconnect failed:', e.message)), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async (ev) => {
    if (ev.type !== 'notify') return;
    for (const m of ev.messages) {
      try { await handleIncoming(m); }
      catch (e) { console.warn('[whatsapp] incoming error:', e.message); }
    }
  });

  return status();
}

async function disconnect() {
  clearTimeout(reconnectTimer);
  if (sock) {
    try { await sock.logout(); } catch { /* ignore */ }
    try { sock.end?.(undefined); } catch { /* ignore */ }
  }
  sock = null;
  await clearSession().catch(() => {});
  state = { qr: null, connected: false, me: null, starting: false, error: null };
  return status();
}

function status() {
  return {
    enabled: config.whatsapp.enabled,
    installed: isInstalled(),
    connected: state.connected, starting: state.starting,
    qr: state.qr, me: state.me, error: state.error,
    bandNumber: config.whatsapp.bandNumber,
  };
}

// Self-heal: if WhatsApp is enabled and a session was saved but the socket is
// not live (e.g. after a Railway restart or a silent drop), reconnect without a
// re-scan. Fire-and-forget — callers just read status() a moment later.
async function ensureLive() {
  if (!config.whatsapp.enabled || !isInstalled()) return;
  if (sock || state.starting) return;
  const row = await loadSessionRow().catch(() => null);
  if (!row) return; // never linked → needs a QR scan, don't auto-start
  connect().catch(e => console.warn('[whatsapp] ensureLive failed:', e.message));
}

// reconnect automatically at boot if a session was saved; otherwise wait for the
// user to link from Settings (don't spin up a socket that only yields an unscanned QR)
async function start() {
  if (!config.whatsapp.enabled) {
    console.log('[whatsapp] disabled (set ENABLE_WHATSAPP=true to activate)');
    return;
  }
  if (!isInstalled()) {
    console.warn('[whatsapp] @whiskeysockets/baileys not installed — run: npm i');
    return;
  }
  const row = await loadSessionRow().catch(() => null);
  if (row) {
    console.log('[whatsapp] restoring saved session…');
    connect().catch(e => console.warn('[whatsapp] restore failed:', e.message));
  } else {
    console.log('[whatsapp] enabled — link the band phone from Settings → WhatsApp');
  }
}

// "0501234567" / "+972501234567" / "972501234567" -> "972501234567@s.whatsapp.net"
function toJid(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) throw new Error('מספר טלפון ריק');
  const intl = digits.startsWith('972') ? digits : digits.replace(/^0/, '972');
  return `${intl}@s.whatsapp.net`;
}

async function sendToNumber(phone, text) {
  if (!sock || !state.connected) throw new Error('וואטסאפ אינו מחובר — יש לחבר מ"הגדרות"');
  return sock.sendMessage(toJid(phone), { text });
}

// send to a lead: reply straight to the stored WhatsApp chat id (works for both
// @s.whatsapp.net and @lid chats), falling back to the phone number.
// Returns { jid, id } — id lets the caller dedupe the echo Baileys emits.
async function sendToLead(lead, text) {
  if (!sock || !state.connected) throw new Error('וואטסאפ אינו מחובר — יש לחבר מ"הגדרות"');
  const ref = lead.source_ref || '';
  const jid = /@(s\.whatsapp\.net|lid)$/.test(ref) ? ref : toJid(lead.phone1);
  const sent = await sock.sendMessage(jid, { text });
  return { jid, id: sent?.key?.id || null };
}

// quiet pino if present, else a no-op logger Baileys accepts
function quietLogger() {
  try {
    const pino = require('pino');
    return pino({ level: 'silent' });
  } catch {
    const noop = () => {};
    const l = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
    l.child = () => l;
    return l;
  }
}

const isReady = () => !!sock && state.connected;

module.exports = {
  start, connect, disconnect, status, ensureLive,
  sendToNumber, sendToLead, toJid, isReady, handleIncoming,
};
