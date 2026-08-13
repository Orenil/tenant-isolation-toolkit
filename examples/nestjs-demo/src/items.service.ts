import { Inject, Injectable } from "@nestjs/common";
import { TENANT_POOL } from "./db.provider";
import type { TenantPool } from "../../../src";

@Injectable()
export class ItemsService {
  constructor(@Inject(TENANT_POOL) private readonly pool: TenantPool) {}

  /**
   * Deliberately filter-less -- no `WHERE tenant_id = ...` anywhere, on
   * purpose, exactly like the adversarial test suite. Isolation here comes
   * entirely from RLS plus the tenant context the interceptor established;
   * this method could not leak cross-tenant rows even if it tried.
   */
  listItems() {
    return this.pool.query("SELECT id, name, secret FROM items");
  }
}
