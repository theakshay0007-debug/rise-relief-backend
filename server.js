require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');
const Razorpay = require('razorpay');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const NGO_80G_REG_NO = process.env.NGO_80G_REG_NO || 'NOT YET CONFIGURED';
const NGO_PAN = process.env.NGO_PAN || 'NOT YET CONFIGURED';

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL in environment. Set it in your .env file or hosting dashboard.');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error('Missing JWT_SECRET in environment. Set it to a long random string.');
  process.exit(1);
}
if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — donation payment endpoints will return an error until these are configured.');
}
if (!RESEND_API_KEY) {
  console.warn('RESEND_API_KEY not set — 80G certificate emails will be skipped until this is configured.');
}
const razorpay = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // needed for most hosted Postgres (Neon, Supabase, Render)
});

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: '8mb' })); // raised from default 100kb to allow uploaded blog images

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

// ================= CAMPAIGNS (public read, admin write) =================

function campaignRowToJson(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    categories: (row.categories || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    goal: Number(row.goal),
    raised: Number(row.raised),
    donors: row.donors,
    urgent: row.urgent,
    createdAt: row.created_at
  };
}

// Public: list all campaigns (used by the Explore Campaigns page and homepage)
app.get('/api/campaigns', async (req, res) => {
  const result = await pool.query('SELECT * FROM campaigns ORDER BY created_at DESC');
  res.json(result.rows.map(campaignRowToJson));
});

