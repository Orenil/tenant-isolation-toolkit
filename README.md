# tenant-isolation-toolkit

A Postgres row-level-security multi-tenancy toolkit: tenant context is
propagated at the connection level and isolation is enforced by the
database itself, not by application code remembering to add
`WHERE tenant_id = ?` to every query.

## Problem

The standard way multi-tenant apps enforce isolation is "every query
includes a tenant filter." That's an app-level convention, not a
guarantee — one missed `WHERE` clause in one code path, one new endpoint
someone forgets to scope, one raw admin script, and tenant A reads tenant
B's rows. That bug class is extremely common and extremely expensive.

This project moves the enforcement point into Postgres: every table with
tenant data has row-level security policies keyed off a per-transaction
session variable. A query that forgets its tenant filter doesn't leak data
— it just gets the same rows a correctly-filtered query would get, because
the database is doing the filtering regardless of what the query text
says.

## Architecture

```
 request                 AsyncLocalStorage            Postgres (per txn)
┌─────────┐   tenantId   ┌────────────────┐  BEGIN;             ┌──────────┐
│middleware│─────────────▶│ tenant context │  set_config(...);   │   RLS    │
│/interceptor│            │ (context.ts)   │─────────────────────▶│ policies │
└─────────┘               └────────────────┘  <query>;           └──────────┘
                                  │            COMMIT;
                                  ▼
                            TenantPool.query() — the only sanctioned
                            path to the database (pool.ts)
```

**Tenant context lives in `AsyncLocalStorage`, not a request object.**
`runWithTenant(tenantId, fn)` binds the tenant id for the entire async call
chain kicked off inside `fn` — route handler, service calls, further
`await`s — without threading it through every function signature by hand.
Framework adapters (`tenantMiddleware` for Express, `TenantInterceptor` for
NestJS) are thin: they resolve a tenant id from the request and call
`runWithTenant` once. *Rejected alternative:* passing a `tenantId` param
through every function call. Correct, but it means any function anywhere
in the call graph could accidentally be called without it, which is
exactly the "one missed spot" failure mode this project exists to close.

**Isolation is enforced with `SET LOCAL` (via `set_config(..., true)`)
inside a transaction wrapped around every query, not a `SET` on
checkout.** `SET` mutates session state for the lifetime of the physical
connection — on a pooled connection, that means the *next* logical request
to reuse that socket silently inherits the previous request's tenant,
regardless of whether it remembers to reset anything. `SET LOCAL` is
scoped to the current transaction and is unconditionally undone at
`COMMIT`/`ROLLBACK`, so it cannot survive into whatever request the pool
hands that connection to next — the safety property comes from the
transaction boundary, not from anyone remembering to clean up. On top of
that, `TenantPool` also runs a defensive `RESET` on every checkout release
and every new physical connection, and the RLS policy itself is written to
fail closed (§ below) if a session variable is ever missing. *Rejected
alternative:* resetting session vars only in the pool's `connect` event.
That event fires once per new physical connection, not per checkout of an
already-open idle connection — so it would do nothing for the exact
failure mode (idle-connection reuse) that matters most.

**Fail closed, not fail open.** The RLS policy is
`tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`.
`current_setting(..., true)` returns `NULL` instead of raising when the
variable was never set — and a connection that never went through
`TenantPool` never has it set. `tenant_id = NULL` is never true in SQL, so
an unscoped connection sees **zero rows**, not every tenant's rows. This
is deliberate: an app-layer bug in *setting* the context degrades to "this
request sees nothing," which is broken but safe, instead of "this request
sees everyone's data."

**Session variables are set via `set_config($1, $2, true)` — a
parameterized query — never string-interpolated SQL.** A malformed or
adversarial tenant id can't be used to inject SQL through the
context-setting step itself; at worst it fails the `::uuid` cast in the
policy and the query errors out.

**The escape hatch is a separate, explicit code path, not a fallback.**
`runWithElevatedContext(actor, reason, fn)` is structurally distinct from
`runWithTenant`: it requires both an `actor` and a `reason` string (throws
without them), sets a second session flag (`app.bypass_rls`), and
unconditionally emits an audit event before and after the elevated work
runs. A second, separate *permissive* RLS policy
(`tenant_isolation_bypass`, OR'd with the tenant-scoped policy by
Postgres) is what actually grants the cross-tenant visibility — normal
request handling has no path that ever sets `app.bypass_rls`, so it's
opt-in by construction, not something a misconfigured request can stumble
into. *Rejected alternative:* a superuser/table-owner connection for admin
tooling. Table owners and superusers bypass RLS entirely and silently by
default in Postgres, with no audit trail and no `WITH CHECK` protection —
exactly the kind of implicit, unaudited bypass this project is trying to
avoid.

