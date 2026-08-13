import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ItemsController } from "./items.controller";
import { ItemsService } from "./items.service";
import { tenantPoolProvider } from "./db.provider";
import { TenantInterceptor } from "./tenant.interceptor";

@Module({
  controllers: [ItemsController],
  providers: [ItemsService, tenantPoolProvider, { provide: APP_INTERCEPTOR, useClass: TenantInterceptor }],
})
export class AppModule {}