// Admin: create a campaign
app.post('/api/admin/campaigns', requireAdmin, async (req, res) => {
  try {
    const { title, description, imageUrl, categories, goal, raised, donors, urgent } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const categoriesStr = Array.isArray(categories) ? categories.join(',') : (categories || '');
    const result = await pool.query(
      `INSERT INTO campaigns (title, description, image_url, categories, goal, raised, donors, urgent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [title, description || '', imageUrl || '', categoriesStr, goal || 0, raised || 0, donors || 0, !!urgent]
    );
    res.status(201).json(campaignRowToJson(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Admin: update a campaign
app.put('/api/admin/campaigns/:id', requireAdmin, async (req, res) => {
  try {
    const { title, description, imageUrl, categories, goal, raised, donors, urgent } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const categoriesStr = Array.isArray(categories) ? categories.join(',') : (categories || '');
    const result = await pool.query(
      `UPDATE campaigns SET title=$1, description=$2, image_url=$3, categories=$4,
       goal=$5, raised=$6, donors=$7, urgent=$8, updated_at=now() WHERE id=$9 RETURNING *`,
      [title, description || '', imageUrl || '', categoriesStr, goal || 0, raised || 0, donors || 0, !!urgent, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found.' });
    res.json(campaignRowToJson(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Admin: delete a campaign
app.delete('/api/admin/campaigns/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM campaigns WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ================= BLOGS (public read, admin write) =================

function blogRowToJson(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    imageUrl: row.image_url,
    imageData: row.image_data,
    createdAt: row.created_at
  };
}

app.get('/api/blogs', async (req, res) => {
  const result = await pool.query('SELECT * FROM blogs ORDER BY created_at DESC');
  res.json(result.rows.map(blogRowToJson));
});

app.post('/api/admin/blogs', requireAdmin, async (req, res) => {
  try {
    const { title, content, imageUrl, imageData } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const result = await pool.query(
      'INSERT INTO blogs (title, content, image_url, image_data) VALUES ($1,$2,$3,$4) RETURNING *',
      [title, content || '', imageUrl || '', imageData || '']
    );
    res.status(201).json(blogRowToJson(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.put('/api/admin/blogs/:id', requireAdmin, async (req, res) => {
  try {
    const { title, content, imageUrl, imageData } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const result = await pool.query(
      'UPDATE blogs SET title=$1, content=$2, image_url=$3, image_data=$4, updated_at=now() WHERE id=$5 RETURNING *',
      [title, content || '', imageUrl || '', imageData || '', req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Blog post not found.' });
    res.json(blogRowToJson(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.delete('/api/admin/blogs/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM blogs WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ================= DONATIONS (Razorpay) =================

// Builds the 80G donation receipt/certificate as a PDF, returned as a Buffer.
function generateCertificatePdf(donation) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 56 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const receiptNo = 'RR-' + donation.id;
      const dateStr = new Date(donation.created_at || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

      doc.fontSize(20).fillColor('#292929').font('Helvetica-Bold')
        .text('Rise and Relief Foundation', { align: 'center' });
      doc.fontSize(10).fillColor('#5c5a56').font('Helvetica')
        .text('113, Makreda, Bhadauli, Ghaziabad 201003', { align: 'center' })
        .text('contact@riseandrelieffoundation.in  |  +91 8384809570', { align: 'center' });
      doc.moveDown(1.2);
      doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#d9573a').lineWidth(1.5).stroke();
      doc.moveDown(1);

      doc.fontSize(15).fillColor('#292929').font('Helvetica-Bold')
        .text('Donation Receipt cum 80G Tax Exemption Certificate', { align: 'center' });
      doc.moveDown(1.2);

      doc.fontSize(11).fillColor('#292929').font('Helvetica');
      const row = (label, value) => {
        doc.font('Helvetica-Bold').text(label, { continued: true }).font('Helvetica').text('  ' + value);
        doc.moveDown(0.35);
      };
      row('Receipt No:', receiptNo);
      row('Date:', dateStr);
      row('Donor Name:', donation.is_anonymous ? 'Anonymous (name on file: ' + (donation.name || 'N/A') + ')' : (donation.name || 'N/A'));
      row('Donor PAN:', donation.pan || 'N/A');
      row('Amount Donated:', '\u20B9' + Number(donation.amount).toLocaleString('en-IN') + ' (' + donation.currency + ')');
      row('Purpose / Cause:', donation.cause || 'General Donation');
      row('Payment Reference:', donation.razorpay_payment_id);

      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').text("Foundation's 80G Registration No:", { continued: true }).font('Helvetica').text('  ' + NGO_80G_REG_NO);
      doc.font('Helvetica-Bold').text("Foundation's PAN:", { continued: true }).font('Helvetica').text('  ' + NGO_PAN);
      doc.moveDown(1);

      doc.fontSize(10).fillColor('#5c5a56')
        .text('This is to certify that the above donation is eligible for tax exemption under Section 80G of the Income Tax Act, 1961, subject to applicable limits and conditions. No goods or services were provided in exchange for this contribution.', { align: 'left' });

      if (NGO_80G_REG_NO === 'NOT YET CONFIGURED' || NGO_PAN === 'NOT YET CONFIGURED') {
        doc.moveDown(1);
        doc.fillColor('#c62828').font('Helvetica-Bold')
          .text('NOTICE: This certificate is not yet valid for tax filing purposes. The foundation has not yet configured its official 80G registration number and/or PAN in the system that generates this document.');
      }

      doc.moveDown(2);
      doc.fontSize(10).fillColor('#292929').text('With gratitude,', { align: 'left' });
      doc.font('Helvetica-Bold').text('Rise and Relief Foundation');

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Emails the certificate PDF to the donor via Resend's REST API.
async function sendCertificateEmail(donation, pdfBuffer) {
  if (!RESEND_API_KEY) {
    console.warn('Skipping certificate email — RESEND_API_KEY not configured.');
    return;
  }
  if (!donation.email) {
    console.warn('Skipping certificate email — donation has no email address on file.');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Rise and Relief Foundation <' + FROM_EMAIL + '>',
      to: [donation.email],
      subject: 'Your Donation Receipt & 80G Certificate — Rise and Relief Foundation',
      html: '<p>Dear ' + (donation.name || 'Friend') + ',</p>' +
            '<p>Thank you for your generous donation of \u20B9' + Number(donation.amount).toLocaleString('en-IN') + ' to Rise and Relief Foundation.</p>' +
            '<p>Your 80G tax exemption certificate is attached to this email as a PDF.</p>' +
            '<p>With gratitude,<br>Rise and Relief Foundation</p>',
      attachments: [{
        filename: 'RiseAndRelief-80G-Certificate-' + donation.id + '.pdf',
        content: pdfBuffer.toString('base64')
      }]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Resend API error: ' + res.status + ' ' + errText);
  }
}

// Step 1: browser asks us to create an order. We never trust an amount sent
// from the browser as "final" — Razorpay ties the payment to this order's
// exact amount, and we verify the signature below before ever recording it.
app.post('/api/donations/create-order', async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: 'Payments are not configured yet.' });
    const { amount, cause } = req.body;
    const amountNum = Number(amount);
    if (!amountNum || amountNum < 250) return res.status(400).json({ error: 'Minimum donation amount is ₹250.' });

    const order = await razorpay.orders.create({
      amount: Math.round(amountNum * 100), // Razorpay expects paise
      currency: 'INR',
      notes: { cause: cause || 'General Donation' }
    });

    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: RAZORPAY_KEY_ID });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not start the payment. Please try again.' });
  }
});

// Step 2: after checkout, the browser sends us what Razorpay gave it. We
// recompute the signature ourselves with our secret key — if it doesn't
// match, the payment is rejected and nothing is recorded as a real donation.
app.post('/api/donations/verify', async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: 'Payments are not configured yet.' });
    const {
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
      name, email, phone, amount, cause, isAnonymous, taxExemption, pan
    } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details.' });
    }
    if (taxExemption && !/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(String(pan || '').trim())) {
      return res.status(400).json({ error: 'A valid PAN number is required for a tax exemption certificate.' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment could not be verified.' });
    }

    const insertResult = await pool.query(
      `INSERT INTO donations (name, email, phone, cause, amount, razorpay_order_id, razorpay_payment_id, status, is_anonymous, tax_exemption, pan)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',$8,$9,$10)
       ON CONFLICT (razorpay_payment_id) DO NOTHING
       RETURNING *`,
      [
        name || '', email || '', phone || '', cause || 'General Donation', Number(amount) || 0,
        razorpay_order_id, razorpay_payment_id,
        !!isAnonymous, !!taxExemption, taxExemption ? String(pan).trim().toUpperCase() : null
      ]
    );

    const donationRow = insertResult.rows[0];
    if (donationRow && donationRow.tax_exemption) {
      try {
        const pdfBuffer = await generateCertificatePdf(donationRow);
        await sendCertificateEmail(donationRow, pdfBuffer);
      } catch (emailErr) {
        // The payment itself succeeded and is recorded — a certificate email
        // failure should never make the donation look like it failed.
        console.error('Certificate email failed:', emailErr);
      }
    }

    res.json({ message: 'Thank you! Your donation was received.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong confirming your payment.' });
  }
});

app.get('/api/admin/donations', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM donations ORDER BY created_at DESC');
  res.json(result.rows);
});

// ---- One-time admin setup (for hosts without shell access, e.g. Render free tier) ----
// Protected by SETUP_SECRET (set it in your host's environment variables) and only
// works while the admin_users table is empty — it auto-disables itself after first use.
// Delete the SETUP_SECRET environment variable once you've used this, to close it off.
app.get('/api/setup-admin', async (req, res) => {
  try {
    const SETUP_SECRET = process.env.SETUP_SECRET;
    if (!SETUP_SECRET) return res.status(403).json({ error: 'Setup is disabled (no SETUP_SECRET configured).' });
    const { key, loginId, password } = req.query;
    if (!key || key !== SETUP_SECRET) return res.status(403).json({ error: 'Invalid or missing setup key.' });
    if (!loginId || !password) return res.status(400).json({ error: 'Provide loginId and password as query parameters.' });

    const existing = await pool.query('SELECT COUNT(*) FROM admin_users');
    if (parseInt(existing.rows[0].count, 10) > 0) {
      return res.status(403).json({ error: 'An admin account already exists — setup is disabled. Remove SETUP_SECRET from your environment.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO admin_users (login_id, password_hash) VALUES ($1,$2)', [loginId, passwordHash]);
    res.json({ message: 'Admin account created for "' + loginId + '". Now remove the SETUP_SECRET environment variable in Render for safety.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log('Rise and Relief backend running on port ' + PORT);
});
