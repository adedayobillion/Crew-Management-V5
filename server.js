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
const SUPPLIER_TIN = process.env.SUPPLIER_TIN || '';
const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED === 'true';
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';
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

app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], baseUri: ["'self'"], fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], scriptSrc: ["'self'"], scriptSrcAttr: ["'none'"], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"] } } }));
// rawBody is kept so payment-webhook signatures can be verified against the exact bytes received
app.use(express.json({ limit: '8mb', type: 'application/json', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && req.get('origin')) {
    const origin = req.get('origin'); const host = req.get('host');
    if (!host || origin !== `${req.protocol}://${host}`) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  }
  next();
});
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'dist'), { dotfiles: 'ignore' }));

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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_one_per_booking ON reviews(booking_id);
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
const publicUser = u => ({
  id: u.id, name: u.name, email: u.email,
  phone: u.phone || '', location: u.location || '', bio: u.bio || '',
  accountType: u.account_type, accountStatus: u.account_status, isVerified: !!u.is_verified
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
  if (name.length < 2) fail(400, 'Please enter your full name.');
  const { rows } = await withTx(async db => {
    const updated = await db.query('UPDATE users SET name=$1,phone=$2,location=$3,bio=$4 WHERE id=$5 RETURNING *',
      [name, phone || null, location || null, bio || null, req.user.id]);
    // Keep the public crew listing in sync with the account owner’s editable profile.
    const applications = await db.query(
      'UPDATE crew_applications SET name=$1, full_name=$1, email=$2, location=$3, bio=$4 WHERE user_id=$5 RETURNING id, professional_id',
      [name, updated.rows[0].email, location || '', bio || '', req.user.id]);
    for (const application of applications.rows) {
      await db.query(
        "UPDATE professionals SET name=$1, location=$2, bio=$3, \"desc\"=$4, description=$3 WHERE id=$5 OR application_id=$6",
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
  if (name.length < 2) fail(400, 'Please enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email address.');
  if (password.length < 10 || password.length > 200 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) fail(400, 'Password must be at least 10 characters and include a letter and a number.');
  if (!req.body.termsAccepted) fail(400, 'You must accept the terms to create an account.');
  const hash = await bcrypt.hash(password, 12);
  let user;
  try {
    const r = await pool.query(
      `INSERT INTO users (name, email, password_hash, account_type, account_status, terms_accepted_at, terms_version) VALUES ($1,$2,$3,$4,$5,NOW(),'v1') RETURNING *`,
      [name, email, hash, accountType, REQUIRE_APPROVAL ? 'pending_review' : 'approved']);
    user = r.rows[0];
  } catch (e) {
    if (e.code === '23505') fail(409, 'An account with this email already exists. Try logging in.');
    throw e;
  }
  await startSession(res, user.id);
  res.status(201).json({ success: true, user: publicUser(user) });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  const password = String(req.body.password || '').slice(0, 200);
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const u = rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) fail(401, 'Incorrect email or password.');
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

// One login, two modes (like Airbnb's guest/host switch). The mode is remembered on the account.
app.post('/api/auth/switch-mode', requireUser, wrap(async (req, res) => {
  const mode = req.body.mode;
  if (!['client', 'crew'].includes(mode)) fail(400, 'Mode must be client or crew.');
  const { rows } = await pool.query('UPDATE users SET account_type = $1 WHERE id = $2 RETURNING *', [mode, req.user.id]);
  res.json({ success: true, user: publicUser(rows[0]) });
}));

// Crew workspace: show requests for every professional profile owned by this account.
app.get('/api/crew/bookings', requireUser, wrap(async (req, res) => {
  const proIds = await crewProfessionalIds(pool, req.user);
  const app_ = (await pool.query('SELECT id, status, professional_id FROM crew_applications WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [req.user.id])).rows[0] || null;
  if (!proIds.length) return res.json({ hasProfile: false, application: app_ ? { id: app_.id, status: app_.status } : null, bookings: [] });
  const { rows } = await pool.query(
    `SELECT id, reference, client_name, project_type, project_location, start_date, end_date, booking_unit, status, crew_response, crew_net, project_brief, overtime_terms, counter_details, payment_status
       FROM bookings WHERE professional_id = ANY($1::int[]) ORDER BY created_at DESC LIMIT 200`, [proIds]); // client email/phone are deliberately not shared
  res.json({ hasProfile: true, application: app_ ? { id: app_.id, status: app_.status } : null, bookings: rows.map(b => ({ ...b, reference: b.reference || refFor(b.id) })) });
}));

/* ---------------- admin guard ---------------- */
const adminFailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true, requestWasSuccessful: (req, res) => res.statusCode !== 401, message: { error: 'Too many failed attempts. Try again later.' } });
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKENS.length) return res.status(503).json({ error: 'Admin console is disabled. Set CMA_ADMIN_TOKEN (or CMA_ADMIN_TOKENS) in Railway Variables.' });
  const a = crypto.createHash('sha256').update(String(req.get('x-admin-token') || '')).digest();
  let who = null;
  for (const t of ADMIN_TOKENS) { // check every entry so timing does not reveal which one matched
    const b = crypto.createHash('sha256').update(t.token).digest();
    if (crypto.timingSafeEqual(a, b) && !who) who = t.name;
  }
  if (!who) return res.status(401).json({ error: 'Unauthorized' });
  req.adminName = who;
  next();
}
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

app.get('/api/professionals', wrap(async (req, res) => {
  const { role, location, category } = req.query;
  let query = "SELECT * FROM professionals WHERE status = 'approved' AND is_active = TRUE AND NOT EXISTS (" +
    "SELECT 1 FROM crew_applications ca JOIN users u ON u.id=ca.user_id " +
    "LEFT JOIN user_settings us ON us.user_id=u.id WHERE (ca.professional_id=professionals.id OR professionals.application_id='app-' || ca.id::text) AND COALESCE(us.profile_visibility,TRUE)=FALSE)";
  const params = [];
  if (role) { params.push(String(role)); query += ` AND role = $${params.length}`; }
  if (category) { params.push(String(category)); query += ` AND category = $${params.length}`; }
  if (location) { params.push(`%${String(location).replace(/[\\%_]/g, '\\$&')}%`); query += ` AND location ILIKE $${params.length}`; }
  const { rows } = await pool.query(query + ' ORDER BY id', params);
  res.json({ professionals: rows }); // the frontend reads data.professionals
}));

app.get('/api/professionals/:id/reviews', wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid id.');
  const { rows } = await pool.query('SELECT id, rating, comment, reviewer_name, reviewer_type, created_at FROM reviews WHERE professional_id = $1 ORDER BY created_at DESC', [id]);
  res.json(rows);
}));

/* ---------------- bookings (client) ---------------- */
app.post('/api/bookings', requireUser, requireApproved, wrap(async (req, res) => {
  const b = req.body || {};
  const proId = toInt(b.professionalId);
  const unit = b.bookingUnit === 'half' ? 'half' : 'full';
  const start = b.startDate;
  const end = unit === 'half' ? b.startDate : b.endDate;
  const projectType = str(b.projectType, 100);
  if (!proId) fail(400, 'Please choose a crew member.');
  if ((await crewProfessionalIds(pool, req.user)).includes(proId)) fail(400, 'You cannot book your own crew profile.');
  if (!projectType) fail(400, 'Please select a project type.');
  if (!isDate(start) || !isDate(end)) fail(400, 'Please choose valid start and end dates.');
  if (start < todayLagos()) fail(400, 'The start date cannot be in the past.');
  if (end < start) fail(400, 'The end date cannot be before the start date.');
  const days = unit === 'half' ? 0.5 : daysBetween(start, end);
  if (days > 90) fail(400, 'Bookings longer than 90 days must be arranged with support.');

  const recent = await pool.query(`SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [req.user.id]);
  if (recent.rows[0].n >= 10) fail(429, 'You have reached the limit of 10 booking requests per 24 hours.');
  const booking = await withTx(async db => {
    const p = (await db.query(`SELECT id, name, role, rate FROM professionals WHERE id = $1 AND status = 'approved' AND is_active = TRUE FOR UPDATE`, [proId])).rows[0];
    if (!p) fail(404, 'This crew member is not available.');
    const clash = await db.query(`SELECT 1 FROM availability_blocks WHERE professional_id = $1 AND NOT (end_date < $2 OR start_date > $3) LIMIT 1`, [proId, start, end]);
    if (clash.rows.length) fail(409, 'This professional is not available for the requested dates.');
    const base = Math.round(Number(p.rate) * days);
    const fee = Math.round(base * 0.1);
    const ins = await db.query(
      `INSERT INTO bookings (reference, professional_id, user_id, client_name, client_email, start_date, end_date, project_brief, overtime_terms, project_type, booking_unit, project_location, client_total, crew_net, status, crew_response)
       VALUES ($14,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'awaiting_review','pending') RETURNING *`,
      [proId, req.user.id, req.user.name, req.user.email, start, end, str(b.brief, 2000), str(b.overtimeTerms, 1000), projectType, unit, str(b.projectLocation, 200), base + fee, base - fee, 'TMP-' + crypto.randomBytes(8).toString('hex')]);
    const row = ins.rows[0];
    const ref = refFor(row.id);
    await db.query('UPDATE bookings SET reference = $1 WHERE id = $2', [ref, row.id]);
    return { ...row, reference: ref, professional_name: p.name, professional_role: p.role };
  });
  notifyBooking(await crewUserIdsFor(pool, proId), booking, 'New booking request', booking.reference + ' (' + fmtRange(booking) + ') from ' + booking.client_name + '.');
  res.status(201).json({ success: true, booking });
}));

app.get('/api/my/bookings', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, p.name AS professional_name, p.role AS professional_role
       FROM bookings b LEFT JOIN professionals p ON p.id = b.professional_id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC`, [req.user.id]);
  res.json({ bookings: rows.map(b => ({ ...b, reference: b.reference || refFor(b.id) })) });
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
}
app.post('/api/bookings/:id/cancel', requireUser, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid booking id.');
  const booking = await withTx(async db => {
    const b = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!b) fail(404, 'Booking not found.');
    if (!ownsBooking(req.user, b)) fail(403, 'You do not have access to this booking.');
    if (['cancelled', 'completed', 'refunded'].includes(b.status)) fail(409, 'This booking can no longer be cancelled.');
    if (b.payment_status === 'paid') fail(409, 'Paid bookings must be cancelled through support so a refund can be arranged.');
    const upd = await db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING *`, [id]);
    // Only a booking that was confirmed holds a block. Freeing one for a pending/declined request would delete
    // the block of a different, confirmed booking on the same dates and let the professional be double-booked.
    if (BLOCKING_STATUSES.includes(b.status)) {
      await db.query(
        `DELETE FROM availability_blocks WHERE id = (SELECT id FROM availability_blocks WHERE professional_id = $1 AND start_date = $2 AND end_date = $3 AND reason = 'confirmed booking' LIMIT 1)`,
        [b.professional_id, b.start_date, b.end_date]);
    }
    return { ...upd.rows[0], _crew: await crewUserIdsFor(db, b.professional_id) };
  });
  const { _crew, ...cancelled } = booking;
  notifyBooking(_crew, cancelled, 'Booking cancelled', 'The client cancelled ' + (cancelled.reference || refFor(cancelled.id)) + ' (' + fmtRange(cancelled) + ').');
  res.json({ success: true, booking: cancelled });
}));

/* ---------------- crew response ---------------- */
app.post('/api/crew/bookings/:id/respond', requireUser, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid booking id.');
  const response = req.body.response;
  if (!['accepted', 'declined', 'countered'].includes(response)) fail(400, 'Invalid response action.');
  const result = await withTx(async db => {
    const b = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!b) fail(404, 'Booking not found.');
    if (!(await ownsProfessionalBooking(db, req.user, b))) fail(403, 'This booking is not assigned to you.');
    if (!['awaiting_review', 'pending'].includes(b.status)) fail(409, 'This booking can no longer be responded to.');
    let newStatus = response === 'accepted' ? 'confirmed' : response === 'declined' ? 'declined' : 'counter_pending';
    if (response === 'accepted') {
      await db.query('SELECT id FROM professionals WHERE id = $1 FOR UPDATE', [b.professional_id]);
      const clash = await db.query(`SELECT 1 FROM availability_blocks WHERE professional_id = $1 AND NOT (end_date < $2 OR start_date > $3) LIMIT 1`, [b.professional_id, b.start_date, b.end_date]);
      if (clash.rows.length) fail(409, 'You already have a confirmed booking on these dates.');
      await db.query(`INSERT INTO availability_blocks (professional_id, start_date, end_date, reason) VALUES ($1,$2,$3,'confirmed booking')`, [b.professional_id, b.start_date, b.end_date]);
    }
    await db.query('UPDATE bookings SET crew_response = $1, status = $2, counter_details = $3 WHERE id = $4', [response, newStatus, response === 'countered' ? str(req.body.counter_details, 1000) || null : null, id]);
    return { status: newStatus, crew_response: response, _b: b };
  });
  const { _b, ...result_ } = result;
  notifyBooking([Number(_b.user_id)], _b, response === 'accepted' ? 'Booking accepted' : response === 'declined' ? 'Booking declined' : 'Counter-offer received',
    (_b.reference || refFor(_b.id)) + ' (' + fmtRange(_b) + ')' + (response === 'countered' ? ': open it to review the crew member\'s terms.' : '.'));
  res.json({ success: true, ...result_ });
}));

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
  res.json({ success: true, booking: answered });
}));

/* ---------------- payments & invoices ---------------- */
app.post('/api/payments/initialize', requireUser, wrap(async (req, res) => {
  if (!PAYMENTS_ENABLED) fail(503, 'Online payments are not available yet.');
  const b = await getAccessibleBooking(pool, req, req.body.booking_id);
  if (!ownsBooking(req.user, b)) fail(403, 'Only the client can pay for a booking.');
  if (['cancelled', 'declined', 'refunded'].includes(b.status)) fail(409, 'This booking cannot be paid.');
  if (!BLOCKING_STATUSES.includes(b.status)) fail(409, 'You can pay once the crew member has accepted this booking.');
  if (b.payment_status === 'paid') fail(409, 'This booking is already paid.');
  const amount = Number(b.client_total);
  if (!(amount > 0)) fail(400, 'This booking has no payable amount.');
  const reference = `TXN-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  await pool.query(`INSERT INTO payments (booking_id, gateway, gateway_reference, amount, status) VALUES ($1,'bachs',$2,$3,'pending')`, [b.id, reference, amount]);
  res.json({ success: true, reference, amount, checkout_url: `https://checkout.gateway.mock/pay/${reference}` });
}));

app.post('/api/payments/webhook', wrap(async (req, res) => {
  if (!WEBHOOK_SECRET) fail(503, 'Payment webhook is not configured.');
  const given = Buffer.from(String(req.get('x-signature') || ''), 'utf8');
  const expected = Buffer.from(crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex'), 'utf8');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) fail(401, 'Invalid signature.');
  const { gateway_reference, status, raw_payload } = req.body || {};
  if (!gateway_reference) fail(400, 'gateway_reference is required.');
  const out = await withTx(async db => {
    const payment = (await db.query('SELECT * FROM payments WHERE gateway_reference = $1 FOR UPDATE', [String(gateway_reference)])).rows[0];
    if (!payment) fail(404, 'Payment record not found.');
    if (payment.status !== 'pending') return { duplicate: true, status: payment.status }; // idempotent: replays do nothing
    if (status === 'verified') {
      await db.query(`UPDATE payments SET status = 'verified', raw_webhook = $1 WHERE id = $2`, [JSON.stringify(raw_payload || {}), payment.id]);
      await db.query(`UPDATE bookings SET payment_status = 'paid' WHERE id = $1`, [payment.booking_id]);
      const total = Number(payment.amount);
      const subtotal = total / 1.075;
      const booking = (await db.query('SELECT client_name FROM bookings WHERE id = $1', [payment.booking_id])).rows[0];
      await db.query(
        `INSERT INTO invoices (invoice_number, booking_id, client_name, subtotal, vat_rate, vat_amount, total_amount, supplier_tin) VALUES ($1,$2,$3,$4,7.5,$5,$6,$7) ON CONFLICT (invoice_number) DO NOTHING`,
        [`INV-${new Date().getUTCFullYear()}-${String(payment.id).padStart(6, '0')}`, payment.booking_id, (booking && booking.client_name) || 'Client', subtotal.toFixed(2), (total - subtotal).toFixed(2), total, SUPPLIER_TIN || null]);
      return { status: 'verified' };
    }
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [payment.id]);
    await db.query(`UPDATE bookings SET payment_status = 'failed' WHERE id = $1 AND payment_status <> 'paid'`, [payment.booking_id]);
    return { status: 'failed' };
  });
  res.json({ success: true, ...out });
}));

app.get('/api/invoices/:booking_id', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.params.booking_id);
  const { rows } = await pool.query('SELECT * FROM invoices WHERE booking_id = $1', [b.id]);
  if (!rows[0]) fail(404, 'Invoice not found.');
  res.json(rows[0]);
}));

