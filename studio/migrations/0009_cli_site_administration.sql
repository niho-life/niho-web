-- Rebuild the grant table to extend its capability check and allow indefinite grants.
-- CLI and membership audit rows have no foreign key to the grant being replaced.
DROP TRIGGER studio_cli_grants_revoke_on_demotion;

CREATE TABLE studio_cli_grants_v9 (
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
    'translations.translate', 'translations.publish', 'translations.settings',
    'site.settings.read', 'site.settings.write', 'site.members.read', 'site.members.manage'
  )),
  delegated_by_subject TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER CHECK (expires_at IS NULL OR expires_at > created_at),
  PRIMARY KEY (client_id, project_id, site_id, capability),
  FOREIGN KEY (project_id, site_id) REFERENCES sites(project_id, id),
  FOREIGN KEY (project_id, delegated_by_subject)
    REFERENCES project_members(project_id, access_subject) ON DELETE CASCADE
) STRICT;

INSERT INTO studio_cli_grants_v9 (client_id, project_id, site_id, capability, delegated_by_subject, created_at, expires_at)
SELECT client_id, project_id, site_id, capability, delegated_by_subject, created_at, expires_at
  FROM studio_cli_grants;

DROP TABLE studio_cli_grants;
ALTER TABLE studio_cli_grants_v9 RENAME TO studio_cli_grants;

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
