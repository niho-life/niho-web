PRAGMA foreign_keys = ON;

-- Keep only the current draft and published pointers in D1. Style snapshots are
-- immutable, site-scoped R2 objects; retained_bytes follows managed CMS limits.
CREATE TABLE managed_site_styles (
  site_id TEXT PRIMARY KEY NOT NULL
    REFERENCES managed_sites(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  draft_version TEXT NOT NULL DEFAULT 'initial'
    CHECK (length(draft_version) BETWEEN 1 AND 200),
  draft_key TEXT,
  draft_digest TEXT
    CHECK (draft_digest IS NULL OR (length(draft_digest) = 64 AND draft_digest NOT GLOB '*[^0-9a-f]*')),
  published_version TEXT NOT NULL DEFAULT 'initial'
    CHECK (length(published_version) BETWEEN 1 AND 200),
  published_key TEXT,
  published_digest TEXT
    CHECK (published_digest IS NULL OR (length(published_digest) = 64 AND published_digest NOT GLOB '*[^0-9a-f]*')),
  retained_bytes INTEGER NOT NULL DEFAULT 0 CHECK (retained_bytes BETWEEN 0 AND 104857600),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by_subject TEXT
    CHECK (updated_by_subject IS NULL OR (length(updated_by_subject) BETWEEN 1 AND 256 AND updated_by_subject = trim(updated_by_subject))),
  CHECK ((draft_version = 'initial' AND draft_key IS NULL AND draft_digest IS NULL)
      OR (draft_version <> 'initial' AND draft_key GLOB 'sites/*/site-styles/*.json' AND draft_digest IS NOT NULL)),
  CHECK ((published_version = 'initial' AND published_key IS NULL AND published_digest IS NULL)
      OR (published_version <> 'initial' AND published_key GLOB 'sites/*/site-styles/*.json' AND published_digest IS NOT NULL))
) STRICT;

INSERT INTO managed_site_styles (site_id)
SELECT site_id FROM managed_sites;

CREATE TRIGGER managed_site_styles_after_site_insert
AFTER INSERT ON managed_sites
BEGIN
  INSERT OR IGNORE INTO managed_site_styles (site_id) VALUES (NEW.site_id);
END;

CREATE TRIGGER managed_site_styles_identity_is_immutable
BEFORE UPDATE OF site_id ON managed_site_styles
BEGIN
  SELECT RAISE(ABORT, 'managed site styles identity is immutable');
END;
