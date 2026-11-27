ALTER TABLE managed_site_hosts ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0
  CHECK (is_primary IN (0, 1));

UPDATE managed_site_hosts
   SET is_primary = 1
 WHERE path_prefix <> '' AND noindex = 0
   AND site_id NOT IN (SELECT site_id FROM managed_sites WHERE public_domain IS NOT NULL);

INSERT INTO managed_site_hosts (hostname, path_prefix, site_id, noindex, is_primary)
SELECT public_domain, '', site_id, public_domain_noindex, 1
  FROM managed_sites
 WHERE public_domain IS NOT NULL;

CREATE UNIQUE INDEX managed_site_hosts_one_primary
  ON managed_site_hosts(site_id) WHERE is_primary = 1;

CREATE TABLE managed_site_publication_history (
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  release_id TEXT NOT NULL
    CHECK (length(release_id) = 64 AND release_id = lower(release_id) AND release_id NOT GLOB '*[^0-9a-f]*'),
  manifest_key TEXT NOT NULL
    CHECK (manifest_key = 'managed-sites/' || site_id || '/manifests/' || release_id || '.json'),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (site_id, release_id)
) STRICT;

CREATE INDEX managed_site_publication_history_by_site
  ON managed_site_publication_history(site_id, created_at DESC, release_id DESC);

INSERT OR IGNORE INTO managed_site_publication_history (site_id, release_id, manifest_key, created_at)
SELECT site_id,
       substr(manifest_key, length('managed-sites/' || site_id || '/manifests/') + 1, 64),
       manifest_key,
       max(created_at)
  FROM managed_page_publications
 WHERE manifest_key IS NOT NULL
   AND manifest_key GLOB 'managed-sites/' || site_id || '/manifests/*.json'
 GROUP BY site_id, manifest_key;

INSERT OR IGNORE INTO managed_site_publication_history (site_id, release_id, manifest_key, created_at)
SELECT site_id,
       version,
       manifest_key,
       updated_at
  FROM managed_site_publication_state
 WHERE manifest_key IS NOT NULL;

CREATE TRIGGER managed_site_publication_history_after_pointer_update
AFTER UPDATE OF version, manifest_key ON managed_site_publication_state
WHEN NEW.manifest_key IS NOT NULL AND (NEW.version <> OLD.version OR NEW.manifest_key <> OLD.manifest_key)
BEGIN
  INSERT OR IGNORE INTO managed_site_publication_history (site_id, release_id, manifest_key, created_at)
  VALUES (NEW.site_id, NEW.version, NEW.manifest_key, NEW.updated_at);
END;
