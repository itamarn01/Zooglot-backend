// Classify a form visitor for analytics: device, browser, OS and country.
//
// Country is derived from the IANA timezone the browser reports (e.g.
// "Asia/Jerusalem" → IL) rather than from the IP address. A server-side GeoIP
// database was the first choice, but both maintained packages ship ~155MB of
// data — a heavy price on every Railway deploy for one breakdown. The timezone
// is exact for the zones that matter here, needs no data file, and means no IP
// is ever stored. `countryFromTimezone` is the only place that knows how country
// is resolved, so swapping in a GeoIP lookup later is a one-function change.

// IANA zone → ISO2. Covers the zones real traffic comes from; anything unknown
// falls back to the region heuristic below and finally to null (shown as "אחר").
const ZONE_COUNTRY = {
  'Asia/Jerusalem': 'IL', 'Asia/Tel_Aviv': 'IL', 'Asia/Gaza': 'PS', 'Asia/Hebron': 'PS',
  'Asia/Beirut': 'LB', 'Asia/Damascus': 'SY', 'Asia/Amman': 'JO', 'Asia/Baghdad': 'IQ',
  'Asia/Riyadh': 'SA', 'Asia/Dubai': 'AE', 'Asia/Qatar': 'QA', 'Asia/Kuwait': 'KW',
  'Asia/Bahrain': 'BH', 'Asia/Muscat': 'OM', 'Asia/Tehran': 'IR', 'Asia/Istanbul': 'TR',
  'Europe/Istanbul': 'TR', 'Asia/Nicosia': 'CY', 'Asia/Famagusta': 'CY',
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Karachi': 'PK', 'Asia/Dhaka': 'BD',
  'Asia/Bangkok': 'TH', 'Asia/Singapore': 'SG', 'Asia/Hong_Kong': 'HK', 'Asia/Shanghai': 'CN',
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Manila': 'PH', 'Asia/Jakarta': 'ID',
  'Asia/Kuala_Lumpur': 'MY', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Taipei': 'TW',
  'Asia/Yerevan': 'AM', 'Asia/Tbilisi': 'GE', 'Asia/Baku': 'AZ', 'Asia/Tashkent': 'UZ',

  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Lisbon': 'PT', 'Europe/Madrid': 'ES',
  'Europe/Paris': 'FR', 'Europe/Brussels': 'BE', 'Europe/Amsterdam': 'NL',
  'Europe/Luxembourg': 'LU', 'Europe/Berlin': 'DE', 'Europe/Zurich': 'CH', 'Europe/Vienna': 'AT',
  'Europe/Rome': 'IT', 'Europe/Malta': 'MT', 'Europe/Prague': 'CZ', 'Europe/Bratislava': 'SK',
  'Europe/Warsaw': 'PL', 'Europe/Budapest': 'HU', 'Europe/Ljubljana': 'SI', 'Europe/Zagreb': 'HR',
  'Europe/Belgrade': 'RS', 'Europe/Sarajevo': 'BA', 'Europe/Skopje': 'MK', 'Europe/Tirane': 'AL',
  'Europe/Athens': 'GR', 'Europe/Bucharest': 'RO', 'Europe/Sofia': 'BG', 'Europe/Chisinau': 'MD',
  'Europe/Kiev': 'UA', 'Europe/Kyiv': 'UA', 'Europe/Minsk': 'BY', 'Europe/Moscow': 'RU',
  'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK',
  'Europe/Helsinki': 'FI', 'Europe/Riga': 'LV', 'Europe/Vilnius': 'LT', 'Europe/Tallinn': 'EE',
  'Europe/Reykjavik': 'IS', 'Atlantic/Reykjavik': 'IS',

  'America/New_York': 'US', 'America/Detroit': 'US', 'America/Chicago': 'US',
  'America/Denver': 'US', 'America/Phoenix': 'US', 'America/Los_Angeles': 'US',
  'America/Anchorage': 'US', 'Pacific/Honolulu': 'US',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA', 'America/Halifax': 'CA', 'America/St_Johns': 'CA',
  'America/Mexico_City': 'MX', 'America/Bogota': 'CO', 'America/Lima': 'PE',
  'America/Santiago': 'CL', 'America/Argentina/Buenos_Aires': 'AR',
  'America/Sao_Paulo': 'BR', 'America/Montevideo': 'UY', 'America/Panama': 'PA',
  'America/Costa_Rica': 'CR', 'America/Guatemala': 'GT',

  'Africa/Cairo': 'EG', 'Africa/Johannesburg': 'ZA', 'Africa/Lagos': 'NG',
  'Africa/Nairobi': 'KE', 'Africa/Casablanca': 'MA', 'Africa/Tunis': 'TN',
  'Africa/Algiers': 'DZ', 'Africa/Addis_Ababa': 'ET',

  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU',
  'Pacific/Auckland': 'NZ',
};

function countryFromTimezone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  const zone = tz.trim();
  if (ZONE_COUNTRY[zone]) return ZONE_COUNTRY[zone];
  // "US/Eastern", "Israel", "GB" and similar legacy aliases
  const legacy = { Israel: 'IL', GB: 'GB', Japan: 'JP', Egypt: 'EG', Turkey: 'TR', Poland: 'PL' };
  if (legacy[zone]) return legacy[zone];
  if (zone.startsWith('US/')) return 'US';
  if (zone.startsWith('Canada/')) return 'CA';
  if (zone.startsWith('Australia/')) return 'AU';
  return null;
}

// Minimal UA parsing. A dependency here would be another package to keep current
// for three coarse buckets; order matters because the strings nest (Edge claims
// Chrome, Chrome claims Safari).
function parseUserAgent(ua = '') {
  const s = String(ua);
  const has = (re) => re.test(s);

  let browser = 'אחר';
  if (has(/\bEdg[eA]?\//)) browser = 'Edge';
  else if (has(/\b(OPR|Opera)\//)) browser = 'Opera';
  else if (has(/\bSamsungBrowser\//)) browser = 'Samsung Internet';
  else if (has(/\bFirefox\/|\bFxiOS\//)) browser = 'Firefox';
  else if (has(/\bCriOS\//)) browser = 'Chrome';
  else if (has(/\bChrome\//)) browser = 'Chrome';
  else if (has(/\bSafari\//) && has(/\bVersion\//)) browser = 'Safari';

  let os = 'אחר';
  if (has(/\bWindows NT/)) os = 'Windows';
  else if (has(/\b(iPhone|iPad|iPod)\b/)) os = 'iOS';
  else if (has(/\bAndroid\b/)) os = 'Android';
  else if (has(/\bMac OS X\b/)) os = 'macOS';
  else if (has(/\bLinux\b/)) os = 'Linux';

  // iPadOS reports as Macintosh; the touch hint from the client settles it
  let device = 'desktop';
  if (has(/\bTablet\b|\biPad\b/)) device = 'tablet';
  else if (has(/\bMobi|\bAndroid\b.*\bMobile\b|\biPhone\b|\biPod\b/)) device = 'mobile';
  else if (has(/\bAndroid\b/)) device = 'tablet';

  return { browser, os, device };
}

module.exports = { countryFromTimezone, parseUserAgent };
