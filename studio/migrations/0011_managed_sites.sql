PRAGMA foreign_keys = ON;

-- Studio が D1 だけで所有するサイト。sites.public_origin は既存ホスト用の
-- UNIQUE 契約を保ち、共有公開 origin と path prefix はこの登録から投影する。
CREATE TABLE managed_sites (
  site_id TEXT PRIMARY KEY NOT NULL
    REFERENCES sites(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  slug TEXT NOT NULL UNIQUE
    CHECK (
      length(slug) BETWEEN 1 AND 63
      AND slug = lower(slug)
      AND slug NOT GLOB '*[^a-z0-9-]*'
      AND substr(slug, 1, 1) <> '-'
      AND substr(slug, -1, 1) <> '-'
      AND instr(slug, '--') = 0
    ),
  created_by_subject TEXT NOT NULL
    CHECK (length(created_by_subject) BETWEEN 1 AND 128 AND created_by_subject = trim(created_by_subject)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE managed_pages (
  site_id TEXT NOT NULL
    REFERENCES managed_sites(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  page_id TEXT NOT NULL
    CHECK (length(page_id) BETWEEN 1 AND 80),
  locale TEXT NOT NULL
    CHECK (length(locale) BETWEEN 2 AND 40),
  title TEXT NOT NULL
    CHECK (length(trim(title)) BETWEEN 1 AND 120),
  path TEXT NOT NULL
    CHECK (length(path) BETWEEN 1 AND 160 AND substr(path, 1, 1) = '/'),
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'private')),
  current_version TEXT NOT NULL
    CHECK (length(current_version) BETWEEN 1 AND 200),
  current_revision INTEGER NOT NULL
    CHECK (current_revision >= 1),
  published_revision INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (site_id, page_id, locale),
  UNIQUE (site_id, path),
  CHECK (published_revision IS NULL OR published_revision >= 1)
) STRICT;

CREATE TABLE managed_page_versions (
  site_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'save', 'restore')),
  created_by_subject TEXT NOT NULL
    CHECK (length(created_by_subject) BETWEEN 1 AND 256 AND created_by_subject = trim(created_by_subject)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (site_id, page_id, locale, revision),
  FOREIGN KEY (site_id, page_id, locale)
    REFERENCES managed_pages(site_id, page_id, locale) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE managed_page_publications (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  action TEXT NOT NULL CHECK (action IN ('publish', 'rollback')),
  published_by_subject TEXT NOT NULL
    CHECK (length(published_by_subject) BETWEEN 1 AND 256 AND published_by_subject = trim(published_by_subject)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (site_id, page_id, locale, source_revision)
    REFERENCES managed_page_versions(site_id, page_id, locale, revision) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX managed_page_publications_by_page
  ON managed_page_publications(site_id, page_id, locale, created_at DESC, id DESC);

-- 確認画面と反映の間を、actor・site・対象版・有効期限へ固定する短命plan。
CREATE TABLE managed_editor_plans (
  token_hash TEXT PRIMARY KEY NOT NULL
    CHECK (length(token_hash) = 64 AND token_hash = lower(token_hash)),
  site_id TEXT NOT NULL
    REFERENCES managed_sites(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_subject TEXT NOT NULL
    CHECK (length(actor_subject) BETWEEN 1 AND 128 AND actor_subject = trim(actor_subject)),
  operation TEXT NOT NULL
    CHECK (operation IN ('release.publish', 'release.rollback', 'page.create', 'page.update', 'page.visibility')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 900)
) STRICT;

CREATE INDEX managed_editor_plans_by_expiry
  ON managed_editor_plans(expires_at);

CREATE TABLE managed_site_audit (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_subject TEXT NOT NULL
    CHECK (length(actor_subject) BETWEEN 1 AND 256 AND actor_subject = trim(actor_subject)),
  action TEXT NOT NULL
    CHECK (action IN ('site.created', 'page.created', 'page.saved', 'page.published', 'page.restored', 'page.updated', 'page.visibility')),
  page_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX managed_site_audit_by_site
  ON managed_site_audit(site_id, created_at DESC, id DESC);

CREATE TRIGGER managed_site_identity_is_immutable
BEFORE UPDATE OF site_id, slug ON managed_sites
BEGIN
  SELECT RAISE(ABORT, 'managed site identity is immutable');
END;

CREATE TRIGGER managed_page_identity_is_immutable
BEFORE UPDATE OF site_id, page_id, locale ON managed_pages
BEGIN
  SELECT RAISE(ABORT, 'managed page identity is immutable');
END;

CREATE TRIGGER managed_page_versions_are_immutable
BEFORE UPDATE ON managed_page_versions
BEGIN
  SELECT RAISE(ABORT, 'managed page versions are immutable');
END;

CREATE TRIGGER managed_active_page_versions_cannot_be_deleted
BEFORE DELETE ON managed_page_versions
WHEN EXISTS (
  SELECT 1 FROM managed_pages
   WHERE site_id = OLD.site_id AND page_id = OLD.page_id AND locale = OLD.locale
     AND (current_revision = OLD.revision OR published_revision = OLD.revision)
)
BEGIN
  SELECT RAISE(ABORT, 'active managed page versions cannot be deleted');
END;

CREATE TRIGGER managed_page_publications_are_immutable
BEFORE UPDATE ON managed_page_publications
BEGIN
  SELECT RAISE(ABORT, 'managed publications are immutable');
END;

CREATE TRIGGER managed_page_publications_cannot_be_deleted
BEFORE DELETE ON managed_page_publications
BEGIN
  SELECT RAISE(ABORT, 'managed publications cannot be deleted');
END;

CREATE TRIGGER managed_site_audit_is_immutable
BEFORE UPDATE ON managed_site_audit
BEGIN
  SELECT RAISE(ABORT, 'managed audit is immutable');
END;

CREATE TRIGGER managed_site_audit_cannot_be_deleted
BEFORE DELETE ON managed_site_audit
BEGIN
  SELECT RAISE(ABORT, 'managed audit cannot be deleted');
END;
