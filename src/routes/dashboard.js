const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const [leads, contracts, profiles] = await Promise.all([
    db.list('leads', {}), db.list('contracts', {}), db.list('profiles', {}),
  ]);

  const by = (arr, key) => arr.reduce((m, x) => {
    const k = x[key] || 'לא ידוע';
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {});

  const open = leads.filter(l => l.sale_status === 'open');
  const win = leads.filter(l => l.sale_status === 'win');
  const lost = leads.filter(l => l.sale_status === 'lost');
  const decided = win.length + lost.length;

  const signedRevenue = contracts
    .filter(c => c.client_signed_at)
    .reduce((s, c) => s + (Number(c.final_price) || 0), 0);
  const proposedPipeline = open.reduce((s, l) => s + (Number(l.proposed_price) || 0), 0);

  // per-user sales performance
  const perUser = profiles.map(p => {
    const owned = leads.filter(l => l.owner_id === p.id);
    const uWin = owned.filter(l => l.sale_status === 'win').length;
    const uLost = owned.filter(l => l.sale_status === 'lost').length;
    const revenue = contracts
      .filter(c => c.client_signed_at && owned.some(l => l.id === c.lead_id))
      .reduce((s, c) => s + (Number(c.final_price) || 0), 0);
    return {
      user_id: p.id,
      name: p.full_name || p.email,
      leads: owned.length,
      open: owned.length - uWin - uLost,
      win: uWin,
      lost: uLost,
      conversion: (uWin + uLost) ? Math.round((uWin / (uWin + uLost)) * 100) : null,
      revenue,
    };
  }).filter(u => u.leads > 0);

  // monthly new leads (last 12 months)
  const months = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    months.push({
      month: key,
      new_leads: leads.filter(l => (l.created_at || '').startsWith(key)).length,
      wins: leads.filter(l => l.sale_status === 'win' && (l.close_date || '').startsWith(key)).length,
    });
  }

  res.json({
    totals: {
      leads: leads.length,
      open: open.length,
      win: win.length,
      lost: lost.length,
      conversion: decided ? Math.round((win.length / decided) * 100) : null,
      signed_revenue: signedRevenue,
      proposed_pipeline: proposedPipeline,
      contracts_signed: contracts.filter(c => c.client_signed_at).length,
      contracts_pending: contracts.filter(c => c.status === 'sent' && !c.client_signed_at).length,
    },
    per_user: perUser.sort((a, b) => b.win - a.win),
    monthly: months,
    sources: by(leads, 'source'),
    hear_about_us: by(leads.filter(l => l.hear_about_us), 'hear_about_us'),
    lost_reasons: by(lost, 'lost_reason'),
    lost_competitors: by(lost, 'lost_competitor'),
  });
});

module.exports = router;
