// The band works in Israel; Railway runs the container in UTC. Pin the process
// timezone so logs, cron-style ticks and any local-time formatting match the
// clock the team actually reads. (Calendar dates additionally go through
// lib/dates.js, since toISOString() is UTC no matter what TZ says.)
process.env.TZ = process.env.TZ || 'Asia/Jerusalem';

const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const config = require('./config');
const whatsapp = require('./services/whatsapp');

const app = express();
// The board ships every lead in one response — several MB once the history from
// Monday is in. JSON gzips ~10:1, so this is the difference between a snappy
// board and a slow one on a phone connection.
app.use(compression());
app.use(cors());
// Keep the raw body: Meta signs its webhook deliveries over the exact bytes
// sent, so the signature cannot be verified from the parsed object.
app.use(express.json({
  limit: '15mb', // signatures/avatars arrive as data URLs
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ---- API ----
app.use('/api/auth', require('./routes/auth'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/import', require('./routes/import'));
app.use('/api/products', require('./routes/products'));
app.use('/api/packages', require('./routes/packages'));
app.use('/api/contracts', require('./routes/contracts').authed);
app.use('/api/portal', require('./routes/contracts').portal);
app.use('/api/forms', require('./routes/forms').authed);
app.use('/api/public/forms', require('./routes/forms').publicRouter);
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/instagram', require('./routes/instagram'));
app.use('/api/voice', require('./routes/voice'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/settings', require('./routes/settings'));

app.get('/api/health', (req, res) => res.json({
  ok: true, app: 'Zooglot.DB', mock_db: config.mockDb,
}));

// ---- frontend (static) — only in local dev or if explicitly enabled ----
if (process.env.SERVE_FRONTEND !== 'false' && config.mockDb) {
  const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
  app.use(express.static(FRONTEND));
  app.get('/', (req, res) => res.sendFile(path.join(FRONTEND, 'index.html')));
}

// ---- errors ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'שגיאת שרת פנימית' });
});

app.listen(config.port, () => {
  console.log(`\n🎷 Zooglot.DB running at ${config.appUrl}`);
  console.log(`   DB mode: ${config.mockDb ? 'MOCK (local JSON, demo data)' : 'Supabase'}`);
  if (config.mockDb) {
    console.log('   Demo login: itamar@kolotband.co.il / kolot123');
  }
  whatsapp.start().catch(e => console.warn('[whatsapp] failed to start:', e.message));
  require('./services/reminders').start();
});
