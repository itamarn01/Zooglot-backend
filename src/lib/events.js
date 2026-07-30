// Server-sent events: one long-lived connection per open browser tab, so a
// change by one member of the band shows up on the other two without a refresh.
//
// In-process on purpose. Railway runs this as a single instance, and an
// in-memory fan-out has no broker, no extra service and no failure mode of its
// own. If this ever scales to more than one instance the clients on the other
// instances stop hearing anything — at that point this needs Postgres LISTEN /
// NOTIFY or Supabase Realtime behind the same broadcast() call.
const clients = new Set();

function addClient(res, meta = {}) {
  const client = { res, ...meta };
  clients.add(client);
  return () => clients.delete(client);
}

// `by` carries the user who caused the change so a browser can ignore its own
// echo — it already applied the change locally and must not fight itself.
function broadcast(entity, action, payload = {}) {
  if (!clients.size) return;
  const frame = `data: ${JSON.stringify({ entity, action, ...payload, at: Date.now() })}\n\n`;
  for (const c of [...clients]) {
    try {
      c.res.write(frame);
      c.res.flush?.(); // compression middleware buffers otherwise
    } catch {
      clients.delete(c);
    }
  }
}

const clientCount = () => clients.size;

module.exports = { addClient, broadcast, clientCount };
