import { parseIdList } from "../shared/util.ts";
import type { LogLevel } from "./logger.ts";

export type BotMode = "polling" | "webhook";
export const DEFAULT_HTTP_PORT = 18080;

export interface Config {
  dataDir: string;
  port: number;
  host: string;
  mode: BotMode;
  telegramToken?: string;
  allowedUsers: number[];
  publicUrl?: string;
  webhookSecret?: string;
  masterKeyEnv?: string;
  logLevel: LogLevel;
}

function env(name: string): string | undefined {
  const value = Deno.env.get(name);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseLogLevel(value: string | undefined): LogLevel {
  switch (value) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value;
    default:
      return "info";
  }
}

function parseMode(value: string | undefined): BotMode {
  return value === "webhook" ? "webhook" : "polling";
}

export function loadConfig(): Config {
  return {
    dataDir: env("DEBOT_DATA_DIR") ?? "./data",
    port: envInt("DEBOT_PORT", DEFAULT_HTTP_PORT),
    host: env("DEBOT_HOST") ?? "0.0.0.0",
    mode: parseMode(env("DEBOT_MODE")),
    telegramToken: env("TELEGRAM_BOT_TOKEN"),
    allowedUsers: parseIdList(env("DEBOT_ALLOWED_USERS")),
    publicUrl: env("DEBOT_PUBLIC_URL"),
    webhookSecret: env("DEBOT_WEBHOOK_SECRET"),
    masterKeyEnv: env("DEBOT_MASTER_KEY"),
    logLevel: parseLogLevel(env("DEBOT_LOG_LEVEL")),
  };
}

export type ReadinessState = "ok" | "missing" | "warn";

export interface Readiness {
  ready: boolean;
  checks: Record<string, ReadinessState>;
  notes: string[];
}

export function evaluateReadiness(config: Config): Readiness {
  const checks: Record<string, ReadinessState> = {};
  const notes: string[] = [];

  checks.telegram = config.telegramToken ? "ok" : "missing";
  if (!config.telegramToken) notes.push("TELEGRAM_BOT_TOKEN is not set");

  checks.allowlist = config.allowedUsers.length > 0 ? "ok" : "warn";
  if (config.allowedUsers.length === 0) {
    notes.push("DEBOT_ALLOWED_USERS is empty; the bot will reject every user");
  }

  if (config.mode === "webhook") {
    checks.webhook = config.publicUrl ? "ok" : "missing";
    if (!config.publicUrl) {
      notes.push("DEBOT_MODE=webhook requires DEBOT_PUBLIC_URL");
    }
  } else {
    checks.webhook = "ok";
  }

  const ready = Object.values(checks).every((state) => state !== "missing");
  return { ready, checks, notes };
}
