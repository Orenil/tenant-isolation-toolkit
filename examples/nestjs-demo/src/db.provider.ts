import type { Provider } from "@nestjs/common";
import { TenantPool } from "../../../src";

/** DI token for the shared TenantPool instance -- string token so nothing depends on emitted TS decorator metadata. */
export const TENANT_POOL = "TENANT_POOL";

/**
 * Wires TenantPool into Nest's DI container the same way any real app
 * would wire in a database connection pool: one shared instance, built
 * from the standard libpq env vars, provided under a token that every
 * service/controller injects instead of ever constructing `pg.Pool`
 * itself.
 */
export const tenantPoolProvider: Provider = {
  provide: TENANT_POOL,
  useFactory: (): TenantPool =>
    new TenantPool({
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
      user: process.env.PGUSER ?? "tenant_app",
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE ?? "tenant_toolkit_test",
      max: 5,
    }),
};
