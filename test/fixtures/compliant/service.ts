// Fixture: a well-behaved data-access module. It only ever talks to the
// database through TenantPool, never touches `pg` directly.
import { TenantPool } from "../../../src/pool";

export async function listItemsForCurrentTenant(pool: TenantPool) {
  return pool.query("SELECT * FROM items");
}