**The CI bypass check is real static analysis (TypeScript compiler API),
not a regex.** `scripts/check-raw-queries.ts` parses every `.ts` file
under `src/` and `examples/` into an AST and flags any `import ... from
"pg"` (or `require("pg")`) outside `src/pool.ts`. `TenantPool` is the only
code path that sets the RLS session variables before running a query, so
any other file reaching for `pg` directly is a structural bypass of
isolation — this makes that fail the build instead of landing silently.
Tested against both a compliant fixture and a deliberately-bypassing one
(`test/fixtures/`).

## Project layout

```
src/                    framework-agnostic core (Node/TypeScript, no framework deps)
  context.ts              AsyncLocalStorage tenant context + audited escape hatch
  pool.ts                 TenantPool: the only sanctioned way to query Postgres
  middleware.ts            Express-compatible middleware adapter
db/schema.sql            tables, RLS policies, the tenant_app role
scripts/
  db-start.sh / db-stop.sh   local throwaway Postgres cluster (unix socket only)
  check-raw-queries.ts       CI lint gate (real AST-based static analysis)
examples/nestjs-demo/     a real NestJS app wiring the middleware in as an
                          interceptor + a pg-pool provider through Nest's DI
test/                     adversarial RLS suite, pool-reset stress test, lint-gate tests
```

## Setup

Requires Node 20+ and local Postgres binaries (`initdb`, `pg_ctl`, `psql`)
on your `PATH` — on macOS, `brew install postgresql@14` and add
`/opt/homebrew/bin` (or wherever brew put it) to `PATH`.

```bash
git clone <this-repo>
cd tenant-isolation-toolkit
npm install

# Stands up a throwaway local Postgres cluster under ./.pgdata, listening
# only on a unix socket (no TCP port, so it can't collide with anything
# else running on the machine), creates the test database, and applies
# db/schema.sql (tables + RLS policies + the tenant_app role).
npm run db:start

export PGHOST="$PWD/.pgdata/sock"
export PGUSER=tenant_app
export PGDATABASE=tenant_toolkit_test

npm run lint        # CI's static-analysis bypass check
npm run typecheck
npm test            # adversarial RLS suite + pool-stress test + lint-gate tests + NestJS e2e

npm run db:stop      # stop the cluster (add --wipe to also delete ./.pgdata)
```

To run the NestJS demo as a standalone HTTP server (same env vars as
above):

```bash
npm run start:nestjs-demo
# in another shell:
curl -H "x-tenant-id: <some-uuid>" http://localhost:3000/items
```

## Usage

```ts
import { TenantPool, runWithTenant, runWithElevatedContext } from "./src";

const pool = new TenantPool({ database: "tenant_toolkit_test" });

// Every query inside this callback is scoped to tenantId by RLS, even if
// the query itself has no WHERE clause.
await runWithTenant(tenantId, async () => {
  const items = await pool.query("SELECT * FROM items"); // filter-less, still scoped
});

// Admin/support tooling only — audited, explicit, opt-in.
await runWithElevatedContext("support-agent-42", "customer escalation #1234", async () => {
  const allItems = await pool.query("SELECT * FROM items"); // sees every tenant
});
```

## Real test output

Local cluster started via `npm run db:start`, then `npm test` against real
Postgres 14 (Homebrew), unix-socket only:

