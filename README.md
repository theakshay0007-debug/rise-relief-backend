# Rise and Relief Foundation — Backend

A small API server that stores volunteer registrations, contact messages, and
fundraiser requests in a real database, and protects the admin dashboard with
a real server-side login check (passwords hashed with bcrypt, sessions signed
with JWT). Nothing sensitive — passwords, the database, or the full list of
submissions — ever lives in the website's HTML/JS. The browser only ever
holds a short-lived login token after a successful admin login, which is
useless without this server to verify it.

## What you need (all free tiers are enough for a small NGO site)

1. A free Postgres database — easiest options: [Neon](https://neon.tech) or [Supabase](https://supabase.com)
2. A free place to run this Node server — easiest option: [Render](https://render.com)

## Step 1 — Create the database

1. Sign up at neon.tech (or supabase.com) and create a new project/database.
2. Copy the **connection string** it gives you (looks like
   `postgres://user:password@host/dbname?sslmode=require`).
3. Open the SQL editor in your provider's dashboard, paste in the contents of
   `schema.sql` from this folder, and run it. This creates the four tables
   (`admin_users`, `volunteers`, `contact_messages`, `fundraiser_requests`).

## Step 2 — Configure this project

1. Copy `.env.example` to a new file named `.env`.
2. Fill in:
   - `DATABASE_URL` — the connection string from Step 1.
   - `JWT_SECRET` — a long random string. Generate one by running:
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `FRONTEND_ORIGIN` — the exact URL your website will be hosted at (you can
     use `*` temporarily while testing locally, but lock this down before
     going live).
3. Install dependencies:
   ```
   npm install
   ```
4. Create the admin login (this hashes the password — it is never stored in
   plain text anywhere):
   ```
   npm run create-admin -- "Akshay@settler798" "Aezakmihesoyam@798"
   ```
   You can change these values to whatever you actually want the real
   credentials to be — just re-run this command with new values any time you
   want to change the password.

## Step 3 — Run it locally to test (optional but recommended)

```
npm start
```

Visit `http://localhost:3000/api/health` — you should see `{"ok":true}`.

## Step 4 — Deploy it for real (Render)

1. Push this `backend` folder to a GitHub repository (or use Render's "deploy
   from a folder" option if you don't want to use GitHub).
2. On Render, create a new **Web Service**, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under "Environment", add the same variables from your `.env` file
   (`DATABASE_URL`, `JWT_SECRET`, `FRONTEND_ORIGIN`).
5. Deploy. Render will give you a URL like `https://rise-relief-api.onrender.com`.
6. Run the admin-creation command once against your *production* database too
   (either via Render's shell, or by pointing your local `.env` at the same
   `DATABASE_URL` and running `npm run create-admin -- ...` from your machine).

## Step 5 — Point the website at this API

In the website's HTML file, find this line near the top of the `<script>`
block:

```js
var API_BASE_URL = ''; // e.g. 'https://rise-relief-api.onrender.com'
```

Set it to your deployed Render URL. The forms and the admin dashboard will
then talk to this real backend instead of browser storage.

## Security notes

- Passwords are hashed with bcrypt before storage — the real password is
  never saved anywhere, including in this codebase.
- Admin sessions are JWTs that expire after 2 hours and are verified on
  every protected request — the server never trusts the browser blindly.
- Basic rate-limiting is included on login endpoints to slow down
  brute-force attempts. For real production use, consider adding a proper
  rate-limiting/WAF layer (e.g. Cloudflare) in front of this API.
- Set `FRONTEND_ORIGIN` to your real domain (not `*`) once you're live, so
  only your website can call this API.
- Rotate `JWT_SECRET` and the admin password periodically.
