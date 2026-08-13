import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { seedTwoTenants, testPoolConfig, wipeItemsAndTenants, type SeededTenant } from "../../../test/db-helpers";
import { TenantPool } from "../../../src";

/**
 * Exercises tenant isolation through the *real* NestJS HTTP stack: a real
 * `INestApplication`, the real `TenantInterceptor` reading a real request
 * header, a real `TenantPool` provider resolved through Nest's DI
 * container, hitting the real Postgres RLS policies -- not the middleware
 * called directly in isolation.
 */
describe("NestJS demo: tenant isolation enforced end-to-end through the interceptor + RLS", () => {
  let app: INestApplication;
  let pool: TenantPool;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    pool = new TenantPool(testPoolConfig());
    await wipeItemsAndTenants();
    const seeded = await seedTwoTenants(pool);
    tenantA = seeded.tenantA;
    tenantB = seeded.tenantB;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await wipeItemsAndTenants();
  });

  it("rejects a request missing the x-tenant-id header before it ever reaches the controller", async () => {
    await request(app.getHttpServer()).get("/items").expect(400);
  });

  it("GET /items with tenant A's header returns only tenant A's rows, from a filter-less controller query", async () => {
    const res = await request(app.getHttpServer()).get("/items").set("x-tenant-id", tenantA.id).expect(200);
    expect(res.body.length).toBe(3);
    expect(res.body.every((r: { name: string }) => r.name.startsWith("a-item"))).toBe(true);
  });

  it("GET /items with tenant B's header never returns any of tenant A's rows", async () => {
    const res = await request(app.getHttpServer()).get("/items").set("x-tenant-id", tenantB.id).expect(200);
    expect(res.body.length).toBe(3);
    expect(res.body.every((r: { name: string }) => r.name.startsWith("b-item"))).toBe(true);
    const secrets: string[] = res.body.map((r: { secret: string }) => r.secret);
    expect(secrets.some((s) => s.startsWith("a-secret"))).toBe(false);
  });
});
