import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The tenant context that is active for the current async execution chain.
 *
 * `elevated: true` means the context was created through the audited escape
 * hatch (see `runWithElevatedContext`) and queries run under it are allowed
 * to see rows across tenants. Ordinary request handling should never set
 * this itself -- it is only ever produced by `runWithElevatedContext`.
 */
export interface TenantContext {
  tenantId: string;
  elevated: boolean;
  /** Present only on elevated contexts; who/why the bypass was invoked. */
  actor?: string;
  reason?: string;
}

export interface AuditEvent {
  type: "elevated-context-start" | "elevated-context-end";
  tenantId: string;
  actor: string;
  reason: string;
  timestamp: string;
}

export type AuditLogger = (event: AuditEvent) => void;

/**
 * Placeholder `tenant_id` used on elevated contexts. It is never a real
 * tenant's id and matches no row's `tenant_id`; it exists only so
 * `app.tenant_id` remains a syntactically valid uuid for the (unrelated)
 * `tenant_isolation` RLS policy to cast and compare against. Cross-tenant
 * visibility under an elevated context comes entirely from the separate
 * `tenant_isolation_bypass` policy keyed off `app.bypass_rls`, not from
 * this value.
 */
export const ELEVATED_CONTEXT_TENANT_SENTINEL = "00000000-0000-0000-0000-000000000000";

let auditLogger: AuditLogger = (event) => {
  // Default logger: structured line on stderr so it lands in ops/log
  // pipelines without polluting stdout. Callers can override this (e.g. in
  // tests, or to ship audit events to a real audit trail / SIEM).
  // eslint-disable-next-line no-console
  console.error(`[AUDIT] ${JSON.stringify(event)}`);
};

/** Override where audit events for the escape hatch are sent. */
export function setAuditLogger(logger: AuditLogger): void {
  auditLogger = logger;
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Returns the tenant context active for the currently executing async
 * chain, or `undefined` if no context has been established. Middleware /
 * interceptors are responsible for making sure this is never undefined by
 * the time a query actually runs -- `TenantPool` fails closed if it is.
 */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/**
 * Runs `fn` with `tenantId` bound as the active tenant context for the
 * whole async call chain kicked off inside `fn` (further `await`s,
 * callbacks, etc. all see it via AsyncLocalStorage). This is the mandatory
 * entry point every request path is expected to go through -- framework
 * middleware (Express, NestJS, ...) should call this once per request.
 */
export function runWithTenant<T>(tenantId: string, fn: () => T | Promise<T>): T | Promise<T> {
  if (!tenantId || typeof tenantId !== "string") {
    throw new TypeError("runWithTenant requires a non-empty tenantId string");
  }
  const ctx: TenantContext = { tenantId, elevated: false };
  return storage.run(ctx, fn);
}

/**
 * The audited cross-tenant escape hatch. Unlike `runWithTenant`, this
 * requires an explicit `actor` (who is invoking it) and `reason` (why) and
 * unconditionally emits an audit event before *and* after the elevated
 * work runs. Queries executed inside `fn` are allowed to see rows across
 * every tenant.
 *
 * This must never be reachable from normal request handling -- it exists
 * for admin/support tooling, invoked explicitly and deliberately, never as
 * a fallback for a misconfigured or missing tenant context.
 */
export function runWithElevatedContext<T>(
  actor: string,
  reason: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  if (!actor || !reason) {
    throw new TypeError("runWithElevatedContext requires both an actor and a reason");
  }
  const timestamp = new Date().toISOString();
  auditLogger({ type: "elevated-context-start", tenantId: "*", actor, reason, timestamp });
  const ctx: TenantContext = { tenantId: ELEVATED_CONTEXT_TENANT_SENTINEL, elevated: true, actor, reason };
  const finish = () =>
    auditLogger({
      type: "elevated-context-end",
      tenantId: "*",
      actor,
      reason,
      timestamp: new Date().toISOString(),
    });
  const result = storage.run(ctx, fn);
  if (result instanceof Promise) {
    return result.finally(finish);
  }
  finish();
  return result;
}
