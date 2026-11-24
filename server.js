'use strict';
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool, types } = require('pg');
types.setTypeParser(1082, v => v); // keep DATE columns as 'YYYY-MM-DD' strings
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
// Admin credentials. CMA_ADMIN_TOKEN is a single token (actor "admin"). CMA_ADMIN_TOKENS lets each admin have
// their own token as "name:token,name2:token2" so the audit log records who did what.
const ADMIN_TOKENS = [];
if (process.env.CMA_ADMIN_TOKEN) ADMIN_TOKENS.push({ name: 'admin', token: process.env.CMA_ADMIN_TOKEN });
for (const part of String(process.env.CMA_ADMIN_TOKENS || '').split(',')) {
  const i = part.indexOf(':'); const name = part.slice(0, i).trim(); const token = part.slice(i + 1).trim();
  if (i > 0 && name && token.length >= 24) ADMIN_TOKENS.push({ name: name.slice(0, 60), token });
}
const ADMIN_TOKEN_AUTH = process.env.ADMIN_TOKEN_AUTH !== 'disabled'; // set to "disabled" once named admin accounts exist
const SUPPLIER_TIN = process.env.SUPPLIER_TIN || '';
const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED === 'true';
const BACHS_API_KEY = process.env.BACHS_API_KEY || '';
const BACHS_WEBHOOK_SECRET = process.env.BACHS_WEBHOOK_SECRET || '';
const BACHS_BASE = (process.env.BACHS_API_BASE || (BACHS_API_KEY.startsWith('sk_live_') ? 'https://api.bachs.io' : 'https://sandbox-api.bachs.io')).replace(/\/+$/, '');
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const SENDBYTE_API_KEY = process.env.SENDBYTE_API_KEY || '';
const SENDBYTE_BASE = (process.env.SENDBYTE_API_BASE || 'https://api.sendbyte.africa').replace(/\/+$/, '');
const MAIL_FROM = process.env.MAIL_FROM || '';
const EMAIL_ENABLED = !!(SENDBYTE_API_KEY && MAIL_FROM);
const REQUIRE_APPROVAL = process.env.REQUIRE_ACCOUNT_APPROVAL === 'true'; // true => new accounts start as pending_review
if (!DATABASE_URL) {
  console.error('DATABASE_URL is missing. Add a Railway PostgreSQL service and attach its DATABASE_URL variable.');
  process.exit(1);
}
// TLS to Postgres: off for local/private Railway hosts. Otherwise set DATABASE_SSL_CA (PEM) to fully verify the
// server certificate, or DATABASE_SSL_REJECT_UNAUTHORIZED=true if the server uses a publicly trusted certificate.
// Without either, the connection is encrypted but the certificate is not verified (previous behaviour).
function dbSsl() {
  if (/localhost|127\.0\.0\.1|\.railway\.internal/.test(DATABASE_URL)) return false;
  if (process.env.DATABASE_SSL_CA) return { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  return { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' };
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: dbSsl(),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on('error', err => console.error('Idle database client error:', err.message));

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], baseUri: ["'self'"], fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], scriptSrc: ["'self'"], scriptSrcAttr: ["'none'"], imgSrc: ["'self'", 'data:', 'blob:', 'https://i.ytimg.com'], frameSrc: ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"] } } }));
// rawBody is kept so payment-webhook signatures can be verified against the exact bytes received
// Small bodies everywhere; only the upload routes (base64 photos and ID documents) may be large.
const jsonVerify = (req, res, buf) => { req.rawBody = buf; };
const jsonSmall = express.json({ limit: '128kb', type: 'application/json', verify: jsonVerify });
const jsonLarge = express.json({ limit: '8mb', type: 'application/json', verify: jsonVerify });
app.use((req, res, next) => (/^\/api\/(profile\/ids|crew\/photo|crew\/listings\/\d+\/photo|crew\/listings\/\d+\/portfolio|professionals\/\d+\/photo)$/.test(req.path) ? jsonLarge : jsonSmall)(req, res, next));
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && req.get('origin')) {
    const origin = req.get('origin'); const host = req.get('host');
    if (!host || origin !== `${req.protocol}://${host}`) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  }
  next();
});
app.use((req, res, next) => { res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'); next(); });
app.use('/api/', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); // personal data is never cached by browsers or proxies
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 1500, standardHeaders: 'draft-7', legacyHeaders: false, skip: (req) => req.path.endsWith('/stream') })); // SSE reconnects must not eat the shared budget that login depends on
app.use(express.static(path.join(__dirname, 'dist'), { dotfiles: 'ignore', index: false }));

/* ---------------- helpers ---------------- */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const toInt = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const todayLagos = () => new Date(Date.now() + 3600000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
const refFor = id => 'BK-' + String(id).padStart(5, '0');
async function withTx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

/* ---------------- database ---------------- */
let SKILLS_IS_JSON = false; // legacy databases store professionals.skills as jsonb instead of text[]
async function initDb() {
  const client = await pool.connect();
  try {
    // Run statements one at a time; failures are retried after the whole pass (e.g. an index that
    // needs a column added by a later repair), and never abort startup or roll back other statements.
    const failed = [];
    const allSql = [];
    const runSql = async sql => {
      allSql.push(sql);
      for (const st of sql.split(';').map(x => x.trim()).filter(Boolean)) {
        try { await client.query(st); } catch (err) { failed.push([st, err]); }
      }
    };
    await runSql(`
      CREATE TABLE IF NOT EXISTS professionals (
        id SERIAL PRIMARY KEY,
        application_id VARCHAR(255) UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        job_title TEXT,
        category TEXT,
        location TEXT,
        bio TEXT,
        photo TEXT,
        showreel TEXT,
        skills TEXT[],
        kit TEXT[],
        languages TEXT[],
        rate NUMERIC,
        rate_half_day NUMERIC,
        rate_full_day NUMERIC,
        rate_overtime NUMERIC,
        rate_travel NUMERIC,
        rating NUMERIC DEFAULT 4.9,
        credits TEXT,
        "desc" TEXT,
        verified BOOLEAN DEFAULT FALSE,
        status VARCHAR(50) DEFAULT 'approved',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_professionals_application_id ON professionals(application_id);

      CREATE TABLE IF NOT EXISTS availability_blocks (
        id SERIAL PRIMARY KEY,
        professional_id INT REFERENCES professionals(id) ON DELETE CASCADE,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        reason TEXT DEFAULT 'booking',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        professional_id INT REFERENCES professionals(id),
        client_name TEXT NOT NULL,
        client_email TEXT,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        crew_response VARCHAR(50) DEFAULT 'pending',
        counter_details TEXT,
        agreed BOOLEAN DEFAULT FALSE,
        terms_version VARCHAR(50),
        payment_status VARCHAR(50) DEFAULT 'unpaid',
        payout_status VARCHAR(50) DEFAULT 'unpaid',
        project_brief TEXT,
        overtime_terms TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS team_bookings (
        id SERIAL PRIMARY KEY,
        project_title TEXT NOT NULL,
        client_name TEXT NOT NULL,
        client_email TEXT NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS team_booking_members (
        id SERIAL PRIMARY KEY,
        team_booking_id INT REFERENCES team_bookings(id) ON DELETE CASCADE,
        professional_id INT REFERENCES professionals(id),
        role TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'pending'
      );

      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        booking_id INT REFERENCES bookings(id),
        gateway VARCHAR(50) DEFAULT 'bachs',
        gateway_reference VARCHAR(255) UNIQUE,
        amount NUMERIC NOT NULL,
        currency VARCHAR(10) DEFAULT 'NGN',
        status VARCHAR(50) DEFAULT 'pending',
        raw_webhook JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        invoice_number VARCHAR(100) UNIQUE NOT NULL,
        booking_id INT REFERENCES bookings(id),
        client_name TEXT NOT NULL,
        subtotal NUMERIC NOT NULL,
        vat_rate NUMERIC DEFAULT 7.5,
        vat_amount NUMERIC NOT NULL,
        total_amount NUMERIC NOT NULL,
        supplier_tin TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS disputes (
        id SERIAL PRIMARY KEY,
        booking_id INT REFERENCES bookings(id),
        raised_by VARCHAR(50) NOT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'open',
        resolution TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS payouts (
        id SERIAL PRIMARY KEY,
        professional_id INT REFERENCES professionals(id),
        booking_id INT REFERENCES bookings(id),
        amount NUMERIC NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        payout_reference VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        booking_id INT REFERENCES bookings(id),
        professional_id INT REFERENCES professionals(id),
        reviewer_type VARCHAR(50) NOT NULL,
        reviewer_name TEXT NOT NULL,
        rating INT CHECK (rating >= 1 AND rating <= 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        booking_id INT REFERENCES bookings(id),
        sender_type VARCHAR(50) NOT NULL,
        sender_name TEXT NOT NULL,
        masked_content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await runSql(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        account_type VARCHAR(20) NOT NULL DEFAULT 'client',
        account_status VARCHAR(30) NOT NULL DEFAULT 'approved',
        terms_accepted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
      CREATE TABLE IF NOT EXISTS crew_applications (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        location TEXT,
        portfolio TEXT,
        bio TEXT,
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        target_user_id INT,
        target_name TEXT,
        target_email TEXT,
        details JSONB DEFAULT '{}'::jsonb,
        ip_address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Additive migrations (safe to run on every start, and on databases created by older versions)
    const migrations = `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'text';
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS offer JSONB;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS daily_rate NUMERIC;
      CREATE TABLE IF NOT EXISTS email_tokens (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind VARCHAR(20) NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS professional_photos (
        professional_id INT PRIMARY KEY REFERENCES professionals(id) ON DELETE CASCADE,
        mime TEXT NOT NULL,
        data BYTEA NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        totp_secret TEXT,
        totp_last_step BIGINT DEFAULT 0,
        recovery_hashes TEXT[] DEFAULT '{}',
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        admin_id INT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS admin_login_tickets (
        token_hash TEXT PRIMARY KEY,
        admin_id INT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        pending_secret TEXT,
        attempts INT NOT NULL DEFAULT 0,
        expires_at TIMESTAMP NOT NULL
      );
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_id VARCHAR(255);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS booking_ids INT[];
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_url TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(10);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS group_ref VARCHAR(20);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS quantity NUMERIC DEFAULT 1;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS schedule_kind VARCHAR(10) DEFAULT 'calendar';
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS rate_unit VARCHAR(10) DEFAULT 'day';
      UPDATE messages SET masked_content = regexp_replace(masked_content, ' · client total ₦[0-9,]+$', ' · rate per day shown in the offer') WHERE kind = 'system' AND masked_content LIKE '% · client total ₦%';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS group_title TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_status VARCHAR(20);
      ALTER TABLE professionals ALTER COLUMN rating DROP DEFAULT;
      UPDATE professionals SET rating = NULL WHERE rating = 4.9 AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.professional_id = professionals.id);
      ALTER TABLE bookings ALTER COLUMN project_location DROP NOT NULL;
      ALTER TABLE bookings ALTER COLUMN overtime_terms DROP NOT NULL;
      ALTER TABLE bookings ALTER COLUMN project_brief DROP NOT NULL;
      ALTER TABLE bookings ALTER COLUMN project_type DROP NOT NULL;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_user_id INT REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient_user_id INT REFERENCES users(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        message_popups BOOLEAN NOT NULL DEFAULT TRUE,
        email_notifications BOOLEAN NOT NULL DEFAULT TRUE,
        profile_visibility BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS id_documents (
        id BIGSERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        document_type VARCHAR(40) NOT NULL,
        original_name TEXT NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        encrypted_data BYTEA NOT NULL,
        encryption_iv BYTEA NOT NULL,
        encryption_tag BYTEA NOT NULL,
        review_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        review_note TEXT,
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, document_type)
      );
      CREATE INDEX IF NOT EXISTS idx_id_documents_review ON id_documents(review_status, created_at DESC);
      CREATE TABLE IF NOT EXISTS message_reads (
        message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(message_id, user_id)
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspicious BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_notes TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version VARCHAR(50);
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS professional_id INT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS user_id INT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reference TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS project_type TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_unit VARCHAR(10) DEFAULT 'full';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS project_location TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_total NUMERIC DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS crew_net NUMERIC DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS overtime_agreed BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_reference ON bookings(reference);
      CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
      DROP INDEX IF EXISTS idx_reviews_one_per_booking;
    `;
    // Repair databases created by older versions: CREATE TABLE IF NOT EXISTS never adds missing columns.
    const repairs = `
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS name TEXT;
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS full_name TEXT;
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS role TEXT;
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS location TEXT;
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS portfolio TEXT;
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS portfolio_url TEXT DEFAULT '';
      ALTER TABLE crew_applications ALTER COLUMN portfolio_url SET DEFAULT '';
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS bio TEXT;
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'pending';
      ALTER TABLE crew_applications ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) NOT NULL DEFAULT 'client';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(30) NOT NULL DEFAULT 'approved';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS application_id VARCHAR(255);
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS job_title TEXT;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS daily_rate BIGINT;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE professionals ALTER COLUMN active SET DEFAULT TRUE;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS category TEXT;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS location TEXT;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS bio TEXT;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS photo TEXT;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS showreel TEXT;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS skills TEXT[];
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS kit TEXT[];
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS languages TEXT[];
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS rate NUMERIC;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS rate_half_day NUMERIC;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS rate_full_day NUMERIC;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS rate_overtime NUMERIC;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS rate_travel NUMERIC;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS rating NUMERIC DEFAULT 4.9;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS credits TEXT;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS "desc" TEXT;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'approved';
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE professionals ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_email TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS crew_response VARCHAR(50) DEFAULT 'pending';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS counter_details TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS agreed BOOLEAN DEFAULT FALSE;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS terms_version VARCHAR(50);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'unpaid';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS project_brief TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS overtime_terms TEXT;
      ALTER TABLE availability_blocks ADD COLUMN IF NOT EXISTS professional_id INT REFERENCES professionals(id) ON DELETE CASCADE;
      ALTER TABLE availability_blocks ADD COLUMN IF NOT EXISTS start_date DATE;
      ALTER TABLE availability_blocks ADD COLUMN IF NOT EXISTS end_date DATE;
      ALTER TABLE availability_blocks ADD COLUMN IF NOT EXISTS reason TEXT DEFAULT 'booking';
      ALTER TABLE availability_blocks ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE team_bookings ADD COLUMN IF NOT EXISTS project_title TEXT;
      ALTER TABLE team_bookings ADD COLUMN IF NOT EXISTS client_name TEXT;
      ALTER TABLE team_bookings ADD COLUMN IF NOT EXISTS client_email TEXT;
      ALTER TABLE team_bookings ADD COLUMN IF NOT EXISTS start_date DATE;
      ALTER TABLE team_bookings ADD COLUMN IF NOT EXISTS end_date DATE;
      ALTER TABLE team_bookings ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
      ALTER TABLE team_bookings ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE team_booking_members ADD COLUMN IF NOT EXISTS team_booking_id INT REFERENCES team_bookings(id) ON DELETE CASCADE;
      ALTER TABLE team_booking_members ADD COLUMN IF NOT EXISTS professional_id INT REFERENCES professionals(id);
      ALTER TABLE team_booking_members ADD COLUMN IF NOT EXISTS role TEXT;
      ALTER TABLE team_booking_members ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS booking_id INT REFERENCES bookings(id);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway VARCHAR(50) DEFAULT 'bachs';
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_reference VARCHAR(255);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount NUMERIC;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'NGN';
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS raw_webhook JSONB;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(100);
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS booking_id INT REFERENCES bookings(id);
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_name TEXT;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal NUMERIC;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vat_rate NUMERIC DEFAULT 7.5;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vat_amount NUMERIC;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total_amount NUMERIC;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS supplier_tin TEXT;
      ALTER TABLE invoices ALTER COLUMN supplier_tin DROP DEFAULT;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS booking_id INT REFERENCES bookings(id);
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS raised_by VARCHAR(50);
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS reason TEXT;
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'open';
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS resolution TEXT;
      CREATE TABLE IF NOT EXISTS call_sheets (
        id SERIAL PRIMARY KEY, owner_id INT NOT NULL, token VARCHAR(24) UNIQUE NOT NULL, data JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS call_sheets_owner_idx ON call_sheets (owner_id);
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS subject_user_id INT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_booking_reviewer ON reviews (booking_id, reviewer_type);
      CREATE TABLE IF NOT EXISTS portfolio_items (
        id SERIAL PRIMARY KEY, professional_id INT NOT NULL, kind VARCHAR(10) NOT NULL, url TEXT, mime VARCHAR(40), data BYTEA,
        caption VARCHAR(140), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS portfolio_items_pro_idx ON portfolio_items (professional_id);
      CREATE TABLE IF NOT EXISTS job_posts (
        id SERIAL PRIMARY KEY, owner_id INT NOT NULL, title VARCHAR(140) NOT NULL, category VARCHAR(40) NOT NULL, role VARCHAR(80),
        description TEXT NOT NULL, location VARCHAR(120) NOT NULL, budget INT, start_date DATE NOT NULL, end_date DATE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'open', hired_booking_id INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS job_posts_status_idx ON job_posts (status, end_date);
      CREATE TABLE IF NOT EXISTS job_applications (
        id SERIAL PRIMARY KEY, job_id INT NOT NULL, user_id INT NOT NULL, professional_id INT NOT NULL, message TEXT, quote INT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE (job_id, professional_id)
      );
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS outcome VARCHAR(20);
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(80);
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE payouts ADD COLUMN IF NOT EXISTS professional_id INT REFERENCES professionals(id);
      ALTER TABLE payouts ADD COLUMN IF NOT EXISTS booking_id INT REFERENCES bookings(id);
      ALTER TABLE payouts ADD COLUMN IF NOT EXISTS amount NUMERIC;
      ALTER TABLE payouts ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
      ALTER TABLE payouts ADD COLUMN IF NOT EXISTS payout_reference VARCHAR(255);
      ALTER TABLE payouts ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS booking_id INT REFERENCES bookings(id);
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS professional_id INT REFERENCES professionals(id);
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewer_type VARCHAR(50);
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewer_name TEXT;
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rating INT;
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS comment TEXT;
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS booking_id INT REFERENCES bookings(id);
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_type VARCHAR(50);
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS masked_content TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_hash TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS action TEXT;
      ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS actor VARCHAR(120) NOT NULL DEFAULT 'admin';
      ALTER TABLE admin_audit_log ALTER COLUMN actor SET DEFAULT 'admin';
      ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS target_user_id BIGINT;
      ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS target_name TEXT;
      ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS target_email TEXT;
      ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS ip_address TEXT;
      ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS professional_id INT REFERENCES professionals(id);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payout_status VARCHAR(50) DEFAULT 'unpaid';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_reference ON payments(gateway_reference);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_professionals_application_id ON professionals(application_id);
    `;
    await runSql(repairs);
    await runSql(migrations);
    // Existing production tables may already have these columns without defaults.
    // The current application intentionally omits them from inserts, so enforce safe defaults.
    await runSql(`
      ALTER TABLE users ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE users ALTER COLUMN is_verified SET DEFAULT FALSE;
      ALTER TABLE users ALTER COLUMN is_suspicious SET DEFAULT FALSE;
      ALTER TABLE users ALTER COLUMN is_suspended SET DEFAULT FALSE;
      ALTER TABLE sessions ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE crew_applications ALTER COLUMN status SET DEFAULT 'pending';
      ALTER TABLE crew_applications ALTER COLUMN portfolio_url SET DEFAULT '';
      ALTER TABLE crew_applications ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE professionals ALTER COLUMN active SET DEFAULT TRUE;
      ALTER TABLE professionals ALTER COLUMN is_active SET DEFAULT TRUE;
      ALTER TABLE professionals ALTER COLUMN verified SET DEFAULT FALSE;
      ALTER TABLE professionals ALTER COLUMN status SET DEFAULT 'approved';
      ALTER TABLE professionals ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'pending';
      ALTER TABLE bookings ALTER COLUMN payment_status SET DEFAULT 'unpaid';
      ALTER TABLE bookings ALTER COLUMN payout_status SET DEFAULT 'unpaid';
      ALTER TABLE bookings ALTER COLUMN overtime_agreed SET DEFAULT FALSE;
      ALTER TABLE bookings ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE messages ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE admin_audit_log ALTER COLUMN actor SET DEFAULT 'admin';
      ALTER TABLE admin_audit_log ALTER COLUMN details SET DEFAULT '{}'::jsonb;
      ALTER TABLE admin_audit_log ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE user_settings ALTER COLUMN message_popups SET DEFAULT TRUE;
      ALTER TABLE user_settings ALTER COLUMN email_notifications SET DEFAULT TRUE;
      ALTER TABLE user_settings ALTER COLUMN profile_visibility SET DEFAULT TRUE;
      ALTER TABLE user_settings ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE id_documents ALTER COLUMN review_status SET DEFAULT 'pending';
      ALTER TABLE id_documents ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE id_documents ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE message_reads ALTER COLUMN read_at SET DEFAULT CURRENT_TIMESTAMP;
    `);
    for (const [st, firstErr] of failed) {
      try { await client.query(st); }
      catch (err) { console.warn('Migration note (non-fatal):', err.message, '::', st.replace(/\s+/g, ' ').slice(0, 80)); }
    }

    // Older databases store professionals.application_id as a number; the app uses text ids like 'app-6'.
    try {
      // Older databases restrict booking_unit to full/half; allow the hourly and project units too.
      const { rows: bu } = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'bookings'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%booking_unit%'`);
      for (const c of bu) await client.query(`ALTER TABLE bookings DROP CONSTRAINT "${String(c.conname).replace(/"/g, '')}"`);
      await client.query(`ALTER TABLE bookings ADD CONSTRAINT bookings_booking_unit_check CHECK (booking_unit IN ('full','half','hour','project'))`).catch(e => { if (e.code !== '42710') throw e; });
      const { rows: ty } = await client.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='professionals' AND column_name='application_id'`);
      if (ty[0] && !['character varying', 'text'].includes(ty[0].data_type)) {
        await client.query(`ALTER TABLE professionals ALTER COLUMN application_id TYPE VARCHAR(255) USING application_id::text`);
        console.log('Converted professionals.application_id to VARCHAR(255)');
      }
      const { rows: sk } = await client.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='professionals' AND column_name='skills'`);
      SKILLS_IS_JSON = !!sk[0] && sk[0].data_type === 'jsonb';
    } catch (err) { console.warn('Column type fix note (non-fatal):', err.message); }

    // Some legacy tables have an `id` column with no default and no identity, so every INSERT gets id = NULL.
    try {
      const { rows: noId } = await client.query(`SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'id' AND column_default IS NULL AND is_identity = 'NO'
        AND table_name = ANY($1)`, [['professionals', 'bookings', 'users', 'sessions', 'crew_applications', 'admin_audit_log', 'availability_blocks',
          'team_bookings', 'team_booking_members', 'payments', 'invoices', 'disputes', 'payouts', 'reviews', 'messages']]);
      for (const { table_name: t } of noId) {
        await client.query(`CREATE SEQUENCE IF NOT EXISTS "${t}_id_seq" OWNED BY "${t}".id`);
        await client.query(`SELECT setval('"${t}_id_seq"', COALESCE((SELECT MAX(id) FROM "${t}"), 0) + 1, false)`);
        await client.query(`ALTER TABLE "${t}" ALTER COLUMN id SET DEFAULT nextval('"${t}_id_seq"')`);
        console.log(`Added id default to ${t}`);
      }
    } catch (err) { console.warn('id default fix note (non-fatal):', err.message); }

    // Older databases may carry extra NOT NULL columns the app never fills (e.g. crew_applications.full_name),
    // which makes every INSERT fail. Relax them, and align legacy values with what the app queries.
    try {
      const known = {};
      const text = allSql.join('\n');
      for (const [, t, c] of text.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS "?(\w+)"?/g)) (known[t] ||= new Set(['id'])).add(c);
      for (const [, t, body] of text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n      \);/g)) {
        const set = (known[t] ||= new Set(['id']));
        for (const line of body.split('\n')) { const c = line.trim().match(/^"?(\w+)"?\s/); if (c && !/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)$/i.test(c[1])) set.add(c[1]); }
      }
      const { rows: legacy } = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND is_nullable = 'NO' AND column_default IS NULL AND is_identity = 'NO' AND table_name = ANY($1)`, [Object.keys(known)]);
      for (const { table_name: t, column_name: c } of legacy) {
        if (known[t].has(c)) continue;
        await client.query(`ALTER TABLE "${t}" ALTER COLUMN "${c}" DROP NOT NULL`);
        console.log(`Relaxed legacy NOT NULL on ${t}.${c}`);
      }
      const { rows: fn } = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='crew_applications' AND column_name='full_name'`);
      if (fn.length) await client.query(`UPDATE crew_applications SET name = full_name WHERE name IS NULL`);
      await client.query(`ALTER TABLE crew_applications ALTER COLUMN status SET DEFAULT 'pending'`);
      await client.query(`UPDATE crew_applications SET status = 'pending' WHERE status = 'pending_review'`);
    } catch (err) { console.warn('Legacy column cleanup note (non-fatal):', err.message); }

    // One-time schema report in the logs, to debug databases created by older versions.
    try {
      const { rows: cols } = await client.query(`SELECT table_name, string_agg(column_name || ':' || data_type || CASE WHEN is_nullable = 'NO' THEN '!' ELSE '' END, ', ' ORDER BY ordinal_position) AS cols
        FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name ORDER BY table_name`);
      for (const r of cols) console.log(`Schema ${r.table_name}: ${r.cols}`);
      const { rows: cons } = await client.query(`SELECT conrelid::regclass AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype IN ('c', 'f', 'u')`);
      for (const r of cons) console.log(`Constraint ${r.t} ${r.conname}: ${r.def}`);
    } catch (err) { console.warn('Schema report failed:', err.message); }

    // One-time cleanup: the six fictional professionals the old startup seed inserted. Matched by exact name and no
    // application_id, so real profiles (which always have an application_id) are never touched. Rows that bookings
    // still reference are deactivated instead of deleted.
    try {
      const demo = ['Tobi Adebayo', 'Amaka Okorie', 'Daniel Eze', 'Mariam Bello', 'Chuka Nwosu', 'Zainab Yusuf'];
      const { rows: found } = await client.query(`SELECT id, name FROM professionals WHERE name = ANY($1) AND application_id IS NULL`, [demo]);
      for (const { id, name } of found) {
        try {
          await client.query('DELETE FROM professionals WHERE id = $1', [id]);
          console.log(`Removed demo professional ${id} (${name})`);
        } catch (err) {
          if (err.code !== '23503') throw err;
          await client.query(`UPDATE professionals SET status = 'inactive', is_active = FALSE WHERE id = $1`, [id]);
          console.log(`Deactivated demo professional ${id} (${name}); it has bookings`);
        }
      }
    } catch (err) { console.warn('Demo cleanup note (non-fatal):', err.message); }

    // One-time backfill. Ownership used to fall back to matching e-mail addresses on rows without a user_id, which
    // let anyone who registered with someone else's (unverified) address inherit their bookings and crew profile.
    // Ownership is now by user_id only, so link legacy rows once, here, and never again.
    try {
      // runSql splits on ';', so anything with a procedural body (DO blocks) is done here instead.
      const hasVerified = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='email_verified'`);
      if (!hasVerified.rowCount) {
        await client.query('ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT TRUE'); // existing accounts are grandfathered in
        await client.query('ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT FALSE');
      }
      await client.query(`CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
      const done = await client.query(`SELECT 1 FROM app_migrations WHERE name = 'link-legacy-rows-by-email'`);
      if (!done.rowCount) {
        await client.query('BEGIN');
        const a = await client.query(`UPDATE crew_applications ca SET user_id = u.id FROM users u WHERE ca.user_id IS NULL AND LOWER(u.email) = LOWER(ca.email)`);
        const b = await client.query(`UPDATE bookings b SET user_id = u.id FROM users u WHERE b.user_id IS NULL AND LOWER(u.email) = LOWER(b.client_email)`);
        await client.query(`INSERT INTO app_migrations (name) VALUES ('link-legacy-rows-by-email')`);
        await client.query('COMMIT');
        console.log(`Linked legacy rows to accounts: ${a.rowCount} crew applications, ${b.rowCount} bookings`);
      }
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.warn('Legacy link note (non-fatal):', err.message); }

    await client.query(`DELETE FROM sessions WHERE expires_at < NOW()`);
  } finally {
    client.release();
  }
}

