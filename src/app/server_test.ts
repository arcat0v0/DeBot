import { assert, assertEquals } from "@std/assert";
import { createLogger } from "./logger.ts";
import { createHandler } from "./server.ts";
import type { Config } from "./config.ts";
import type { Dispatcher } from "../bot/dispatcher.ts";
import type { TgUpdate } from "../bot/types.ts";

function fakeDispatcher(captured: TgUpdate[]): Dispatcher {
  return {
    handleUpdate: (update: TgUpdate) => {
      captured.push(update);
      return Promise.resolve();
    },
  } as unknown as Dispatcher;
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    dataDir: "./data",
    port: 8080,
    host: "0.0.0.0",
    mode: "polling",
    allowedUsers: [1],
    logLevel: "error",
    telegramToken: "token",
    ...overrides,
  };
}

const logger = createLogger("error", {}, () => {});

Deno.test("healthz reports ok", async () => {
  const handler = createHandler({ config: baseConfig(), logger });
  const res = await handler(new Request("http://localhost/healthz"));
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.status, "ok");
});

Deno.test("readyz is 503 when telegram token is missing", async () => {
  const handler = createHandler({
    config: baseConfig({ telegramToken: undefined }),
    logger,
  });
  const res = await handler(new Request("http://localhost/readyz"));
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.ready, false);
});

Deno.test("readyz is 200 when configured", async () => {
  const handler = createHandler({ config: baseConfig(), logger });
  const res = await handler(new Request("http://localhost/readyz"));
  assertEquals(res.status, 200);
});

Deno.test("webhook rejects a wrong secret", async () => {
  const captured: TgUpdate[] = [];
  const handler = createHandler({
    config: baseConfig({ webhookSecret: "expected" }),
    logger,
    dispatcher: fakeDispatcher(captured),
  });
  const res = await handler(
    new Request("http://localhost/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      body: JSON.stringify({ update_id: 1 }),
    }),
  );
  assertEquals(res.status, 403);
  assertEquals(captured.length, 0);
});

Deno.test("webhook dispatches a valid update", async () => {
  const captured: TgUpdate[] = [];
  const handler = createHandler({
    config: baseConfig({ webhookSecret: "expected" }),
    logger,
    dispatcher: fakeDispatcher(captured),
  });
  const res = await handler(
    new Request("http://localhost/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "expected" },
      body: JSON.stringify({ update_id: 7, message: { text: "hi" } }),
    }),
  );
  assertEquals(res.status, 200);
  assert(captured.length === 1);
});
