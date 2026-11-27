ALTER TABLE managed_sites ADD COLUMN public_policy_json TEXT NOT NULL
  DEFAULT '{"frameOrigins":[],"resourceOrigins":[],"ga4MeasurementId":null}' CHECK (json_valid(public_policy_json));
ALTER TABLE managed_sites ADD COLUMN public_policy_version TEXT NOT NULL DEFAULT 'initial';

CREATE TABLE managed_embed_connections (
  site_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  parent_origin TEXT NOT NULL,
  public_path TEXT NOT NULL,
  src TEXT NOT NULL,
  PRIMARY KEY (site_id, ref_id),
  FOREIGN KEY (site_id, page_id, locale) REFERENCES managed_pages(site_id, page_id, locale)
) STRICT;
