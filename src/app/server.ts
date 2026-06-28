import type { Logger } from "./logger.ts";
import type { Config } from "./config.ts";
import { evaluateReadiness } from "./config.ts";
import type { Dispatcher } from "../bot/dispatcher.ts";
import type { TgUpdate } from "../bot/types.ts";

export interface ServerOptions {
  config: Config;
  logger: Logger;
  dispatcher?: Dispatcher;
}

export function createHandler(
  options: ServerOptions,
): (req: Request) => Promise<Response> {
  const { config, logger, dispatcher } = options;

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok", service: "debot" });
    }

    if (req.method === "GET" && url.pathname === "/readyz") {
      const readiness = evaluateReadiness(config);
      return Response.json(
        { service: "debot", ...readiness },
        { status: readiness.ready ? 200 : 503 },
      );
    }

    if (req.method === "POST" && url.pathname === "/telegram/webhook") {
      if (!dispatcher) {
        return Response.json({ ok: false, error: "bot disabled" }, {
          status: 503,
        });
      }
      if (config.webhookSecret) {
        const secret = req.headers.get("x-telegram-bot-api-secret-token");
        if (secret !== config.webhookSecret) {
          return Response.json({ ok: false }, { status: 403 });
        }
      }
      let update: TgUpdate;
      try {
        update = (await req.json()) as TgUpdate;
      } catch {
        return Response.json({ ok: false, error: "bad json" }, { status: 400 });
      }
      dispatcher.handleUpdate(update).catch((error) => {
        logger.error("webhook dispatch failed", { error: String(error) });
      });
      return Response.json({ ok: true });
    }

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(
        "<h1>DeBot</h1><p>Self-hosted multi-cloud operations bot.</p>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    return new Response("Not Found", { status: 404 });
  };
}
