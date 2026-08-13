import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { TenantPool, runWithTenant, runWithElevatedContext, setAuditLogger, type AuditEvent } from "../src";
import { adminPoolConfig, seedTwoTenants, testPoolConfig, wipeItemsAndTenants, type SeededTenant } from "./db-helpers";

/**
 * The adversarial suite. Every query fired at the database in here is
 * DELIBERATELY filter-less -- `SELECT * FROM items` with no `WHERE
 * tenant_id = ...` clause anywhere. If RLS is doing its job, that doesn't
 * matter: the database itself restricts the rows, regardless of what the
 * application code forgot to type.
 */
describe("adversarial: RLS blocks cross-tenant access even with filter-less queries", () => {
  let pool: TenantPool;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  beforeAll(async () => {
    pool = new TenantPool(testPoolConfig());
    await wipeItemsAndTenants();
    const seeded = await seedTwoTenants(pool);
    tenantA = seeded.tenantA;
    tenantB = seeded.tenantB;
  });

  afterAll(async () => {
    await pool.end();
    await wipeItemsAndTenants();
  });

  it("a filter-less SELECT under tenant A's context returns only tenant A's rows", async () => {
    const rows = await runWithTenant(tenantA.id, () => pool.query("SELECT * FROM items"));
    expect(rows.length).toBe(3);
    expect(rows.every((r: any) => r.tenant_id === tenantA.id)).toBe(true);
  });

  it("the same filter-less SELECT under tenant B's context returns only tenant B's rows", async () => {
    const rows = await runWithTenant(tenantB.id, () => pool.query("SELECT * FROM items"));
    expect(rows.length).toBe(3);
    expect(rows.every((r: any) => r.tenant_id === tenantB.id)).toBe(true);
  });

  it("tenant A can never see even a single row belonging to tenant B", async () => {
    const rows = await runWithTenant(tenantA.id, () => pool.query("SELECT * FROM items"));
    const secrets = rows.map((r: any) => r.secret as string);
    for (const bId of tenantB.itemIds) {
      expect(rows.find((r: any) => r.id === bId)).toBeUndefined();
    }
    expect(secrets.some((s) => s.startsWith("b-secret"))).toBe(false);
  });

  it("a connection with NO tenant context set at all sees zero rows (fails closed, not open)", async () => {
    // Bypass the wrapper's context requirement on purpose to prove the
    // *database*, not just the wrapper, is what's enforcing isolation:
    // connect raw and never set app.tenant_id.
    const raw = new Pool({ ...testPoolConfig() });
    try {
      const res = await raw.query("SELECT * FROM items");
      expect(res.rows.length).toBe(0);
    } finally {
      await raw.end();
    }
  });

  it("WITH CHECK rejects trying to write a row under a different tenant's id while impersonating tenant A", async () => {
    await expect(
      runWithTenant(tenantA.id, () =>
        pool.query("INSERT INTO items (tenant_id, name, secret) VALUES ($1, 'evil', 'x')", [tenantB.id]),
      ),
    ).rejects.toThrow();
  });

  it("a crafted tenant id cannot inject SQL through the session-variable setup (set_config is parameterized)", async () => {
    const malicious = "' OR '1'='1'; DROP TABLE items; --";
    await expect(
      runWithTenant(malicious, () => pool.query("SELECT * FROM items")),
    ).rejects.toThrow(); // invalid uuid cast -- rejected, not executed as SQL

    // Prove the table really does still exist and still has data.
    const admin = new Pool(adminPoolConfig());
    try {
      const res = await admin.query("SELECT count(*)::int AS n FROM items");
      expect(res.rows[0].n).toBeGreaterThan(0);
    } finally {
      await admin.end();
    }
  });

  it("the audited escape hatch is opt-in only: normal tenant context never sees cross-tenant rows", async () => {
    const rows = await runWithTenant(tenantA.id, () => pool.query("SELECT * FROM items"));
    expect(rows.length).toBe(3);
  });

  it("runWithElevatedContext can see rows across every tenant, and emits audit events", async () => {
    const events: AuditEvent[] = [];
    setAuditLogger((e) => events.push(e));
    try {
      const rows = await runWithElevatedContext("support-agent-42", "customer escalation #1234", () =>
        pool.query("SELECT * FROM items"),
      );
      expect(rows.length).toBe(6); // both tenants' items
      expect(events.map((e) => e.type)).toEqual(["elevated-context-start", "elevated-context-end"]);
      expect(events[0].actor).toBe("support-agent-42");
      expect(events[0].reason).toBe("customer escalation #1234");
    } finally {
      setAuditLogger(() => {});
    }
  });

  it("runWithElevatedContext requires both an actor and a reason", () => {
    expect(() => runWithElevatedContext("", "no actor", () => Promise.resolve())).toThrow();
    expect(() => runWithElevatedContext("someone", "", () => Promise.resolve())).toThrow();
  });
});
