import { BadRequestException, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { firstValueFrom, from, type Observable } from "rxjs";
import { runWithTenant } from "../../../src";

/**
 * Establishes the tenant context for every incoming request, the same way
 * `tenantMiddleware` does for Express -- this is the NestJS-native
 * equivalent, proving the framework-agnostic core (`runWithTenant`) plugs
 * into Nest's own request pipeline instead of needing a parallel
 * implementation.
 *
 * It's an interceptor rather than plain `NestMiddleware` specifically so
 * the tenant context established here (via AsyncLocalStorage) stays bound
 * around the *entire* rest of the request pipeline -- route handler,
 * services, and the RxJS chain Nest builds around them -- all the way
 * through to the response being emitted.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const tenantId = req.headers["x-tenant-id"];
    if (!tenantId || Array.isArray(tenantId)) {
      throw new BadRequestException('missing tenant id (expected header "x-tenant-id")');
    }
    return from(runWithTenant(tenantId, () => firstValueFrom(next.handle())));
  }
}
