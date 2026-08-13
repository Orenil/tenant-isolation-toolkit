import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { TenantPool, runWithTenant } from "../src";

/**
 * Connection config shared by every test. Reads standard libpq env vars
 * (PGHOST, PGUSER, PGDATABASE, ...) which the local dev cluster
 * (scripts/db-start.sh) and CI's Postgres service container both populate.
 * Falls back to sane local-dev defaults matching db-start.sh's output.
 */
export function testPoolConfig() {
  return {
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    user: process.env.PGUSER ?? "tenant_app",
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? "tenant_toolkit_test",
    max: 5,
  };
}

/** A raw superuser pool for test setup/teardown that must bypass RLS entirely. */
export function adminPoolConfig() {
  return {
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    user: "postgres",
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? "tenant_toolkit_test",
    max: 2,
  };
}

export interface SeededTenant {
  id: string;
  name: string;
  itemIds: string[];
}

/**
 * Creates two fresh tenants, each with their own items containing a
 * distinguishing "secret" value, using the real TenantPool + RLS write
 * path (not a superuser bulk insert) so the seeded data itself proves
 * `WITH CHECK` is being honored.
 */
export async function seedTwoTenants(pool: TenantPool): Promise<{ tenantA: SeededTenant; tenantB: SeededTenant }> {
  const admin = new Pool(adminPoolConfig());
  try {
    const mk = async (name: string) => {
      const res = await admin.query<{ id: string }>("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [name]);
      return res.rows[0].id;
    };
    const tenantAId = await mk(`tenant-a-${randomUUID().slice(0, 8)}`);
    const tenantBId = await mk(`tenant-b-${randomUUID().slice(0, 8)}`);

    const seedItems = async (tenantId: string, label: string) => {
      return runWithTenant(tenantId, async () => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          const rows = await pool.query<{ id: string }>(
            "INSERT INTO items (tenant_id, name, secret) VALUES ($1, $2, $3) RETURNING id",
            [tenantId, `${label}-item-${i}`, `${label}-secret-${i}-${randomUUID()}`],
          );
          ids.push(rows[0].id);
        }
        return ids;
      });
    };

    const [aIds, bIds] = await Promise.all([seedItems(tenantAId, "a"), seedItems(tenantBId, "b")]);

    return {
      tenantA: { id: tenantAId, name: "a", itemIds: aIds },
      tenantB: { id: tenantBId, name: "b", itemIds: bIds },
    };
  } finally {
    await admin.end();
  }
}

export async function wipeItemsAndTenants(): Promise<void> {
  const admin = new Pool(adminPoolConfig());
  try {
    await admin.query("DELETE FROM items");
    await admin.query("DELETE FROM tenants");
  } finally {
    await admin.end();
  }
}
