CREATE TABLE IF NOT EXISTS public.infrastructure_smoke_probe (
  probe_key text PRIMARY KEY,
  last_command_id uuid NOT NULL,
  last_probe_token uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT infrastructure_smoke_probe_fixed_key
    CHECK (probe_key = 'mobile-server-database-v1')
);

ALTER TABLE public.infrastructure_smoke_probe ENABLE ROW LEVEL SECURITY;
