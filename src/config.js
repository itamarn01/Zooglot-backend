require('dotenv').config();

const filled = (v) => Boolean(v && v !== '...' && v.trim() !== '');

const config = {
  port: Number(process.env.PORT || 4000),
  // appUrl: this backend's own address — only correct for API/webhook links.
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 4000}`,
  // frontendUrl: where the SPA (and public pages like form.html/portal.html)
  // actually live. In prod this is the Vercel URL, not the Railway backend —
  // falls back to appUrl for local dev where both are served from one origin.
  frontendUrl: process.env.FRONTEND_URL || process.env.APP_URL || `http://localhost:${process.env.PORT || 4000}`,
  jwtSecret: process.env.JWT_SECRET || 'zooglot-dev-secret',
  webhookSecret: process.env.WEBHOOK_SECRET || 'dev-webhook-secret',

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: process.env.SUPABASE_ANON_KEY,
    enabled: filled(process.env.SUPABASE_URL) && filled(process.env.SUPABASE_SERVICE_ROLE_KEY),
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM || 'KOLOT CRM <onboarding@resend.dev>',
    enabled: filled(process.env.RESEND_API_KEY),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1',
    extractModel: process.env.OPENAI_EXTRACT_MODEL || 'gpt-4o-mini',
    enabled: filled(process.env.OPENAI_API_KEY),
  },
  // Gemini is the default voice engine: the free tier needs no credit card, and
  // Flash understands audio directly — one call transcribes AND extracts, where
  // OpenAI needs Whisper then GPT. OpenAI stays as a fallback if its key is set.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    enabled: filled(process.env.GEMINI_API_KEY) || filled(process.env.GOOGLE_AI_API_KEY),
  },
  // Microsoft Clarity — free session recordings + heatmaps for the lead forms
  clarity: {
    projectId: process.env.CLARITY_PROJECT_ID || '',
    enabled: filled(process.env.CLARITY_PROJECT_ID),
  },
  // Instagram / Facebook Messenger → leads
  instagram: {
    verifyToken: process.env.META_VERIFY_TOKEN || 'zooglot-verify',
    appSecret: process.env.META_APP_SECRET || '',
    pageToken: process.env.META_PAGE_TOKEN || '',
    enabled: filled(process.env.META_PAGE_TOKEN),
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI ||
      `http://localhost:${process.env.PORT || 4000}/api/calendar/oauth/callback`,
    enabled: filled(process.env.GOOGLE_CLIENT_ID) && filled(process.env.GOOGLE_CLIENT_SECRET),
  },
  whatsapp: {
    enabled: process.env.ENABLE_WHATSAPP === 'true',
    sessionId: process.env.WHATSAPP_SESSION_ID || 'kolot',
    bandNumber: '972555081080',
  },
};

config.mockDb = !config.supabase.enabled;

module.exports = config;