/* ---------------- authentication ---------------- */
const SESSION_COOKIE = 'cma_session';
const SESSION_DAYS = 7;
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const DUMMY_HASH = bcrypt.hashSync('dummy-password-1', 10);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true, message: { error: 'Too many attempts. Try again in a few minutes.' } });

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) { /* ignore bad cookie */ } }
  });
  return out;
}
function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_DAYS * 86400000, path: '/' });
}
const PHONE_RE = /^\+?[0-9][0-9\s\-().]{6,22}[0-9]$/;
const nameOk = n => String(n || '').trim().length >= 3 && String(n).trim().split(/\s+/).length >= 2;
const profileComplete = u => nameOk(u.name) && PHONE_RE.test(String(u.phone || '')) && String(u.location || '').trim().length >= 2;
const publicUser = u => ({
  profileComplete: profileComplete(u),
  id: u.id, name: u.name, email: u.email,
  phone: u.phone || '', location: u.location || '', bio: u.bio || '',
  accountType: u.account_type, accountStatus: u.account_status, isVerified: !!u.is_verified,
  emailVerified: u.email_verified !== false, emailEnabled: EMAIL_ENABLED
});

async function loadUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW()`, [sha256(token)]);
  const u = rows[0];
  if (!u || u.is_suspended || u.account_status === 'rejected') return null;
  return u;
}
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${SESSION_DAYS} days')`, [userId, sha256(token)]);
  setSessionCookie(res, token);
}
/* ---------------- email (SendByte) ---------------- */
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function emailLayout(title, lines, cta) {
  const body = lines.map(l => `<p style="margin:0 0 14px;line-height:1.55">${esc(l)}</p>`).join('');
  const btn = cta ? `<p style="margin:22px 0"><a href="${esc(cta.url)}" style="background:#12372a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">${esc(cta.label)}</a></p><p style="font-size:12px;color:#667085;word-break:break-all">If the button does not work, copy this link: ${esc(cta.url)}</p>` : '';
  return { html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#1d2939;max-width:520px;margin:auto;padding:24px"><h2 style="margin:0 0 16px;font-size:20px">${esc(title)}</h2>${body}${btn}<hr style="border:0;border-top:1px solid #e4e7ec;margin:24px 0 12px"><p style="font-size:12px;color:#98a2b3">Crew Management. You get this because of your account activity. Message alerts can be switched off in your profile settings.</p></div>`,
    text: title + '\n\n' + lines.join('\n\n') + (cta ? '\n\n' + cta.label + ': ' + cta.url : '') };
}
// Fire-and-forget: an email problem must never break the action that triggered it.
async function sendEmail(to, subject, lines, cta, idemKey) {
  if (!EMAIL_ENABLED || !to) return false;
  const { html, text } = emailLayout(subject, lines, cta);
  try {
    const res = await fetch(SENDBYTE_BASE + '/v1/emails', {
      method: 'POST',
      headers: Object.assign({ Authorization: 'Bearer ' + SENDBYTE_API_KEY, 'Content-Type': 'application/json' }, idemKey ? { 'Idempotency-Key': idemKey } : {}),
      body: JSON.stringify({ from: MAIL_FROM, to, subject, html, text }), signal: AbortSignal.timeout(10000) });
    if (!res.ok) { console.warn('SendByte', res.status, (await res.text()).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.warn('SendByte unreachable:', e.message); return false; }
}
// Booking and message emails honour the user's "email notifications" setting. Account emails (reset, verify) do not.
async function emailUsers(userIds, subject, lines, path, key) {
  if (!EMAIL_ENABLED) return;
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return;
  try {
    const { rows } = await pool.query(`SELECT u.id,u.name,u.email FROM users u LEFT JOIN user_settings us ON us.user_id = u.id WHERE u.id = ANY($1::int[]) AND NOT u.is_suspended AND COALESCE(us.email_notifications, TRUE)`, [ids]);
    for (const u of rows) await sendEmail(u.email, subject, ['Hi ' + String(u.name).split(' ')[0] + ','].concat(lines), { label: 'Open Crew Management', url: appBase() + (path || '/') }, key ? key + '-' + u.id : undefined);
  } catch (e) { console.warn('emailUsers:', e.message); }
}
const appBase = () => APP_URL || 'http://localhost:' + PORT;
// Never build links from an attacker-controlled Host header: use APP_URL, or a strictly validated host outside production.
function baseUrl(req) {
  if (APP_URL) return APP_URL;
  const host = String(req.get('host') || '');
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? req.protocol + '://' + host : appBase();
}
if (process.env.NODE_ENV === 'production' && !APP_URL) console.warn('SECURITY: APP_URL is not set. Set it to your public https address so email and payment links cannot be spoofed.');
const chatEmailLast = new Map(); // booking:user -> timestamp, so a busy chat does not flood an inbox
async function emailNewMessage(recipientId, b, senderName, preview) {
  if (!EMAIL_ENABLED || !recipientId) return;
  if ((messageNotificationSubs.get(Number(recipientId)) || new Set()).size) return; // already live in the app
  const k = b.id + ':' + recipientId, now = Date.now();
  if (now - (chatEmailLast.get(k) || 0) < 15 * 60 * 1000) return;
  chatEmailLast.set(k, now);
  await emailUsers([recipientId], 'New message from ' + senderName, [String(preview || '').slice(0, 300)], '/?inbox=' + b.id);
}
async function issueEmailToken(db, userId, kind, hours) {
  await db.query(`DELETE FROM email_tokens WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`, [userId, kind]);
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(`INSERT INTO email_tokens (user_id, kind, token_hash, expires_at) VALUES ($1,$2,$3, NOW() + ($4 || ' hours')::interval)`, [userId, kind, sha256(token), String(hours)]);
  return token;
}
async function sendVerifyEmail(user) {
  const token = await issueEmailToken(pool, user.id, 'verify', 48);
  return sendEmail(user.email, 'Confirm your email address', ['Hi ' + String(user.name).split(' ')[0] + ',', 'Please confirm your email address so you can book crew or accept bookings.'], { label: 'Confirm my email', url: appBase() + '/?verify=' + token });
}
function checkPassword(password) {
  if (password.length < 10 || password.length > 200 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) fail(400, 'Password must be at least 10 characters and include a letter and a number.');
}
const requireVerifiedEmail = (req, res, next) => {
  if (EMAIL_ENABLED && req.user.email_verified === false) return res.status(403).json({ error: 'Please confirm your email address first. We sent you a link; you can request another from your profile.', code: 'email_unverified' });
  next();
};
const requireUser = wrap(async (req, res, next) => {
  const u = await loadUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in to continue.' });
  req.user = u; next();
});
const requireApproved = (req, res, next) => {
  if (req.user.account_status !== 'approved') return res.status(403).json({ error: 'Your account is awaiting administrator approval.' });
  next();
};

/* ---------------- profile, preferences and private identity documents ---------------- */
const ID_TYPES = ['national_id', 'passport', 'drivers_license', 'voters_card', 'other'];
function identityKey() {
  const raw = String(process.env.ID_ENCRYPTION_KEY || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(raw)) fail(503, 'Identity uploads are not configured. Please contact support.');
  return Buffer.from(raw, 'hex');
}
function encryptIdentity(bytes) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', identityKey(), iv);
  return { data: Buffer.concat([cipher.update(bytes), cipher.final()]), iv, tag: cipher.getAuthTag() };
}
function decryptIdentity(row) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', identityKey(), row.encryption_iv);
  decipher.setAuthTag(row.encryption_tag);
  return Buffer.concat([decipher.update(row.encrypted_data), decipher.final()]);
}
async function syncIdentityVerification(db,userId,verified) {
  await db.query('UPDATE users SET is_verified=$1 WHERE id=$2',[verified,userId]);
  await db.query(
    "UPDATE professionals p SET verified=$1 FROM crew_applications ca JOIN users u ON u.id=$2 " +
    "WHERE (ca.professional_id=p.id OR p.application_id='app-' || ca.id::text) " +
    "AND ca.user_id=$2",
    [verified,userId]);
}
const safeIdFilename = name => String(name || 'identity-document').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'identity-document';
function validIdentityFile(type, bytes) {
  if (type === 'application/pdf') return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  return false;
}
app.get('/api/profile', requireUser, wrap(async (req, res) => {
  await pool.query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [req.user.id]);
  const u = (await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id])).rows[0];
  const settings = (await pool.query('SELECT message_popups,email_notifications,profile_visibility FROM user_settings WHERE user_id=$1', [req.user.id])).rows[0];
  const documents = (await pool.query('SELECT id,document_type,original_name,mime_type,review_status,review_note,created_at FROM id_documents WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id])).rows;
  res.json({ user: publicUser(u), settings, documents });
}));
app.patch('/api/profile', requireUser, wrap(async (req, res) => {
  const name = str(req.body.name,120), phone = str(req.body.phone,40), location = str(req.body.location,120), bio = str(req.body.bio,1000);
  if (!nameOk(name)) fail(400, 'Please enter your full name as it appears on your government ID (first and last name).');
  if (!PHONE_RE.test(phone)) fail(400, 'Please enter a valid phone number, for example +234 801 234 5678.');
  if (location.length < 2) fail(400, 'Please enter your location, for example Lagos.');
  const rows = await withTx(async db => {
    const updated = await db.query('UPDATE users SET name=$1,phone=$2,location=$3,bio=$4 WHERE id=$5 RETURNING *',
      [name, phone || null, location || null, bio || null, req.user.id]);
    // Keep the public crew listing in sync with the account owner’s editable profile.
    const applications = await db.query(
      'UPDATE crew_applications SET name=$1::text, full_name=$1::text, email=$2::text, location=$3::text, bio=$4::text WHERE user_id=$5 RETURNING id, professional_id',
      [name, updated.rows[0].email, location || '', bio || '', req.user.id]);
    for (const application of applications.rows) {
      await db.query(
        "UPDATE professionals SET name=$1::text, location=$2::text, bio=$3::text, \"desc\"=$4::text, description=$3::text WHERE id=$5 OR application_id=$6::text",
        [name, location || '', bio || '', (bio || '').slice(0,200), application.professional_id, 'app-' + application.id]);
    }
    return updated.rows;
  });
  res.json({ success:true, user:publicUser(rows[0]) });
}));
app.patch('/api/profile/settings', requireUser, wrap(async (req, res) => {
  await pool.query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [req.user.id]);
  const current=(await pool.query('SELECT * FROM user_settings WHERE user_id=$1',[req.user.id])).rows[0];
  const next={
    message_popups:typeof req.body.message_popups==='boolean'?req.body.message_popups:current.message_popups,
    email_notifications:typeof req.body.email_notifications==='boolean'?req.body.email_notifications:current.email_notifications,
    profile_visibility:typeof req.body.profile_visibility==='boolean'?req.body.profile_visibility:current.profile_visibility
  };
  const {rows}=await pool.query('UPDATE user_settings SET message_popups=$1,email_notifications=$2,profile_visibility=$3,updated_at=NOW() WHERE user_id=$4 RETURNING message_popups,email_notifications,profile_visibility',
    [next.message_popups,next.email_notifications,next.profile_visibility,req.user.id]);
  res.json({success:true,settings:rows[0]});
}));
app.post('/api/profile/ids', requireUser, wrap(async (req,res)=>{
  const docType=str(req.body.document_type,40), mime=str(req.body.mime_type,100).toLowerCase();
  const filename=safeIdFilename(req.body.filename), base64=String(req.body.data_base64||'');
  if(!ID_TYPES.includes(docType)) fail(400,'Choose a supported identity document type.');
  if(!['application/pdf','image/jpeg','image/png'].includes(mime)) fail(400,'Upload a PDF, JPG or PNG file.');
  if(!base64 || base64.length>7*1024*1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail(400,'The file is empty, invalid or larger than 5 MB.');
  const bytes=Buffer.from(base64,'base64');
  if(!bytes.length || bytes.length>5*1024*1024 || bytes.toString('base64').replace(/=+$/,'')!==base64.replace(/=+$/,'')) fail(400,'The file is invalid or larger than 5 MB.');
  if(!validIdentityFile(mime,bytes)) fail(400,'The file contents do not match the selected PDF, JPG or PNG format.');
  const encrypted=encryptIdentity(bytes);
  const {rows}=await pool.query(
    "INSERT INTO id_documents (user_id,document_type,original_name,mime_type,encrypted_data,encryption_iv,encryption_tag,review_status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') " +
    "ON CONFLICT (user_id,document_type) DO UPDATE SET original_name=EXCLUDED.original_name,mime_type=EXCLUDED.mime_type,encrypted_data=EXCLUDED.encrypted_data,encryption_iv=EXCLUDED.encryption_iv,encryption_tag=EXCLUDED.encryption_tag,review_status='pending',review_note=NULL,reviewed_at=NULL,updated_at=NOW() " +
    "RETURNING id,document_type,original_name,mime_type,review_status,review_note,created_at",
    [req.user.id,docType,filename,mime,encrypted.data,encrypted.iv,encrypted.tag]);
  const stillVerified=await pool.query("SELECT 1 FROM id_documents WHERE user_id=$1 AND review_status='approved' LIMIT 1",[req.user.id]);
  await syncIdentityVerification(pool,req.user.id,!!stillVerified.rowCount);
  res.status(201).json({success:true,document:rows[0]});
}));
app.delete('/api/profile/ids/:id', requireUser, wrap(async(req,res)=>{
  const id=toInt(req.params.id); if(!id) fail(400,'Invalid document id.');
  const deleted=await pool.query('DELETE FROM id_documents WHERE id=$1 AND user_id=$2 RETURNING id',[id,req.user.id]);
  if(!deleted.rowCount) fail(404,'Document not found.');
  const approved=await pool.query("SELECT 1 FROM id_documents WHERE user_id=$1 AND review_status='approved' LIMIT 1",[req.user.id]);
  await syncIdentityVerification(pool,req.user.id,!!approved.rowCount);
  res.json({success:true});
}));


app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const name = str(req.body.name, 120);
  const email = str(req.body.email, 254).toLowerCase();
  const password = String(req.body.password || '');
  const accountType = req.body.accountType === 'crew' ? 'crew' : 'client';
  const phone = str(req.body.phone, 30), location = str(req.body.location, 120);
  if (name.length < 3 || name.split(/\s+/).filter(Boolean).length < 2) fail(400, 'Please enter your full name as it appears on your government ID (first and last name).');
  if (!/^\+?[0-9][0-9\s\-().]{6,22}[0-9]$/.test(phone)) fail(400, 'Please enter a valid phone number, for example +234 801 234 5678.');
  if (location.length < 2) fail(400, 'Please enter your location, for example Lagos.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email address.');
  checkPassword(password);
  if (!req.body.termsAccepted) fail(400, 'You must accept the terms to create an account.');
  const hash = await bcrypt.hash(password, 12);
  let user;
  try {
    const r = await pool.query(
      `INSERT INTO users (name, email, password_hash, account_type, account_status, terms_accepted_at, terms_version, phone, location) VALUES ($1,$2,$3,$4,$5,NOW(),'v1',$6,$7) RETURNING *`,
      [name, email, hash, accountType, REQUIRE_APPROVAL ? 'pending_review' : 'approved', phone, location]);
    user = r.rows[0];
  } catch (e) {
    if (e.code === '23505') fail(409, 'An account with this email already exists. Try logging in.');
    throw e;
  }
  await startSession(res, user.id);
  if (EMAIL_ENABLED) sendVerifyEmail(user).catch(() => {});
  res.status(201).json({ success: true, user: publicUser(user) });
}));

// Per-account throttle on top of the per-IP limiter, so one account cannot be guessed at from many addresses.
const loginFails = new Map();
const LOGIN_MAX = 8, LOGIN_WINDOW = 15 * 60 * 1000;
function loginBlocked(email) { const f = loginFails.get(email); if (!f) return false; if (f.until < Date.now()) { loginFails.delete(email); return false; } return f.n >= LOGIN_MAX; }
function loginFailed(email) { const f = loginFails.get(email); if (!f || f.until < Date.now()) loginFails.set(email, { n: 1, until: Date.now() + LOGIN_WINDOW }); else f.n++; if (loginFails.size > 50000) loginFails.clear(); }
app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  if (loginBlocked(email)) fail(429, 'Too many failed attempts for this account. Wait 15 minutes or reset your password.');
  const password = String(req.body.password || '').slice(0, 200);
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const u = rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) { loginFailed(email); fail(401, 'Incorrect email or password.'); }
  loginFails.delete(email);
  if (u.is_suspended || u.account_status === 'rejected') fail(403, 'This account is not active. Please contact support.');
  await startSession(res, u.id);
  res.json({ success: true, user: publicUser(u) });
}));

app.get('/api/auth/me', wrap(async (req, res) => {
  const u = await loadUser(req);
  res.json({ user: u ? publicUser(u) : null });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ success: true });
}));

const accountMailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Try again in a few minutes.' } });
app.post('/api/auth/forgot', accountMailLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  const u = (await pool.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];
  // Same answer whether or not the account exists, so this cannot be used to discover who has one.
  if (u && !u.is_suspended && EMAIL_ENABLED) {
    const token = await issueEmailToken(pool, u.id, 'reset', 1);
    sendEmail(u.email, 'Reset your password', ['Hi ' + String(u.name).split(' ')[0] + ',', 'Use the button below to choose a new password. The link works once and expires in 1 hour. If you did not ask for this, ignore this email; your password has not changed.'], { label: 'Choose a new password', url: appBase() + '/?reset=' + token }).catch(() => {});
  }
  res.json({ success: true, message: 'If that email has an account, a reset link is on its way.' });
}));
app.post('/api/auth/reset', authLimiter, wrap(async (req, res) => {
  const token = String(req.body.token || ''); const password = String(req.body.password || '');
  checkPassword(password);
  const hash = await bcrypt.hash(password, 12);
  await withTx(async db => {
    const t = (await db.query(`SELECT * FROM email_tokens WHERE token_hash = $1 AND kind = 'reset' AND used_at IS NULL AND expires_at > NOW() FOR UPDATE`, [sha256(token)])).rows[0];
    if (!t) fail(400, 'This reset link is invalid or has expired. Please request a new one.');
    await db.query('UPDATE email_tokens SET used_at = NOW() WHERE id = $1', [t.id]);
    await db.query('UPDATE users SET password_hash = $1, email_verified = TRUE WHERE id = $2', [hash, t.user_id]); // clicking the emailed link proves the inbox
    await db.query('DELETE FROM sessions WHERE user_id = $1', [t.user_id]); // sign out everywhere
  });
  res.json({ success: true });
}));
app.post('/api/auth/change-password', requireUser, authLimiter, wrap(async (req, res) => {
  const current = String(req.body.current || '').slice(0, 200), password = String(req.body.password || '');
  if (!(await bcrypt.compare(current, req.user.password_hash))) fail(403, 'Your current password is not correct.');
  checkPassword(password);
  if (password === current) fail(400, 'Choose a password you have not used just now.');
  const hash = await bcrypt.hash(password, 12);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, sha256(parseCookies(req)[SESSION_COOKIE] || '')]);
  sendEmail(req.user.email, 'Your password was changed', ['Your Crew Management password was just changed. If this was not you, reset your password straight away and contact support.']).catch(() => {});
  res.json({ success: true });
}));
app.post('/api/auth/verify-email', authLimiter, wrap(async (req, res) => {
  const token = String(req.body.token || '');
  const t = (await pool.query(`UPDATE email_tokens SET used_at = NOW() WHERE token_hash = $1 AND kind = 'verify' AND used_at IS NULL AND expires_at > NOW() RETURNING user_id`, [sha256(token)])).rows[0];
  if (!t) fail(400, 'This confirmation link is invalid or has expired. Sign in and ask for a new one.');
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [t.user_id]);
  res.json({ success: true });
}));
app.post('/api/auth/resend-verification', requireUser, accountMailLimiter, wrap(async (req, res) => {
  if (!EMAIL_ENABLED) fail(503, 'Email is not set up yet.');
  if (req.user.email_verified !== false) return res.json({ success: true, already: true });
  await sendVerifyEmail(req.user);
  res.json({ success: true });
}));
// Deleting an account anonymises it (bookings and invoices must stay for the other party and for tax records).
app.post('/api/account/delete', requireUser, authLimiter, wrap(async (req, res) => {
  const password = String(req.body.password || '').slice(0, 200);
  if (!(await bcrypt.compare(password, req.user.password_hash))) fail(403, 'Your password is not correct.');
  await withTx(async db => {
    const profileIds = await crewProfessionalIds(db, req.user);
    const open = await db.query(
      `SELECT COUNT(*)::int AS n FROM bookings WHERE status = ANY($1::text[]) AND (user_id = $2 OR professional_id = ANY($3::int[]))`,
      [BLOCKING_STATUSES.filter(x => x !== 'completed'), req.user.id, profileIds]);
    if (open.rows[0].n) fail(409, 'You have confirmed or active bookings. Finish or cancel them first, then you can delete your account.');
    // pending requests on either side are withdrawn / declined
    await db.query(`UPDATE bookings SET status = 'cancelled', cancelled_by = $3, cancel_reason = 'Account closed' WHERE status IN ('awaiting_review','pending','counter_pending') AND (user_id = $1 OR professional_id = ANY($2::int[]))`, [req.user.id, profileIds, req.user.account_type === 'crew' ? 'crew' : 'client']);
    if (profileIds.length) await db.query('UPDATE professionals SET is_active = FALSE WHERE id = ANY($1::int[])', [profileIds]);
    await db.query('DELETE FROM id_documents WHERE user_id = $1', [req.user.id]);
    await db.query('DELETE FROM user_settings WHERE user_id = $1', [req.user.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
    await db.query('DELETE FROM email_tokens WHERE user_id = $1', [req.user.id]);
    await db.query(`UPDATE crew_applications SET name = 'Deleted user', full_name = 'Deleted user', email = NULL, bio = NULL WHERE user_id = $1`, [req.user.id]);
    await db.query('DELETE FROM call_sheets WHERE owner_id = $1', [req.user.id]);
    await db.query('DELETE FROM job_applications WHERE user_id = $1 OR job_id IN (SELECT id FROM job_posts WHERE owner_id = $1)', [req.user.id]);
    await db.query('DELETE FROM job_posts WHERE owner_id = $1', [req.user.id]);
    await db.query(`UPDATE users SET name = 'Deleted user', email = $2, password_hash = $3, phone = NULL, location = NULL, bio = NULL, is_suspended = TRUE, email_verified = FALSE WHERE id = $1`,
      [req.user.id, 'deleted-' + req.user.id + '@deleted.invalid', await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10)]);
  });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ success: true });
}));

// One login, two modes (like Airbnb's guest/host switch). The mode is remembered on the account.
app.post('/api/auth/switch-mode', requireUser, wrap(async (req, res) => {
  const mode = req.body.mode;
  if (!['client', 'crew'].includes(mode)) fail(400, 'Mode must be client or crew.');
  const { rows } = await pool.query('UPDATE users SET account_type = $1 WHERE id = $2 RETURNING *', [mode, req.user.id]);
  res.json({ success: true, user: publicUser(rows[0]) });
}));

// Crew workspace: show requests for every professional profile owned by this account.
/* ---------------- admin guard ---------------- */
const adminFailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true, requestWasSuccessful: (req, res) => res.statusCode !== 401, message: { error: 'Too many failed attempts. Try again later.' } });
/* ---- TOTP (RFC 6238: SHA-1, 30 s, 6 digits) ---- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = '', out = ''; for (const x of buf) bits += x.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
function b32dec(str) { let bits = ''; for (const c of String(str).replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) throw new Error('bad base32'); bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function hotp(secret, counter) { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter)); const h = crypto.createHmac('sha1', secret).update(c).digest(); const o = h[19] & 15; return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0'); }
// Returns the matched time step (so a code cannot be replayed) or null.
function totpMatch(secretB32, code, lastStep) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const secret = b32dec(secretB32), now = Math.floor(Date.now() / 30000); let hit = null;
  for (const d of [-1, 0, 1]) { const st = now + d; if (st > Number(lastStep || 0) && crypto.timingSafeEqual(Buffer.from(hotp(secret, st)), Buffer.from(String(code)))) hit = st; }
  return hit;
}
function totpKey() {
  const raw = String(process.env.ADMIN_2FA_KEY || process.env.ID_ENCRYPTION_KEY || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(raw)) fail(503, 'Two-factor setup needs ADMIN_2FA_KEY (64 hex characters) in the server settings.');
  return Buffer.from(raw, 'hex');
}
function sealSecret(plain) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', totpKey(), iv); const d = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return [iv, c.getAuthTag(), d].map(x => x.toString('base64')).join('.'); }
function openSecret(sealed) { const [iv, tag, d] = String(sealed).split('.').map(x => Buffer.from(x, 'base64')); const c = crypto.createDecipheriv('aes-256-gcm', totpKey(), iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString('utf8'); }

const ADMIN_COOKIE = 'cma_admin', ADMIN_SESSION_HOURS = 8;
async function adminFromRequest(req) {
  const tok = parseCookies(req)[ADMIN_COOKIE]; if (!tok) return null;
  const r = await pool.query(`SELECT a.id, a.name, a.email FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id WHERE s.token_hash = $1 AND s.expires_at > NOW() AND NOT a.disabled`, [sha256(tok)]);
  return r.rows[0] || null;
}
const requireAdmin = wrap(async (req, res, next) => {
  const session = await adminFromRequest(req);
  if (session) {
    // Cookie auth needs a custom header on changes, which a cross-site form cannot send (SameSite=Strict is the first line of defence).
    if (!['GET', 'HEAD'].includes(req.method) && req.get('x-requested-with') !== 'cma-admin') return res.status(403).json({ error: 'Missing request header.' });
    req.adminName = session.name; req.adminId = session.id; return next();
  }
  if (!ADMIN_TOKENS.length && !(await pool.query('SELECT 1 FROM admin_users LIMIT 1')).rowCount) return res.status(503).json({ error: 'Admin console is disabled. Set CMA_ADMIN_TOKEN in the server settings to create the first admin account.' });
  if (ADMIN_TOKEN_AUTH && ADMIN_TOKENS.length) {
    const a = crypto.createHash('sha256').update(String(req.get('x-admin-token') || '')).digest();
    let who = null;
    for (const t of ADMIN_TOKENS) { // check every entry so timing does not reveal which one matched
      const b = crypto.createHash('sha256').update(t.token).digest();
      if (crypto.timingSafeEqual(a, b) && !who) who = t.name;
    }
    if (who) { req.adminName = who; req.adminLegacy = true; return next(); }
  }
  return res.status(401).json({ error: 'Unauthorized' });
});
const adminGuard = [adminFailLimiter, requireAdmin];
async function audit(db, req, action, target, details) {
  await db.query(
    `INSERT INTO admin_audit_log (action, actor, target_user_id, target_name, target_email, details, ip_address) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [action, req.adminName || 'admin', target ? target.id : null, target ? target.name : null, target ? target.email : null, JSON.stringify(details || {}), req.ip]);
}

/* ---------------- access helpers ---------------- */
// Resolve every crew profile linked to this account. The application_id fallback
// also recognises profiles created by earlier versions if the direct link is absent.
async function crewProfessionalIds(db, user) {
  const { rows } = await db.query(
    `SELECT DISTINCT p.id
       FROM professionals p
       JOIN crew_applications ca
         ON (ca.professional_id = p.id OR p.application_id = 'app-' || ca.id::text)
      WHERE ca.user_id = $1`,
    [user.id]);
  return rows.map(r => Number(r.id)).filter(Number.isSafeInteger);
}
async function ownsProfessionalBooking(db, user, booking) {
  const profileIds = await crewProfessionalIds(db, user);
  return profileIds.includes(Number(booking.professional_id));
}
const ownsBooking = (user, b) => b.user_id != null && Number(b.user_id) === Number(user.id);
// Each side sees only its own money: the client never sees the crew payout, the crew never sees what the client was charged.
function scrubMoney(x, role) {
  if (Array.isArray(x)) return x.map(v => scrubMoney(v, role));
  if (!x || typeof x !== 'object' || x instanceof Date) return x;
  const hide = role === 'crew' ? ['client_total', 'client_fee', 'clientTotal'] : role === 'client' ? ['crew_net', 'crew_commission', 'crewNet'] : [];
  const out = {};
  for (const k of Object.keys(x)) if (!hide.includes(k)) out[k] = scrubMoney(x[k], role);
  return out;
}
const roleOf = (req, b) => (ownsBooking(req.user, b) ? 'client' : 'crew');
async function canAccessBooking(db, user, b) {
  // Account mode controls the interface, not ownership. Either participant can
  // retain access to their booking conversations after switching Hiring/Crew.
  if (ownsBooking(user, b)) return true;
  return ownsProfessionalBooking(db, user, b);
}
async function getAccessibleBooking(db, req, rawId) {
  const id = toInt(rawId); if (!id) fail(400, 'Invalid booking id.');
  const { rows } = await db.query('SELECT * FROM bookings WHERE id = $1', [id]);
  if (!rows[0]) fail(404, 'Booking not found.');
  if (!(await canAccessBooking(db, req.user, rows[0]))) fail(403, 'You do not have access to this booking.');
  return rows[0];
}

/* ---------------- public API ---------------- */
app.get('/api/health', (req, res) => res.json({ ok: true, version: '2.4.0' }));

/* ---------------- crew self-service: listing, photo, personal unavailability ---------------- */
async function myListing(db, user, rawId) {
  const ids = await crewProfessionalIds(db, user);
  if (!ids.length) fail(404, 'You do not have a published crew profile yet.');
  const id = rawId == null ? ids[0] : toInt(rawId);
  if (!id) fail(400, 'Invalid listing id.');
  if (!ids.includes(id)) fail(403, 'You do not own this listing.');
  const row = (await db.query('SELECT * FROM professionals WHERE id = $1', [id])).rows[0];
  if (!row) fail(404, 'Listing not found.');
  return row;
}
const isoDate = v => { const x = String(v || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(x)) return null; const d = new Date(x + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === x ? x : null; };
const listingView = p => ({ id: p.id, role: p.role, category: p.category || '', location: p.location || '', bio: p.bio || '', skills: p.skills || [], showreel: p.showreel || '', rate: Number(p.rate) || 0, rate_unit: rateUnitOf(p.rate_unit), photo: p.photo || '', is_active: p.is_active !== false, status: p.status });
app.get('/api/crew/listing', requireUser, wrap(async (req, res) => {
  const ids = await crewProfessionalIds(pool, req.user);
  const rows = ids.length ? (await pool.query("SELECT * FROM professionals WHERE id = ANY($1::int[]) AND COALESCE(status,'') <> 'removed' ORDER BY id", [ids])).rows : [];
  const blocks = (await pool.query(`SELECT id, professional_id, start_date::text AS start_date, end_date::text AS end_date, reason FROM availability_blocks WHERE professional_id = ANY($1::int[]) AND end_date >= $2::date ORDER BY start_date`, [ids, todayLagos()])).rows;
  const listings = rows.map(listingView);
  res.json({ listings, listing: listings[0] || null, blocks });
}));
const BIO_MIN = 20, BIO_MSG = 'Write at least 20 characters about your experience and the work you offer. Clients read this before booking.';
async function updateCrewListing(req, res, listingId) {
  const p = await myListing(pool, req.user, listingId), b = req.body || {}, sets = [], vals = [];
  const add = (col, cast, v) => { vals.push(v); sets.push(`${col} = $${vals.length}::${cast}`); };
  if (b.role !== undefined) { const v = str(b.role, 80); if (v.length < 2) fail(400, 'Enter your role, for example Director of Photography.'); add('role', 'text', v); }
  if (b.category !== undefined) add('category', 'text', str(b.category, 60) || null);
  if (b.location !== undefined) add('location', 'text', str(b.location, 120) || null);
  if (b.bio !== undefined) { const v = str(b.bio, 1000) || null; if (!v || v.length < BIO_MIN) fail(400, BIO_MSG); add('bio', 'text', v); add('"desc"', 'text', v); add('description', 'text', v); }
  if (b.rate !== undefined) {
    const r = Math.round(Number(b.rate));
    if (!Number.isFinite(r) || r < 1000 || r > 10000000) fail(400, 'Enter a rate between ₦1,000 and ₦10,000,000.');
    add('rate', 'numeric', r); add('daily_rate', 'numeric', r); add('rate_full_day', 'numeric', r); // existing bookings keep the rate they were agreed at
  }
  if (b.rateUnit !== undefined) { if (!RATE_UNITS.includes(b.rateUnit)) fail(400, 'Choose how you charge: per day, per hour or per project.'); add('rate_unit', 'text', b.rateUnit); }
  if (b.skills !== undefined) {
    const list = (Array.isArray(b.skills) ? b.skills : String(b.skills).split(',')).map(x => str(x, 40)).filter(Boolean);
    if (list.length > 15) fail(400, 'Add at most 15 skills.');
    const uniqueSkills = [...new Set(list)];
    // Existing Railway databases may define skills as JSONB rather than TEXT[].
    if (SKILLS_IS_JSON) add('skills', 'jsonb', JSON.stringify(uniqueSkills));
    else add('skills', 'text[]', uniqueSkills);
  }
  if (b.showreel !== undefined) {
    const v = str(b.showreel, 300);
    if (v) { let u; try { u = new URL(v); } catch (e) { fail(400, 'Enter the full showreel link, starting with https://'); } if (u.protocol !== 'https:') fail(400, 'The showreel link must start with https://'); }
    add('showreel', 'text', v || null);
  }
  if (b.is_active !== undefined) { add('is_active', 'boolean', !!b.is_active); add('active', 'boolean', !!b.is_active); }
  if (!sets.length) fail(400, 'Nothing to update.');
  vals.push(p.id);
  const row = (await pool.query(`UPDATE professionals SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals)).rows[0];
  res.json({ success: true, listing: listingView(row) });
}
// Delete a listing. Past bookings, invoices and reviews keep their history, so the row is retired (hidden everywhere) instead of erased.
app.delete('/api/crew/listings/:id', requireUser, wrap(async (req, res) => {
  const p = await myListing(pool, req.user, req.params.id);
  const live = await pool.query(`SELECT COUNT(*)::int AS n FROM bookings WHERE professional_id = $1 AND status IN ('awaiting_review','pending','counter_pending','confirmed','in_progress','completion_review')`, [p.id]);
  if (live.rows[0].n > 0) fail(409, 'You have ' + live.rows[0].n + ' open booking(s) on this listing. Finish or cancel them first, or pause the listing instead.');
  await withTx(async db => {
    await db.query('DELETE FROM portfolio_items WHERE professional_id = $1', [p.id]);
    await db.query('DELETE FROM professional_photos WHERE professional_id = $1', [p.id]);
    await db.query('DELETE FROM availability_blocks WHERE professional_id = $1', [p.id]);
    await db.query(`UPDATE professionals SET status = 'removed', is_active = FALSE WHERE id = $1`, [p.id]);
  });
  res.json({ success: true });
}));
app.patch('/api/crew/listing', requireUser, wrap(async (req, res) => updateCrewListing(req, res, null)));
app.patch('/api/crew/listings/:id', requireUser, wrap(async (req, res) => updateCrewListing(req, res, req.params.id)));
app.post('/api/crew/listings', requireUser, requireVerifiedEmail, wrap(async (req, res) => {
  const b = req.body || {};
  const role = str(b.role, 80), category = CATEGORIES.find(c => c.toLowerCase() === str(b.category, 60).toLowerCase());
  const location = str(b.location || req.user.location, 120), bio = str(b.bio, 1000), showreel = str(b.showreel, 300);
  const rate = Math.round(Number(b.rate)); const rateUnit = RATE_UNITS.includes(b.rateUnit) ? b.rateUnit : 'day';
  const skills = (Array.isArray(b.skills) ? b.skills : String(b.skills || '').split(',')).map(x => str(x, 40)).filter(Boolean);
  if (role.length < 2) fail(400, 'Enter a role for this listing.');
  if (bio.length < BIO_MIN) fail(400, BIO_MSG);
  if (!category) fail(400, 'Choose a valid category.');
  if (!Number.isFinite(rate) || rate < 1000 || rate > 10000000) fail(400, 'Enter a rate between ₦1,000 and ₦10,000,000.');
  if (skills.length > 15) fail(400, 'Add at most 15 skills.');
  if (showreel) { let u; try { u = new URL(showreel); } catch (e) { fail(400, 'Enter a valid portfolio link starting with https://'); } if (u.protocol !== 'https:') fail(400, 'The portfolio link must use https://'); }
  const identity = (await pool.query('SELECT is_verified FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!identity?.is_verified) fail(403, 'Verify your identity before adding another public listing.');
  const professional = await withTx(async db => {
    const appRow = (await db.query(`INSERT INTO crew_applications (user_id,name,full_name,email,role,location,portfolio,portfolio_url,bio,status) VALUES ($1,$2::text,$2::text,$3,$4,$5,$6::text,$6::text,$7,'approved') RETURNING id`, [req.user.id, req.user.name, req.user.email, role, location, showreel || '', bio])).rows[0];
    const skillsCast = SKILLS_IS_JSON ? 'jsonb' : 'text[]';
    const skillsValue = SKILLS_IS_JSON ? JSON.stringify([...new Set(skills)]) : [...new Set(skills)];
    const p = (await db.query(`INSERT INTO professionals (application_id,name,role,category,location,bio,\"desc\",description,showreel,rate,daily_rate,rate_full_day,rate_half_day,skills,verified,status,credits,active,is_active) VALUES ($1,$2,$3,$4,$5,$6::text,$7,$6::text,$8,$9::numeric,$9::numeric,$9::numeric,$10::numeric,$11::${skillsCast},$12,'approved','',TRUE,TRUE) RETURNING *`, ['app-' + appRow.id, req.user.name, role, category, location, bio, bio.slice(0,200), showreel || null, rate, Math.round(rate/2), skillsValue, true])).rows[0];
    await db.query('UPDATE crew_applications SET professional_id = $1 WHERE id = $2', [p.id, appRow.id]);
    await db.query('UPDATE professionals SET rate_unit = $1::text WHERE id = $2', [rateUnit, p.id]); p.rate_unit = rateUnit;
    return p;
  });
  res.status(201).json({ success: true, listing: listingView(professional) });
}));
const PHOTO_TYPES = { 'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, 'image/png': b => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'image/webp': b => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' };
async function uploadCrewListingPhoto(req, res, listingId) {
  const p = await myListing(pool, req.user, listingId);
  const mime = str(req.body.mime_type, 40).toLowerCase(), b64 = String(req.body.data_base64 || '');
  if (!PHOTO_TYPES[mime]) fail(400, 'Upload a JPG, PNG or WebP photo.');
  if (!b64 || b64.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) fail(400, 'The photo is empty, invalid or larger than 2 MB.');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length < 12 || bytes.length > 2 * 1024 * 1024 || !PHOTO_TYPES[mime](bytes)) fail(400, 'The file is not a valid ' + mime.split('/')[1].toUpperCase() + ' photo under 2 MB.');
  await withTx(async db => {
    await db.query(`INSERT INTO professional_photos (professional_id, mime, data) VALUES ($1,$2,$3) ON CONFLICT (professional_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = NOW()`, [p.id, mime, bytes]);
    await db.query('UPDATE professionals SET photo = $1::text WHERE id = $2', [`/api/professionals/${p.id}/photo?v=${Date.now()}`, p.id]);
  });
  res.json({ success: true, photo: `/api/professionals/${p.id}/photo?v=${Date.now()}` });
}
app.post('/api/crew/listings/:id/photo', requireUser, wrap(async (req, res) => uploadCrewListingPhoto(req, res, req.params.id)));
app.post('/api/crew/photo', requireUser, wrap(async (req, res) => uploadCrewListingPhoto(req, res, null)));
app.delete('/api/crew/listings/:id/photo', requireUser, wrap(async (req, res) => {
  const p = await myListing(pool, req.user, req.params.id);
  await pool.query('DELETE FROM professional_photos WHERE professional_id = $1', [p.id]);
  await pool.query('UPDATE professionals SET photo = NULL WHERE id = $1', [p.id]);
  res.json({ success: true });
}));
app.delete('/api/crew/photo', requireUser, wrap(async (req, res) => {
  const p = await myListing(pool, req.user);
  await pool.query('DELETE FROM professional_photos WHERE professional_id = $1', [p.id]);
  await pool.query('UPDATE professionals SET photo = NULL WHERE id = $1', [p.id]);
  res.json({ success: true });
}));
app.get('/api/professionals/:id/photo', wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(404, 'Not found.');
  const r = (await pool.query(`SELECT ph.mime, ph.data FROM professional_photos ph JOIN professionals p ON p.id = ph.professional_id WHERE ph.professional_id = $1 AND p.status = 'approved'`, [id])).rows[0];
  if (!r) fail(404, 'Not found.');
  res.set({ 'Content-Type': r.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'none'" }).send(r.data);
}));
app.post('/api/crew/availability', requireUser, wrap(async (req, res) => {
  const start = isoDate(req.body.start_date), end = isoDate(req.body.end_date || req.body.start_date);
  if (!start || !end) fail(400, 'Choose valid dates.');
  if (start < todayLagos()) fail(400, 'You cannot block dates in the past.');
  if (end < start) fail(400, 'The end date cannot be before the start date.');
  if ((new Date(end) - new Date(start)) / 86400000 > 365) fail(400, 'Block at most one year at a time.');
  const row = await withTx(async db => {
    const p = await myListing(db, req.user, req.body.professional_id);
    await db.query('SELECT id FROM professionals WHERE id = $1 FOR UPDATE', [p.id]); // serialise with new bookings
    if ((await db.query(`SELECT COUNT(*)::int AS n FROM availability_blocks WHERE professional_id = $1 AND reason = 'personal' AND end_date >= $2::date`, [p.id, todayLagos()])).rows[0].n >= 100) fail(400, 'You have too many blocked periods. Remove some first.');
    if ((await db.query(`SELECT 1 FROM availability_blocks WHERE professional_id = $1 AND reason <> 'personal' AND NOT (end_date < $2::date OR start_date > $3::date) LIMIT 1`, [p.id, start, end])).rowCount) fail(409, 'You already have a confirmed booking on some of these dates.');
    return (await db.query(`INSERT INTO availability_blocks (professional_id, start_date, end_date, reason) VALUES ($1,$2::date,$3::date,'personal') RETURNING id, start_date::text AS start_date, end_date::text AS end_date, reason`, [p.id, start, end])).rows[0];
  });
  res.status(201).json({ success: true, block: row });
}));
app.delete('/api/crew/availability/:id', requireUser, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid id.');
  const ownedIds = await crewProfessionalIds(pool, req.user);
  const d = await pool.query(`DELETE FROM availability_blocks WHERE id = $1 AND professional_id = ANY($2::int[]) AND reason = 'personal' RETURNING id`, [id, ownedIds]);
  if (!d.rowCount) fail(404, 'Blocked period not found. Dates held by bookings cannot be removed here.');
  res.json({ success: true });
}));