/* ---------------- disputes, reviews, messages, teams ---------------- */
app.post('/api/disputes', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.body.booking_id);
  const reason = str(req.body.reason, 2000);
  if (reason.length < 5) fail(400, 'Please describe the issue (at least 5 characters).');
  const { rows } = await pool.query(
    `INSERT INTO disputes (booking_id, raised_by, reason, status) VALUES ($1,$2,$3,'open') RETURNING *`, [b.id, ownsBooking(req.user, b) ? 'client' : 'crew', reason]);
  res.status(201).json(rows[0]);
}));

app.post('/api/reviews', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.body.booking_id);
  if (!ownsBooking(req.user, b)) fail(403, 'You can only review your own bookings.');
  if (b.payment_status !== 'paid') fail(400, 'Reviews are only allowed after a completed and paid booking.');
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'Rating must be a whole number from 1 to 5.');
  const row = await withTx(async db => {
    const dup = await db.query('SELECT 1 FROM reviews WHERE booking_id = $1', [b.id]);
    if (dup.rows.length) fail(409, 'You have already reviewed this booking.');
    const ins = await db.query(
      `INSERT INTO reviews (booking_id, professional_id, reviewer_type, reviewer_name, rating, comment) VALUES ($1,$2,'client',$3,$4,$5) RETURNING *`,
      [b.id, b.professional_id, req.user.name, rating, str(req.body.comment, 1000)]);
    await db.query(`UPDATE professionals SET rating = (SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE professional_id = $1) WHERE id = $1`, [b.professional_id]);
    return ins.rows[0];
  });
  res.status(201).json(row);
}));

