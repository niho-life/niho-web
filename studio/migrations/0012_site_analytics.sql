PRAGMA foreign_keys = ON;

-- サイト分析（GA4 / Search Console）の接続。サイトごとに1行で、既存 table は変えない（expand のみ）。
-- 鍵・access token・Google の生 response・検索語・個人単位の行は保存しない。
-- version は接続の変更・解除で進める CAS 用の整数。集計 cache はこの version に束縛する。
CREATE TABLE site_analytics_connections (
  site_id TEXT PRIMARY KEY NOT NULL
    REFERENCES sites(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1
    CHECK (version >= 1),
  ga4_property_id TEXT
    CHECK (ga4_property_id IS NULL OR (length(ga4_property_id) BETWEEN 4 AND 20 AND ga4_property_id NOT GLOB '*[^0-9]*')),
  ga4_stream_id TEXT
    CHECK (ga4_stream_id IS NULL OR (length(ga4_stream_id) BETWEEN 1 AND 20 AND ga4_stream_id NOT GLOB '*[^0-9]*')),
  -- 接続時にストリームの defaultUri から得た origin。sites.public_origin と一致する間だけ有効。
  ga4_stream_origin TEXT
    CHECK (ga4_stream_origin IS NULL OR (length(ga4_stream_origin) BETWEEN 9 AND 2048 AND substr(ga4_stream_origin, 1, 8) = 'https://')),
  ga4_measurement_id TEXT
    CHECK (ga4_measurement_id IS NULL OR (length(ga4_measurement_id) BETWEEN 6 AND 26 AND substr(ga4_measurement_id, 1, 2) = 'G-')),
  ga4_time_zone TEXT
    CHECK (ga4_time_zone IS NULL OR length(ga4_time_zone) BETWEEN 1 AND 80),
  ga4_reporting_state TEXT NOT NULL DEFAULT 'not-connected'
    CHECK (ga4_reporting_state IN ('not-connected', 'checking', 'connected', 'permission-required', 'property-mismatch', 'permission-revoked', 'syncing', 'sync-delayed', 'quota-limited', 'partial', 'failed')),
  ga4_tracking_tag_state TEXT NOT NULL DEFAULT 'not-configured'
    CHECK (ga4_tracking_tag_state IN ('not-configured', 'pending', 'published', 'failed')),
  ga4_last_synced_at INTEGER,
  gsc_property_kind TEXT
    CHECK (gsc_property_kind IS NULL OR gsc_property_kind IN ('url-prefix', 'domain')),
  gsc_property_value TEXT
    CHECK (gsc_property_value IS NULL OR length(gsc_property_value) BETWEEN 1 AND 2048),
  gsc_reporting_state TEXT NOT NULL DEFAULT 'not-connected'
    CHECK (gsc_reporting_state IN ('not-connected', 'checking', 'connected', 'permission-required', 'property-mismatch', 'permission-revoked', 'syncing', 'sync-delayed', 'quota-limited', 'partial', 'failed')),
  gsc_ownership_state TEXT NOT NULL DEFAULT 'not-verified'
    CHECK (gsc_ownership_state IN ('not-verified', 'pending', 'verified', 'failed')),
  gsc_last_synced_at INTEGER,
  updated_by_subject TEXT NOT NULL
    CHECK (length(updated_by_subject) BETWEEN 1 AND 128 AND updated_by_subject = trim(updated_by_subject)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((ga4_property_id IS NULL) = (ga4_stream_id IS NULL)
     AND (ga4_property_id IS NULL) = (ga4_stream_origin IS NULL)
     AND (ga4_property_id IS NULL) = (ga4_time_zone IS NULL)
     AND (ga4_property_id IS NOT NULL OR ga4_reporting_state = 'not-connected')),
  CHECK ((gsc_property_kind IS NULL) = (gsc_property_value IS NULL)
     AND (gsc_property_kind IS NOT NULL OR gsc_reporting_state = 'not-connected'))
) STRICT;

CREATE TRIGGER site_analytics_connection_identity_is_immutable
BEFORE UPDATE OF site_id ON site_analytics_connections
BEGIN
  SELECT RAISE(ABORT, 'site analytics connection identity is immutable');
END;

-- 確認画面と反映の間を、site・action・actor・接続 version・payload・有効期限（2分）へ固定する一回用の plan。
-- confirmation token は hash だけを保存し、apply で消費する。
CREATE TABLE site_analytics_plans (
  token_hash TEXT PRIMARY KEY NOT NULL
    CHECK (length(token_hash) = 64 AND token_hash = lower(token_hash)),
  site_id TEXT NOT NULL
    REFERENCES sites(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action TEXT NOT NULL
    CHECK (action IN ('connect-ga4', 'disconnect-ga4', 'connect-search-console', 'disconnect-search-console')),
  actor_subject TEXT NOT NULL
    CHECK (length(actor_subject) BETWEEN 1 AND 128 AND actor_subject = trim(actor_subject)),
  -- 0 は接続の行がまだ無い状態。
  connection_version INTEGER NOT NULL
    CHECK (connection_version >= 0),
  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json) AND length(payload_json) <= 4096),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
    CHECK (expires_at > created_at AND expires_at <= created_at + 120)
) STRICT;

CREATE INDEX site_analytics_plans_by_site
  ON site_analytics_plans(site_id, expires_at);

-- 正規化済みの集計（閲覧契約の source 結果）だけを、site・source・期間・接続 version・期間の終端日に束縛して短時間保存する。
CREATE TABLE site_analytics_cache (
  site_id TEXT NOT NULL
    REFERENCES sites(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source TEXT NOT NULL
    CHECK (source IN ('ga4', 'search-console')),
  period TEXT NOT NULL
    CHECK (period IN ('7d', '28d', '3m', '12m')),
  connection_version INTEGER NOT NULL
    CHECK (connection_version >= 1),
  range_end TEXT NOT NULL
    CHECK (length(range_end) = 10),
  result_json TEXT NOT NULL
    CHECK (json_valid(result_json) AND length(result_json) <= 262144),
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
    CHECK (expires_at > fetched_at AND expires_at <= fetched_at + 3600),
  PRIMARY KEY (site_id, source, period)
) STRICT;