app.get('/api/professionals', wrap(async (req, res) => {
  const { role, location, category } = req.query;
  let query = "SELECT professionals.*, (SELECT COUNT(*)::int FROM reviews r WHERE r.professional_id = professionals.id) AS review_count FROM professionals WHERE status = 'approved' AND is_active = TRUE AND NOT EXISTS (" +
    "SELECT 1 FROM crew_applications ca JOIN users u ON u.id=ca.user_id " +
    "LEFT JOIN user_settings us ON us.user_id=u.id WHERE (ca.professional_id=professionals.id OR professionals.application_id='app-' || ca.id::text) AND COALESCE(us.profile_visibility,TRUE)=FALSE)";
  const params = [];
  if (role) { params.push(String(role)); query += ` AND role = $${params.length}`; }
  if (category) { params.push(String(category)); query += ` AND category = $${params.length}`; }
  if (location) { params.push(`%${String(location).replace(/[\\%_]/g, '\\$&')}%`); query += ` AND location ILIKE $${params.length}`; }
  const { rows } = await pool.query(query + ' ORDER BY id', params);
  res.json({ professionals: rows }); // the frontend reads data.professionals
}));


const shortName = n => { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? p[0] + ' ' + p[p.length - 1][0] + '.' : (p[0] || 'Client'); };
/* ---------------- portfolio: photos and video links shown on a crew profile ---------------- */
const PORTFOLIO_MAX = 24;
const imageKind = b => (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg' : b.length > 8 && b.subarray(0, 4).toString('hex') === '89504e47' ? 'image/png' : b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null);
const VIDEO_HOSTS = /^(www\.|m\.)?(youtube\.com|youtu\.be|vimeo\.com)$/i;
async function ownListing(req) {
  const id = toInt(req.params.id) || 0;
  if (!(await crewProfessionalIds(pool, req.user)).includes(id)) fail(404, 'Listing not found.');
  return id;
}
app.get('/api/professionals/:id/portfolio', wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid id.');
  const { rows } = await pool.query(`SELECT i.id, i.kind, i.url, i.caption, i.created_at FROM portfolio_items i JOIN professionals p ON p.id = i.professional_id WHERE i.professional_id = $1 AND p.status = 'approved' ORDER BY i.created_at DESC`, [id]);
  res.json(rows.map(r => ({ id: r.id, kind: r.kind, caption: r.caption || '', url: r.kind === 'link' ? r.url : '/api/portfolio/' + r.id + '/image' })));
}));
app.get('/api/portfolio/:id/image', wrap(async (req, res) => {
  const r = (await pool.query(`SELECT i.mime, i.data FROM portfolio_items i JOIN professionals p ON p.id = i.professional_id WHERE i.id = $1 AND i.kind = 'image' AND p.status = 'approved'`, [toInt(req.params.id) || 0])).rows[0];
  if (!r) fail(404, 'Not found.');
  res.set({ 'Content-Type': r.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'" }).send(r.data);
}));
app.post('/api/crew/listings/:id/portfolio', requireUser, wrap(async (req, res) => {
  const proId = await ownListing(req); const b = req.body || {};
  const caption = str(b.caption, 140);
  const n = (await pool.query('SELECT COUNT(*)::int AS n FROM portfolio_items WHERE professional_id = $1', [proId])).rows[0].n;
  if (n >= PORTFOLIO_MAX) fail(400, 'You can add up to ' + PORTFOLIO_MAX + ' items. Remove one first.');
  let row;
  if (b.kind === 'link') {
    let u; try { u = new URL(str(b.url, 500)); } catch (e) { fail(400, 'Enter a valid link starting with https://'); }
    if (u.protocol !== 'https:' || !VIDEO_HOSTS.test(u.hostname)) fail(400, 'Add a YouTube or Vimeo video link.');
    row = (await pool.query(`INSERT INTO portfolio_items (professional_id, kind, url, caption) VALUES ($1,'link',$2,$3) RETURNING id`, [proId, u.toString(), caption])).rows[0];
  } else {
    const base64 = String(b.data_base64 || '');
    if (!base64 || base64.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail(400, 'Choose a valid photo under 2 MB.');
    const bytes = Buffer.from(base64, 'base64'); const mime = imageKind(bytes);
    if (!mime || bytes.length > 2 * 1024 * 1024) fail(400, 'Upload a JPG, PNG or WebP photo under 2 MB.');
    row = (await pool.query(`INSERT INTO portfolio_items (professional_id, kind, mime, data, caption) VALUES ($1,'image',$2,$3,$4) RETURNING id`, [proId, mime, bytes, caption])).rows[0];
  }
  res.status(201).json({ id: row.id });
}));
app.delete('/api/crew/listings/:id/portfolio/:itemId', requireUser, wrap(async (req, res) => {
  const proId = await ownListing(req);
  const r = await pool.query('DELETE FROM portfolio_items WHERE id = $1 AND professional_id = $2', [toInt(req.params.itemId) || 0, proId]);
  if (!r.rowCount) fail(404, 'Item not found.');
  res.json({ success: true });
}));
// What a crew member sees about the client they are working with: history and reviews written by other crew.
app.get('/api/bookings/:id/client-profile', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.params.id);
  if (!b.user_id) fail(404, 'No client profile.');
  if (ownsBooking(req.user, b)) fail(403, 'This is your own profile.');
  const u = (await pool.query('SELECT name, created_at FROM users WHERE id = $1', [b.user_id])).rows[0];
  const done = (await pool.query(`SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = $1 AND status = 'completed' AND payment_status = 'paid'`, [b.user_id])).rows[0].n;
  const reviews = (await pool.query(`SELECT id, rating, comment, reviewer_name, created_at FROM reviews WHERE subject_user_id = $1 AND reviewer_type = 'crew' ORDER BY created_at DESC LIMIT 50`, [b.user_id])).rows.map(r => ({ ...r, reviewer_name: shortName(r.reviewer_name) }));
  const avg = reviews.length ? Math.round(reviews.reduce((a, r) => a + r.rating, 0) / reviews.length * 10) / 10 : null;
  res.json({ name: shortName(u?.name), member_since: u?.created_at, completed_jobs: done, rating: avg, review_count: reviews.length, reviews });
}));

app.get('/api/professionals/:id/reviews', wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid id.');
  const { rows } = await pool.query('SELECT id, rating, comment, reviewer_name, reviewer_type, created_at FROM reviews WHERE professional_id = $1 ORDER BY created_at DESC', [id]);
  res.json(rows.map(r => ({ ...r, reviewer_name: shortName(r.reviewer_name) })));
}));

