ALTER TABLE managed_site_publication_history ADD COLUMN actor_name TEXT;
ALTER TABLE managed_site_publication_history ADD COLUMN changed_paths_json TEXT;
ALTER TABLE managed_site_publication_history ADD COLUMN changed_path_count INTEGER;
