ALTER TABLE studio_cli_audit ADD COLUMN request_key TEXT CHECK (
  request_key IS NULL OR (
    length(request_key) = 36
    AND substr(request_key, 9, 1) = '-' AND substr(request_key, 14, 1) = '-'
    AND substr(request_key, 19, 1) = '-' AND substr(request_key, 24, 1) = '-'
    AND substr(request_key, 15, 1) = '4' AND substr(request_key, 20, 1) IN ('8', '9', 'a', 'b')
    AND length(replace(request_key, '-', '')) = 32
    AND replace(request_key, '-', '') NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE UNIQUE INDEX studio_cli_audit_by_request_key
  ON studio_cli_audit(project_id, site_id, actor_subject, request_key);
