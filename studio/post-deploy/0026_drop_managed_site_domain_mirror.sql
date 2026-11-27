-- Apply after every Worker version that reads the legacy domain mirror is no longer a rollback target.
DROP INDEX IF EXISTS managed_sites_public_domain_unique;
ALTER TABLE managed_sites DROP COLUMN public_domain;
ALTER TABLE managed_sites DROP COLUMN public_domain_noindex;