/* ---------------- bookings (client) ---------------- */
/* ---------------- chat-based booking: a request is the first message in the thread ---------------- */
const SERVICE_FEE = 0.1;
const RATE_UNITS = ['day', 'hour', 'project'];
const rateUnitOf = v => (RATE_UNITS.includes(v) ? v : 'day');
// quantity = days (full), 0.5 (half), hours, or 1 for a flat project fee. The server always recomputes totals.
function priceFor(unit, start, end, rate, quantity) {
  let qty;
  if (unit === 'half') qty = 0.5; else if (unit === 'hour') qty = Number(quantity); else if (unit === 'project') qty = 1; else qty = daysBetween(start, end);
  const base = Math.round(Number(rate) * qty);
  const fee = Math.round(base * SERVICE_FEE);
  return { days: qty, quantity: qty, base, client_total: base + fee, crew_net: base - fee };
}
// Validates the proposal for a listing priced per day, per hour or as a flat project fee; never trusts client totals.
function parseProposal(body, defaultRate, rateUnit) {
  const ru = rateUnitOf(rateUnit);
  let unit, kind = 'calendar', qty = 1, start = body.startDate, end = body.endDate;
  if (ru === 'hour') {
    unit = 'hour'; end = start; qty = Number(body.quantity);
    if (!(qty >= 1 && qty <= 240 && Number.isInteger(qty * 2))) fail(400, 'Enter the number of hours (1 to 240, in half hours).');
  } else if (ru === 'project') {
    unit = 'project'; kind = body.scheduleKind === 'delivery' ? 'delivery' : 'calendar';
    if (kind === 'delivery') { start = body.deliveryDate || body.startDate; end = start; }
  } else {
    unit = body.bookingUnit === 'half' ? 'half' : 'full'; if (unit === 'half') end = start;
  }
  if (!isDate(start) || !isDate(end)) fail(400, kind === 'delivery' ? 'Please choose a valid delivery date.' : 'Please choose valid start and end dates.');
  if (start < todayLagos()) fail(400, kind === 'delivery' ? 'The delivery date cannot be in the past.' : 'The start date cannot be in the past.');
  if (end < start) fail(400, 'The end date cannot be before the start date.');
  if (kind === 'calendar' && unit !== 'half' && unit !== 'hour' && daysBetween(start, end) > 90) fail(400, 'Bookings longer than 90 days must be arranged with support.');
  let rate = Number(defaultRate);
  if (body.dailyRate != null && body.dailyRate !== '') {
    rate = Number(body.dailyRate);
    if (!Number.isSafeInteger(rate) || rate < 1 || rate > 10000000) fail(400, 'The rate must be a whole number of naira.');
  }
  if (!(rate > 0)) fail(400, 'This crew member has no rate set.');
  return { booking_unit: unit, schedule_kind: kind, start_date: start, end_date: end, daily_rate: rate, ...priceFor(unit, start, end, rate, qty) };
}
function offerSummary(o) {
  const rate = '₦' + Number(o.daily_rate).toLocaleString('en-NG');
  const when = o.schedule_kind === 'delivery' ? 'Delivery by ' + fmtRange({ start_date: o.start_date, end_date: o.start_date }) : fmtRange(o);
  if (o.booking_unit === 'project') return when + ' · flat project fee ' + rate;
  if (o.booking_unit === 'hour') return when + ' · ' + o.quantity + ' hour' + (Number(o.quantity) === 1 ? '' : 's') + ' · ' + rate + ' per hour';
  return when + (o.booking_unit === 'half' ? ' · half day · ' + rate + ' half-day rate' : ' · ' + o.days + ' day' + (o.days === 1 ? '' : 's') + ' · ' + rate + ' per day');
}
async function insertChatMessage(db, b, user, kind, text, offer, recipientId) {
  const senderType = ownsBooking(user, b) ? 'client' : 'crew';
  const { rows } = await db.query(
    'INSERT INTO messages (booking_id,sender_type,sender_name,masked_content,sender_user_id,recipient_user_id,kind,offer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [b.id, senderType, user.name, kind === 'system' ? String(text || '') : maskContact(String(text || '')), user.id, recipientId || null, kind, offer ? JSON.stringify(offer) : null]);
  return rows[0];
}
function pushChat(b, row, recipientId, user) {
  broadcastChat(b.id, row);
  if (recipientId && Number(recipientId) !== Number(user.id)) {
    emitMessageNotification(recipientId, { type: 'message', booking_id: b.id, reference: b.reference || refFor(b.id), sender_name: user.name, preview: row.masked_content, created_at: row.created_at });
    if (row.kind === 'text' || !row.kind) emailNewMessage(recipientId, b, user.name, row.masked_content).catch(() => {});
    else {
      const ref = b.reference || refFor(b.id);
      const title = row.kind === 'request' ? 'New booking request' : row.kind === 'offer' ? 'Proposed change to a booking' : 'Booking update';
      const detail = row.kind === 'system' ? row.masked_content : user.name + ' sent you ' + (row.kind === 'request' ? 'a booking request' : 'a proposed change') + '. Open the chat to review the dates and price and to reply.';
      emailUsers([recipientId], title + ' (' + ref + ')', [detail], '/?inbox=' + b.id, 'msg' + row.id).catch(() => {});
    }
  }
}
const setOfferStatus = (db, messageId, status) => db.query(`UPDATE messages SET offer = jsonb_set(offer, '{status}', to_jsonb($2::text)) WHERE id = $1 RETURNING *`, [messageId, status]);

// Creates one booking request (and its chat thread) for one professional. Shared by single and group requests.
async function createBookingRequest(db, user, proId, body, note, group) {
  const p = (await db.query(`SELECT id, name, role, rate, rate_unit FROM professionals WHERE id = $1 AND status = 'approved' AND is_active = TRUE FOR UPDATE`, [proId])).rows[0];
  if (!p) fail(404, 'This crew member is not available.');
  if (group && rateUnitOf(p.rate_unit) !== 'day') fail(400, p.name + ' is priced per ' + (p.rate_unit === 'hour' ? 'hour' : 'project') + '. Book them on their own instead of in a group.');
  const o = parseProposal({ ...body, dailyRate: undefined }, p.rate, p.rate_unit); // the client cannot set the rate on a first request
  const clash = o.schedule_kind === 'delivery' ? { rows: [] } : await db.query(`SELECT 1 FROM availability_blocks WHERE professional_id = $1 AND NOT (end_date < $2 OR start_date > $3) LIMIT 1`, [proId, o.start_date, o.end_date]);
  if (clash.rows.length) fail(409, (group ? p.name + ' is' : 'This professional is') + ' not available for the requested dates.');
  // One person, one booking per client for the same dates, even if they list several roles.
  const crewIds = await crewUserIdsFor(db, proId);
  const dup = o.schedule_kind === 'delivery' ? { rows: [] } : await db.query(
    `SELECT 1 FROM bookings b WHERE b.user_id = $1::int AND COALESCE(b.schedule_kind,'calendar') = 'calendar' AND b.status NOT IN ('cancelled','declined','expired','refunded') AND NOT (b.end_date < $3::date OR b.start_date > $4::date)
       AND (b.professional_id = $2::int OR b.professional_id IN (SELECT p.id FROM professionals p JOIN crew_applications ca ON (ca.professional_id = p.id OR p.application_id = 'app-' || ca.id::text) WHERE ca.user_id = ANY($5::int[]))) LIMIT 1`,
    [user.id, proId, o.start_date, o.end_date, crewIds]);
  if (dup.rows.length) fail(409, 'You already have a booking with ' + p.name + ' that overlaps these dates. Open it in Messages to change the details instead of booking them again.');
  const ins = await db.query(
    `INSERT INTO bookings (reference, professional_id, user_id, client_name, client_email, start_date, end_date, project_brief, project_type, project_location, overtime_terms, booking_unit, daily_rate, client_total, crew_net, status, crew_response, group_ref, group_title, quantity, schedule_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'General','','',$9,$10,$11,$12,'awaiting_review','pending',$13,$14,$15,$16) RETURNING *`,
    ['TMP-' + crypto.randomBytes(8).toString('hex'), proId, user.id, user.name, user.email, o.start_date, o.end_date, note, o.booking_unit, o.daily_rate, o.client_total, o.crew_net, group ? group.ref : null, group ? group.title : null, o.quantity, o.schedule_kind]);
  const row = ins.rows[0]; const ref = refFor(row.id);
  await db.query('UPDATE bookings SET reference = $1 WHERE id = $2', [ref, row.id]);
  const booking = { ...row, reference: ref, professional_name: p.name, professional_role: p.role };
  const msg = await insertChatMessage(db, booking, user, 'request', note || 'Hi, I would like to book you for these dates.', { ...o, proposed_by: 'client', status: 'pending' }, crewIds[0]);
  return { booking, msg, crewId: crewIds[0] };
}

app.post('/api/bookings', requireUser, requireApproved, requireVerifiedEmail, wrap(async (req, res) => {
  const b = req.body || {};
  const proId = toInt(b.professionalId);
  if (!proId) fail(400, 'Please choose a crew member.');
  if ((await crewProfessionalIds(pool, req.user)).includes(proId)) fail(400, 'You cannot book your own crew profile.');
  const note = str(b.message, 2000);
  const recent = await pool.query(`SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [req.user.id]);
  if (recent.rows[0].n >= 10) fail(429, 'You have reached the limit of 10 booking requests per 24 hours.');
  const out = await withTx(db => createBookingRequest(db, req.user, proId, b, note, null));
  pushChat(out.booking, out.msg, out.crewId, req.user);
  res.status(201).json({ success: true, booking: scrubMoney(out.booking, 'client') });
}));

// Group booking: one request per crew member for the same dates, each with its own chat, price and payment.
app.post('/api/group-bookings', requireUser, requireApproved, requireVerifiedEmail, wrap(async (req, res) => {
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.professionalIds) ? b.professionalIds : []).map(toInt).filter(Boolean))];
  if (ids.length < 2 || ids.length > 12) fail(400, 'Choose between 2 and 12 crew members for a group booking.');
  const title = str(b.title, 120);
  if (!title) fail(400, 'Give the project a title so the crew know what it is for.');
  const note = str(b.message, 2000);
  const own = await crewProfessionalIds(pool, req.user);
  if (ids.some(i => own.includes(i))) fail(400, 'You cannot book your own crew profile.');
  const recent = await pool.query(`SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [req.user.id]);
  if (recent.rows[0].n + ids.length > 30) fail(429, 'You have reached the daily limit of booking requests. Try again tomorrow.');
  const group = { ref: 'GRP-' + crypto.randomBytes(5).toString('hex').toUpperCase(), title };
  const outs = await withTx(async db => { const r = []; for (const id of ids) r.push(await createBookingRequest(db, req.user, id, b, note, group)); return r; });
  for (const o of outs) pushChat(o.booking, o.msg, o.crewId, req.user);
  res.status(201).json({ success: true, group_ref: group.ref, bookings: outs.map(o => scrubMoney(o.booking, 'client')) });
}));

app.get('/api/my/bookings', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, p.name AS professional_name, p.role AS professional_role
       FROM bookings b LEFT JOIN professionals p ON p.id = b.professional_id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC`, [req.user.id]);
  res.json({ bookings: rows.map(b => scrubMoney({ ...b, reference: b.reference || refFor(b.id) }, 'client')) });
}));

// Statuses in which a booking holds an availability block on the professional's calendar.
const BLOCKING_STATUSES = ['confirmed', 'in_progress', 'completion_review', 'completed', 'disputed'];
const fmtRange = b => (b.start_date === b.end_date ? b.start_date : b.start_date + ' to ' + b.end_date);
async function crewUserIdsFor(db, professionalId) {
  const r = await db.query(
    "SELECT DISTINCT ca.user_id FROM crew_applications ca JOIN professionals p ON (ca.professional_id=p.id OR p.application_id='app-' || ca.id::text) WHERE p.id=$1 AND ca.user_id IS NOT NULL", [professionalId]);
  return r.rows.map(x => Number(x.user_id));
}
// Live pop-up for booking lifecycle events (the same stream the message alerts use).
function notifyBooking(userIds, b, title, preview) {
  for (const uid of userIds) if (uid) emitMessageNotification(uid, { type: 'booking', booking_id: b.id, reference: b.reference || refFor(b.id), sender_name: title, preview, created_at: new Date().toISOString() });
  emailUsers(userIds, title + ' (' + (b.reference || refFor(b.id)) + ')', [preview], '/?inbox=' + b.id, 'bk' + b.id + '-' + Buffer.from(title).toString('hex').slice(0, 20) + '-' + Date.now()).catch(() => {});
}
// Strict policy. A client may withdraw a request until the crew member confirms it. After that the only way out
// is through the crew member (who must give a reason; a paid booking is then flagged for a refund) or support.
app.post('/api/bookings/:id/cancel', requireUser, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid booking id.');
  const reason = str(req.body && req.body.reason, 1000);
  const out = await withTx(async db => {
    const b = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!b) fail(404, 'Booking not found.');
    if (!(await canAccessBooking(db, req.user, b))) fail(403, 'You do not have access to this booking.');
    if (['cancelled', 'completed', 'refunded', 'declined', 'expired'].includes(b.status)) fail(409, 'This booking can no longer be cancelled.');
    const mine = ownsBooking(req.user, b) ? 'client' : 'crew';
    const holds = BLOCKING_STATUSES.includes(b.status);
    if (mine === 'client' && holds) fail(409, 'This booking is confirmed. Ask the crew member in the chat to cancel it, or contact support.');
    if (mine === 'crew' && reason.length < 5) fail(400, 'Please give the client a reason (at least 5 characters).');
    const refund = b.payment_status === 'paid' ? 'pending' : null;
    const upd = await db.query(`UPDATE bookings SET status = 'cancelled', cancelled_by = $2, cancel_reason = $3, refund_status = COALESCE($4, refund_status) WHERE id = $1 RETURNING *`, [id, mine, reason || null, refund]);
    // Only a booking that was confirmed holds a block (see BLOCKING_STATUSES).
    if (holds) {
      await db.query(
        `DELETE FROM availability_blocks WHERE id = (SELECT id FROM availability_blocks WHERE professional_id = $1 AND start_date = $2 AND end_date = $3 AND reason = 'confirmed booking' LIMIT 1)`,
        [b.professional_id, b.start_date, b.end_date]);
    }
    await db.query(`UPDATE messages SET offer = jsonb_set(offer, '{status}', '"superseded"') WHERE booking_id = $1 AND kind IN ('request','offer') AND offer->>'status' = 'pending'`, [id]);
    const other = mine === 'client' ? (await crewUserIdsFor(db, b.professional_id))[0] : Number(b.user_id);
    const sys = await insertChatMessage(db, b, req.user, 'system', mine === 'client' ? 'The client withdrew this request.' : 'The crew member cancelled this booking. Reason: ' + reason.replace(/[.\s]+$/, '') + '.' + (refund ? ' A refund will be arranged.' : ''), null, other);
    return { booking: upd.rows[0], sys, other, mine };
  });
  pushChat(out.booking, out.sys, out.other, req.user);
  res.json({ success: true, booking: scrubMoney(out.booking, roleOf(req, out.booking)) });
}));

// The client confirms the job was done. Only then can reviews be left and the crew member be paid out.
app.post('/api/bookings/:id/complete', requireUser, wrap(async (req, res) => {
  const out = await withTx(async db => {
    const b = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [toInt(req.params.id) || 0])).rows[0];
    if (!b) fail(404, 'Booking not found.');
    if (!ownsBooking(req.user, b)) fail(403, 'Only the client can confirm completion.');
    if (!['confirmed', 'in_progress', 'completion_review'].includes(b.status)) fail(409, 'This booking is not in progress.');
    if (b.payment_status !== 'paid') fail(409, 'Payment must be completed before the job can be marked complete.');
    if ((b.schedule_kind || 'calendar') === 'calendar' && String(b.start_date).slice(0, 10) > todayLagos()) fail(409, 'You can confirm completion once the job has started.');
    const upd = await db.query(`UPDATE bookings SET status = 'completed', completed_at = NOW() WHERE id = $1 RETURNING *`, [b.id]);
    const other = (await crewUserIdsFor(db, b.professional_id))[0];
    const sys = await insertChatMessage(db, b, req.user, 'system', 'The client confirmed the job is complete.', null, other);
    return { booking: upd.rows[0], sys, other };
  });
  pushChat(out.booking, out.sys, out.other, req.user);
  res.json({ success: true, booking: scrubMoney(out.booking, roleOf(req, out.booking)) });
}));

// Requests nobody answers within 48 hours lapse, so dates are not held hostage and clients are not left waiting.
const REQUEST_EXPIRY_HOURS = Number(process.env.REQUEST_EXPIRY_HOURS || 48);
async function expireStaleRequests() {
  const { rows } = await pool.query(
    `UPDATE bookings b SET status = 'expired'
      WHERE b.status IN ('awaiting_review','pending','counter_pending')
        AND GREATEST(b.created_at, COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.booking_id = b.id), b.created_at)) < NOW() - make_interval(hours => $1::int)
      RETURNING b.*`, [REQUEST_EXPIRY_HOURS]);
  for (const b of rows) {
    try {
      await pool.query(`UPDATE messages SET offer = jsonb_set(offer, '{status}', '"superseded"') WHERE booking_id = $1 AND kind IN ('request','offer') AND offer->>'status' = 'pending'`, [b.id]);
      const sys = (await pool.query(`INSERT INTO messages (booking_id,sender_type,sender_name,masked_content,kind) VALUES ($1,'system','System',$2,'system') RETURNING *`,
        [b.id, 'This request expired because nobody answered within ' + REQUEST_EXPIRY_HOURS + ' hours.'])).rows[0];
      broadcastChat(b.id, sys);
      const people = [Number(b.user_id), ...(await crewUserIdsFor(pool, b.professional_id))];
      notifyBooking(people, b, 'Request expired', (b.reference || refFor(b.id)) + ' expired with no answer.');
    } catch (e) { console.warn('expire note:', e.message); }
  }
  return rows.length;
}

/* ---------------- crew response ---------------- */
/* ---------------- hirer response to a crew counter-offer ---------------- */
app.post('/api/bookings/:id/counter-response', requireUser, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid booking id.');
  const response = req.body.response;
  if (!['approved', 'rejected'].includes(response)) fail(400, 'Invalid response action.');
  const booking = await withTx(async db => {
    const b = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!b) fail(404, 'Booking not found.');
    if (!ownsBooking(req.user, b)) fail(403, 'You do not have access to this booking.');
    if (b.status !== 'counter_pending') fail(409, 'This booking has no counter-offer awaiting your response.');
    if (response === 'approved') {
      await db.query('SELECT id FROM professionals WHERE id = $1 FOR UPDATE', [b.professional_id]);
      const clash = await db.query(`SELECT 1 FROM availability_blocks WHERE professional_id = $1 AND NOT (end_date < $2 OR start_date > $3) LIMIT 1`, [b.professional_id, b.start_date, b.end_date]);
      if (clash.rows.length) fail(409, 'The professional is no longer available on these dates.');
      await db.query(`INSERT INTO availability_blocks (professional_id, start_date, end_date, reason) VALUES ($1,$2,$3,'confirmed booking')`, [b.professional_id, b.start_date, b.end_date]);
    }
    const upd = await db.query('UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *', [response === 'approved' ? 'confirmed' : 'declined', id]);
    return { ...upd.rows[0], _crew: await crewUserIdsFor(db, b.professional_id) };
  });
  const { _crew, ...answered } = booking;
  notifyBooking(_crew, answered, response === 'approved' ? 'Counter-offer accepted' : 'Counter-offer declined', (answered.reference || refFor(answered.id)) + ' (' + fmtRange(answered) + ').');
  res.json({ success: true, booking: scrubMoney(answered, roleOf(req, answered)) });
}));

/* ---------------- payments & invoices ---------------- */
/* ---------------- payments: Bachs hosted checkout ---------------- */
async function bachsFetch(method, path, body, idempotencyKey) {
  const headers = { Authorization: 'Bearer ' + BACHS_API_KEY, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let res;
  try { res = await fetch(BACHS_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
  catch (e) { const err = new Error('Payment provider is unreachable.'); err.status = 502; throw err; }
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!res.ok) { console.warn('Bachs error', res.status, text.slice(0, 300)); const err = new Error('The payment provider rejected the request.'); err.status = 502; throw err; }
  return json || {};
}
// Mirrors Bachs's documented scheme: HMAC-SHA256 over "<timestamp>.<raw body>", header "t=<unix>,v1=<hex>[,v1=<hex>]"
// (legacy X-Bachs-Timestamp / X-Bachs-Signature pair also accepted), 300 s replay window, any matching v1 digest wins.
function verifyBachsSignature(rawBody, headers, secret, toleranceSeconds = 300) {
  const v2 = headers['x-bachs-signature-v2'];
  let timestamp, signatures;
  if (v2 !== undefined) {
    const fields = String(v2).split(',').map(x => x.trim());
    const ts = fields.filter(x => x.startsWith('t='));
    if (ts.length !== 1) return false;
    timestamp = ts[0].slice(2); signatures = fields.filter(x => x.startsWith('v1=')).map(x => x.slice(3));
  } else {
    timestamp = headers['x-bachs-timestamp']; signatures = headers['x-bachs-signature'] ? [String(headers['x-bachs-signature'])] : [];
  }
  if (!timestamp || !/^\d+$/.test(String(timestamp))) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(String(timestamp) + '.', 'utf8').update(rawBody).digest();
  return signatures.some(sig => /^[a-fA-F0-9]{64}$/.test(sig) && crypto.timingSafeEqual(expected, Buffer.from(sig, 'hex')));
}
function collectStrings(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => collectStrings(v, out, depth + 1));
  else if (typeof value === 'object') Object.values(value).forEach(v => collectStrings(v, out, depth + 1));
  return out;
}

// Never trust a redirect or a webhook body alone: settle only after re-reading the session from Bachs and checking
// status, amount and currency against what we asked for.
async function settleFromBachs(payment) {
  if (!payment.checkout_id) return { status: payment.status };
  const session = await bachsFetch('GET', '/v1/checkout-sessions/' + encodeURIComponent(payment.checkout_id));
  const chargeStatus = session.charge && session.charge.status;
  const paid = session.status === 'completed' && ['succeeded', 'accepted'].includes(String(chargeStatus || session.payment_status || ''));
  const dead = ['expired', 'cancelled', 'failed'].includes(String(session.status));
  if (!paid && !dead) return { status: 'pending' };
  return withTx(async db => {
    const cur = (await db.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [payment.id])).rows[0];
    if (cur.status !== 'pending') return { status: cur.status, duplicate: true }; // idempotent
    if (dead) {
      await db.query(`UPDATE payments SET status = 'failed', raw_webhook = $2 WHERE id = $1`, [cur.id, JSON.stringify(session)]);
      await db.query(`UPDATE bookings SET payment_status = 'failed' WHERE id = ANY($1::int[]) AND payment_status <> 'paid'`, [cur.booking_ids || [cur.booking_id]]);
      return { status: 'failed' };
    }
    if (session.amount != null && Math.abs(Number(session.amount) - Number(cur.amount)) > 0.009) { console.error('Bachs amount mismatch', cur.id, session.amount, cur.amount); return { status: 'amount_mismatch' }; }
    if (session.currency && String(session.currency).toUpperCase() !== 'NGN') { console.error('Bachs currency mismatch', cur.id, session.currency); return { status: 'currency_mismatch' }; }
    const ids = cur.booking_ids || [cur.booking_id];
    const done = [];
    for (const bid of ids) {
      const booking = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bid])).rows[0];
      if (!booking || booking.payment_status === 'paid') continue;
      await db.query(`UPDATE bookings SET payment_status = 'paid' WHERE id = $1`, [bid]);
      const total = cur.booking_ids ? Number(booking.client_total) : Number(cur.amount); const subtotal = total / 1.075;
      const invNo = `INV-${new Date().getUTCFullYear()}-${String(cur.id).padStart(6, '0')}` + (cur.booking_ids ? '-' + bid : '');
      await db.query(
        `INSERT INTO invoices (invoice_number, booking_id, client_name, subtotal, vat_rate, vat_amount, total_amount, supplier_tin) VALUES ($1,$2,$3,$4,7.5,$5,$6,$7) ON CONFLICT (invoice_number) DO NOTHING`,
        [invNo, bid, booking.client_name || 'Client', subtotal.toFixed(2), (total - subtotal).toFixed(2), total, SUPPLIER_TIN || null]);
      const crewId = (await crewUserIdsFor(db, booking.professional_id))[0];
      const sys = (await db.query(`INSERT INTO messages (booking_id,sender_type,sender_name,masked_content,kind,recipient_user_id) VALUES ($1,'system','System',$2,'system',$3) RETURNING *`,
        [booking.id, 'Payment received. The booking is now confirmed and paid. Contact details are available above.', crewId || null])).rows[0];
      done.push({ booking, sys, crewId });
    }
    await db.query(`UPDATE payments SET status = 'verified', raw_webhook = $2 WHERE id = $1`, [cur.id, JSON.stringify(session)]);
    return { status: 'verified', done };
  }).then(r => {
    for (const d of r.done || []) {
      broadcastChat(d.booking.id, d.sys);
      for (const uid of [Number(d.booking.user_id), d.crewId]) if (uid) emitMessageNotification(uid, { type: 'message', booking_id: d.booking.id, reference: d.booking.reference || refFor(d.booking.id), sender_name: 'Payment received', preview: d.sys.masked_content, created_at: d.sys.created_at });
      afterPayment(d.booking, d.crewId).catch(e => console.warn('afterPayment:', e.message));
    }
    return { status: r.status };
  });
}
async function afterPayment(booking, crewId) {
  const ref = booking.reference || refFor(booking.id);
  await emailUsers([Number(booking.user_id)], 'Payment received (' + ref + ')', ['We received your payment of ' + naira(booking.client_total) + '. Your booking is confirmed.'], '/?inbox=' + booking.id, 'pay' + booking.id + '-c');
  await emailUsers([crewId], 'Booking paid (' + ref + ')', ['The client has paid for ' + ref + '. You are confirmed for ' + fmtRange(booking) + '.'], '/?inbox=' + booking.id, 'pay' + booking.id + '-p');
}
const naira = n => '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });

app.post('/api/payments/initialize', requireUser, requireVerifiedEmail, wrap(async (req, res) => {
  if (!PAYMENTS_ENABLED || !BACHS_API_KEY) fail(503, 'Online payments are not available yet.');
  const b = await getAccessibleBooking(pool, req, req.body.booking_id);
  if (!ownsBooking(req.user, b)) fail(403, 'Only the client can pay for a booking.');
  if (['cancelled', 'declined', 'refunded', 'expired'].includes(b.status)) fail(409, 'This booking cannot be paid.');
  if (!BLOCKING_STATUSES.includes(b.status)) fail(409, 'You can pay once the crew member has accepted this booking.');
  if (b.payment_status === 'paid') fail(409, 'This booking is already paid.');
  const amount = Number(b.client_total);
  if (!(amount > 0)) fail(400, 'This booking has no payable amount.');
  // Re-use a recent open checkout instead of creating duplicates when the client taps Pay twice.
  const open = (await pool.query(`SELECT * FROM payments WHERE booking_id = $1 AND booking_ids IS NULL AND status = 'pending' AND checkout_url IS NOT NULL AND amount = $2 AND created_at > NOW() - INTERVAL '25 minutes' ORDER BY id DESC LIMIT 1`, [b.id, amount])).rows[0];
  if (open) return res.json({ success: true, reference: open.gateway_reference, amount, checkout_url: open.checkout_url });
  const reference = `TXN-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const base = baseUrl(req);
  const ins = await pool.query(`INSERT INTO payments (booking_id, gateway, gateway_reference, amount, currency, status) VALUES ($1,'bachs',$2,$3,'NGN','pending') RETURNING id`, [b.id, reference, amount]);
  try {
    const session = await bachsFetch('POST', '/v1/checkout-sessions', {
      pricing: { currency: 'NGN', amount: amount.toFixed(2), price_type: 'fixed' },
      customer: { email: req.user.email, name: req.user.name },
      success_url: base + '/?pay=success&booking=' + b.id,
      cancel_url: base + '/?pay=cancelled&booking=' + b.id,
      reference,
      metadata: { booking_id: b.id, payment_id: ins.rows[0].id, booking_reference: b.reference || refFor(b.id) },
      expires_in_minutes: 60
    }, 'crew-' + reference);
    if (!session.checkout_url || !session.checkout_id) throw Object.assign(new Error('The payment provider returned an incomplete response.'), { status: 502 });
    await pool.query('UPDATE payments SET checkout_id = $1, checkout_url = $2 WHERE id = $3', [session.checkout_id, session.checkout_url, ins.rows[0].id]);
    res.json({ success: true, reference, amount, checkout_url: session.checkout_url });
  } catch (e) {
    await pool.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [ins.rows[0].id]);
    throw e;
  }
}));

// Pay for every accepted, unpaid booking of a group in one checkout. Each booking is still paid, invoiced and refunded on its own.
app.post('/api/payments/initialize-group', requireUser, requireVerifiedEmail, wrap(async (req, res) => {
  if (!PAYMENTS_ENABLED || !BACHS_API_KEY) fail(503, 'Online payments are not available yet.');
  const ref = str(req.body && req.body.group_ref, 20);
  if (!ref) fail(400, 'Missing group.');
  const rows = (await pool.query(`SELECT * FROM bookings WHERE group_ref = $1 AND user_id = $2 ORDER BY id`, [ref, req.user.id])).rows;
  if (!rows.length) fail(404, 'Group booking not found.');
  const due = rows.filter(b => BLOCKING_STATUSES.includes(b.status) && b.payment_status !== 'paid' && b.payment_status !== 'refunded' && Number(b.client_total) > 0);
  if (!due.length) fail(409, 'Nothing in this group is ready to pay yet. You can pay once crew members accept.');
  const ids = due.map(b => b.id);
  const amount = due.reduce((t, b) => t + Number(b.client_total), 0);
  const open = (await pool.query(`SELECT * FROM payments WHERE booking_ids = $1::int[] AND status = 'pending' AND checkout_url IS NOT NULL AND amount = $2 AND created_at > NOW() - INTERVAL '25 minutes' ORDER BY id DESC LIMIT 1`, [ids, amount])).rows[0];
  if (open) return res.json({ success: true, reference: open.gateway_reference, amount, count: ids.length, checkout_url: open.checkout_url });
  const reference = `TXN-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const base = baseUrl(req);
  const ins = await pool.query(`INSERT INTO payments (booking_id, booking_ids, gateway, gateway_reference, amount, currency, status) VALUES ($1,$2,'bachs',$3,$4,'NGN','pending') RETURNING id`, [ids[0], ids, reference, amount]);
  try {
    const session = await bachsFetch('POST', '/v1/checkout-sessions', {
      pricing: { currency: 'NGN', amount: amount.toFixed(2), price_type: 'fixed' },
      customer: { email: req.user.email, name: req.user.name },
      success_url: base + '/?pay=success&booking=' + ids[0],
      cancel_url: base + '/?pay=cancelled&booking=' + ids[0],
      reference,
      metadata: { group_ref: ref, payment_id: ins.rows[0].id, booking_ids: ids.join(',') },
      expires_in_minutes: 60
    }, 'crew-' + reference);
    if (!session.checkout_url || !session.checkout_id) throw Object.assign(new Error('The payment provider returned an incomplete response.'), { status: 502 });
    await pool.query('UPDATE payments SET checkout_id = $1, checkout_url = $2 WHERE id = $3', [session.checkout_id, session.checkout_url, ins.rows[0].id]);
    res.json({ success: true, reference, amount, count: ids.length, checkout_url: session.checkout_url });
  } catch (e) {
    await pool.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [ins.rows[0].id]);
    throw e;
  }
}));

// Called when the customer comes back from the hosted checkout (and works even if the webhook is delayed).
app.post('/api/payments/verify', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.body.booking_id);
  if (b.payment_status === 'paid') return res.json({ success: true, status: 'verified' });
  const p = (await pool.query(`SELECT * FROM payments WHERE (booking_id = $1 OR $1 = ANY(booking_ids)) AND status = 'pending' ORDER BY id DESC LIMIT 1`, [b.id])).rows[0];
  if (!p) return res.json({ success: true, status: 'none' });
  res.json({ success: true, ...(await settleFromBachs(p)) });
}));

app.post('/api/payments/webhook', wrap(async (req, res) => {
  if (!BACHS_WEBHOOK_SECRET) fail(503, 'Payment webhook is not configured.');
  if (!req.rawBody || !verifyBachsSignature(req.rawBody, req.headers, BACHS_WEBHOOK_SECRET)) fail(401, 'Invalid signature.');
  const event = req.body || {};
  const strings = collectStrings(event.data);
  if (!strings.length) return res.json({ received: true, ignored: true });
  const p = (await pool.query(`SELECT * FROM payments WHERE gateway = 'bachs' AND status = 'pending' AND (gateway_reference = ANY($1::text[]) OR checkout_id = ANY($1::text[])) ORDER BY id DESC LIMIT 1`, [strings])).rows[0];
  if (!p) return res.json({ received: true, ignored: true }); // unrelated or already settled: acknowledge so Bachs stops retrying
  res.json({ received: true, ...(await settleFromBachs(p)) });
}));

app.get('/api/invoices/:booking_id', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.params.booking_id);
  if (!ownsBooking(req.user, b)) fail(403, 'Invoices are issued to the client who paid.');
  const { rows } = await pool.query('SELECT * FROM invoices WHERE booking_id = $1', [b.id]);
  if (!rows[0]) fail(404, 'Invoice not found.');
  res.json(rows[0]);
}));

/* ---------------- disputes, reviews, messages, teams ---------------- */
app.post('/api/disputes', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.body.booking_id);
  const reason = str(req.body.reason, 2000);
  if (reason.length < 5) fail(400, 'Please describe the issue (at least 5 characters).');
  const mine = ownsBooking(req.user, b) ? 'client' : 'crew';
  const out = await withTx(async db => {
    const ins = await db.query(`INSERT INTO disputes (booking_id, raised_by, reason, status) VALUES ($1,$2,$3,'open') RETURNING *`, [b.id, mine, reason]);
    await db.query(`UPDATE bookings SET status = 'disputed' WHERE id = $1 AND status IN ('confirmed','in_progress','completion_review','completed')`, [b.id]);
    const other = mine === 'client' ? (await crewUserIdsFor(db, b.professional_id))[0] : Number(b.user_id);
    const sys = await insertChatMessage(db, b, req.user, 'system', 'A problem was reported on this booking. Support will review it and get in touch.', null, other);
    return { row: ins.rows[0], sys, other };
  });
  pushChat(b, out.sys, out.other, req.user);
  res.status(201).json(out.row);
}));

app.post('/api/reviews', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.body.booking_id);
  const crewIds = await crewUserIdsFor(pool, b.professional_id);
  const side = ownsBooking(req.user, b) ? 'client' : crewIds.includes(Number(req.user.id)) ? 'crew' : null;
  if (!side) fail(403, 'You can only review your own bookings.');
  if (b.payment_status !== 'paid' || b.status !== 'completed') fail(400, 'You can review a booking once it is paid and the job is marked complete.');
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'Rating must be a whole number from 1 to 5.');
  const row = await withTx(async db => {
    const dup = await db.query('SELECT 1 FROM reviews WHERE booking_id = $1 AND reviewer_type = $2', [b.id, side]);
    if (dup.rows.length) fail(409, 'You have already reviewed this booking.');
    // Crew reviews of a booker are stored against the booker (professional_id stays empty so listing ratings are unaffected).
    const ins = await db.query(
      `INSERT INTO reviews (booking_id, professional_id, subject_user_id, reviewer_type, reviewer_name, rating, comment) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.id, side === 'client' ? b.professional_id : null, side === 'crew' ? b.user_id : null, side, req.user.name, rating, str(req.body.comment, 1000)]);
    if (side === 'client') await db.query(`UPDATE professionals SET rating = (SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE professional_id = $1) WHERE id = $1`, [b.professional_id]);
    return ins.rows[0];
  });
  res.status(201).json(row);
}));

const maskContact = text => text
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[Masked Email]')
  .replace(/\+?[0-9][0-9\s\-().]{7,}[0-9]/g, '[Masked Phone Number]');


