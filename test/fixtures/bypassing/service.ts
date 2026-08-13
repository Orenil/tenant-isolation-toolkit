// Fixture: a deliberately non-compliant module that reaches for `pg`
// directly instead of going through TenantPool -- this is exactly the
// bypass the CI lint check exists to catch.
import { Pool } from "pg";

const pool = new Pool();

export async function listAllItemsUnsafely() {
  const result = await pool.query("SELECT * FROM items");
  return result.rows;
}
