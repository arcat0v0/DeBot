import { delay } from "@std/async";
import type { Logger } from "../app/logger.ts";
import type { TelegramClient } from "./telegram.ts";
import type { Dispatcher } from "./dispatcher.ts";

export class PollingRunner {
  private running = false;

  constructor(
    private readonly client: TelegramClient,
    private readonly dispatcher: Dispatcher,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    let offset: number | undefined;
    this.logger.info("starting telegram long polling");
    while (this.running) {
      try {
        const updates = await this.client.getUpdates({ offset, timeout: 30 });
        for (const update of updates) {
          offset = update.update_id + 1;
          await this.dispatcher.handleUpdate(update);
        }
      } catch (error) {
        if (!this.running) break;
        this.logger.error("polling error", { error: String(error) });
        await delay(3000);
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}
