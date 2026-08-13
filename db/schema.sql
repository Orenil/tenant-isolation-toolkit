-- Schema + RLS policies for the tenant-isolation-toolkit test database.
--
-- Design: isolation is enforced by Postgres itself via row-level security
-- policies keyed off two session variables that TenantPool sets, inside a
-- transaction, on every query:
--
--   app.tenant_id   - the tenant the current request is scoped to
--   app.bypass_rls  - 'on' only when running inside runWithElevatedContext
--
-- The `tenant_app` role is NOT the table owner and is NOT superuser, which
-- is what makes RLS apply to it at all (table owners and superusers bypass
-- RLS by default unless the table has FORCE ROW LEVEL SECURITY). We set
-- FORCE anyway as defense in depth, so accidentally running migrations or
-- ad-hoc queries as the owning role doesn't silently disable isolation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_app') THEN
    CREATE ROLE tenant_app LOGIN;
  END IF;
END
$$;

DROP TABLE IF EXISTS items CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;

CREATE TABLE tenants (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE items (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name      text NOT NULL,
  secret    text NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, items TO tenant_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO tenant_app;

ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;

-- current_setting(..., true) returns NULL (rather than raising) when the
-- variable has never been set on this connection/transaction at all. NULL
-- compared against tenant_id is never true, so a connection that never
-- went through TenantPool.withTenant() sees zero rows -- fail closed, not
-- fail open.
CREATE POLICY tenant_isolation ON items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Separate permissive policy for the audited escape hatch. Permissive
-- policies on the same table are OR'd together by Postgres, so this widens
-- access only when app.bypass_rls was explicitly set to 'on' by
-- runWithElevatedContext -- normal tenant contexts never set it, so this
-- policy is a no-op for them.
CREATE POLICY tenant_isolation_bypass ON items
  USING (current_setting('app.bypass_rls', true) = 'on')
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on');

-- tenants table itself is intentionally not RLS-scoped: it's the directory
-- of tenants, not tenant data. (Not part of this project's demo surface.)
