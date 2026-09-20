-- Rise and Relief Foundation — database schema
-- Run this once against your Postgres database before starting the server.

CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  login_id      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS volunteers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT NOT NULL,
  interest      TEXT,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT,
  subject    TEXT,
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fundraiser_requests (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL,
  fund_use      TEXT,
  hosp_status   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin-managed campaigns shown on the Explore Campaigns page.
-- "categories" is a comma-separated list of slugs, e.g. "urgent,medical"
-- matching the filter buttons on the Explore Campaigns page:
-- urgent, children, animals, disability, disaster-relief, education, elderly, faith, hunger, medical
CREATE TABLE IF NOT EXISTS campaigns (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  image_url     TEXT,
  categories    TEXT NOT NULL DEFAULT '',
  goal          NUMERIC NOT NULL DEFAULT 0,
  raised        NUMERIC NOT NULL DEFAULT 0,
  donors        INTEGER NOT NULL DEFAULT 0,
  urgent        BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blogs (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  content       TEXT,
  image_url     TEXT,
  image_data    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safe to re-run: adds the uploaded-image column if this table already existed
-- from before drag-and-drop upload support was added.
ALTER TABLE blogs ADD COLUMN IF NOT EXISTS image_data TEXT;

-- Donations made through Razorpay via the "Donate Now" flow.
-- A row is only inserted after the payment signature is verified server-side,
-- so every row here represents a payment Razorpay has confirmed as genuine.
CREATE TABLE IF NOT EXISTS donations (
  id                  SERIAL PRIMARY KEY,
  name                TEXT,
  email               TEXT,
  phone               TEXT,
  cause               TEXT,
  amount              NUMERIC NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'INR',
  razorpay_order_id   TEXT NOT NULL,
  razorpay_payment_id TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'paid',
  is_anonymous        BOOLEAN NOT NULL DEFAULT false,
  tax_exemption       BOOLEAN NOT NULL DEFAULT false,
  pan                 TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safe to re-run: adds these columns if the donations table already existed
-- from before tax-exemption (80G) and anonymous-donation support were added.
ALTER TABLE donations ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE donations ADD COLUMN IF NOT EXISTS tax_exemption BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE donations ADD COLUMN IF NOT EXISTS pan TEXT;

