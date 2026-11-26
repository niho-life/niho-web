ALTER TABLE managed_sites ADD COLUMN bindings_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE managed_page_versions ADD COLUMN bindings_json TEXT
  CHECK (bindings_json IS NULL OR json_valid(bindings_json));
ALTER TABLE managed_page_publications ADD COLUMN cms_release_id TEXT;
ALTER TABLE managed_page_publications ADD COLUMN cms_schema_revision TEXT
  CHECK ((cms_release_id IS NULL) = (cms_schema_revision IS NULL));
ALTER TABLE managed_pages ADD COLUMN published_publication_id TEXT REFERENCES managed_page_publications(id);

CREATE TRIGGER managed_page_bindings_generation
AFTER INSERT ON managed_page_versions
WHEN NEW.bindings_json IS NOT NULL OR EXISTS (
  SELECT 1 FROM managed_page_versions WHERE site_id = NEW.site_id AND page_id = NEW.page_id
    AND locale = NEW.locale AND revision = NEW.revision - 1 AND bindings_json IS NOT NULL
)
BEGIN
  UPDATE managed_sites SET bindings_generation = bindings_generation + 1 WHERE site_id = NEW.site_id;
END;

CREATE TABLE managed_page_operations (
  site_id TEXT NOT NULL REFERENCES managed_sites(site_id),
  actor_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  PRIMARY KEY (site_id, actor_id, operation_id)
) STRICT;