const maskContact = text => text
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[Masked Email]')
  .replace(/\+?[0-9][0-9\s\-().]{7,}[0-9]/g, '[Masked Phone Number]');


/* ---------------- inbox and live account notifications ---------------- */
const messageNotificationSubs = new Map();
function emitMessageNotification(userId,payload){
  if(!userId) return;
  for(const sub of messageNotificationSubs.get(Number(userId))||[]){
    try{sub.write('data: '+JSON.stringify(payload)+'\n\n');}catch(e){}
  }
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
    "SELECT b.id,COALESCE(b.reference,'') AS reference,b.client_name,b.project_type,b.status,b.created_at,p.name AS professional_name,"+role+" AS my_role,"+
    "(SELECT m.masked_content FROM messages m WHERE m.booking_id=b.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message,"+
    "(SELECT MAX(m.created_at) FROM messages m WHERE m.booking_id=b.id) AS last_message_at,"+
    "(SELECT COUNT(*)::int FROM messages m WHERE m.booking_id=b.id AND ((m.sender_user_id IS NOT NULL AND m.sender_user_id<>$1) OR (m.sender_user_id IS NULL AND m.sender_type<>CASE WHEN "+client+" THEN 'client' ELSE 'crew' END)) "+
    "AND NOT EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id=m.id AND mr.user_id=$1)) AS unread_count "+
    "FROM bookings b LEFT JOIN professionals p ON p.id=b.professional_id WHERE "+client+" OR "+crew+
    " ORDER BY COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.booking_id=b.id),b.created_at) DESC LIMIT 100",[uid]);
  res.json({conversations:rows.map(b=>({...b,reference:b.reference||refFor(b.id),unread_count:Number(b.unread_count||0)}))});
}));
app.post('/api/inbox/:bookingId/read',requireUser,wrap(async(req,res)=>{
  const booking=await getAccessibleBooking(pool,req,req.params.bookingId);
  const ownType=ownsBooking(req.user,booking)?'client':'crew';
  await pool.query("INSERT INTO message_reads(message_id,user_id) SELECT m.id,$1 FROM messages m WHERE m.booking_id=$2 AND ((m.sender_user_id IS NOT NULL AND m.sender_user_id<>$1) OR (m.sender_user_id IS NULL AND m.sender_type<>$3)) ON CONFLICT(message_id,user_id) DO NOTHING",
    [req.user.id,booking.id,ownType]);
  res.json({success:true});
}));

