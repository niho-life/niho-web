-- A rollback is a new publication event that can point at an existing immutable manifest.
DROP TRIGGER managed_site_publication_history_after_pointer_update;

CREATE TABLE managed_site_publication_history_next (
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  release_id TEXT NOT NULL
    CHECK (length(release_id) = 64 AND release_id = lower(release_id) AND release_id NOT GLOB '*[^0-9a-f]*'),
  manifest_key TEXT NOT NULL
    CHECK (length(manifest_key) = length('managed-sites/' || site_id || '/manifests/') + 69
      AND substr(manifest_key, 1, length('managed-sites/' || site_id || '/manifests/'))
        = 'managed-sites/' || site_id || '/manifests/'
      AND substr(manifest_key, -5) = '.json'),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  actor_name TEXT,
  changed_paths_json TEXT,
  changed_path_count INTEGER,
  PRIMARY KEY (site_id, release_id)
) STRICT;

INSERT INTO managed_site_publication_history_next
  (site_id, release_id, manifest_key, created_at)
SELECT site_id, release_id, manifest_key, created_at
  FROM managed_site_publication_history;

DROP TABLE managed_site_publication_history;
ALTER TABLE managed_site_publication_history_next RENAME TO managed_site_publication_history;

CREATE INDEX managed_site_publication_history_by_site
  ON managed_site_publication_history(site_id, created_at DESC, release_id DESC);

CREATE TRIGGER managed_site_publication_history_after_pointer_update
AFTER UPDATE OF version, manifest_key ON managed_site_publication_state
WHEN NEW.manifest_key IS NOT NULL AND (NEW.version <> OLD.version OR NEW.manifest_key <> OLD.manifest_key)
BEGIN
  INSERT OR IGNORE INTO managed_site_publication_history (site_id, release_id, manifest_key, created_at)
  VALUES (NEW.site_id, NEW.version, NEW.manifest_key, NEW.updated_at);
END;
