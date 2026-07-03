// Transactional email via Resend. In mock mode (no API key) emails are
// printed to the console so the flows are fully testable locally.
const config = require('../config');

let resend = null;
if (config.resend.enabled) {
  const { Resend } = require('resend');
  resend = new Resend(config.resend.apiKey);
}

const shell = (title, bodyHtml) => `
<!doctype html><html dir="rtl" lang="he"><body style="margin:0;background:#0e1b20;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;color:#eef7fa;">
  <h2 style="color:#87cedf;margin:0 0 16px;">KOLOT · Zooglot.DB</h2>
  <h3 style="margin:0 0 12px;">${title}</h3>
  <div style="font-size:15px;line-height:1.6;">${bodyHtml}</div>
  <p style="color:#7fa3ad;font-size:12px;margin-top:28px;">נשלח אוטומטית ממערכת ה-CRM של להקת קולות</p>
</div></body></html>`;

async function send(to, subject, html) {
  if (!resend) {
    console.log(`\n[email:mock] to=${to} subject="${subject}"\n${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n`);
    return { mock: true };
  }
  const { data, error } = await resend.emails.send({
    from: config.resend.from, to, subject, html,
  });
  if (error) throw new Error(`[resend] ${error.message}`);
  return data;
}

module.exports = {
  send,
  verifyEmail: (to, code) =>
    send(to, 'אימות כתובת מייל — KOLOT CRM',
      shell('אימות כתובת המייל שלך', `<p>קוד האימות שלך:</p><p style="font-size:28px;letter-spacing:6px;color:#87cedf;"><b>${code}</b></p><p>הקוד תקף ל-15 דקות.</p>`)),
  otpLogin: (to, code) =>
    send(to, 'קוד התחברות חד-פעמי — KOLOT CRM',
      shell('התחברות ללא סיסמה', `<p>קוד ההתחברות שלך:</p><p style="font-size:28px;letter-spacing:6px;color:#87cedf;"><b>${code}</b></p><p>הקוד תקף ל-10 דקות. אם לא ביקשת קוד — התעלם/י מהמייל.</p>`)),
  passwordReset: (to, link) =>
    send(to, 'איפוס סיסמה — KOLOT CRM',
      shell('איפוס סיסמה', `<p>לאיפוס הסיסמה שלך:</p><p><a href="${link}" style="color:#87cedf;">לחצו כאן לאיפוס הסיסמה</a></p><p>הקישור תקף לשעה.</p>`)),
  invitation: (to, link, inviterName) =>
    send(to, 'הוזמנת ל-Zooglot.DB — מערכת ה-CRM של קולות',
      shell('הוזמנת להצטרף', `<p>${inviterName || 'חבר צוות'} הזמין/ה אותך למערכת ניהול הלקוחות של להקת קולות.</p><p><a href="${link}" style="color:#87cedf;">להשלמת ההרשמה</a></p>`)),
  contractReady: (to, link, leadName) =>
    send(to, `החוזה שלכם מוכן לחתימה — KOLOT`,
      shell('החוזה מוכן', `<p>שלום ${leadName || ''},</p><p>החוזה שלכם מול להקת קולות מוכן לצפייה ולחתימה דיגיטלית:</p><p><a href="${link}" style="color:#87cedf;">לצפייה בחוזה ולחתימה</a></p>`)),
};
