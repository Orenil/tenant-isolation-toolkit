import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
  // eslint-disable-next-line no-console
  console.log('nestjs-demo listening on http://localhost:3000 -- try: curl -H "x-tenant-id: <uuid>" localhost:3000/items');
}

bootstrap();
