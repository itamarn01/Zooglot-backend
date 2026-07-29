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

  // PostgREST caps every response at `max-rows` (1000 on Supabase). Without an
  // explicit range that cap is SILENT: you get 1000 rows and no error, so a
  // growing board simply loses its oldest records from every list, and matching
  // /counting logic quietly works off a partial set. So page through with
  // .range() until a short page comes back and return the whole table.
  //
  // opts.limit still means "at most N" (a real limit, fetched in one page).
  // opts.columns narrows the projection — use it when only a few fields are
  // needed (e.g. counting), since payload size dominates the cost at scale.
  async list(name, opts = {}) {
    const build = () => {
      let q = client.from(name).select(opts.columns || '*');
      if (opts.filters) {
        for (const [k, v] of Object.entries(opts.filters)) {
          if (v === undefined) continue;
          q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
        }
      }
      if (opts.orderBy) q = q.order(opts.orderBy, { ascending: opts.asc !== false });
      return q;
    };

    if (opts.limit) {
      const { data, error } = await build().limit(opts.limit);
      throwIf(error);
      return data || [];
    }

    // an explicit order keeps paging stable; without one PostgREST may return
    // rows in a different order per page and we'd both duplicate and miss rows
    const PAGE = 1000;
    const out = [];
    for (let from = 0; ; from += PAGE) {
      let q = build();
      if (!opts.orderBy) q = q.order('id', { ascending: true });
      const { data, error } = await q.range(from, from + PAGE - 1);
      throwIf(error);
      const page = data || [];
      out.push(...page);
      if (page.length < PAGE) break;
      // hard stop so a runaway table can never spin forever
      if (out.length >= 100000) break;
    }
    return out;
  },

  // cheap server-side count (head request — no rows transferred)
  async count(name, filters = {}) {
    let q = client.from(name).select('id', { count: 'exact', head: true });
    for (const [k, v] of Object.entries(filters)) {
      if (v === undefined) continue;
      q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
    }
    const { count, error } = await q;
    throwIf(error);
    return count || 0;
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

  // One round trip per batch instead of one per row. An Excel import of 5,000
  // leads was 5,000 sequential inserts, which took minutes and timed out the
  // request long before it finished.
  async insertMany(name, rows) {
    if (!rows.length) return [];
    const out = [];
    const CHUNK = 500; // keeps each statement well inside PostgREST's limits
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { data, error } = await client.from(name).insert(rows.slice(i, i + CHUNK)).select();
      throwIf(error);
      out.push(...(data || []));
    }
    return out;
  },

  // Bulk delete by column value — used to empty a whole pipeline. Returns the
  // number of rows actually removed so the caller can report it honestly.
  async removeWhere(name, col, val) {
    const q = client.from(name).delete({ count: 'exact' });
    const { count, error } = await (Array.isArray(val) ? q.in(col, val) : q.eq(col, val));
    throwIf(error);
    return count || 0;
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