/* ---------------- inbox and live account notifications ---------------- */
const messageNotificationSubs = new Map();
/* Live updates reach every replica through Postgres LISTEN/NOTIFY: deliver to our own SSE clients now and tell the others. */
const INSTANCE_ID = crypto.randomBytes(6).toString('hex');
function deliverLocal(evt) {
  if (evt.t === 'chat') { for (const sub of chatSubs.get(evt.b) || []) { try { sub.write('data: ' + JSON.stringify(scrubMoney(evt.row, sub.cmaRole)) + '\n\n'); } catch (e) { /* client gone */ } } }
  else if (evt.t === 'note') { for (const sub of messageNotificationSubs.get(Number(evt.u)) || []) { try { sub.write('data: ' + JSON.stringify(evt.p) + '\n\n'); } catch (e) { /* client gone */ } } }
}
function relay(evt) {
  deliverLocal(evt);
  const payload = JSON.stringify({ i: INSTANCE_ID, e: evt });
  if (payload.length > 7500) { console.warn('Live event too large to relay to other replicas:', evt.t); return; } // NOTIFY payloads are capped at 8000 bytes
  pool.query('SELECT pg_notify($1, $2)', ['cma_events', payload]).catch(() => {});
}
function broadcastChat(bookingId, row) { relay({ t: 'chat', b: bookingId, row }); }
function emitMessageNotification(userId, payload) { if (userId) relay({ t: 'note', u: Number(userId), p: payload }); }
let listenerClient = null;
async function startEventListener() {
  try {
    const client = new (require('pg').Client)({ connectionString: DATABASE_URL, ssl: dbSsl() });
    client.on('error', () => { try { client.end(); } catch (e) { /* already closed */ } });
    client.on('end', () => { if (listenerClient === client) { listenerClient = null; setTimeout(startEventListener, 3000).unref(); } });
    client.on('notification', m => { try { const d = JSON.parse(m.payload); if (d.i !== INSTANCE_ID) deliverLocal(d.e); } catch (e) { /* ignore malformed */ } });
    await client.connect(); await client.query('LISTEN cma_events'); listenerClient = client;
  } catch (e) { console.warn('Live-event listener failed, retrying:', e.message); setTimeout(startEventListener, 5000).unref(); }
}
async function getOtherParticipantId(db,user,booking){
  if(ownsBooking(user,booking)){
    const r=await db.query(
      "SELECT ca.user_id AS user_id " +
      "FROM crew_applications ca JOIN professionals p ON (ca.professional_id=p.id OR p.application_id='app-' || ca.id::text) " +
      "WHERE p.id=$1 AND ca.user_id IS NOT NULL ORDER BY ca.id DESC LIMIT 1",
      [booking.professional_id]);
    return r.rows[0]?.user_id?Number(r.rows[0].user_id):null;
  }
  const r=await db.query("SELECT id FROM users WHERE id=$1 LIMIT 1",[booking.user_id]);
  return r.rows[0]?Number(r.rows[0].id):null;
}
app.get('/api/messages/stream',requireUser,(req,res)=>{
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});
  res.flushHeaders(); res.write('retry: 3000\n\n');
  const uid=Number(req.user.id);
  if(!messageNotificationSubs.has(uid)) messageNotificationSubs.set(uid,new Set());
  const subs=messageNotificationSubs.get(uid); subs.add(res);
  const ping=setInterval(()=>res.write(': ping\n\n'),25000);
  req.on('close',()=>{clearInterval(ping);subs.delete(res);if(!subs.size)messageNotificationSubs.delete(uid);});
});
app.get('/api/inbox',requireUser,wrap(async(req,res)=>{
  const uid=Number(req.user.id);
  const client="(b.user_id=$1)";
  const crew="EXISTS (SELECT 1 FROM professionals px JOIN crew_applications ca ON (ca.professional_id=px.id OR px.application_id='app-' || ca.id::text) WHERE px.id=b.professional_id AND ca.user_id=$1)";
  const role="CASE WHEN "+client+" THEN 'client' ELSE 'crew' END";
  const {rows}=await pool.query(
    "SELECT b.id,b.professional_id,COALESCE(b.reference,'') AS reference,b.client_name,b.project_type,b.status,b.created_at,b.payment_status,b.start_date,b.end_date,b.booking_unit,b.daily_rate,b.client_total,b.crew_net,b.cancel_reason,b.cancelled_by,b.group_title,b.group_ref,b.quantity,b.schedule_kind,(SELECT rate_unit FROM professionals WHERE id=b.professional_id) AS rate_unit,(SELECT COUNT(*)::int FROM reviews rv WHERE rv.booking_id=b.id AND rv.reviewer_type="+role+") AS review_count,p.name AS professional_name,"+role+" AS my_role,"+
    "(SELECT m.masked_content FROM messages m WHERE m.booking_id=b.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message,"+
    "(SELECT MAX(m.created_at) FROM messages m WHERE m.booking_id=b.id) AS last_message_at,"+
    "(SELECT COUNT(*)::int FROM messages m WHERE m.booking_id=b.id AND ((m.sender_user_id IS NOT NULL AND m.sender_user_id<>$1) OR (m.sender_user_id IS NULL AND m.sender_type<>CASE WHEN "+client+" THEN 'client' ELSE 'crew' END)) "+
    "AND NOT EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id=m.id AND mr.user_id=$1)) AS unread_count "+
    "FROM bookings b LEFT JOIN professionals p ON p.id=b.professional_id WHERE "+client+" OR "+crew+
    " ORDER BY COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.booking_id=b.id),b.created_at) DESC LIMIT 100",[uid]);
  res.json({conversations:rows.map(b=>scrubMoney({...b,reference:b.reference||refFor(b.id),unread_count:Number(b.unread_count||0)}, b.my_role))});
}));
app.post('/api/inbox/:bookingId/read',requireUser,wrap(async(req,res)=>{
  const booking=await getAccessibleBooking(pool,req,req.params.bookingId);
  const ownType=ownsBooking(req.user,booking)?'client':'crew';
  await pool.query("INSERT INTO message_reads(message_id,user_id) SELECT m.id,$1 FROM messages m WHERE m.booking_id=$2 AND ((m.sender_user_id IS NOT NULL AND m.sender_user_id<>$1) OR (m.sender_user_id IS NULL AND m.sender_type<>$3)) ON CONFLICT(message_id,user_id) DO NOTHING RETURNING message_id",
    [req.user.id,booking.id,ownType]).then(r=>{ if(r.rows.length) broadcastChat(booking.id,{_read:true,reader:req.user.id,ids:r.rows.map(x=>Number(x.message_id))}); });
  res.json({success:true});
}));

app.get('/api/bookings/:id/messages', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.params.id);
  const { rows } = await pool.query('SELECT m.*, (m.sender_user_id IS NOT NULL AND EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id <> m.sender_user_id)) AS read_by_other FROM messages m WHERE m.booking_id = $1 ORDER BY m.created_at ASC', [b.id]);
  res.json(scrubMoney(rows, roleOf(req, b)));
}));

// Only once payment has succeeded, the two sides can see each other's contact details (never before).
app.get('/api/bookings/:id/contact', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.params.id);
  if (b.payment_status !== 'paid' || !['confirmed', 'in_progress', 'completion_review', 'completed'].includes(b.status)) return res.json({ available: false });
  let uid = null;
  if (ownsBooking(req.user, b)) uid = (await crewUserIdsFor(pool, b.professional_id))[0] || null;
  else uid = b.user_id != null ? Number(b.user_id) : null;
  const u = uid ? (await pool.query('SELECT name, phone, email FROM users WHERE id = $1', [uid])).rows[0] : null;
  if (!u) return res.json({ available: false });
  res.json({ available: true, name: u.name || '', phone: u.phone || '', email: u.email || '' });
}));

// Live delivery: one Server-Sent Events stream per open chat, fed by an in-process subscriber map (single replica).
const chatSubs = new Map();
app.get('/api/bookings/:id/messages/stream', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.params.id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  if (!chatSubs.has(b.id)) chatSubs.set(b.id, new Set());
  if ((sseCount.get(req.user.id) || 0) >= 10) { chatSubs.get(b.id).size || chatSubs.delete(b.id); return res.status(429).end(); }
  sseCount.set(req.user.id, (sseCount.get(req.user.id) || 0) + 1);
  res.cmaRole = roleOf(req, b);
  chatSubs.get(b.id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { sseCount.set(req.user.id, Math.max(0, (sseCount.get(req.user.id) || 1) - 1)); clearInterval(ping); const set = chatSubs.get(b.id); if (set) { set.delete(res); if (!set.size) chatSubs.delete(b.id); } });
}));

const msgRate = new Map(); // user id -> { n, reset }
function msgAllowed(uid) { const now = Date.now(); const r = msgRate.get(uid); if (!r || r.reset < now) { msgRate.set(uid, { n: 1, reset: now + 60000 }); return true; } if (msgRate.size > 20000) msgRate.clear(); return ++r.n <= 40; }
const sseCount = new Map();
app.post('/api/bookings/:id/messages', requireUser, wrap(async (req, res) => {
  if (!msgAllowed(req.user.id)) fail(429, 'You are sending messages too quickly. Please wait a moment.');
  const b = await getAccessibleBooking(pool, req, req.params.id);
  const content = str(req.body.content, 2000);
  if (!content) fail(400, 'Message cannot be empty.');
  const senderType = ownsBooking(req.user, b) ? 'client' : 'crew';
  const recipientId = await getOtherParticipantId(pool, req.user, b);
  const { rows } = await pool.query(
    'INSERT INTO messages (booking_id,sender_type,sender_name,masked_content,sender_user_id,recipient_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [b.id,senderType,req.user.name,maskContact(content),req.user.id,recipientId]);
  broadcastChat(b.id, rows[0]);
  if (recipientId && recipientId !== Number(req.user.id)) {
    emitMessageNotification(recipientId,{type:'message',booking_id:b.id,reference:b.reference||refFor(b.id),sender_name:req.user.name,preview:rows[0].masked_content,created_at:rows[0].created_at});
    emailNewMessage(recipientId, b, req.user.name, rows[0].masked_content).catch(() => {});
  }
  res.status(201).json(scrubMoney(rows[0], senderType));
}));

const OPEN_FOR_OFFERS = ['awaiting_review', 'pending', 'counter_pending', 'confirmed'];
app.post('/api/bookings/:id/offers', requireUser, wrap(async (req, res) => {
  const out = await withTx(async db => {
    const b = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [toInt(req.params.id) || 0])).rows[0];
    if (!b) fail(404, 'Booking not found.');
    if (!(await canAccessBooking(db, req.user, b))) fail(403, 'You do not have access to this booking.');
    if (!OPEN_FOR_OFFERS.includes(b.status)) fail(409, 'This booking is closed, so changes can no longer be proposed.');
    if (b.payment_status === 'paid') fail(409, 'This booking is already paid. Contact support to change it.');
    const pro = (await db.query('SELECT rate, rate_unit FROM professionals WHERE id = $1', [b.professional_id])).rows[0];
    const mine = ownsBooking(req.user, b) ? 'client' : 'crew';
    const o = parseProposal(req.body || {}, b.daily_rate || (pro && pro.rate), pro && pro.rate_unit);
    const holds = BLOCKING_STATUSES.includes(b.status);
    const clash = o.schedule_kind === 'delivery' ? { rows: [] } : await db.query(
      `SELECT 1 FROM availability_blocks WHERE professional_id = $1 AND NOT (end_date < $2 OR start_date > $3)
         AND NOT ($4::boolean AND start_date = $5 AND end_date = $6 AND $7::text = 'calendar') LIMIT 1`, [b.professional_id, o.start_date, o.end_date, holds, b.start_date, b.end_date, b.schedule_kind || 'calendar']);
    if (clash.rows.length) fail(409, 'The professional is not available for those dates.');
    await db.query(`UPDATE messages SET offer = jsonb_set(offer, '{status}', '"superseded"') WHERE booking_id = $1 AND kind IN ('request','offer') AND offer->>'status' = 'pending'`, [b.id]);
    const other = mine === 'client' ? (await crewUserIdsFor(db, b.professional_id))[0] : Number(b.user_id);
    const msg = await insertChatMessage(db, b, req.user, 'offer', str(req.body.note, 1000) || 'Proposed changes to this booking.', { ...o, proposed_by: mine, status: 'pending' }, other);
    if (!holds) await db.query('UPDATE bookings SET status = $1 WHERE id = $2', [mine === 'crew' ? 'counter_pending' : 'awaiting_review', b.id]);
    return { b, msg, other };
  });
  pushChat(out.b, out.msg, out.other, req.user);
  res.status(201).json({ success: true, message: scrubMoney(out.msg, roleOf(req, out.b || out.booking || { user_id: null })) });
}));

app.post('/api/bookings/:id/offers/:messageId/respond', requireUser, wrap(async (req, res) => {
  const response = req.body && req.body.response;
  if (!['accepted', 'declined'].includes(response)) fail(400, 'Response must be accepted or declined.');
  const out = await withTx(async db => {
    const b = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [toInt(req.params.id) || 0])).rows[0];
    if (!b) fail(404, 'Booking not found.');
    if (!(await canAccessBooking(db, req.user, b))) fail(403, 'You do not have access to this booking.');
    const m = (await db.query(`SELECT * FROM messages WHERE id = $1 AND booking_id = $2 AND kind IN ('request','offer') FOR UPDATE`, [toInt(req.params.messageId) || 0, b.id])).rows[0];
    if (!m || !m.offer) fail(404, 'Proposal not found.');
    if (m.offer.status !== 'pending') fail(409, 'This proposal has already been answered or replaced.');
    const mine = ownsBooking(req.user, b) ? 'client' : 'crew';
    if (m.offer.proposed_by === mine) fail(403, 'The other person has to answer your proposal.');
    if (!OPEN_FOR_OFFERS.includes(b.status)) fail(409, 'This booking is closed.');
    const o = m.offer; const holds = BLOCKING_STATUSES.includes(b.status);
    const other = mine === 'client' ? (await crewUserIdsFor(db, b.professional_id))[0] : Number(b.user_id);
    let text; let nextStatus = b.status;
    if (response === 'accepted') {
      await db.query('SELECT id FROM professionals WHERE id = $1 FOR UPDATE', [b.professional_id]);
      const delivery = o.schedule_kind === 'delivery', wasCalendar = (b.schedule_kind || 'calendar') === 'calendar';
      const clash = delivery ? { rows: [] } : await db.query(
        `SELECT 1 FROM availability_blocks WHERE professional_id = $1 AND NOT (end_date < $2 OR start_date > $3)
           AND NOT ($4::boolean AND $7::boolean AND start_date = $5 AND end_date = $6) LIMIT 1`, [b.professional_id, o.start_date, o.end_date, holds, b.start_date, b.end_date, wasCalendar]);
      if (clash.rows.length) fail(409, 'The professional is no longer available on those dates.');
      const price = priceFor(o.booking_unit, o.start_date, o.end_date, o.daily_rate, o.quantity); // recomputed on the server
      if (holds && wasCalendar) await db.query(`DELETE FROM availability_blocks WHERE id = (SELECT id FROM availability_blocks WHERE professional_id = $1 AND start_date = $2 AND end_date = $3 AND reason = 'confirmed booking' LIMIT 1)`, [b.professional_id, b.start_date, b.end_date]);
      if (!delivery) await db.query(`INSERT INTO availability_blocks (professional_id, start_date, end_date, reason) VALUES ($1,$2,$3,'confirmed booking')`, [b.professional_id, o.start_date, o.end_date]);
      if (!holds) nextStatus = 'confirmed';
      await db.query(`UPDATE bookings SET start_date=$1, end_date=$2, booking_unit=$3, daily_rate=$4, client_total=$5, crew_net=$6, status=$7, crew_response='accepted', quantity=$9, schedule_kind=$10 WHERE id=$8`,
        [o.start_date, o.end_date, o.booking_unit, o.daily_rate, price.client_total, price.crew_net, nextStatus, b.id, price.quantity, o.schedule_kind || 'calendar']);
      text = (holds ? 'Change accepted: ' : 'Booking accepted: ') + offerSummary({ ...o, ...price }) + (holds ? '' : ' The client can now proceed to payment to secure this booking. Contact details are shared once payment is received.');
    } else {
      if (m.kind === 'request' && mine === 'crew') { nextStatus = 'declined'; text = 'Request declined.'; }
      else { if (!holds) nextStatus = 'awaiting_review'; text = 'Proposal declined.'; }
      if (nextStatus !== b.status) await db.query('UPDATE bookings SET status = $1 WHERE id = $2', [nextStatus, b.id]);
    }
    const updated = (await setOfferStatus(db, m.id, response)).rows[0];
    const sys = await insertChatMessage(db, b, req.user, 'system', text, null, other);
    const fresh = (await db.query('SELECT * FROM bookings WHERE id = $1', [b.id])).rows[0];
    return { b: fresh, updated, sys, other };
  });
  broadcastChat(out.b.id, out.updated);
  pushChat(out.b, out.sys, out.other, req.user);
  res.json({ success: true, booking: scrubMoney(out.b, roleOf(req, out.b)) });
}));


/* ---------------- crew applications ---------------- */
app.post('/api/crew-applications', requireUser, requireVerifiedEmail, wrap(async (req, res) => {
  // Account approval + identity verification are the publishing gate. New listings
  // are published immediately; administrators can remove them from the marketplace.
  const identity = (await pool.query('SELECT is_verified FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!identity?.is_verified) fail(403, 'Please complete identity verification in your Profile before creating a public listing.');
  const role = str(req.body.role, 120);
  const location = str(req.body.location, 120);
  let portfolio = str(req.body.portfolio, 500);
  const bio = str(req.body.bio, 2000);
  const dailyRate = Math.round(Number(req.body.dailyRate));
  const category = CATEGORIES.find(c => c.toLowerCase() === role.toLowerCase()) || (['makeup', 'other'].includes(role.toLowerCase()) ? 'Creative' : null);
  if (!role) fail(400, 'Please choose your primary role.');
  if (!location) fail(400, 'Please enter your location.');
  if (!category) fail(400, 'Choose a valid crew category.');
  if (!Number.isFinite(dailyRate) || dailyRate < 1000 || dailyRate > 10000000) fail(400, 'Enter a rate between ₦1,000 and ₦10,000,000.');
  if (portfolio) {
    if (!/^https?:\/\//i.test(portfolio)) portfolio = 'https://' + portfolio;
    try { const u = new URL(portfolio); if (u.protocol !== 'https:') throw 0; portfolio = u.toString(); } catch (e) { fail(400, 'Portfolio must be a valid HTTPS link.'); }
  }
  const result = await withTx(async db => {
    const existing = (await db.query("SELECT p.id FROM professionals p JOIN crew_applications ca ON p.application_id = 'app-' || ca.id::text WHERE ca.user_id = $1", [req.user.id])).rows;
    if (existing.length) fail(409, 'You already have a crew profile. Add another listing from your Crew Listing dashboard.');
    const application = (await db.query(
      `INSERT INTO crew_applications (user_id,name,full_name,email,role,location,portfolio,portfolio_url,bio,status)
       VALUES ($1,$2::text,$2::text,$3,$4,$5,$6::text,$6::text,$7,'approved') RETURNING *`,
      [req.user.id, req.user.name, req.user.email, role, location, portfolio || '', bio])).rows[0];
    const skillsCast = SKILLS_IS_JSON ? 'jsonb' : 'text[]';
    const emptySkills = SKILLS_IS_JSON ? '[]' : [];
    const professional = (await db.query(
      `INSERT INTO professionals (application_id,name,role,category,location,bio,"desc",description,showreel,rate,daily_rate,rate_full_day,rate_half_day,skills,verified,status,credits,active,is_active)
       VALUES ($1,$2,$3,$4,$5,$6::text,$7,$6::text,$8,$9::numeric,$9::numeric,$9::numeric,$10::numeric,$11::${skillsCast},TRUE,'approved','',TRUE,TRUE)
       RETURNING *`,
      ['app-' + application.id, req.user.name, role, category, location, bio, bio.slice(0,200), portfolio || null, dailyRate, Math.round(dailyRate / 2), emptySkills])).rows[0];
    await db.query('UPDATE crew_applications SET professional_id = $1 WHERE id = $2', [professional.id, application.id]);
    return { application: { ...application, status: 'approved', professional_id: professional.id }, professional };
  });
  res.status(201).json({ success: true, application: result.application, listing: listingView(result.professional) });
}));

/* ---------------- admin accounts: password + authenticator app ---------------- */
const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true, requestWasSuccessful: (req, res) => res.statusCode < 400, message: { error: 'Too many attempts. Try again in a few minutes.' } });
const adminView = a => ({ id: a.id, name: a.name, email: a.email });
app.get('/api/admin/auth/config', wrap(async (req, res) => {
  const n = (await pool.query('SELECT COUNT(*)::int AS n FROM admin_users')).rows[0].n;
  res.json({ accounts: n > 0, tokenLogin: ADMIN_TOKEN_AUTH && ADMIN_TOKENS.length > 0 });
}));
app.post('/api/admin/auth/login', adminLoginLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase(), password = String(req.body.password || '').slice(0, 200);
  const a = (await pool.query('SELECT * FROM admin_users WHERE email = $1', [email])).rows[0];
  const ok = await bcrypt.compare(password, a ? a.password_hash : DUMMY_HASH);
  if (!a || a.disabled || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });
  let pending = null, setup = null;
  if (!a.totp_secret) {
    const secret = b32enc(crypto.randomBytes(20)); pending = sealSecret(secret);
    const uri = 'otpauth://totp/' + encodeURIComponent('Crew Management:' + a.email) + '?secret=' + secret + '&issuer=' + encodeURIComponent('Crew Management');
    setup = { secret, otpauth: uri, qr: await require('qrcode').toDataURL(uri, { margin: 1, width: 220 }) };
  }
  const ticket = crypto.randomBytes(24).toString('hex');
  await pool.query('DELETE FROM admin_login_tickets WHERE admin_id = $1 OR expires_at < NOW()', [a.id]);
  await pool.query(`INSERT INTO admin_login_tickets (token_hash, admin_id, pending_secret, expires_at) VALUES ($1,$2,$3, NOW() + INTERVAL '10 minutes')`, [sha256(ticket), a.id, pending]);
  res.json({ success: true, step: setup ? 'enroll' : 'code', ticket, setup });
}));
app.post('/api/admin/auth/verify', adminLoginLimiter, wrap(async (req, res) => {
  const code = String(req.body.code || '').replace(/\s/g, '').toLowerCase().slice(0, 40);
  const out = await withTx(async db => {
    const t = (await db.query(`SELECT * FROM admin_login_tickets WHERE token_hash = $1 AND expires_at > NOW() FOR UPDATE`, [sha256(String(req.body.ticket || ''))])).rows[0];
    if (!t) fail(401, 'This sign-in has expired. Start again.');
    if (t.attempts >= 5) { await db.query('DELETE FROM admin_login_tickets WHERE token_hash = $1', [t.token_hash]); fail(401, 'Too many wrong codes. Start again.'); }
    await db.query('UPDATE admin_login_tickets SET attempts = attempts + 1 WHERE token_hash = $1', [t.token_hash]);
    const a = (await db.query('SELECT * FROM admin_users WHERE id = $1 FOR UPDATE', [t.admin_id])).rows[0];
    if (!a || a.disabled) fail(401, 'This account is disabled.');
    let recovery = null, usedRecovery = false;
    if (t.pending_secret) {
      const step = totpMatch(openSecret(t.pending_secret), code, 0);
      if (step === null) fail(401, 'That code is not right. Check the time on your phone and try the next code.');
      recovery = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').replace(/^(.{5})(.{5})$/, '$1-$2'));
      await db.query('UPDATE admin_users SET totp_secret = $1, totp_last_step = $2, recovery_hashes = $3 WHERE id = $4', [t.pending_secret, step, recovery.map(sha256), a.id]);
    } else if (/^\d{6}$/.test(code)) {
      const step = totpMatch(openSecret(a.totp_secret), code, a.totp_last_step);
      if (step === null) fail(401, 'That code is not right or was already used.');
      await db.query('UPDATE admin_users SET totp_last_step = $1 WHERE id = $2', [step, a.id]);
    } else {
      const h = sha256(code);
      if (!(a.recovery_hashes || []).includes(h)) fail(401, 'That code is not right.');
      await db.query('UPDATE admin_users SET recovery_hashes = array_remove(recovery_hashes, $1) WHERE id = $2', [h, a.id]);
      usedRecovery = true;
    }
    await db.query('DELETE FROM admin_login_tickets WHERE token_hash = $1', [t.token_hash]);
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(`INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES ($1,$2, NOW() + ($3 || ' hours')::interval)`, [sha256(token), a.id, String(ADMIN_SESSION_HOURS)]);
    await db.query('UPDATE admin_users SET last_login = NOW() WHERE id = $1', [a.id]);
    await audit(db, { adminName: a.name, ip: req.ip }, usedRecovery ? 'admin_login_recovery_code' : 'admin_login', null, {});
    return { token, admin: adminView(a), recovery, usedRecovery };
  });
  res.cookie(ADMIN_COOKIE, out.token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: ADMIN_SESSION_HOURS * 3600000, path: '/api/admin' });
  res.json({ success: true, admin: out.admin, recovery_codes: out.recovery, used_recovery_code: out.usedRecovery });
}));
app.get('/api/admin/auth/me', wrap(async (req, res) => { const a = await adminFromRequest(req); res.json({ admin: a ? adminView(a) : null }); }));
app.post('/api/admin/auth/logout', wrap(async (req, res) => {
  const tok = parseCookies(req)[ADMIN_COOKIE]; if (tok) await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256(tok)]);
  res.clearCookie(ADMIN_COOKIE, { path: '/api/admin' }); res.json({ success: true });
}));

