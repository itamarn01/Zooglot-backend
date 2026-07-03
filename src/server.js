const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const whatsapp = require('./services/whatsapp');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // signatures/avatars arrive as data URLs

// ---- API ----
app.use('/api/auth', require('./routes/auth'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/products', require('./routes/products'));
app.use('/api/packages', require('./routes/packages'));
app.use('/api/contracts', require('./routes/contracts').authed);
app.use('/api/portal', require('./routes/contracts').portal);
app.use('/api/forms', require('./routes/forms').authed);
app.use('/api/public/forms', require('./routes/forms').publicRouter);
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/voice', require('./routes/voice'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/settings', require('./routes/settings'));

app.get('/api/health', (req, res) => res.json({
  ok: true, app: 'Zooglot.DB', mock_db: config.mockDb,
}));

// ---- frontend (static) ----
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(FRONTEND));
app.get('/', (req, res) => res.sendFile(path.join(FRONTEND, 'index.html')));

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
});
