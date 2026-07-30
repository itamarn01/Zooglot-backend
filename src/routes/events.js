const express = require('express');
const { addClient, clientCount } = require('../lib/events');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/events — the live change feed.
router.get('/', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // stops proxies buffering the stream into silence
  });
  res.flushHeaders?.();
  res.write('retry: 4000\n\n');
  res.write(`data: ${JSON.stringify({ entity: 'stream', action: 'open' })}\n\n`);

  const remove = addClient(res, { userId: req.user.id, email: req.user.email });

  // Idle connections are dropped by proxies after ~60s. A comment line keeps it
  // alive and costs nothing — without it the feed dies quietly after a minute
  // and nobody notices until an update fails to arrive.
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); res.flush?.(); } catch { /* closed */ }
  }, 25000);

  const close = () => { clearInterval(ping); remove(); };
  req.on('close', close);
  req.on('error', close);
});

router.get('/status', requireAuth, (_req, res) => res.json({ clients: clientCount() }));

module.exports = router;
