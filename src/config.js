require('dotenv').config();

const filled = (v) => Boolean(v && v !== '...' && v.trim() !== '');

const config = {
  port: Number(process.env.PORT || 4000),
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 4000}`,
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
