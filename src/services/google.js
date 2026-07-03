// Google Calendar integration via raw REST (no heavy googleapis dependency).
// Two-way sync: leads with an event_date are pushed as calendar events, and
// pull() reads changes made in Google Calendar back onto the lead.
const config = require('../config');
const db = require('../db');

const OAUTH = 'https://oauth2.googleapis.com/token';
const CAL = 'https://www.googleapis.com/calendar/v3';

function authUrl(state) {
  const p = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/calendar.events openid email',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function exchangeCode(code) {
  const rsp = await fetch(OAUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!rsp.ok) throw new Error(`google token exchange failed: ${await rsp.text()}`);
  return rsp.json(); // { access_token, refresh_token, id_token, ... }
}

async function accessToken(refreshToken) {
  const rsp = await fetch(OAUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!rsp.ok) throw new Error(`google token refresh failed: ${await rsp.text()}`);
  return (await rsp.json()).access_token;
}

function leadToEvent(lead) {
  return {
    summary: `KOLOT · ${lead.name}`,
    description: [
      lead.contact_name && `איש קשר: ${lead.contact_name}`,
      lead.phone1 && `טלפון: ${lead.phone1}`,
      lead.event_location && `מיקום: ${lead.event_location}`,
      `סטטוס: ${lead.sale_status}`,
      `zooglot-lead:${lead.id}`,
    ].filter(Boolean).join('\n'),
    location: lead.event_location || undefined,
    start: { date: lead.event_date },
    end: { date: lead.event_date },
  };
}

// push a single lead to the connected calendar of `userId`
async function pushLead(userId, lead) {
  if (!config.google.enabled) return { mock: true, note: 'Google OAuth not configured' };
  const link = await db.getBy('calendar_links', 'user_id', userId);
  if (!link) throw new Error('Google Calendar is not connected for this user');
  if (!lead.event_date) throw new Error('Lead has no event_date to sync');

  const token = await accessToken(link.google_refresh_token);
  const existing = (await db.list('calendar_events', { filters: { lead_id: lead.id } }))[0];
  const body = JSON.stringify(leadToEvent(lead));
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let rsp;
  if (existing) {
    rsp = await fetch(`${CAL}/calendars/${encodeURIComponent(link.calendar_id)}/events/${existing.google_event_id}`, {
      method: 'PATCH', headers, body,
    });
  } else {
    rsp = await fetch(`${CAL}/calendars/${encodeURIComponent(link.calendar_id)}/events`, {
      method: 'POST', headers, body,
    });
  }
  if (!rsp.ok) throw new Error(`calendar push failed: ${await rsp.text()}`);
  const ev = await rsp.json();
  if (existing) {
    await db.update('calendar_events', existing.id, { last_synced_at: new Date().toISOString() });
  } else {
    await db.insert('calendar_events', {
      lead_id: lead.id, google_event_id: ev.id,
      calendar_id: link.calendar_id, last_synced_at: new Date().toISOString(),
    });
  }
  return ev;
}

// pull changes from Google back to leads (date/location edited in calendar)
async function pull(userId) {
  if (!config.google.enabled) return { mock: true, updated: 0 };
  const link = await db.getBy('calendar_links', 'user_id', userId);
  if (!link) throw new Error('Google Calendar is not connected for this user');
  const token = await accessToken(link.google_refresh_token);

  let updated = 0;
  const mappings = await db.list('calendar_events', {});
  for (const m of mappings) {
    const rsp = await fetch(
      `${CAL}/calendars/${encodeURIComponent(m.calendar_id)}/events/${m.google_event_id}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!rsp.ok) continue;
    const ev = await rsp.json();
    if (ev.status === 'cancelled') continue;
    const lead = await db.get('leads', m.lead_id);
    if (!lead) continue;
    const newDate = ev.start?.date || (ev.start?.dateTime || '').slice(0, 10);
    const patch = {};
    if (newDate && newDate !== lead.event_date) patch.event_date = newDate;
    if (ev.location && ev.location !== lead.event_location) patch.event_location = ev.location;
    if (Object.keys(patch).length) {
      await db.update('leads', lead.id, patch);
      updated++;
    }
    await db.update('calendar_events', m.id, { last_synced_at: new Date().toISOString() });
  }
  return { updated };
}

module.exports = { authUrl, exchangeCode, pushLead, pull };
