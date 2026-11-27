PRAGMA foreign_keys = ON;

-- The public worker selects one immutable manifest for each site. The pointer is
-- advanced with compare-and-swap during the same D1 batch as page publication.
CREATE TABLE managed_site_publication_state (
  site_id TEXT PRIMARY KEY NOT NULL REFERENCES managed_sites(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 200),
  manifest_key TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (manifest_key IS NULL OR manifest_key GLOB 'managed-sites/*/manifests/*.json')
) STRICT;

INSERT INTO managed_site_publication_state (site_id, version, manifest_key)
SELECT site_id, 'initial', NULL FROM managed_sites;

-- During a rolling deploy, the previous Studio Worker may still create a site.
-- Keep the new publish path initialized without requiring that Worker to know
-- about this table.
CREATE TRIGGER managed_site_publication_state_after_site_insert
AFTER INSERT ON managed_sites
BEGIN
  INSERT OR IGNORE INTO managed_site_publication_state (site_id, version, manifest_key)
  VALUES (NEW.site_id, 'initial', NULL);
END;

-- A host can serve multiple sites when each uses a distinct path prefix.
-- Preview hosts must set noindex=1 so every response, including 404s, stays out
-- of search indexes.
CREATE TABLE managed_site_hosts (
  hostname TEXT NOT NULL
    CHECK (length(hostname) BETWEEN 1 AND 253 AND hostname = lower(hostname)
      AND hostname NOT GLOB '*[^a-z0-9.-]*' AND substr(hostname, 1, 1) <> '.'
      AND substr(hostname, -1, 1) <> '.' AND instr(hostname, '..') = 0),
  path_prefix TEXT NOT NULL DEFAULT ''
    CHECK (length(path_prefix) <= 160 AND (path_prefix = '' OR substr(path_prefix, 1, 1) = '/')
      AND (path_prefix = '' OR path_prefix = '/' OR substr(path_prefix, -1, 1) <> '/')),
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  noindex INTEGER NOT NULL DEFAULT 0 CHECK (noindex IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (hostname, path_prefix)
) STRICT;

CREATE INDEX managed_site_hosts_by_site ON managed_site_hosts(site_id, hostname, path_prefix);

ALTER TABLE managed_page_publications ADD COLUMN path TEXT;
ALTER TABLE managed_page_publications ADD COLUMN artifact_key TEXT;
ALTER TABLE managed_page_publications ADD COLUMN artifact_digest TEXT
  CHECK (artifact_digest IS NULL OR (length(artifact_digest) = 64 AND artifact_digest = lower(artifact_digest)));
ALTER TABLE managed_page_publications ADD COLUMN manifest_key TEXT;
ALTER TABLE managed_page_publications ADD COLUMN content_type TEXT;
ALTER TABLE managed_page_publications ADD COLUMN content_security_policy TEXT;

CREATE TRIGGER managed_page_publication_artifact_is_immutable
BEFORE UPDATE OF path, artifact_key, artifact_digest, manifest_key, content_type, content_security_policy ON managed_page_publications
WHEN OLD.artifact_key IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'managed published artifacts are immutable');
END;
