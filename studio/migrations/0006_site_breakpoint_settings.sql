CREATE TABLE site_breakpoint_settings (
  site_id TEXT PRIMARY KEY NOT NULL
    REFERENCES sites(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1
    CHECK (version >= 1),
  settings_json TEXT NOT NULL
    CHECK (json_valid(settings_json)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TRIGGER site_breakpoint_identity_is_immutable
BEFORE UPDATE OF site_id ON site_breakpoint_settings
BEGIN
  SELECT RAISE(ABORT, 'site breakpoint identity is immutable');
END;

INSERT INTO site_breakpoint_settings (site_id, settings_json)
SELECT id, '{"base":{"name":"Mobile","previewWidth":480},"breakpoints":[{"name":"Tablet","minWidth":691,"previewWidth":840},{"name":"Small","minWidth":991,"previewWidth":991},{"name":"PC","minWidth":1280,"previewWidth":1280}]}'
  FROM sites
 WHERE id = 'kamakura' AND project_id = 'project-kamakura';
