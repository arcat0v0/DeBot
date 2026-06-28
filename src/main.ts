import { evaluateReadiness, loadConfig } from "./app/config.ts";
import { createLogger } from "./app/logger.ts";
import { createHandler } from "./app/server.ts";
import { loadOrCreateMasterKey } from "./security/crypto.ts";
import { ProfileStore } from "./storage/profiles.ts";
import { PresetStore } from "./storage/presets.ts";
import { JobStore } from "./jobs/store.ts";
import { JobQueue } from "./jobs/queue.ts";
import { CloudService } from "./cloud/service.ts";
import { SessionStore } from "./bot/sessions.ts";
import { TelegramClient } from "./bot/telegram.ts";
import { Dispatcher } from "./bot/dispatcher.ts";
import { PollingRunner } from "./bot/runner.ts";

const BOT_COMMANDS = [
  { command: "start", description: "打开云菜单" },
  { command: "aws", description: "AWS EC2 与 Lightsail" },
  { command: "azure", description: "Azure 虚拟机" },
  { command: "gcp", description: "Google 计算引擎" },
  { command: "do", description: "DigitalOcean 云主机" },
  { command: "profile", description: "管理云凭证" },
  { command: "presets", description: "管理创建预设" },
  { command: "jobs", description: "最近的操作" },
  { command: "help", description: "显示帮助" },
];

export async function runServer(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: "debot" });
  const readiness = evaluateReadiness(config);
  for (const note of readiness.notes) logger.warn(note);

  let dispatcher: Dispatcher | undefined;
  let runner: PollingRunner | undefined;

  if (config.telegramToken) {
    const masterKey = await loadOrCreateMasterKey(
      config.dataDir,
      config.masterKeyEnv,
    );
    const profiles = new ProfileStore(config.dataDir, masterKey);
    const presets = new PresetStore(config.dataDir);
    const jobStore = new JobStore(config.dataDir);
    const jobs = new JobQueue(jobStore, logger);
    const cloud = new CloudService(profiles);
    const sessions = new SessionStore();
    const client = new TelegramClient(config.telegramToken);

    dispatcher = new Dispatcher({
      api: client,
      cloud,
      profiles,
      presets,
      jobs,
      jobStore,
      sessions,
      logger,
      allowedUsers: config.allowedUsers,
    });

    client.setMyCommands(BOT_COMMANDS).catch((error) =>
      logger.warn("could not set bot commands", { error: String(error) })
    );

    if (config.mode === "webhook" && config.publicUrl) {
      const webhookUrl = new URL("/telegram/webhook", config.publicUrl)
        .toString();
      await client.setWebhook({
        url: webhookUrl,
        secret_token: config.webhookSecret,
        allowed_updates: ["message", "callback_query"],
      });
      logger.info("registered telegram webhook", { url: webhookUrl });
    } else {
      await client.deleteWebhook().catch(() => {});
      runner = new PollingRunner(client, dispatcher, logger);
      runner.start().catch((error) =>
        logger.error("runner crashed", { error: String(error) })
      );
    }
  } else {
    logger.warn("TELEGRAM_BOT_TOKEN missing; serving health endpoints only");
  }

  const handler = createHandler({ config, logger, dispatcher });
  const server = Deno.serve(
    { port: config.port, hostname: config.host },
    handler,
  );

  const shutdown = () => {
    logger.info("shutting down");
    runner?.stop();
    server.shutdown().finally(() => Deno.exit(0));
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  logger.info("debot listening", { port: config.port, mode: config.mode });
  await server.finished;
}

if (import.meta.main) {
  await runServer();
}
