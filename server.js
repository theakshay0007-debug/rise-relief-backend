require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL in environment. Set it in your .env file or hosting dashboard.');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error('Missing JWT_SECRET in environment. Set it to a long random string.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // needed for most hosted Postgres (Neon, Supabase, Render)
});

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

// Basic rate limiting (very small, dependency-free) to slow down brute-force login attempts.
const loginAttempts = new Map(); // ip -> { count, resetAt }
function rateLimitLogin(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 15 * 60 * 1000; }
  rec.count += 1;
  loginAttempts.set(ip, rec);
  if (rec.count > 10) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  next();
}

// ---- Auth middleware for admin-only routes ----
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('wrong role');
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

// ================= PUBLIC FORM SUBMISSION ROUTES =================

// Volunteer registration
app.post('/api/volunteers', async (req, res) => {
  try {
    const { name, email, phone, interest, password } = req.body;
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'Name, email, phone and password are required.' });
    }
    const existing = await pool.query('SELECT id FROM volunteers WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO volunteers (name, email, phone, interest, password_hash) VALUES ($1,$2,$3,$4,$5)',
      [name, email.toLowerCase(), phone, interest || null, passwordHash]
    );
    res.status(201).json({ message: 'Registered successfully.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Volunteer login (separate from admin login — just confirms identity, no dashboard access implied)
app.post('/api/volunteers/login', rateLimitLogin, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const result = await pool.query('SELECT * FROM volunteers WHERE email = $1', [email.toLowerCase()]);
    const volunteer = result.rows[0];
    if (!volunteer) return res.status(401).json({ error: 'No matching account found.' });
    const ok = await bcrypt.compare(password, volunteer.password_hash);
    if (!ok) return res.status(401).json({ error: 'No matching account found.' });
    res.json({ message: 'Welcome back, ' + volunteer.name + '!' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Contact form
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email and message are required.' });
    }
    await pool.query(
      'INSERT INTO contact_messages (name, email, phone, subject, message) VALUES ($1,$2,$3,$4,$5)',
      [name, email, phone || null, subject || null, message]
    );
    res.status(201).json({ message: 'Message received.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Start a Campaign / fundraiser request
app.post('/api/fundraiser', async (req, res) => {
  try {
    const { name, email, phone, fundUse, hospStatus } = req.body;
    if (!name || !email || !phone) {
      return res.status(400).json({ error: 'Name, email and phone are required.' });
    }
    await pool.query(
      'INSERT INTO fundraiser_requests (name, email, phone, fund_use, hosp_status) VALUES ($1,$2,$3,$4,$5)',
      [name, email, phone, fundUse || null, hospStatus || null]
    );
    res.status(201).json({ message: 'Fundraiser request received.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ================= ADMIN ROUTES =================

app.post('/api/admin/login', rateLimitLogin, async (req, res) => {
  try {
    const { loginId, password } = req.body;
    if (!loginId || !password) return res.status(400).json({ error: 'Login ID and password are required.' });
    const result = await pool.query('SELECT * FROM admin_users WHERE login_id = $1', [loginId]);
    const admin = result.rows[0];
    if (!admin) return res.status(401).json({ error: 'Incorrect Login ID or Password.' });
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect Login ID or Password.' });
    const token = jwt.sign({ role: 'admin', loginId: admin.login_id }, JWT_SECRET, { expiresIn: '2h' });
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/admin/volunteers', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT id, name, email, phone, interest, created_at FROM volunteers ORDER BY created_at DESC');
  res.json(result.rows);
});

app.get('/api/admin/contact', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT id, name, email, phone, subject, message, created_at FROM contact_messages ORDER BY created_at DESC');
  res.json(result.rows);
});

app.get('/api/admin/fundraiser', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT id, name, email, phone, fund_use, hosp_status, created_at FROM fundraiser_requests ORDER BY created_at DESC');
  res.json(result.rows);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log('Rise and Relief backend running on port ' + PORT);
});
