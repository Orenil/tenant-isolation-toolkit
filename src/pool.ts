import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import { getTenantContext } from "./context";

/**
 * Thin wrapper around `pg.Pool` that is the *only* sanctioned way to run a
 * query against the database. It guarantees that every query executes
 * inside a transaction that has just had the Postgres session variables
 * driving RLS (`app.tenant_id`, `app.bypass_rls`) freshly set via
 * `set_config(..., is_local => true)`.
 *
 * Why `SET LOCAL` (via `set_config`) instead of a plain `SET` on checkout:
 * a pooled connection is a physical socket that gets handed to many
 * unrelated logical requests over its lifetime. `SET` mutates session state
 * that would otherwise persist across every future checkout of that same
 * connection -- exactly the "next request silently inherits the previous
 * tenant" bug this project exists to prevent. `SET LOCAL` (equivalently,
 * `set_config(name, value, true)`) is scoped to the current transaction and
 * is automatically and unconditionally undone at COMMIT or ROLLBACK, no
 * matter how the connection is reused afterwards. So instead of trying to
 * remember to reset state on the way *out*, we make it structurally
 * impossible for it to survive past the transaction that set it.
 *
 * On top of that transaction-scoping (which is the actual safety
 * guarantee), every checkout also gets a defensive `RESET` before it is
 * handed back to the pool, and every brand new physical connection gets a
 * `RESET` immediately on `connect`. Neither of those two is what makes this
 * safe -- the transaction scoping is -- but they mean a bug elsewhere (e.g.
 * someone bypassing `withTenant` and holding a client open across multiple
 * transactions) fails closed (no context set -> RLS denies all rows)
 * instead of leaking.
 */
export class TenantPool {
  private readonly pool: Pool;

  constructor(config: PoolConfig = {}) {
    this.pool = new Pool(config);
    this.pool.on("connect", (client) => {
      // New physical connection: make sure it doesn't start out carrying
      // any leftover session state from a previous cluster session.
      client.query("RESET app.tenant_id; RESET app.bypass_rls;").catch(() => {
        /* best effort defense-in-depth; transaction scoping is the real guarantee */
      });
    });
  }

  /**
   * Runs `fn` with a client whose session variables have been set to match
   * the tenant context currently active on the AsyncLocalStorage chain
   * (established via `runWithTenant` / `runWithElevatedContext`). Fails
   * closed with an error if no context is active, rather than silently
   * running the query without RLS scoping.
   */
  async withTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const ctx = getTenantContext();
    if (!ctx) {
      throw new Error(
        "TenantPool.withTenant() called with no tenant context active. " +
          "Wrap the call site in runWithTenant(...) or runWithElevatedContext(...).",
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // set_config with a parameterized value (never string-interpolated
      // SQL) so a malicious/malformed tenant id can never be used to
      // inject SQL through the session-variable setup step itself.
      await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.bypass_rls', $2, true)", [
        ctx.tenantId,
        ctx.elevated ? "on" : "off",
      ]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      // Defensive reset on checkout release (see class doc: not the source
      // of the safety guarantee, but cheap insurance).
      await client.query("RESET app.tenant_id; RESET app.bypass_rls;").catch(() => {});
      client.release();
    }
  }

  /** Convenience wrapper for the common case of a single parameterized query. */
  async query<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
    return this.withTenant(async (client) => {
      const res = await client.query<R>(text, params);
      return res.rows;
    });
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  /** Escape hatch for callers (e.g. tests) that need the underlying pg.Pool. */
  get raw(): Pool {
    return this.pool;
  }
}
