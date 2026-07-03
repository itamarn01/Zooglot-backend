const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  res.json({ products: await db.list('products', { orderBy: 'created_at' }) });
});

router.post('/', async (req, res) => {
  const { name, description, default_price } = req.body || {};
  if (!name) return res.status(400).json({ error: 'שם המוצר הוא שדה חובה' });
  const product = await db.insert('products', {
    name, description: description || '',
    default_price: Number(default_price) || 0, active: true,
  });
  res.status(201).json({ product });
});

router.patch('/:id', async (req, res) => {
  const patch = {};
  for (const f of ['name', 'description', 'default_price', 'active']) {
    if (f in (req.body || {})) patch[f] = f === 'default_price' ? Number(req.body[f]) || 0 : req.body[f];
  }
  const product = await db.update('products', req.params.id, patch);
  if (!product) return res.status(404).json({ error: 'מוצר לא נמצא' });
  res.json({ product });
});

router.delete('/:id', async (req, res) => {
  // guard: block deleting a product that is used inside packages
  const usage = await db.list('package_items', { filters: { product_id: req.params.id } });
  if (usage.length) {
    return res.status(400).json({ error: 'המוצר בשימוש בחבילות — הסר אותו מהחבילות קודם' });
  }
  await db.remove('products', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
