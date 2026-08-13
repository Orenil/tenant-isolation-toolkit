import { Controller, Get, Inject } from "@nestjs/common";
import { ItemsService } from "./items.service";

@Controller("items")
export class ItemsController {
  constructor(@Inject(ItemsService) private readonly itemsService: ItemsService) {}

  @Get()
  list() {
    return this.itemsService.listItems();
  }
}
