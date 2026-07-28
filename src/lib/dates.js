// Israel-time date helpers.
//
// The server runs in UTC (Railway), but the band works in Israel. `new
// Date().toISOString().slice(0,10)` therefore returns YESTERDAY's date every
// night between midnight and 02:00/03:00 Israel time — which silently landed on
// first_contact_date, close_date and the contract's {{today}}. Everything that
// means "today in Israel" must go through here.
//
// Instants (created_at, remind_at, sent_at) stay UTC ISO strings on purpose:
// they are absolute points in time and are formatted for display in the
// viewer's timezone. Only *calendar dates* need the Israel view.

const TZ = 'Asia/Jerusalem';

// yyyy-mm-dd for the given instant, as seen in Israel
function todayISO(d = new Date()) {
  // 'en-CA' formats as yyyy-mm-dd, which is exactly the shape a <input
  // type="date"> and a Postgres `date` column expect
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// human date+time in Israel, e.g. "28/07/2026, 14:05" (he) — for emails/messages
function formatIL(d = new Date(), locale = 'he-IL') {
  return new Intl.DateTimeFormat(locale, {
    timeZone: TZ, dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(d));
}

module.exports = { TZ, todayISO, formatIL };
