// Creates (or updates the password for) an admin login.
// Usage:  node scripts/create-admin.js "Akshay@settler798" "Aezakmihesoyam@798"
//
// Run this ONCE after your database is set up. It hashes the password before
// storing it — the real password is never saved anywhere, only its hash.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

async function main() {
  const [loginId, password] = process.argv.slice(2);
  if (!loginId || !password) {
    console.error('Usage: node scripts/create-admin.js <loginId> <password>');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in environment (.env file).');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const passwordHash = await bcrypt.hash(password, 10);

  await pool.query(
    `INSERT INTO admin_users (login_id, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (login_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [loginId, passwordHash]
  );

  console.log('Admin user "' + loginId + '" created/updated successfully.');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
