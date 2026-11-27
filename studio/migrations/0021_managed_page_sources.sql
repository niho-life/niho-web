ALTER TABLE managed_page_versions ADD COLUMN document_key TEXT;
ALTER TABLE managed_page_versions ADD COLUMN document_digest TEXT
  CHECK (document_digest IS NULL OR (length(document_digest) = 64 AND document_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE managed_page_versions ADD COLUMN link_index_json TEXT
  CHECK ((document_key IS NULL AND document_digest IS NULL AND link_index_json IS NULL)
      OR (document_key IS NOT NULL AND document_digest IS NOT NULL AND link_index_json IS NOT NULL
          AND json_valid(link_index_json) AND document_json = '{}'));

DROP TRIGGER managed_page_versions_are_immutable;
CREATE TRIGGER managed_page_versions_are_immutable
BEFORE UPDATE ON managed_page_versions
WHEN NOT (
  OLD.document_key IS NULL AND OLD.document_digest IS NULL AND OLD.link_index_json IS NULL
  AND NEW.document_key IS NOT NULL AND NEW.document_digest IS NOT NULL AND NEW.link_index_json IS NOT NULL
  AND NEW.document_json = '{}'
  AND NEW.site_id = OLD.site_id AND NEW.page_id = OLD.page_id AND NEW.locale = OLD.locale
  AND NEW.revision = OLD.revision AND NEW.kind = OLD.kind
  AND NEW.created_by_subject = OLD.created_by_subject AND NEW.created_at = OLD.created_at
  AND NEW.bindings_json IS OLD.bindings_json
)
BEGIN
  SELECT RAISE(ABORT, 'managed page versions are immutable');
END;
