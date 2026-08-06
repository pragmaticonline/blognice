-- Blog Nice — INDEX database schema (binding: DB)
-- Holds accounts, memberships, tenants, sessions, domains. Post bodies live in
-- the separate POSTS database (see schema-posts.sql).
-- Run with:  npm run db:init        (remote)
--            npm run db:init:local  (local dev)

-- Drop everything first so re-applying is idempotent. Includes tables that may
-- linger from other versions (subscribers, and the reader-era account tables),
-- so a re-apply cleanly resets to this schema regardless of prior state.
DROP TABLE IF EXISTS bookmarks;
DROP TABLE IF EXISTS bookmark_lists;
DROP TABLE IF EXISTS reactions;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS subscribers;
DROP TABLE IF EXISTS staff_audit_events;
DROP TABLE IF EXISTS staff_users;
DROP TABLE IF EXISTS pronunciation_overrides;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS blog_invitations;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS domains;
DROP TABLE IF EXISTS tenant_slug_aliases;
DROP TABLE IF EXISTS tenants;

-- One row per blog.
CREATE TABLE tenants (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT    NOT NULL UNIQUE,          -- opaque identifier used in public URLs/API paths
  slug          TEXT    NOT NULL UNIQUE,          -- the subdomain: <slug>.blognice.com
  custom_domain TEXT             UNIQUE,          -- optional: blog.theircompany.com (nullable)
  title         TEXT    NOT NULL,                 -- blog title, shown in header + <title>
  description   TEXT    NOT NULL DEFAULT '',      -- tagline, shown under the title + meta description
  avatar_key    TEXT,                             -- R2 key of the blog's profile image (nullable)
  favicon_key   TEXT,                             -- R2 key of the blog's browser icon (nullable)
  accent_color  TEXT    NOT NULL DEFAULT '#1a8917', -- six-digit hex branding accent
  topics_json   TEXT    NOT NULL DEFAULT '[]',     -- normalized blog topics
  shard         TEXT    NOT NULL DEFAULT 'primary', -- which POSTS database holds this tenant's posts (see src/db.ts)
  created_at    INTEGER NOT NULL                  -- unix seconds
);

-- A login. An account can own several blogs (via memberships).
CREATE TABLE accounts (
  id         INTEGER PRIMARY KEY,
  email      TEXT    NOT NULL UNIQUE,
  pw_hash    TEXT    NOT NULL,                    -- pbkdf2$iterations$salt$hash
  api_key_hash       TEXT,                        -- sha-256 hex of the account's API key (nullable)
  api_key_created_at INTEGER,                     -- when the current key was generated
  status     TEXT    NOT NULL DEFAULT 'active',  -- active | suspended
  status_reason TEXT,
  status_changed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_accounts_api_key ON accounts (api_key_hash);
CREATE INDEX idx_accounts_status ON accounts (status, created_at DESC);

CREATE TABLE staff_users (
  subject TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'read_only',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE staff_audit_events (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT,
  result TEXT NOT NULL,
  request_id TEXT,
  before_json TEXT,
  after_json TEXT
);

CREATE INDEX idx_staff_audit_occurred ON staff_audit_events(occurred_at DESC);
CREATE INDEX idx_staff_audit_target ON staff_audit_events(target_type, target_id, occurred_at DESC);

-- Which accounts can manage which blogs. One row = one account's access to one
-- blog. `role` is 'owner' today; the column exists so collaborator roles can be
-- added later without a migration.
CREATE TABLE memberships (
  account_id INTEGER NOT NULL,
  tenant_id  INTEGER NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'owner',
  display_name TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, tenant_id),
  FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id)  REFERENCES tenants (id)  ON DELETE CASCADE
);

CREATE INDEX idx_memberships_account ON memberships (account_id);
CREATE INDEX idx_memberships_tenant  ON memberships (tenant_id);

CREATE TABLE blog_invitations (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE tenant_slug_aliases (
  old_slug TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX idx_tenant_slug_aliases_tenant ON tenant_slug_aliases(tenant_id);
CREATE INDEX idx_blog_invites_tenant ON blog_invitations(tenant_id, created_at DESC);
CREATE INDEX idx_blog_invites_email ON blog_invitations(email, expires_at);

-- Customer-owned domains connected via Cloudflare for SaaS. A tenant may have
-- several. A domain only routes once status = 'active' (verified + certificate).
CREATE TABLE domains (
  hostname       TEXT    PRIMARY KEY,              -- blog.theircompany.com
  tenant_id      INTEGER NOT NULL,
  cf_hostname_id TEXT,                             -- Cloudflare custom_hostname id
  status         TEXT    NOT NULL DEFAULT 'pending', -- pending | active
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE INDEX idx_domains_active ON domains (hostname, status);

-- Login sessions. The cookie holds the opaque token; everything else is here.
CREATE TABLE sessions (
  token      TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- Newsletter subscribers, per blog. `token` powers one-click unsubscribe links.
CREATE TABLE subscribers (
  id         INTEGER PRIMARY KEY,
  tenant_id  INTEGER NOT NULL,
  email      TEXT    NOT NULL,
  token      TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, email),
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE INDEX idx_subscribers_tenant ON subscribers (tenant_id, created_at DESC);