/* ---------------- admin API (session cookie, or x-admin-token while enabled) ---------------- */
app.get('/api/admin/accounts', adminGuard, wrap(async (req, res) => {
  res.json({ accounts: (await pool.query('SELECT id, name, email, disabled, last_login, (totp_secret IS NOT NULL) AS two_factor, created_at FROM admin_users ORDER BY id')).rows });
}));
app.post('/api/admin/accounts', adminGuard, wrap(async (req, res) => {
  const name = str(req.body.name, 60), email = str(req.body.email, 254).toLowerCase(), password = String(req.body.password || '');
  if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Enter the admin\'s name and a valid email.');
  if (password.length < 12 || password.length > 200 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) fail(400, 'Admin passwords need at least 12 characters with a letter and a number.');
  totpKey(); // fail early if 2FA cannot be set up
  const hash = await bcrypt.hash(password, 12);
  const row = (await pool.query('INSERT INTO admin_users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email', [name, email, hash])).rows[0];
  await audit(pool, req, 'admin_account_created', null, { admin: row.name, email: row.email });
  res.status(201).json({ success: true, account: row });
}));
app.patch('/api/admin/accounts/:id', adminGuard, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid id.');
  if (req.adminId === id) fail(400, 'You cannot change your own account here.');
  const reset2fa = req.body.reset_2fa === true, disabled = typeof req.body.disabled === 'boolean' ? req.body.disabled : null;
  if (!reset2fa && disabled === null) fail(400, 'Nothing to change.');
  const row = await withTx(async db => {
    const a = (await db.query('SELECT * FROM admin_users WHERE id = $1 FOR UPDATE', [id])).rows[0]; if (!a) fail(404, 'Admin not found.');
    if (disabled !== null) await db.query('UPDATE admin_users SET disabled = $1 WHERE id = $2', [disabled, id]);
    if (reset2fa) await db.query(`UPDATE admin_users SET totp_secret = NULL, totp_last_step = 0, recovery_hashes = '{}' WHERE id = $1`, [id]);
    if (reset2fa || disabled) await db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [id]);
    await audit(db, req, reset2fa ? 'admin_2fa_reset' : disabled ? 'admin_disabled' : 'admin_enabled', null, { admin: a.name });
    return a;
  });
  res.json({ success: true });
}));
app.get('/api/admin/professionals', adminGuard, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT p.id, p.name, p.role, p.category, p.verified, p.is_active, p.rating, (SELECT COUNT(*)::int FROM reviews r WHERE r.professional_id = p.id) AS review_count FROM professionals p ORDER BY p.id`);
  res.json({ professionals: rows });
}));
app.get('/api/admin/payouts', adminGuard, wrap(async (req, res) => {
  const due = (await pool.query(`SELECT b.id, b.reference, b.client_name, b.crew_net, b.completed_at, p.name AS professional_name FROM bookings b JOIN professionals p ON p.id = b.professional_id WHERE b.status = 'completed' AND b.payment_status = 'paid' AND COALESCE(b.payout_status,'') <> 'paid' ORDER BY b.completed_at NULLS LAST, b.id`)).rows;
  const paid = (await pool.query(`SELECT po.id, po.booking_id, po.amount, po.payout_reference, po.created_at, p.name AS professional_name, b.reference FROM payouts po JOIN professionals p ON p.id = po.professional_id LEFT JOIN bookings b ON b.id = po.booking_id ORDER BY po.id DESC LIMIT 50`)).rows;
  res.json({ due: due.map(b => ({ ...b, reference: b.reference || refFor(b.id) })), paid: paid.map(b => ({ ...b, reference: b.reference || refFor(b.booking_id) })) });
}));
app.get('/api/admin/overview', adminGuard, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE account_status = 'pending_review')::int AS pending,
      COUNT(*) FILTER (WHERE is_verified)::int AS verified,
      COUNT(*) FILTER (WHERE is_suspicious)::int AS suspicious,
      COUNT(*) FILTER (WHERE is_suspended)::int AS suspended,
      COUNT(*) FILTER (WHERE account_type = 'crew')::int AS crew,
      COUNT(*) FILTER (WHERE account_type = 'client')::int AS clients
    FROM users`);
  res.json({ stats: rows[0] });
}));

app.get('/api/admin/users', adminGuard, wrap(async (req, res) => {
  const where = []; const params = [];
  const { status, filter, q } = req.query;
  if (['pending_review', 'approved', 'rejected'].includes(status)) { params.push(status); where.push(`account_status = $${params.length}`); }
  if (filter === 'suspicious') where.push('is_suspicious');
  if (filter === 'suspended') where.push('is_suspended');
  if (filter === 'unverified') where.push('NOT is_verified');
  if (q && String(q).trim()) { params.push(`%${String(q).trim().slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`); where.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`); }
  const { rows } = await pool.query(
    `SELECT id, name AS full_name, email, account_type, account_status, is_verified, is_suspicious, is_suspended, reviewed_at, admin_notes, terms_accepted_at, terms_version, created_at
       FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 200`, params);
  res.json({ users: rows });
}));

const USER_ACTIONS = {
  approve: `account_status = 'approved', reviewed_at = NOW()`,
  reject: `account_status = 'rejected', reviewed_at = NOW()`,
  verify: 'is_verified = TRUE',
  unverify: 'is_verified = FALSE',
  flag_suspicious: 'is_suspicious = TRUE',
  clear_suspicious: 'is_suspicious = FALSE',
  suspend: 'is_suspended = TRUE',
  reactivate: 'is_suspended = FALSE'
};
app.patch('/api/admin/users/:id/action', adminGuard, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid account id.');
  const action = String(req.body.action || '');
  const user = await withTx(async db => {
    let row;
    if (action === 'save_notes') {
      row = (await db.query('UPDATE users SET admin_notes = $1 WHERE id = $2 RETURNING *', [str(req.body.notes, 2000), id])).rows[0];
    } else if (USER_ACTIONS[action]) {
      row = (await db.query(`UPDATE users SET ${USER_ACTIONS[action]} WHERE id = $1 RETURNING *`, [id])).rows[0];
      if (row && ['reject', 'suspend'].includes(action)) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    } else fail(400, 'Unknown action.');
    if (!row) fail(404, 'Account not found.');
    await audit(db, req, action, row, {});
    return row;
  });
  res.json({ success: true, user: publicUser(user) });
}));


app.get('/api/admin/id-documents', adminGuard, wrap(async(req,res)=>{
  const {rows}=await pool.query("SELECT d.id,d.user_id,u.name,u.email,d.document_type,d.original_name,d.mime_type,d.review_status,d.review_note,d.created_at FROM id_documents d JOIN users u ON u.id=d.user_id ORDER BY CASE WHEN d.review_status='pending' THEN 0 ELSE 1 END,d.created_at DESC LIMIT 300");
  res.json({documents:rows});
}));
app.get('/api/admin/id-documents/:id/file', adminGuard, wrap(async(req,res)=>{
  const id=toInt(req.params.id); if(!id) fail(400,'Invalid document id.');
  const row=(await pool.query('SELECT original_name,mime_type,encrypted_data,encryption_iv,encryption_tag FROM id_documents WHERE id=$1',[id])).rows[0];
  if(!row) fail(404,'Document not found.');
  res.set({'Content-Type':row.mime_type,'Content-Disposition':'attachment; filename="'+safeIdFilename(row.original_name)+'"','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
  res.send(decryptIdentity(row));
}));
app.patch('/api/admin/id-documents/:id/review', adminGuard, wrap(async(req,res)=>{
  const id=toInt(req.params.id); if(!id) fail(400,'Invalid document id.');
  const status=String(req.body.status||''); if(!['approved','rejected'].includes(status)) fail(400,'Choose approved or rejected.');
  const note=str(req.body.note,1000);
  await withTx(async db=>{
    const doc=(await db.query('UPDATE id_documents SET review_status=$1,review_note=$2,reviewed_at=NOW(),updated_at=NOW() WHERE id=$3 RETURNING *',[status,note||null,id])).rows[0];
    if(!doc) fail(404,'Document not found.');
    const approved=await db.query("SELECT 1 FROM id_documents WHERE user_id=$1 AND review_status='approved' LIMIT 1",[doc.user_id]);
    await syncIdentityVerification(db,doc.user_id,!!approved.rowCount);
    await audit(db,req,'identity_document_'+status,{id:doc.user_id},{documentId:doc.id,documentType:doc.document_type});
  });
  res.json({success:true});
}));

/* ---------------- call sheets: a free tool for any account; shared by an unguessable link ---------------- */
const isTime = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
function cleanSheet(b) {
  const t = (v, n) => str(v, n);
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  const time = v => (isTime(v) ? v : '');
  const map = String(b.mapUrl || '').trim();
  return {
    title: t(b.title, 120), project: t(b.project, 120), date: isDate(b.date) ? b.date : '', location: t(b.location, 200),
    mapUrl: /^https?:\/\/[^\s]{4,300}$/i.test(map) ? map : '', generalCall: time(b.generalCall), wrap: time(b.wrap),
    producer: t(b.producer, 80), director: t(b.director, 80), notes: t(b.notes, 2000), hospital: t(b.hospital, 200),
    emergency: list(b.emergency, 6).map(e => ({ name: t(e && e.name, 80), phone: t(e && e.phone, 30) })).filter(e => e.name || e.phone),
    schedule: list(b.schedule, 40).map(r => ({ time: time(r && r.time), item: t(r && r.item, 200) })).filter(r => r.item),
    crew: list(b.crew, 150).map(c => ({ name: t(c && c.name, 80), role: t(c && c.role, 80), call: time(c && c.call), phone: t(c && c.phone, 30), bookingId: toInt(c && c.bookingId) || null })).filter(c => c.name),
    showPhones: b.showPhones === true
  };
}
const sheetRow = r => ({ id: r.id, token: r.token, data: r.data, created_at: r.created_at, updated_at: r.updated_at });

/* ============ Job board: bookers post what they need, crew pick what they can do ============ */
const JOB_CATS = ['Camera', 'Production', 'Editing', 'Lighting', 'Sound', 'Creative'];
const jobPublic = j => ({ id: j.id, title: j.title, category: j.category, role: j.role || '', description: j.description, location: j.location, budget: j.budget, start_date: j.start_date, end_date: j.end_date, status: j.status, created_at: j.created_at, applicants: Number(j.applicants || 0), applied: !!j.applied, mine: !!j.mine });
async function loadJobs(where, params, uid) {
  const { rows } = await pool.query(
    `SELECT j.*, (SELECT COUNT(*) FROM job_applications a WHERE a.job_id = j.id) AS applicants,
            ${uid ? 'EXISTS(SELECT 1 FROM job_applications a WHERE a.job_id = j.id AND a.user_id = ' + Number(uid) + ')' : 'FALSE'} AS applied,
            ${uid ? '(j.owner_id = ' + Number(uid) + ')' : 'FALSE'} AS mine
       FROM job_posts j WHERE ${where} ORDER BY j.created_at DESC LIMIT 100`, params);
  return rows.map(jobPublic);
}
app.get('/api/jobs', wrap(async (req, res) => {
  const user = await loadUser(req).catch(() => null);
  const cat = str(req.query.category, 40), q = str(req.query.q, 60).toLowerCase();
  const jobs = await loadJobs(`j.status = 'open' AND j.end_date >= $1::date AND ($2::text = '' OR j.category = $2::text) AND ($3::text = '' OR LOWER(j.title || ' ' || j.location || ' ' || COALESCE(j.role,'')) LIKE '%' || $3::text || '%')`, [todayLagos(), cat, q], user?.id);
  res.json({ jobs });
}));
app.post('/api/jobs', requireUser, requireApproved, requireVerifiedEmail, wrap(async (req, res) => {
  const b = req.body || {};
  if (!profileComplete(req.user)) fail(400, 'Please complete your profile (full name, phone and location) before posting a job.');
  const title = str(b.title, 140), role = str(b.role, 80), description = str(b.description, 3000), location = str(b.location, 120);
  const category = JOB_CATS.includes(b.category) ? b.category : '';
  const budget = b.budget === '' || b.budget == null ? null : Number(b.budget);
  if (title.length < 4) fail(400, 'Give the job a clear title.');
  if (!category) fail(400, 'Choose a category.');
  if (description.length < 20) fail(400, 'Describe the scope of work in a few sentences so crew know what to expect.');
  if (location.length < 2) fail(400, 'Add the shoot location.');
  if (budget != null && (!Number.isSafeInteger(budget) || budget < 1000 || budget > 100000000)) fail(400, 'Enter the budget as a whole number of naira.');
  if (!isDate(b.startDate) || !isDate(b.endDate) || b.endDate < b.startDate) fail(400, 'Choose valid start and end dates.');
  if (b.startDate < todayLagos()) fail(400, 'The start date cannot be in the past.');
  const open = await pool.query(`SELECT COUNT(*)::int AS n FROM job_posts WHERE owner_id = $1 AND status = 'open'`, [req.user.id]);
  if (open.rows[0].n >= 10) fail(429, 'You can have up to 10 open jobs at a time. Close one first.');
  const r = await pool.query(`INSERT INTO job_posts (owner_id, title, category, role, description, location, budget, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.user.id, title, category, role, description, location, budget, b.startDate, b.endDate]);
  res.status(201).json({ job: jobPublic({ ...r.rows[0], mine: true }) });
}));
app.post('/api/jobs/:id/apply', requireUser, requireApproved, requireVerifiedEmail, wrap(async (req, res) => {
  const b = req.body || {};
  const job = (await pool.query(`SELECT * FROM job_posts WHERE id = $1`, [toInt(req.params.id) || 0])).rows[0];
  if (!job || job.status !== 'open') fail(404, 'This job is no longer open.');
  if (job.owner_id === req.user.id) fail(400, 'You cannot apply to your own job.');
  const mine = await crewProfessionalIds(pool, req.user);
  if (!mine.length) fail(403, 'Publish a crew profile first, then you can apply to jobs.');
  // Apply with a listing that is approved and live. A user can own several (paused, removed or pending ones too), so do not just take the first.
  const wanted = toInt(b.professionalId);
  if (wanted && !mine.includes(wanted)) fail(403, 'That listing is not yours.');
  const pro = (await pool.query(`SELECT id, name FROM professionals WHERE id = ANY($1::int[]) AND ($2::int IS NULL OR id = $2::int) AND status = 'approved' AND is_active = TRUE ORDER BY id LIMIT 1`, [mine, wanted || null])).rows[0];
  if (!pro) fail(403, 'You need an approved, live listing to apply. Check My listing: it must be approved by an admin and not paused.');
  const proId = pro.id;
  const message = str(b.message, 1500), quote = b.quote === '' || b.quote == null ? null : Number(b.quote);
  if (message.length < 10) fail(400, 'Tell the booker why you are a good fit (a few words is fine).');
  if (quote != null && (!Number.isSafeInteger(quote) || quote < 1 || quote > 100000000)) fail(400, 'Enter your quote as a whole number of naira.');
  try { await pool.query(`INSERT INTO job_applications (job_id, user_id, professional_id, message, quote) VALUES ($1,$2,$3,$4,$5)`, [job.id, req.user.id, proId, message, quote]); }
  catch (e) { if (e.code === '23505') fail(409, 'You have already applied to this job.'); throw e; }
  emailUsers([job.owner_id], pro.name + ' applied to "' + job.title + '"', ['A crew member is interested in your job post.', 'Open your job board to review their message and accept.'], '/', 'job-app-' + job.id).catch(() => {});
  res.status(201).json({ success: true });
}));
app.get('/api/my/jobs', requireUser, wrap(async (req, res) => {
  const jobs = await loadJobs('j.owner_id = $1', [req.user.id], req.user.id);
  const apps = (await pool.query(
    `SELECT a.id, a.job_id, a.professional_id, a.message, a.quote, a.status, a.created_at, p.name, p.role, p.rate, p.rate_unit
       FROM job_applications a JOIN professionals p ON p.id = a.professional_id JOIN job_posts j ON j.id = a.job_id WHERE j.owner_id = $1 ORDER BY a.created_at`, [req.user.id])).rows;
  const applied = (await pool.query(
    `SELECT a.id, a.job_id, a.status, a.quote, j.title, j.location FROM job_applications a JOIN job_posts j ON j.id = a.job_id WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [req.user.id])).rows;
  res.json({ jobs: jobs.map(j => ({ ...j, applications: apps.filter(a => a.job_id === j.id) })), applied });
}));
app.post('/api/jobs/:id/close', requireUser, wrap(async (req, res) => {
  const r = await pool.query(`UPDATE job_posts SET status = 'closed' WHERE id = $1 AND owner_id = $2 AND status = 'open' RETURNING id`, [toInt(req.params.id) || 0, req.user.id]);
  if (!r.rows.length) fail(404, 'Job not found.');
  res.json({ success: true });
}));
// Accepting an applicant opens a normal booking request (same chat, payment and protections as any booking).
app.post('/api/jobs/:id/applications/:appId/accept', requireUser, requireApproved, requireVerifiedEmail, wrap(async (req, res) => {
  const out = await withTx(async db => {
    const job = (await db.query(`SELECT * FROM job_posts WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [toInt(req.params.id) || 0, req.user.id])).rows[0];
    if (!job || job.status !== 'open') fail(404, 'This job is not open.');
    const app_ = (await db.query(`SELECT * FROM job_applications WHERE id = $1 AND job_id = $2`, [toInt(req.params.appId) || 0, job.id])).rows[0];
    if (!app_) fail(404, 'Application not found.');
    const ds = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
    const note = 'Job: ' + job.title + '\n' + job.description + (app_.quote ? '\n\nYour quote: ₦' + Number(app_.quote).toLocaleString('en-NG') + ' (agree the final price in this chat).' : '');
    const body = { startDate: ds(job.start_date), endDate: ds(job.end_date), quantity: 8 };
    const r = await createBookingRequest(db, req.user, app_.professional_id, body, note.slice(0, 2000), null);
    await db.query(`UPDATE job_applications SET status = CASE WHEN id = $1 THEN 'accepted' ELSE 'declined' END WHERE job_id = $2`, [app_.id, job.id]);
    await db.query(`UPDATE job_posts SET status = 'filled', hired_booking_id = $1 WHERE id = $2`, [r.booking.id, job.id]);
    return r;
  });
  pushChat(out.booking, out.msg, out.crewId, req.user);
  res.status(201).json({ success: true, booking: scrubMoney(out.booking, 'client') });
}));

