ALTER TABLE managed_sites ADD COLUMN public_domain TEXT
  CHECK (public_domain IS NULL OR (
    length(public_domain) BETWEEN 4 AND 253
    AND public_domain = lower(public_domain)
    AND public_domain NOT GLOB '*[^a-z0-9.-]*'
    AND public_domain NOT GLOB '*..*'
    AND substr(public_domain, 1, 1) <> '.'
    AND substr(public_domain, -1, 1) <> '.'
  ));
ALTER TABLE managed_sites ADD COLUMN public_domain_version TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE managed_sites ADD COLUMN public_domain_noindex INTEGER NOT NULL DEFAULT 1
  CHECK (public_domain_noindex IN (0, 1));

CREATE UNIQUE INDEX managed_sites_public_domain_unique
  ON managed_sites(public_domain) WHERE public_domain IS NOT NULL;
