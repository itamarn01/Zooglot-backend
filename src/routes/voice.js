// Voice-note ingestion: record/upload audio -> Whisper transcript ->
// GPT field extraction -> apply to a new or existing lead.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { todayISO } = require('../lib/dates');
const ai = require('../services/ai');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'voice');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024 },
});

const LEAD_KEYS = [
  'name','contact_name','relation','event_type','event_date','event_location',
  'email','phone1','proposed_price','hear_about_us','referrer','next_action',
];

router.post('/', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא התקבל קובץ אודיו' });
  let note = await db.insert('voice_notes', {
    lead_id: req.body?.lead_id || null,
    audio_path: req.file.path,
    transcript: null, extracted: null,
    status: 'pending',
    created_by: req.user.id,
  });
  try {
    // pass the browser-reported mime too — a MediaRecorder blob often arrives
    // with a generic filename and no useful extension
    const transcript = await ai.transcribe(req.file.path, req.file.originalname, req.file.mimetype);
    note = await db.update('voice_notes', note.id, { transcript, status: 'transcribed' });
    const extracted = await ai.extractLeadFields(transcript);
    note = await db.update('voice_notes', note.id, { extracted, status: 'extracted' });
    res.json({ voice_note: note });
  } catch (e) {
    await db.update('voice_notes', note.id, { status: 'failed' });
    res.status(500).json({ error: `ניתוח ההקלטה נכשל: ${e.message}` });
  }
});

// apply extracted fields — to an existing lead (only fills/overrides provided keys)
// or as a brand-new lead when no lead_id is given
router.post('/:id/apply', async (req, res) => {
  const note = await db.get('voice_notes', req.params.id);
  if (!note || !note.extracted) return res.status(404).json({ error: 'ניתוח קולי לא נמצא' });

  const fields = {};
  for (const k of LEAD_KEYS) {
    const v = (req.body?.fields || note.extracted)[k];
    if (v !== undefined && v !== null && v !== '') fields[k] = v;
  }
  const notes = (req.body?.fields || note.extracted).notes;

  let lead;
  const targetId = req.body?.lead_id || note.lead_id;
  if (targetId) {
    lead = await db.update('leads', targetId, fields);
    if (!lead) return res.status(404).json({ error: 'ליד לא נמצא' });
  } else {
    lead = await db.insert('leads', {
      name: fields.name || fields.contact_name || 'ליד מהקלטה קולית',
      stage: 'לקוח חדש ידני', sale_status: 'open', next_action: 'עוד פרטים',
      event_type: 'חתונה',
      first_contact_date: todayISO(),
      ...fields,
      source: 'voice', source_ref: note.id, created_by: req.user.id,
    });
  }
  await db.insert('lead_updates', {
    lead_id: lead.id, author_id: req.user.id, kind: 'system',
    body: `🎙️ מולא אוטומטית מהקלטה קולית.\n\nתמלול:\n${note.transcript || ''}` +
      (notes ? `\n\nהערות AI: ${notes}` : ''),
  });
  await db.update('voice_notes', note.id, { lead_id: lead.id, status: 'applied' });
  res.json({ lead });
});

module.exports = router;
