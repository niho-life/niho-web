CREATE TABLE managed_site_redirects (
  site_id TEXT NOT NULL
    REFERENCES managed_sites(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  locale TEXT NOT NULL
    CHECK (length(locale) BETWEEN 2 AND 40),
  from_path TEXT NOT NULL
    CHECK (length(from_path) BETWEEN 1 AND 160 AND substr(from_path, 1, 1) = '/'),
  to_path TEXT NOT NULL
    CHECK (length(to_path) BETWEEN 1 AND 160 AND substr(to_path, 1, 1) = '/' AND to_path <> from_path),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (site_id, from_path)
) STRICT;
