PRAGMA foreign_keys = ON;

-- Studio 内サイトの画像ライブラリ。バイト列は非公開 R2 の sites/{site_id}/assets/{content_sha256} に置く。
-- 同じサイトに同じバイト列を上げたら同じ素材を返す（UNIQUE）。削除は後続。
CREATE TABLE managed_site_assets (
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  asset_id TEXT NOT NULL CHECK (length(asset_id) = 28 AND substr(asset_id, 1, 4) = 'img_' AND substr(asset_id, 5) NOT GLOB '*[^a-z0-9]*'),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif')),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 20971520),
  width INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 100000),
  height INTEGER CHECK (height IS NULL OR height BETWEEN 1 AND 100000),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_by_subject TEXT NOT NULL CHECK (length(created_by_subject) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (site_id, asset_id),
  UNIQUE (site_id, content_sha256)
) STRICT;

CREATE UNIQUE INDEX managed_site_assets_asset_id ON managed_site_assets(asset_id);