async function ownSheet(req) {
  const r = (await pool.query('SELECT * FROM call_sheets WHERE id = $1 AND owner_id = $2', [toInt(req.params.id) || 0, req.user.id])).rows[0];
  if (!r) fail(404, 'Call sheet not found.');
  return r;
}
// Only crew booked by this client and still active; phone numbers only once the booking is paid.
app.get('/api/callsheets/booked-crew', requireUser, wrap(async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : null;
  const { rows } = await pool.query(
    `SELECT b.id, b.professional_id, b.start_date, b.end_date, b.payment_status, p.name, p.role FROM bookings b JOIN professionals p ON p.id = b.professional_id
      WHERE b.user_id = $1 AND b.status IN ('confirmed','in_progress') AND ($2::date IS NULL OR ($2::date BETWEEN b.start_date AND b.end_date)) ORDER BY b.start_date, p.name LIMIT 100`, [req.user.id, date]);
  const out = [];
  for (const b of rows) {
    let phone = '';
    if (b.payment_status === 'paid') { const uid = (await crewUserIdsFor(pool, b.professional_id))[0]; if (uid) phone = (await pool.query('SELECT phone FROM users WHERE id = $1', [uid])).rows[0]?.phone || ''; }
    out.push({ bookingId: b.id, name: b.name, role: b.role, call: '', phone });
  }
  res.json({ crew: out });
}));
app.get('/api/callsheets', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM call_sheets WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT 100', [req.user.id]);
  res.json({ sheets: rows.map(sheetRow) });
}));
app.post('/api/callsheets', requireUser, wrap(async (req, res) => {
  const n = (await pool.query('SELECT COUNT(*)::int AS n FROM call_sheets WHERE owner_id = $1', [req.user.id])).rows[0].n;
  if (n >= 50) fail(429, 'You have reached the limit of 50 call sheets. Delete an old one first.');
  const data = cleanSheet(req.body || {});
  if (!data.title) fail(400, 'Give the call sheet a title.');
  const token = crypto.randomBytes(12).toString('base64url');
  const r = (await pool.query('INSERT INTO call_sheets (owner_id, token, data) VALUES ($1,$2,$3) RETURNING *', [req.user.id, token, JSON.stringify(data)])).rows[0];
  res.status(201).json({ sheet: sheetRow(r) });
}));
app.put('/api/callsheets/:id', requireUser, wrap(async (req, res) => {
  const cur = await ownSheet(req);
  const data = cleanSheet(req.body || {});
  if (!data.title) fail(400, 'Give the call sheet a title.');
  const r = (await pool.query('UPDATE call_sheets SET data = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [cur.id, JSON.stringify(data)])).rows[0];
  res.json({ sheet: sheetRow(r) });
}));
app.delete('/api/callsheets/:id', requireUser, wrap(async (req, res) => {
  const cur = await ownSheet(req);
  await pool.query('DELETE FROM call_sheets WHERE id = $1', [cur.id]);
  res.json({ success: true });
}));
// Tell the booked crew on the sheet (in the app and by email) that it is ready or has changed.
app.post('/api/callsheets/:id/notify', requireUser, wrap(async (req, res) => {
  const cur = await ownSheet(req);
  const ids = [...new Set((cur.data.crew || []).map(c => c.bookingId).filter(Boolean))];
  if (!ids.length) fail(400, 'Add crew booked through the app to notify them.');
  const { rows } = await pool.query(`SELECT id, professional_id, reference FROM bookings WHERE id = ANY($1::int[]) AND user_id = $2`, [ids, req.user.id]);
  const link = appBase() + '/sheet/' + cur.token;
  let told = 0;
  for (const b of rows) {
    const uid = (await crewUserIdsFor(pool, b.professional_id))[0]; if (!uid) continue;
    emitMessageNotification(uid, { type: 'message', booking_id: b.id, reference: b.reference || refFor(b.id), sender_name: req.user.name, preview: 'Call sheet: ' + (cur.data.title || 'your shoot') + (cur.data.date ? ' · ' + cur.data.date : ''), created_at: new Date().toISOString() });
    emailUsers([uid], 'Call sheet: ' + (cur.data.title || 'your shoot'), [req.user.name + ' shared the call sheet for ' + (cur.data.title || 'your shoot') + (cur.data.date ? ' on ' + cur.data.date : '') + '.', 'Open it here: ' + link], '/?sheet=' + cur.token, 'sheet' + cur.id + '-' + Date.now()).catch(() => {});
    told++;
  }
  res.json({ success: true, notified: told });
}));
// Public, read-only. Crew phone numbers are hidden unless the producer turned them on.
app.get('/api/public/callsheets/:token', wrap(async (req, res) => {
  const r = (await pool.query('SELECT data, updated_at FROM call_sheets WHERE token = $1', [String(req.params.token).slice(0, 24)])).rows[0];
  if (!r) fail(404, 'This call sheet link is not valid any more.');
  const d = { ...r.data, crew: (r.data.crew || []).map(c => ({ name: c.name, role: c.role, call: c.call, phone: r.data.showPhones ? c.phone : '' })) };
  res.set('X-Robots-Tag', 'noindex, nofollow').json({ sheet: d, updated_at: r.updated_at });
}));

/* ---------------- admin: disputes, chat review and support messages ---------------- */
// Admins can read a booking chat only through a dispute, with a written reason that goes into the audit log.
const DISPUTE_SELECT = `SELECT d.id, d.status, d.reason, d.raised_by, d.created_at, d.outcome, d.resolution, d.resolved_by, d.resolved_at,
    b.id AS booking_id, COALESCE(b.reference,'') AS reference, b.status AS booking_status, b.payment_status, b.client_name, b.client_email, b.client_total, b.crew_net,
    b.start_date, b.end_date, p.name AS crew_name
  FROM disputes d JOIN bookings b ON b.id = d.booking_id LEFT JOIN professionals p ON p.id = b.professional_id`;
app.get('/api/admin/disputes', adminGuard, wrap(async (req, res) => {
  const { rows } = await pool.query(DISPUTE_SELECT + ` ORDER BY (d.status = 'open') DESC, d.created_at DESC LIMIT 200`);
  res.json({ disputes: rows.map(r => ({ ...r, reference: r.reference || refFor(r.booking_id) })) });
}));
async function loadDispute(db, id) {
  const d = (await db.query(DISPUTE_SELECT + ' WHERE d.id = $1', [toInt(id)])).rows[0];
  if (!d) fail(404, 'Dispute not found.');
  return d;
}
const disputeBooking = (d) => ({ id: d.booking_id, reference: d.reference || refFor(d.booking_id) });
app.post('/api/admin/disputes/:id/open', adminGuard, wrap(async (req, res) => {
  const reason = str(req.body.reason, 300);
  if (reason.length < 10) fail(400, 'Write a short reason (at least 10 characters) for opening this chat. It is saved in the audit log.');
  const d = await loadDispute(pool, req.params.id);
  const { rows } = await pool.query('SELECT * FROM messages WHERE booking_id = $1 ORDER BY created_at ASC', [d.booking_id]);
  await audit(pool, req, 'chat_viewed', { id: null, name: d.client_name, email: d.client_email }, { reference: d.reference || refFor(d.booking_id), dispute_id: d.id, reason });
  res.json({ dispute: { ...d, reference: d.reference || refFor(d.booking_id) }, messages: rows });
}));
async function bookingParties(db, bookingId) {
  const b = (await db.query('SELECT * FROM bookings WHERE id = $1', [bookingId])).rows[0];
  const crewIds = await crewUserIdsFor(db, b.professional_id);
  return { b, ids: [b.user_id, crewIds[0]].filter(Boolean) };
}
async function postSupportMessage(db, req, d, text, kind) {
  const { b, ids } = await bookingParties(db, d.booking_id);
  const row = (await db.query(`INSERT INTO messages (booking_id,sender_type,sender_name,masked_content,sender_user_id,recipient_user_id,kind) VALUES ($1,'admin','Support team',$2,NULL,NULL,$3) RETURNING *`, [b.id, text, kind])).rows[0];
  return { b, ids, row };
}
function notifySupport(b, ids, row, title) {
  broadcastChat(b.id, row);
  const ref = b.reference || refFor(b.id);
  for (const uid of ids) {
    emitMessageNotification(uid, { type: 'message', booking_id: b.id, reference: ref, sender_name: 'Support team', preview: row.masked_content, created_at: row.created_at });
    emailUsers([uid], title + ' (' + ref + ')', ['Our support team posted an update on your booking ' + ref + ':', String(row.masked_content).slice(0, 600)], '/?inbox=' + b.id, 'sup' + row.id).catch(() => {});
  }
}
app.post('/api/admin/disputes/:id/messages', adminGuard, wrap(async (req, res) => {
  const text = str(req.body.text, 2000);
  if (!text) fail(400, 'Write a message first.');
  const d = await loadDispute(pool, req.params.id);
  const out = await withTx(async db => { const r = await postSupportMessage(db, req, d, text, 'text'); await audit(db, req, 'support_message', { id: null, name: d.client_name, email: d.client_email }, { reference: d.reference || refFor(d.booking_id), dispute_id: d.id }); return r; });
  notifySupport(out.b, out.ids, out.row, 'Message from our support team');
  res.status(201).json({ success: true, message: out.row });
}));
const DISPUTE_OUTCOMES = {
  refund_client: 'The client is refunded',
  pay_crew: 'The crew member is paid',
  dismiss: 'No change: the booking continues'
};
app.post('/api/admin/disputes/:id/resolve', adminGuard, wrap(async (req, res) => {
  const outcome = String(req.body.outcome || '');
  const note = str(req.body.note, 1000);
  if (!DISPUTE_OUTCOMES[outcome]) fail(400, 'Choose an outcome.');
  if (note.length < 10) fail(400, 'Write the decision for both sides (at least 10 characters).');
  const d = await loadDispute(pool, req.params.id);
  if (d.status !== 'open') fail(409, 'This dispute is already resolved.');
  const out = await withTx(async db => {
    await db.query('SELECT id FROM disputes WHERE id = $1 FOR UPDATE', [d.id]);
    const cur = (await db.query('SELECT status FROM disputes WHERE id = $1', [d.id])).rows[0];
    if (cur.status !== 'open') fail(409, 'This dispute is already resolved.');
    const b = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [d.booking_id])).rows[0];
    if (outcome === 'refund_client') {
      await db.query(`UPDATE bookings SET status = 'refunded', payment_status = CASE WHEN payment_status = 'paid' THEN 'refunded' ELSE payment_status END WHERE id = $1`, [b.id]);
      await db.query(`DELETE FROM availability_blocks WHERE id = (SELECT id FROM availability_blocks WHERE professional_id = $1 AND start_date = $2 AND end_date = $3 AND reason = 'confirmed booking' LIMIT 1)`, [b.professional_id, b.start_date, b.end_date]);
    } else if (outcome === 'pay_crew') {
      await db.query(`UPDATE bookings SET status = 'completed' WHERE id = $1`, [b.id]);
    } else {
      await db.query(`UPDATE bookings SET status = 'in_progress' WHERE id = $1 AND status = 'disputed'`, [b.id]);
    }
    await db.query(`UPDATE disputes SET status = 'resolved', outcome = $2, resolution = $3, resolved_by = $4, resolved_at = NOW() WHERE id = $1`, [d.id, outcome, note, req.adminName || 'admin']);
    const r = await postSupportMessage(db, req, d, 'Support decision: ' + DISPUTE_OUTCOMES[outcome] + '. ' + note, 'text');
    await audit(db, req, 'dispute_resolved', { id: null, name: d.client_name, email: d.client_email }, { reference: d.reference || refFor(d.booking_id), dispute_id: d.id, outcome, note });
    return r;
  });
  notifySupport(out.b, out.ids, out.row, 'Decision on your dispute');
  res.json({ success: true, refund_reminder: outcome === 'refund_client' && d.payment_status === 'paid' ? 'Now send the refund of the client total from your Bachs dashboard. The booking is marked refunded.' : null });
}));

app.get('/api/admin/audit-log', adminGuard, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM admin_audit_log ORDER BY created_at DESC, id DESC LIMIT 200');
  res.json({ events: rows });
}));

app.get('/api/admin/bookings', adminGuard, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, p.name AS professional_name, p.role AS professional_role
       FROM bookings b LEFT JOIN professionals p ON p.id = b.professional_id ORDER BY b.created_at DESC LIMIT 300`);
  res.json({ bookings: rows.map(b => ({ ...b, reference: b.reference || refFor(b.id) })) });
}));

async function findBookingByRef(db, ref) {
  const m = /^BK-(\d+)$/.exec(String(ref));
  const { rows } = await db.query('SELECT * FROM bookings WHERE reference = $1 OR id = $2 FOR UPDATE', [String(ref), m ? Number(m[1]) : -1]);
  if (!rows[0]) fail(404, 'Booking not found.');
  return rows[0];
}
const BOOKING_STATUSES = ['expired', 'pending', 'awaiting_review', 'awaiting_terms', 'counter_pending', 'declined', 'confirmed', 'in_progress', 'completion_review', 'completed', 'disputed', 'cancelled', 'refunded'];
app.patch('/api/admin/bookings/:ref/status', adminGuard, wrap(async (req, res) => {
  const status = String(req.body.status || '').trim();
  if (!BOOKING_STATUSES.includes(status)) fail(400, 'Status must be one of: ' + BOOKING_STATUSES.join(', ') + '.');
  await withTx(async db => {
    const b = await findBookingByRef(db, req.params.ref);
    if (['cancelled', 'declined'].includes(b.status) && BLOCKING_STATUSES.includes(status)) fail(409, 'A ' + b.status + ' booking cannot be reactivated. Ask the client to submit a new request.');
    if (BLOCKING_STATUSES.includes(status) && !BLOCKING_STATUSES.includes(b.status)) {
      await db.query('SELECT id FROM professionals WHERE id = $1 FOR UPDATE', [b.professional_id]);
      const clash = await db.query(`SELECT 1 FROM availability_blocks WHERE professional_id = $1 AND NOT (end_date < $2 OR start_date > $3) LIMIT 1`, [b.professional_id, b.start_date, b.end_date]);
      if (clash.rows.length) fail(409, 'The professional already has a confirmed booking on these dates.');
      await db.query(`INSERT INTO availability_blocks (professional_id, start_date, end_date, reason) VALUES ($1,$2,$3,'confirmed booking')`, [b.professional_id, b.start_date, b.end_date]);
    }
    await db.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, b.id]);
    if (['cancelled', 'refunded', 'declined'].includes(status) && BLOCKING_STATUSES.includes(b.status)) {
      await db.query(`DELETE FROM availability_blocks WHERE id = (SELECT id FROM availability_blocks WHERE professional_id = $1 AND start_date = $2 AND end_date = $3 AND reason = 'confirmed booking' LIMIT 1)`, [b.professional_id, b.start_date, b.end_date]);
    }
    await audit(db, req, 'booking_status', { id: b.user_id, name: b.client_name, email: b.client_email }, { reference: b.reference || refFor(b.id), status });
  });
  res.json({ success: true });
}));
app.patch('/api/admin/bookings/:ref/overtime-agreed', adminGuard, wrap(async (req, res) => {
  if (typeof req.body.agreed !== 'boolean') fail(400, 'agreed must be true or false.');
  await withTx(async db => {
    const b = await findBookingByRef(db, req.params.ref);
    await db.query('UPDATE bookings SET overtime_agreed = $1 WHERE id = $2', [req.body.agreed, b.id]);
    await audit(db, req, 'overtime_agreed', { id: b.user_id, name: b.client_name, email: b.client_email }, { reference: b.reference || refFor(b.id), status: req.body.agreed ? 'agreed' : 'not agreed' });
  });
  res.json({ success: true });
}));

app.get('/api/admin/listings', adminGuard, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT p.id,ca.user_id,p.name,p.role,p.category,p.location,p.rate,p.status,p.is_active,p.showreel,p.created_at,ca.email
    FROM professionals p LEFT JOIN crew_applications ca ON p.application_id = 'app-' || ca.id::text ORDER BY p.created_at DESC LIMIT 500`);
  res.json({ listings: rows });
}));
app.delete('/api/admin/listings/:id', adminGuard, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid listing id.');
  await withTx(async db => {
    const p = (await db.query(`SELECT p.id,ca.user_id,p.name,p.role FROM professionals p LEFT JOIN crew_applications ca ON p.application_id = 'app-' || ca.id::text WHERE p.id = $1 FOR UPDATE OF p`, [id])).rows[0];
    if (!p) fail(404, 'Listing not found.');
    const live = (await db.query(`SELECT COUNT(*)::int AS n FROM bookings WHERE professional_id = $1 AND status = ANY($2::text[])`, [id, BLOCKING_STATUSES.filter(x => x !== 'completed')])).rows[0].n;
    if (live) fail(409, 'This listing has confirmed or active bookings. Resolve or cancel them before removing it.');
    await db.query(`UPDATE bookings SET status = 'cancelled', cancelled_by = 'admin', cancel_reason = 'Listing removed by an administrator' WHERE professional_id = $1 AND status IN ('awaiting_review','pending','counter_pending')`, [id]);
    // Keep the record and booking history, but remove it from all public marketplace queries.
    await db.query("UPDATE professionals SET status = 'removed', active = FALSE, is_active = FALSE WHERE id = $1", [id]);
    await db.query('DELETE FROM professional_photos WHERE professional_id = $1', [id]);
    await audit(db, req, 'listing_removed', { id: p.user_id, name: p.name }, { reference: '#' + id, status: 'removed', role: p.role });
  });
  res.json({ success: true });
}));

app.get('/api/admin/applications', adminGuard, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT a.*, a.name AS full_name, a.portfolio AS portfolio_url FROM crew_applications a ORDER BY a.created_at DESC LIMIT 300`);
  res.json({ applications: rows });
}));
app.patch('/api/admin/applications/:id/status', adminGuard, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid application id.');
  const status = String(req.body.status || '');
  if (!['pending', 'approved', 'rejected'].includes(status)) fail(400, 'Status must be pending, approved or rejected.');
  await withTx(async db => {
    const a = (await db.query('UPDATE crew_applications SET status = $1 WHERE id = $2 RETURNING *', [status, id])).rows[0];
    if (!a) fail(404, 'Application not found.');
    await audit(db, req, 'application_status', { id: a.user_id, name: a.name, email: a.email }, { reference: '#' + id, status });
  });
  res.json({ success: true });
}));
const CATEGORIES = ['Camera', 'Production', 'Editing', 'Lighting', 'Sound', 'Creative'];
app.post('/api/admin/applications/:id/create-profile', adminGuard, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid application id.');
  const dailyRate = Number(req.body.dailyRate);
  const category = CATEGORIES.find(c => c.toLowerCase() === String(req.body.category || '').trim().toLowerCase());
  if (!Number.isSafeInteger(dailyRate) || dailyRate < 1) fail(400, 'Daily rate must be a whole number of naira.');
  if (!category) fail(400, 'Category must be one of: ' + CATEGORIES.join(', ') + '.');
  const professional = await withTx(async db => {
    const a = (await db.query('SELECT * FROM crew_applications WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!a) fail(404, 'Application not found.');
    if (a.professional_id) fail(409, 'A profile has already been created for this application.');
    if (a.status === 'rejected') fail(409, 'This application was rejected. Approve it first.');
    const verified = a.user_id ? !!((await db.query('SELECT is_verified FROM users WHERE id = $1', [a.user_id])).rows[0] || {}).is_verified : false;
    const p = (await db.query(
      `INSERT INTO professionals (application_id, name, role, category, location, bio, "desc", description, rate, daily_rate, rate_full_day, rate_half_day, skills, verified, status, credits, active, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8::numeric,$8::numeric,$8::numeric,$9::numeric,$10,$11,'approved','',TRUE,TRUE) RETURNING *`,
      ['app-' + id, a.name || a.full_name, a.role, category, a.location || '', a.bio || '', (a.bio || '').slice(0, 200), dailyRate, Math.round(dailyRate / 2), SKILLS_IS_JSON ? '[]' : [], verified])).rows[0];
    await db.query(`UPDATE crew_applications SET professional_id = $1, status = 'approved' WHERE id = $2`, [p.id, id]);
    await audit(db, req, 'create_profile', { id: a.user_id, name: a.name, email: a.email }, { reference: '#' + id, status: 'profile ' + p.id });
    return p;
  });
  res.status(201).json({ success: true, professional });
}));

app.post('/api/admin/payouts', adminGuard, wrap(async (req, res) => {
  const bookingId = toInt(req.body.booking_id); if (!bookingId) fail(400, 'booking_id is required.');
  const payout = await withTx(async db => {
    const b = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId])).rows[0];
    if (!b) fail(404, 'Booking not found.');
    if (b.payment_status !== 'paid') fail(409, 'Cannot pay out a booking that has not been paid.');
    if (b.status !== 'completed') fail(409, 'A payout is only released after the client confirms the job is complete.');
    if (b.payout_status === 'paid') fail(409, 'This booking has already been paid out.');
    const ins = await db.query(
      `INSERT INTO payouts (professional_id, booking_id, amount, status, payout_reference) VALUES ($1,$2,$3,'paid',$4) RETURNING *`,
      [b.professional_id, b.id, b.crew_net, `PO-${Date.now()}`]);
    await db.query(`UPDATE bookings SET payout_status = 'paid' WHERE id = $1`, [b.id]);
    await audit(db, req, 'payout_recorded', null, { booking: b.reference || refFor(b.id), amount: b.crew_net, payout_reference: ins.rows[0].payout_reference });
    return { ...ins.rows[0], _b: b, _crew: (await crewUserIdsFor(db, b.professional_id))[0] };
  });
  emailUsers([payout._crew], 'Payout sent (' + (payout._b.reference || refFor(payout._b.id)) + ')', ['Your payout of ' + naira(payout.amount) + ' for this booking has been sent.'], '/?inbox=' + payout._b.id, 'po' + payout.id).catch(() => {});
  delete payout._b; delete payout._crew;
  res.json({ success: true, payout });
}));

app.post('/api/admin/verify-professional/:id', adminGuard, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid id.');
  if (typeof req.body.verified !== 'boolean') fail(400, 'verified must be true or false.');
  const { rows } = await pool.query('UPDATE professionals SET verified = $1 WHERE id = $2 RETURNING *', [req.body.verified, id]);
  if (!rows[0]) fail(404, 'Professional not found.');
  await audit(pool, req, req.body.verified ? 'professional_verified' : 'professional_unverified', null, { professional: rows[0].name, id });
  res.json({ success: true, professional: rows[0] });
}));

/* ---------------- fallbacks ---------------- */
app.use('/api', (req, res) => res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl.split('?')[0]}` }));

// Link previews need absolute image URLs, so the page is served with the real origin filled in.
let indexTemplate = null;
app.get('*', (req, res, next) => {
  try {
    if (!indexTemplate) indexTemplate = require('fs').readFileSync(path.join(__dirname, 'dist', 'index.html'), 'utf8');
  } catch (e) { return next(e); }
  const origin = baseUrl(req);
  if (req.query.sheet || req.path.startsWith('/sheet/')) res.set('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(indexTemplate.split('__APP_URL__').join(String(origin).replace(/[^\w:./-]/g, '')));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (err.code === '23505') return res.status(409).json({ error: 'That record already exists.' });
  if (['23502', '23503', '22P02', '22007', '23514'].includes(err.code)) console.warn('DB validation error:', err.code, err.message, '| table:', err.table, 'column:', err.column, 'constraint:', err.constraint, '|', req.method, req.path);
  if (err.code === '23503' || err.code === '22P02' || err.code === '22007' || err.code === '23514') return res.status(400).json({ error: 'Some of the submitted details are invalid.' });
  console.error('Server error:', err); // details stay in the logs, never in the response
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

initDb().then(() => {
  const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  startEventListener();
  setTimeout(() => expireStaleRequests().catch(e => console.warn('expiry:', e.message)), 30000).unref?.();
  setInterval(() => expireStaleRequests().catch(e => console.warn('expiry:', e.message)), 30 * 60 * 1000).unref?.();
  setInterval(() => pool.query('DELETE FROM sessions WHERE expires_at < NOW()').catch(() => {}), 6 * 3600 * 1000).unref();
  const shutdown = () => server.close(() => { const l = listenerClient; listenerClient = null; (l ? l.end() : Promise.resolve()).catch(() => {}).finally(() => pool.end().finally(() => process.exit(0))); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}).catch(err => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});
