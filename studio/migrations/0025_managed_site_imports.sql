CREATE TABLE managed_site_imports (
  site_id TEXT PRIMARY KEY NOT NULL REFERENCES managed_sites(site_id),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
  actor_subject TEXT NOT NULL,
  verification_origin TEXT NOT NULL,
  home_version TEXT NOT NULL,
  setup_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE managed_site_import_resources (
  site_id TEXT NOT NULL REFERENCES managed_site_imports(site_id),
  kind TEXT NOT NULL CHECK (kind IN ('page', 'cms')),
  source_key TEXT NOT NULL,
  target_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  PRIMARY KEY (site_id, kind, source_key),
  UNIQUE (site_id, kind, target_id)
) STRICT;

CREATE TABLE managed_site_import_asset_blobs (
  site_id TEXT NOT NULL REFERENCES managed_site_imports(site_id),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (site_id, content_digest)
) STRICT;
