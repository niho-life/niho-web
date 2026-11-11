PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX sites_by_project_and_id ON sites(project_id, id);

CREATE TABLE studio_cli_grants (
  client_id TEXT NOT NULL
    CHECK (length(client_id) = 39 AND substr(client_id, 33) = '.access'
      AND substr(client_id, 1, 32) NOT GLOB '*[^0-9a-f]*'),
  project_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN (
    'pages.read', 'pages.edit', 'pages.publish',
    'cms.read', 'cms.edit', 'cms.publish',
    'assets.read', 'assets.edit',
    'translations.read', 'translations.edit', 'translations.review',
    'translations.translate', 'translations.publish', 'translations.settings'
  )),
  delegated_by_subject TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  PRIMARY KEY (client_id, project_id, site_id, capability),
  FOREIGN KEY (project_id, site_id) REFERENCES sites(project_id, id),
  FOREIGN KEY (project_id, delegated_by_subject)
    REFERENCES project_members(project_id, access_subject) ON DELETE CASCADE
) STRICT;

CREATE INDEX studio_cli_grants_by_delegator
  ON studio_cli_grants(project_id, delegated_by_subject);

CREATE TRIGGER studio_cli_grants_require_owner
BEFORE INSERT ON studio_cli_grants
WHEN NOT EXISTS (
  SELECT 1 FROM project_members
   WHERE project_id = NEW.project_id AND access_subject = NEW.delegated_by_subject AND role = 'owner'
)
BEGIN
  SELECT RAISE(ABORT, 'CLI grants require a project owner');
END;

CREATE TRIGGER studio_cli_grants_are_immutable
BEFORE UPDATE ON studio_cli_grants
BEGIN
  SELECT RAISE(ABORT, 'replace a CLI grant to change its delegation or expiry');
END;

CREATE TRIGGER studio_cli_grants_revoke_on_demotion
AFTER UPDATE OF role ON project_members
WHEN OLD.role = 'owner' AND NEW.role <> 'owner'
BEGIN
  DELETE FROM studio_cli_grants
   WHERE project_id = OLD.project_id AND delegated_by_subject = OLD.access_subject;
END;

CREATE TABLE studio_cli_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_subject TEXT NOT NULL,
  delegated_by_subject TEXT NOT NULL,
  project_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (length(target_json) <= 1024),
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  FOREIGN KEY (project_id, site_id) REFERENCES sites(project_id, id)
) STRICT;

CREATE INDEX studio_cli_audit_by_site
  ON studio_cli_audit(project_id, site_id, started_at DESC);
