// One-time bootstrap: create the first admin profile directly in the
// database. Needed because registration is invite-only, and an invite
// can only be sent by an existing admin — so the very first account
// has no other way in.
// Usage: node scripts/create-admin.js <email> <password> ["Full Name"]
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

async function main() {
  const [, , email, password, ...nameParts] = process.argv;
  if (!email || !password) {
    console.error('Usage: node scripts/create-admin.js <email> <password> ["Full Name"]');
    process.exit(1);
  }
  const normalized = email.toLowerCase();
  const existing = await db.getBy('profiles', 'email', normalized);
  if (existing) {
    console.error(`כבר קיים משתמש עם המייל ${normalized} (id: ${existing.id}).`);
    process.exit(1);
  }
  const profile = await db.insert('profiles', {
    email: normalized,
    full_name: nameParts.join(' ') || normalized.split('@')[0],
    role: 'admin',
    password_hash: bcrypt.hashSync(password, 10),
    email_verified: true,
    avatar_url: null,
  });
  console.log(`✓ נוצר משתמש אדמין: ${profile.email} (id: ${profile.id})`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
