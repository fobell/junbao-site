CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL UNIQUE, display_name text NOT NULL,
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('admin','operator')), active boolean NOT NULL DEFAULT true,
 totp_secret text, totp_enabled boolean NOT NULL DEFAULT false, last_totp_step bigint NOT NULL DEFAULT -1,
 recovery_hashes jsonb NOT NULL DEFAULT '[]', must_change_password boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (id_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf text NOT NULL, expires_at timestamptz NOT NULL, last_seen timestamptz NOT NULL DEFAULT now());
CREATE TABLE accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, original_id text NOT NULL UNIQUE, app_id text UNIQUE, biz text,
 auto_sync boolean NOT NULL DEFAULT true, sync_hour integer NOT NULL DEFAULT 3 CHECK(sync_hour BETWEEN 0 AND 23),
 sync_minute integer NOT NULL DEFAULT 30 CHECK(sync_minute BETWEEN 0 AND 59), last_scheduled_date date,
 coverage text NOT NULL DEFAULT 'unverified' CHECK(coverage IN ('unverified','verified','has_gaps')), coverage_checked_at timestamptz,
 coverage_report jsonb NOT NULL DEFAULT '{}', last_synced_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE account_access (user_id uuid REFERENCES users(id) ON DELETE CASCADE, account_id uuid REFERENCES accounts(id) ON DELETE CASCADE, PRIMARY KEY(user_id,account_id));
CREATE TABLE connections (
 account_id uuid REFERENCES accounts(id) ON DELETE CASCADE, kind text NOT NULL CHECK(kind IN ('official','browser')),
 secret text NOT NULL, status text NOT NULL DEFAULT 'unknown', last_error text, last_checked_at timestamptz,
 token_secret text, token_expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,kind)
);
CREATE TABLE articles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id), platform_key text NOT NULL,
 title text NOT NULL, author text, published_at timestamptz, source_url text NOT NULL, source_state text NOT NULL DEFAULT 'available',
 current_version_id uuid, resource_state text NOT NULL DEFAULT 'pending', tags text[] NOT NULL DEFAULT '{}',
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,platform_key)
);
CREATE TABLE article_sources (account_id uuid REFERENCES accounts(id), source text NOT NULL, source_id text NOT NULL, article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE, source_url text NOT NULL, PRIMARY KEY(account_id,source,source_id));
CREATE TABLE article_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
 content_hash text NOT NULL, raw_key text NOT NULL, clean_html text NOT NULL, preview_html text NOT NULL, markdown text NOT NULL,
 plain_text text NOT NULL, metadata jsonb NOT NULL, warnings jsonb NOT NULL DEFAULT '[]', archived_at timestamptz NOT NULL DEFAULT now(), UNIQUE(article_id,content_hash)
);
ALTER TABLE articles ADD CONSTRAINT current_version_fk FOREIGN KEY(current_version_id) REFERENCES article_versions(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE assets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id), hash text NOT NULL, storage_key text NOT NULL, mime text NOT NULL, size bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,hash));
CREATE TABLE article_assets (version_id uuid REFERENCES article_versions(id) ON DELETE CASCADE, source_url text NOT NULL, asset_id uuid REFERENCES assets(id), state text NOT NULL DEFAULT 'pending', error text, PRIMARY KEY(version_id,source_url));
CREATE TABLE jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts(id), user_id uuid REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('sync','import','repair','export')), state text NOT NULL DEFAULT 'queued', phase text NOT NULL DEFAULT '等待执行',
 payload jsonb NOT NULL DEFAULT '{}', checkpoint jsonb NOT NULL DEFAULT '{}', report jsonb NOT NULL DEFAULT '{}',
 discovered integer NOT NULL DEFAULT 0, processed integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0,
 error text, idempotency_key text, attempts integer NOT NULL DEFAULT 0, cooldown_count integer NOT NULL DEFAULT 0,
 next_run_at timestamptz, heartbeat_at timestamptz, lease_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,idempotency_key)
);
CREATE UNIQUE INDEX one_account_job ON jobs(account_id) WHERE kind IN ('sync','import','repair') AND state IN ('queued','running','paused','waiting_auth','cooldown');
CREATE TABLE job_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, item_key text NOT NULL, ref jsonb NOT NULL, state text NOT NULL DEFAULT 'pending', article_id uuid REFERENCES articles(id), error text, UNIQUE(job_id,item_key));
CREATE TABLE outbox (id bigserial PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, generation uuid NOT NULL DEFAULT gen_random_uuid(), dispatched_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE exports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL UNIQUE REFERENCES jobs(id), user_id uuid NOT NULL REFERENCES users(id), storage_key text, size bigint, item_count integer NOT NULL, state text NOT NULL DEFAULT 'pending', manifest jsonb, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE export_items (export_id uuid NOT NULL REFERENCES exports(id) ON DELETE CASCADE, article_id uuid NOT NULL REFERENCES articles(id), account_id uuid NOT NULL REFERENCES accounts(id), snapshot jsonb NOT NULL, PRIMARY KEY(export_id,article_id));
CREATE TABLE browser_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id), user_id uuid NOT NULL REFERENCES users(id), state text NOT NULL DEFAULT 'starting', error text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes');
CREATE TABLE audit_events (id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id), action text NOT NULL, target_id text, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE system_status (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX article_account_date ON articles(account_id,published_at DESC);
CREATE INDEX article_title_search ON articles USING gin(title gin_trgm_ops);
CREATE INDEX article_body_search ON article_versions USING gin(plain_text gin_trgm_ops);
CREATE INDEX job_state ON jobs(state,next_run_at);
CREATE INDEX item_state ON job_items(job_id,state);
CREATE INDEX outbox_pending ON outbox(id) WHERE dispatched_at IS NULL;