app.get('/api/bookings/:id/messages', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.params.id);
  const { rows } = await pool.query('SELECT * FROM messages WHERE booking_id = $1 ORDER BY created_at ASC', [b.id]);
  res.json(rows);
}));

// Live delivery: one Server-Sent Events stream per open chat, fed by an in-process subscriber map (single replica).
const chatSubs = new Map();
app.get('/api/bookings/:id/messages/stream', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.params.id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  if (!chatSubs.has(b.id)) chatSubs.set(b.id, new Set());
  chatSubs.get(b.id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); const set = chatSubs.get(b.id); if (set) { set.delete(res); if (!set.size) chatSubs.delete(b.id); } });
}));

app.post('/api/bookings/:id/messages', requireUser, wrap(async (req, res) => {
  const b = await getAccessibleBooking(pool, req, req.params.id);
  const content = str(req.body.content, 2000);
  if (!content) fail(400, 'Message cannot be empty.');
  const senderType = ownsBooking(req.user, b) ? 'client' : 'crew';
  const recipientId = await getOtherParticipantId(pool, req.user, b);
  const { rows } = await pool.query(
    'INSERT INTO messages (booking_id,sender_type,sender_name,masked_content,sender_user_id,recipient_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [b.id,senderType,req.user.name,maskContact(content),req.user.id,recipientId]);
  for (const sub of chatSubs.get(b.id) || []) sub.write('data: '+JSON.stringify(rows[0])+'\n\n');
  if (recipientId && recipientId !== Number(req.user.id)) {
    emitMessageNotification(recipientId,{type:'message',booking_id:b.id,reference:b.reference||refFor(b.id),sender_name:req.user.name,preview:rows[0].masked_content,created_at:rows[0].created_at});
  }
  res.status(201).json(rows[0]);
}));

app.post('/api/team-bookings', requireUser, requireApproved, wrap(async (req, res) => {
  const { project_title, start_date, end_date, members } = req.body || {};
  const title = str(project_title, 150);
  if (!title) fail(400, 'Please enter a project title.');
  if (!isDate(start_date) || !isDate(end_date) || end_date < start_date) fail(400, 'Please choose valid dates.');
  if (!Array.isArray(members) || !members.length || members.length > 20) fail(400, 'Add between 1 and 20 team members.');
  const list = members.map(m => ({ professional_id: toInt(m && m.professional_id), role: str(m && m.role, 100) }));
  if (list.some(m => !m.professional_id || !m.role)) fail(400, 'Each member needs a professional and a role.');
  const ids = [...new Set(list.map(m => m.professional_id))];
  const team = await withTx(async db => {
    const ok = await db.query(`SELECT id FROM professionals WHERE id = ANY($1::int[]) AND status = 'approved' AND is_active = TRUE`, [ids]);
    if (ok.rows.length !== ids.length) fail(400, 'One or more selected professionals are not available.');
    const tb = (await db.query(
      `INSERT INTO team_bookings (project_title, client_name, client_email, start_date, end_date, status) VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
      [title, req.user.name, req.user.email, start_date, end_date])).rows[0];
    for (const m of list) await db.query(`INSERT INTO team_booking_members (team_booking_id, professional_id, role, status) VALUES ($1,$2,$3,'pending')`, [tb.id, m.professional_id, m.role]);
    return tb;
  });
  res.status(201).json({ success: true, team_booking: team });
}));

/* ---------------- crew applications ---------------- */
app.post('/api/crew-applications', requireUser, requireApproved, wrap(async (req, res) => {
  const role = str(req.body.role, 120);
  const location = str(req.body.location, 120);
  let portfolio = str(req.body.portfolio, 500);
  const bio = str(req.body.bio, 2000);
  if (!role) fail(400, 'Please enter your role.');
  if (!location) fail(400, 'Please enter your location.');
  if (portfolio) {
    if (!/^https?:\/\//i.test(portfolio)) portfolio = 'https://' + portfolio;
    try { const u = new URL(portfolio); if (!/^https?:$/.test(u.protocol)) throw 0; portfolio = u.toString(); } catch (e) { fail(400, 'Portfolio must be a valid web link.'); }
  }
  const dup = await pool.query(`SELECT id FROM crew_applications WHERE user_id = $1 AND status = 'pending'`, [req.user.id]);
  if (dup.rows.length) fail(409, 'You already have an application under review (#' + dup.rows[0].id + ').');
  const { rows } = await pool.query(
    `INSERT INTO crew_applications (user_id, name, full_name, email, role, location, portfolio, portfolio_url, bio) VALUES ($1,$2,$2,$3,$4,$5,$6,$6,$7) RETURNING *`,
    [req.user.id, req.user.name, req.user.email, role, location, portfolio || '', bio]);
  res.status(201).json({ success: true, application: rows[0] });
}));

/* ---------------- admin API (x-admin-token) ---------------- */
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
const BOOKING_STATUSES = ['pending', 'awaiting_review', 'awaiting_terms', 'counter_pending', 'declined', 'confirmed', 'in_progress', 'completion_review', 'completed', 'disputed', 'cancelled', 'refunded'];
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
    if (b.payout_status === 'paid') fail(409, 'This booking has already been paid out.');
    const ins = await db.query(
      `INSERT INTO payouts (professional_id, booking_id, amount, status, payout_reference) VALUES ($1,$2,$3,'paid',$4) RETURNING *`,
      [b.professional_id, b.id, b.crew_net, `PO-${Date.now()}`]);
    await db.query(`UPDATE bookings SET payout_status = 'paid' WHERE id = $1`, [b.id]);
    return ins.rows[0];
  });
  res.json({ success: true, payout });
}));

app.post('/api/admin/verify-professional/:id', adminGuard, wrap(async (req, res) => {
  const id = toInt(req.params.id); if (!id) fail(400, 'Invalid id.');
  if (typeof req.body.verified !== 'boolean') fail(400, 'verified must be true or false.');
  const { rows } = await pool.query('UPDATE professionals SET verified = $1 WHERE id = $2 RETURNING *', [req.body.verified, id]);
  if (!rows[0]) fail(404, 'Professional not found.');
  res.json({ success: true, professional: rows[0] });
}));

/* ---------------- fallbacks ---------------- */
app.use('/api', (req, res) => res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl.split('?')[0]}` }));

app.get('*', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'), err => { if (err) next(err); });
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
  setInterval(() => pool.query('DELETE FROM sessions WHERE expires_at < NOW()').catch(() => {}), 6 * 3600 * 1000).unref();
  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}).catch(err => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});
