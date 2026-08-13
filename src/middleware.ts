import { runWithTenant } from "./context";

/** Minimal structural types so this file has zero dependency on express's own types. */
interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface MinimalResponse {
  status(code: number): { json(body: unknown): unknown };
}
type NextFn = (err?: unknown) => void;

export interface TenantMiddlewareOptions {
  /** Header carrying the tenant id. Defaults to `x-tenant-id`. */
  headerName?: string;
  /** Extract the tenant id however the app needs to (JWT claim, subdomain, ...). Overrides `headerName`. */
  extractTenantId?: (req: MinimalRequest) => string | undefined;
}

/**
 * Express-compatible middleware (also usable anywhere else that follows the
 * `(req, res, next)` convention) that is the mandatory on-ramp into a
 * tenant-scoped request: it resolves the tenant id for the request and
 * establishes it as the AsyncLocalStorage context for everything downstream
 * (route handlers, services, `TenantPool` queries) via `runWithTenant`.
 *
 * A request with no resolvable tenant id is rejected with 400 rather than
 * silently proceeding without a context -- letting it through would mean
 * every query issued during that request fails closed with zero rows
 * (safe, but the request should never have gotten that far).
 */
export function tenantMiddleware(options: TenantMiddlewareOptions = {}) {
  const headerName = (options.headerName ?? "x-tenant-id").toLowerCase();
  const extract = options.extractTenantId ?? ((req: MinimalRequest) => {
    const value = req.headers[headerName];
    return Array.isArray(value) ? value[0] : value;
  });

  return function tenantContextMiddleware(req: MinimalRequest, res: MinimalResponse, next: NextFn): void {
    const tenantId = extract(req);
    if (!tenantId) {
      res.status(400).json({ error: `missing tenant id (expected header "${headerName}")` });
      return;
    }
    runWithTenant(tenantId, () => {
      next();
    });
  };
}
