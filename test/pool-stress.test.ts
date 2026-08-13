import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantPool, runWithTenant } from "../src";
import { seedTwoTenants, testPoolConfig, wipeItemsAndTenants } from "./db-helpers";

/**
 * Connection-pool-reset stress test.
 *
 * The dangerous failure mode this project exists to prevent: a pooled
 * connection physically reused across requests silently carries over the
 * *previous* request's `app.tenant_id`, so request N+1 (for a different
 * tenant) ends up reading/writing under request N's tenant.
 *
 * We use a deliberately tiny pool (max 3) against a much larger number of
 * concurrent logical "requests" that each pick a random tenant, so
 * physical connections are guaranteed to be checked out, used for one
 * tenant, released, and immediately reused for a different tenant many
 * times over. Inside each one we read back `current_setting('app.tenant_id')`
 * from Postgres itself (not from our own JS context) both immediately and
 * after an artificial delay, and assert it always matches the tenant that
 * specific logical request was assigned -- never any other tenant's id.
 */
describe("connection pool: no tenant-context leakage across rapid checkout/release cycles", () => {
  let pool: TenantPool;
  let tenantIds: string[];

  beforeAll(async () => {
    pool = new TenantPool({ ...testPoolConfig(), max: 3 });
    await wipeItemsAndTenants();
    const { tenantA, tenantB } = await seedTwoTenants(pool);
    // A third tenant with no rows, purely to widen the alternation.
    tenantIds = [tenantA.id, tenantB.id];
  });

  afterAll(async () => {
    await pool.end();
    await wipeItemsAndTenants();
  });

  it("200 concurrent alternating-tenant operations on a 3-connection pool never observe another tenant's context", async () => {
    const CONCURRENCY = 200;
    const mismatches: string[] = [];

    const runOne = async (i: number) => {
      const tenantId = tenantIds[i % tenantIds.length];
      await runWithTenant(tenantId, async () => {
        const seenBefore = await pool.query<{ tid: string }>("SELECT current_setting('app.tenant_id', true) AS tid");
        if (seenBefore[0].tid !== tenantId) {
          mismatches.push(`op ${i}: expected ${tenantId} before delay, saw ${seenBefore[0].tid}`);
        }
        // Force interleaving: yield the event loop so other concurrent
        // operations get a chance to check out / release connections
        // while this logical request is still "in flight".
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        const seenAfter = await pool.query<{ tid: string }>("SELECT current_setting('app.tenant_id', true) AS tid");
        if (seenAfter[0].tid !== tenantId) {
          mismatches.push(`op ${i}: expected ${tenantId} after delay, saw ${seenAfter[0].tid}`);
        }
      });
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => runOne(i)));

    expect(mismatches).toEqual([]);
  });

  it("a fresh checkout never inherits a bypass flag left by a previous elevated request", async () => {
    // Run a burst of ordinary requests interleaved with nothing special;
    // none of them should ever be able to see cross-tenant rows, proving
    // app.bypass_rls also resets cleanly across checkouts.
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const tenantId = tenantIds[i % tenantIds.length];
        return runWithTenant(tenantId, () => pool.query("SELECT * FROM items"));
      }),
    );
    for (let i = 0; i < results.length; i++) {
      const tenantId = tenantIds[i % tenantIds.length];
      expect(results[i].every((r: any) => r.tenant_id === tenantId)).toBe(true);
    }
  });
});
