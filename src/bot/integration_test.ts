import { assert, assertEquals, assertRejects } from "@std/assert";
import { delay } from "@std/async";
import { createLogger } from "../app/logger.ts";
import { TelegramClient } from "./telegram.ts";
import { PollingRunner } from "./runner.ts";
import type { Dispatcher } from "./dispatcher.ts";
import type { TgUpdate } from "./types.ts";

const silent = createLogger("error", {}, () => {});

Deno.test("TelegramClient performs real HTTP calls and parses results", async () => {
  const seen: { method: string; body: Record<string, unknown> }[] = [];
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen() {} },
    async (req) => {
      const method = new URL(req.url).pathname.split("/").pop() ?? "";
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ method, body });
      if (method === "getMe") {
        return Response.json({
          ok: true,
          result: { id: 1, is_bot: true, first_name: "DeBot" },
        });
      }
      if (method === "sendMessage") {
        if (body.text === "fail") {
          return Response.json({ ok: false, description: "bad request" });
        }
        return Response.json({
          ok: true,
          result: {
            message_id: 5,
            chat: { id: body.chat_id, type: "private" },
            date: 0,
          },
        });
      }
      return Response.json({ ok: true, result: true });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  const client = new TelegramClient("token", {
    baseUrl: `http://localhost:${port}`,
  });

  try {
    const me = await client.getMe();
    assertEquals(me.first_name, "DeBot");

    const message = await client.sendMessage({ chat_id: 42, text: "hi" });
    assertEquals(message.message_id, 5);

    await assertRejects(() =>
      client.sendMessage({ chat_id: 42, text: "fail" })
    );
    assert(seen.some((call) => call.method === "getMe"));
  } finally {
    controller.abort();
    await server.finished;
  }
});

Deno.test("PollingRunner forwards updates to the dispatcher and stops", async () => {
  const batches: TgUpdate[][] = [[{
    update_id: 10,
    message: {
      message_id: 1,
      chat: { id: 1, type: "private" },
      date: 0,
      text: "/start",
    },
  }]];
  let index = 0;
  const fakeClient = {
    getUpdates: () =>
      index < batches.length
        ? Promise.resolve(batches[index++])
        : delay(5).then(() => [] as TgUpdate[]),
  } as unknown as TelegramClient;

  const captured: TgUpdate[] = [];
  const fakeDispatcher = {
    handleUpdate: (update: TgUpdate) => {
      captured.push(update);
      return Promise.resolve();
    },
  } as unknown as Dispatcher;

  const runner = new PollingRunner(fakeClient, fakeDispatcher, silent);
  const loop = runner.start();
  let waited = 0;
  while (captured.length === 0 && waited < 100) {
    await delay(5);
    waited += 1;
  }
  runner.stop();
  await loop;
  assertEquals(captured.length, 1);
  assertEquals(captured[0].update_id, 10);
});
