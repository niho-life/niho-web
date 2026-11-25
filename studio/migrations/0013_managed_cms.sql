PRAGMA foreign_keys = ON;

-- A single generation serializes changes to a managed site's CMS metadata. Content is in private R2.
CREATE TABLE managed_cms_state (
  site_id TEXT PRIMARY KEY REFERENCES managed_sites(site_id),
  generation TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
) STRICT;

CREATE TABLE managed_cms_receipts (
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id),
  actor_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (site_id, actor_id, operation_id)
) STRICT;

CREATE TABLE managed_cms_audit (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id),
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE managed_cms_revisions (
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id),
  revision TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  schema_revision TEXT NOT NULL,
  PRIMARY KEY (site_id, revision)
) STRICT;

CREATE TABLE managed_cms_releases (
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id),
  release_id TEXT NOT NULL,
  released_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (site_id, release_id)
) STRICT;

-- Raw tokens never enter D1. The hash row binds the scoped payload and its expiry.
CREATE TABLE managed_cms_tokens (
  token_hash TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id),
  actor_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX managed_cms_tokens_by_expiry ON managed_cms_tokens(expires_at);
CREATE INDEX managed_cms_tokens_by_actor ON managed_cms_tokens(site_id, actor_id, purpose, expires_at);

CREATE TABLE managed_cms_outbox (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id),
  actor_id TEXT NOT NULL,
  client_id TEXT,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES managed_cms_receipts(transaction_id),
  kind TEXT NOT NULL CHECK (kind IN ('verify', 'release', 'schedule')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'dead', 'cancelled')),
  scheduled_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER,
  failure TEXT
) STRICT;
CREATE INDEX managed_cms_outbox_due ON managed_cms_outbox(state, available_at, lease_until);
CREATE INDEX managed_cms_outbox_site ON managed_cms_outbox(site_id, kind, state);

-- Reserve the CMS path for future pages. Existing configurations can still be edited or moved.
CREATE TRIGGER managed_cms_reserve_new_page_path
BEFORE INSERT ON managed_pages
WHEN NEW.path = '/cms' OR NEW.path GLOB '/cms/*'
BEGIN
  SELECT RAISE(ABORT, 'managed CMS path is reserved');
END;

CREATE TRIGGER managed_cms_reserve_changed_page_path
BEFORE UPDATE OF path ON managed_pages
WHEN OLD.path <> NEW.path AND (NEW.path = '/cms' OR NEW.path GLOB '/cms/*')
BEGIN
  SELECT RAISE(ABORT, 'managed CMS path is reserved');
END;
