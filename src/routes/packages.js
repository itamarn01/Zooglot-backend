const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function withItems(pkg) {
  const items = await db.list('package_items', { filters: { package_id: pkg.id }, orderBy: 'sort_order' });
  const products = await db.list('products', {});
  const pMap = Object.fromEntries(products.map(p => [p.id, p]));
  return {
    ...pkg,
    items: items.map(i => ({
      ...i,
      product: pMap[i.product_id] || null,
      effective_price: i.override_price ?? pMap[i.product_id]?.default_price ?? 0,
    })),
  };
}

router.get('/', async (req, res) => {
  const pkgs = await db.list('packages', { orderBy: 'created_at' });
  res.json({ packages: await Promise.all(pkgs.map(withItems)) });
});

router.post('/', async (req, res) => {
  const { name, description, base_price } = req.body || {};
  if (!name) return res.status(400).json({ error: 'שם החבילה הוא שדה חובה' });
  const pkg = await db.insert('packages', {
    name, description: description || '', base_price: Number(base_price) || 0, active: true,
  });
  res.status(201).json({ package: await withItems(pkg) });
});

router.patch('/:id', async (req, res) => {
  const patch = {};
  for (const f of ['name', 'description', 'base_price', 'active']) {
    if (f in (req.body || {})) patch[f] = f === 'base_price' ? Number(req.body[f]) || 0 : req.body[f];
  }
  const pkg = await db.update('packages', req.params.id, patch);
  if (!pkg) return res.status(404).json({ error: 'חבילה לא נמצאה' });
  res.json({ package: await withItems(pkg) });
});

router.delete('/:id', async (req, res) => {
  for (const i of await db.list('package_items', { filters: { package_id: req.params.id } })) {
    await db.remove('package_items', i.id);
  }
  await db.remove('packages', req.params.id);
  res.json({ ok: true });
});

// ---- items (drag & drop of products into a package) ----
router.post('/:id/items', async (req, res) => {
  const { product_id, included = true, override_price = null, sort_order = 0 } = req.body || {};
  const pkg = await db.get('packages', req.params.id);
  const product = await db.get('products', product_id);
  if (!pkg || !product) return res.status(404).json({ error: 'חבילה או מוצר לא נמצאו' });

  const existing = await db.list('package_items', { filters: { package_id: pkg.id, product_id } });
  if (existing.length) return res.status(400).json({ error: 'המוצר כבר בחבילה' });

  const item = await db.insert('package_items', {
    package_id: pkg.id, product_id,
    included: !!included,
    override_price: override_price === null || override_price === '' ? null : Number(override_price),
    sort_order: Number(sort_order) || 0,
  });
  res.status(201).json({ package: await withItems(pkg) });
});

router.patch('/:id/items/:itemId', async (req, res) => {
  const patch = {};
  if ('included' in (req.body || {})) patch.included = !!req.body.included;
  if ('override_price' in (req.body || {})) {
    patch.override_price = req.body.override_price === null || req.body.override_price === ''
      ? null : Number(req.body.override_price);
  }
  if ('sort_order' in (req.body || {})) patch.sort_order = Number(req.body.sort_order) || 0;
  const item = await db.update('package_items', req.params.itemId, patch);
  if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });
  const pkg = await db.get('packages', req.params.id);
  res.json({ package: await withItems(pkg) });
});

router.delete('/:id/items/:itemId', async (req, res) => {
  await db.remove('package_items', req.params.itemId);
  const pkg = await db.get('packages', req.params.id);
  res.json({ package: pkg ? await withItems(pkg) : null });
});

module.exports = router;
