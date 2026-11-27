ALTER TABLE managed_page_publications ADD COLUMN published_path TEXT
  CHECK (published_path IS NULL OR (length(published_path) BETWEEN 1 AND 160 AND substr(published_path, 1, 1) = '/'));

UPDATE managed_page_publications
   SET published_path = (
     SELECT mp.path FROM managed_pages AS mp
      WHERE mp.site_id = managed_page_publications.site_id
        AND mp.page_id = managed_page_publications.page_id
        AND mp.locale = managed_page_publications.locale
   )
 WHERE published_path IS NULL;

CREATE INDEX managed_page_publications_by_path
  ON managed_page_publications(site_id, published_path, source_revision);
