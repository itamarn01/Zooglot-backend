// Supabase driver — same interface as ./mock.js, backed by supabase-js
// using the service-role key (server-side only).
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const client = createClient(config.supabase.url, config.supabase.serviceKey, {
  auth: { persistSession: false },
});

function throwIf(error) {
  if (error) throw new Error(`[supabase] ${error.message}`);
}

module.exports = {
  isMock: false,
  client,

  async list(name, opts = {}) {
    let q = client.from(name).select('*');
    if (opts.filters) {
      for (const [k, v] of Object.entries(opts.filters)) {
        if (v === undefined) continue;
        q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
      }
    }
    if (opts.orderBy) q = q.order(opts.orderBy, { ascending: opts.asc !== false });
    if (opts.limit) q = q.limit(opts.limit);
    const { data, error } = await q;
    throwIf(error);
    return data || [];
  },

  async get(name, id) {
    const { data, error } = await client.from(name).select('*').eq('id', id).maybeSingle();
    throwIf(error);
    return data;
  },

  async getBy(name, col, val) {
    const { data, error } = await client.from(name).select('*').eq(col, val).maybeSingle();
    throwIf(error);
    return data;
  },

  async insert(name, row) {
    const { data, error } = await client.from(name).insert(row).select().single();
    throwIf(error);
    return data;
  },

  async update(name, id, patch) {
    const { data, error } = await client.from(name).update(patch).eq('id', id).select().maybeSingle();
    throwIf(error);
    return data;
  },

  async remove(name, id) {
    const { error } = await client.from(name).delete().eq('id', id);
    throwIf(error);
    return true;
  },
};
