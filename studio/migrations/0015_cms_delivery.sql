CREATE TABLE managed_cms_delivery_credentials (
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id),
  credential_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (site_id, credential_id)
) STRICT;

-- Append in the same transaction as the release pointer. Each host persists its own cursor.
CREATE TABLE managed_cms_delivery_events (
  site_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  release_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  renderer_version INTEGER NOT NULL,
  PRIMARY KEY (site_id, sequence),
  UNIQUE (site_id, release_id),
  FOREIGN KEY (site_id, release_id) REFERENCES managed_cms_releases(site_id, release_id)
) STRICT;

CREATE TABLE managed_cms_delivery_acks (
  site_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  release_id TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  renderer_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('deployed', 'failed')),
  artifact_id TEXT CHECK ((state = 'deployed') = (artifact_id IS NOT NULL)),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (site_id, locale, release_id),
  FOREIGN KEY (site_id, release_id) REFERENCES managed_cms_releases(site_id, release_id)
) STRICT;