```
> tenant-isolation-toolkit@0.1.0 test
> vitest run --reporter=verbose

 RUN  v2.1.9 /Users/mac/tenant-isolation-toolkit

 ✓ test/adversarial.test.ts > adversarial: RLS blocks cross-tenant access even with filter-less queries > a filter-less SELECT under tenant A's context returns only tenant A's rows
 ✓ test/adversarial.test.ts > adversarial: RLS blocks cross-tenant access even with filter-less queries > the same filter-less SELECT under tenant B's context returns only tenant B's rows
 ✓ test/adversarial.test.ts > adversarial: RLS blocks cross-tenant access even with filter-less queries > tenant A can never see even a single row belonging to tenant B
 ✓ test/adversarial.test.ts > adversarial: RLS blocks cross-tenant access even with filter-less queries > a connection with NO tenant context set at all sees zero rows (fails closed, not open)
 ✓ test/adversarial.test.ts > adversarial: RLS blocks cross-tenant access even with filter-less queries > WITH CHECK rejects trying to write a row under a different tenant's id while impersonating tenant A
 ✓ test/adversarial.test.ts > adversarial: RLS blocks cross-tenant access even with filter-less queries > a crafted tenant id cannot inject SQL through the session-variable setup (set_config is parameterized)
 ✓ test/adversarial.test.ts > adversarial: RLS blocks cross-tenant access even with filter-less queries > the audited escape hatch is opt-in only: normal tenant context never sees cross-tenant rows
 ✓ test/adversarial.test.ts > adversarial: RLS blocks cross-tenant access even with filter-less queries > runWithElevatedContext can see rows across every tenant, and emits audit events
 ✓ test/adversarial.test.ts > adversarial: RLS blocks cross-tenant access even with filter-less queries > runWithElevatedContext requires both an actor and a reason
 ✓ test/pool-stress.test.ts > connection pool: no tenant-context leakage across rapid checkout/release cycles > 200 concurrent alternating-tenant operations on a 3-connection pool never observe another tenant's context
 ✓ test/pool-stress.test.ts > connection pool: no tenant-context leakage across rapid checkout/release cycles > a fresh checkout never inherits a bypass flag left by a previous elevated request
 ✓ examples/nestjs-demo/test/app.e2e.test.ts > NestJS demo: tenant isolation enforced end-to-end through the interceptor + RLS > rejects a request missing the x-tenant-id header before it ever reaches the controller
 ✓ examples/nestjs-demo/test/app.e2e.test.ts > NestJS demo: tenant isolation enforced end-to-end through the interceptor + RLS > GET /items with tenant A's header returns only tenant A's rows, from a filter-less controller query
 ✓ examples/nestjs-demo/test/app.e2e.test.ts > NestJS demo: tenant isolation enforced end-to-end through the interceptor + RLS > GET /items with tenant B's header never returns any of tenant A's rows
 ✓ test/lint.test.ts > CI lint gate: raw pg import bypass check > passes a compliant fixture that only imports TenantPool
 ✓ test/lint.test.ts > CI lint gate: raw pg import bypass check > flags a fixture that imports Pool from 'pg' directly, with file and line
 ✓ test/lint.test.ts > CI lint gate: raw pg import bypass check > the real source tree (src/, examples/) is itself compliant
 ✓ test/lint.test.ts > CI lint gate: raw pg import bypass check > src/pool.ts is allowlisted since it IS the sanctioned pg entry point
 ✓ test/lint.test.ts > CI lint gate: raw pg import bypass check > without the allowlist, src/pool.ts itself would be flagged (proving the check actually inspects it)

 Test Files  4 passed (4)
      Tests  19 passed (19)
```

```
> tenant-isolation-toolkit@0.1.0 lint
> tsx scripts/check-raw-queries.ts

Raw query bypass check passed: no direct "pg" imports outside src/pool.ts.
```

## What's covered by the adversarial suite

- Filter-less `SELECT * FROM items` under tenant A's context returns only
  tenant A's rows; same query under tenant B's context returns only
  tenant B's rows.
- A raw connection that never went through `TenantPool` (no context set at
  all) sees **zero** rows — fail closed, not fail open.
- `WITH CHECK` rejects inserting a row tagged with a different tenant's id
  while impersonating another tenant.
- A crafted tenant id (`' OR '1'='1'; DROP TABLE items; --`) cannot inject
  SQL through the `set_config` context-setting step; the table and its
  rows are still there afterwards.
- `runWithElevatedContext` is the only path that can see rows across
  tenants, and it always emits `elevated-context-start` /
  `elevated-context-end` audit events with the actor and reason.
- 200 concurrent operations against a 3-connection pool, rapidly
  alternating tenant context and yielding the event loop mid-request,
  never observe another tenant's `app.tenant_id` — proving no leakage
  across pooled-connection reuse.

## Scope notes

- The example app (`examples/nestjs-demo`) is intentionally minimal — one
  resource (`items`) — since its job is to prove the interceptor + DI
  wiring works against real RLS, not to be a full application.
- `tenants` itself is not RLS-scoped (it's the tenant directory, not
  tenant-owned data); only `items` demonstrates the isolation policies.
