import type { Logger } from "../app/logger.ts";
import { toUserMessage } from "../shared/errors.ts";
import { PROVIDER_IDS, PROVIDER_LABELS } from "../cloud/types.ts";
import type { Instance, ProviderId } from "../cloud/types.ts";
import type { CloudService } from "../cloud/service.ts";
import { providerServices } from "../cloud/registry.ts";
import type { ProfileStore } from "../storage/profiles.ts";
import type { PresetStore } from "../storage/presets.ts";
import type { JobQueue } from "../jobs/queue.ts";
import type { JobStore } from "../jobs/store.ts";
import type { JobRecord } from "../jobs/types.ts";
import { SessionStore } from "./sessions.ts";
import type { ListItemRef } from "./sessions.ts";
import type {
  BotApi,
  InlineKeyboardMarkup,
  TgCallbackQuery,
  TgMessage,
  TgUpdate,
  TgUser,
} from "./types.ts";
import { button, keyboard } from "./keyboards.ts";
import {
  bold,
  code,
  escapeHtml,
  instanceButtonLabel,
  instanceDetail,
  jobLine,
} from "./format.ts";
import {
  decodeProvider,
  decodeService,
  listKey,
  providerCode,
  serviceCode,
} from "./codes.ts";
import { parseCredentials } from "./credentials.ts";
import { parsePresetLine, PRESET_FORMAT } from "./presetform.ts";

export interface BotDeps {
  api: BotApi;
  cloud: CloudService;
  profiles: ProfileStore;
  presets: PresetStore;
  jobs: JobQueue;
  jobStore: JobStore;
  sessions: SessionStore;
  logger: Logger;
  allowedUsers: number[];
}

interface Surface {
  chatId: number;
  messageId?: number;
}

const COMMAND_PROVIDER: Record<string, ProviderId> = {
  aws: "aws",
  azure: "azure",
  gcp: "gcp",
  do: "digitalocean",
  digitalocean: "digitalocean",
};

const VERB_LABELS: Record<string, string> = {
  start: "已请求启动",
  stop: "已请求停止",
  reboot: "已请求重启",
};

const CREDENTIAL_HINTS: Record<ProviderId, string> = {
  aws: [
    "🔑 <b>获取 AWS 凭证</b>",
    "1. 登录 AWS 控制台 → 右上角账号名 → 「安全凭证」（或 IAM → 用户 → 选择用户 → 安全凭证）",
    "2. 在「访问密钥」中点击「创建访问密钥」",
    "3. 复制 Access Key ID 与 Secret Access Key（密钥只显示一次）",
    "",
    "然后把凭证发给我，格式：",
    "<code>AccessKeyID SecretAccessKey 区域</code>",
    "例如：<code>AKIA... wJal... ap-southeast-1</code>",
    "（也可以直接发送 JSON）",
  ].join("\n"),
  azure: [
    "🔑 <b>获取 Azure 凭证（服务主体）</b>",
    "在装有 Azure CLI 的环境运行：",
    "<code>az ad sp create-for-rbac --name debot \\",
    '  --role "Virtual Machine Contributor" \\',
    "  --scopes /subscriptions/订阅ID</code>",
    "把它输出的 JSON <b>整段</b>发给我即可，例如：",
    "<code>{",
    '  "appId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",',
    '  "displayName": "debot",',
    '  "password": "xxxxxxxxxxxxxxxxxxxxxxxx",',
    '  "tenant": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"',
    "}</code>",
    "订阅 ID 会自动识别（取该主体可访问的第一个订阅）。",
  ].join("\n"),
  gcp: [
    "🔑 <b>获取 Google Cloud 凭证（服务账号密钥）</b>",
    "1. 控制台 → 「IAM 和管理」→「服务账号」→ 创建服务账号",
    "2. 授予角色「Compute 实例管理员 (v1)」",
    "3. 打开该服务账号 →「密钥」→「添加密钥」→「创建新密钥」→ 选择 JSON 并下载",
    "",
    "然后把下载的整个 JSON 密钥文件内容直接发给我。",
  ].join("\n"),
  digitalocean: [
    "🔑 <b>获取 DigitalOcean 凭证（API Token）</b>",
    "1. 登录 DigitalOcean → 左下角「API」（或访问 cloud.digitalocean.com/account/api/tokens）",
    "2. 点击「Generate New Token」，勾选 Write（写）权限",
    "3. 复制生成的 token（dop_v1_... 只显示一次）",
    "",
    "然后把 token 直接发给我。",
  ].join("\n"),
};

export class Dispatcher {
  constructor(private readonly deps: BotDeps) {}

  async handleUpdate(update: TgUpdate): Promise<void> {
    try {
      if (update.callback_query) {
        await this.handleCallback(update.callback_query);
      } else if (update.message) {
        await this.handleMessage(update.message);
      }
    } catch (error) {
      this.deps.logger.error("update handling failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private authorized(user: TgUser | undefined): boolean {
    if (!user) return false;
    return this.deps.allowedUsers.includes(user.id);
  }

  private async showMenu(
    surface: Surface,
    text: string,
    markup?: InlineKeyboardMarkup,
  ): Promise<void> {
    if (surface.messageId !== undefined) {
      try {
        await this.deps.api.editMessageText({
          chat_id: surface.chatId,
          message_id: surface.messageId,
          text,
          parse_mode: "HTML",
          reply_markup: markup,
          disable_web_page_preview: true,
        });
        return;
      } catch (error) {
        if (String(error).includes("not modified")) return;
      }
    }
    await this.deps.api.sendMessage({
      chat_id: surface.chatId,
      text,
      parse_mode: "HTML",
      reply_markup: markup,
      disable_web_page_preview: true,
    });
  }

  private async handleMessage(message: TgMessage): Promise<void> {
    const user = message.from;
    if (!this.authorized(user)) {
      const idLine = user ? `\n你的用户 ID：<code>${user.id}</code>` : "";
      await this.deps.api.sendMessage({
        chat_id: message.chat.id,
        text: (this.deps.allowedUsers.length === 0
          ? "DeBot 尚未配置白名单。把下面的用户 ID 填入 DEBOT_ALLOWED_USERS（可多个，逗号分隔）后重启即可使用。"
          : "你没有使用此机器人的权限。如需开通，请把下面的用户 ID 交给管理员加入白名单。") +
          idLine,
        parse_mode: "HTML",
      });
      return;
    }
    const text = message.text?.trim() ?? "";
    const surface: Surface = { chatId: message.chat.id };

    if (text.startsWith("/")) {
      this.deps.sessions.clearFlow(user!.id);
      await this.handleCommand(surface, text);
      return;
    }

    const session = this.deps.sessions.get(user!.id);
    if (session.flow) {
      await this.handleFlowInput(message, surface, text);
      return;
    }
    await this.showMenu(surface, "发送 /start 打开云菜单。");
  }

  private async handleCommand(surface: Surface, text: string): Promise<void> {
    const command = text.split(/\s+/)[0].replace(/^\//, "").replace(/@.*$/, "")
      .toLowerCase();
    switch (command) {
      case "start":
        await this.showHome(surface);
        return;
      case "help":
        await this.showHelp(surface);
        return;
      case "profile":
      case "profiles":
        await this.showProfiles(surface);
        return;
      case "presets":
        await this.showPresets(surface);
        return;
      case "jobs":
        await this.showJobs(surface);
        return;
      default: {
        const provider = COMMAND_PROVIDER[command];
        if (provider) {
          await this.showProvider(surface, provider);
          return;
        }
        await this.showMenu(surface, "未知命令。试试 /start 或 /help。");
      }
    }
  }

  private async handleCallback(query: TgCallbackQuery): Promise<void> {
    if (!this.authorized(query.from)) {
      await this.deps.api.answerCallbackQuery({
        callback_query_id: query.id,
        text: `无权使用（你的 ID：${query.from.id}）`,
        show_alert: true,
      });
      return;
    }
    const data = query.data ?? "";
    const surface: Surface = {
      chatId: query.message?.chat.id ?? query.from.id,
      messageId: query.message?.message_id,
    };
    let acked = false;
    const ack = async (text?: string, alert = false) => {
      if (acked) return;
      acked = true;
      await this.deps.api.answerCallbackQuery({
        callback_query_id: query.id,
        text,
        show_alert: alert,
      });
    };

    try {
      await this.routeCallback(query.from, surface, data, ack);
    } catch (error) {
      await ack(toUserMessage(error), true);
      this.deps.logger.error("callback failed", {
        data,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await ack();
    }
  }

  private async routeCallback(
    user: TgUser,
    surface: Surface,
    data: string,
    ack: (text?: string, alert?: boolean) => Promise<void>,
  ): Promise<void> {
    const parts = data.split(":");
    const head = parts[0];

    switch (head) {
      case "m":
        await this.showHome(surface);
        return;
      case "help":
        await this.showHelp(surface);
        return;
      case "p":
        await this.showProvider(surface, decodeProvider(parts[1]));
        return;
      case "svc":
        await this.showService(
          surface,
          decodeProvider(parts[1]),
          decodeService(parts[2]),
        );
        return;
      case "ls":
        await this.showList(
          user,
          surface,
          decodeProvider(parts[1]),
          decodeService(parts[2]),
        );
        return;
      case "rg":
        await this.showRegions(
          surface,
          decodeProvider(parts[1]),
          decodeService(parts[2]),
        );
        return;
      case "rgs":
        this.deps.sessions.setRegion(
          user.id,
          decodeProvider(parts[1]),
          parts.slice(3).join(":"),
        );
        await ack(`区域已设为 ${parts.slice(3).join(":")}`);
        await this.showService(
          surface,
          decodeProvider(parts[1]),
          decodeService(parts[2]),
        );
        return;
      case "i":
        await this.handleInstanceCallback(user, surface, parts, ack);
        return;
      case "cr":
        await this.showCreateMenu(
          surface,
          decodeProvider(parts[1]),
          decodeService(parts[2]),
        );
        return;
      case "mk":
        await this.createFromPreset(
          user,
          surface,
          decodeProvider(parts[1]),
          decodeService(parts[2]),
          parts[3],
          ack,
        );
        return;
      case "prof":
        await this.handleProfileCallback(user, surface, parts, ack);
        return;
      case "pst":
        await this.handlePresetCallback(user, surface, parts, ack);
        return;
      case "jobs":
        await this.showJobs(surface);
        return;
      case "noop":
        await ack();
        return;
      default:
        await ack();
    }
  }

  private async showHome(surface: Surface): Promise<void> {
    const rows = [];
    const providerButtons = PROVIDER_IDS.map((provider) =>
      button(PROVIDER_LABELS[provider], `p:${providerCode(provider)}`)
    );
    rows.push(providerButtons.slice(0, 2));
    rows.push(providerButtons.slice(2, 4));
    rows.push([
      button("👤 凭证", "prof:home"),
      button("📦 预设", "pst:home"),
    ]);
    rows.push([button("🧾 任务", "jobs"), button("ℹ️ 帮助", "help")]);
    await this.showMenu(
      surface,
      `${bold("DeBot")}\n自托管的多云运维助手。\n\n请选择云服务商：`,
      keyboard(rows),
    );
  }

  private async showHelp(surface: Surface): Promise<void> {
    const text = [
      bold("DeBot 帮助"),
      "",
      "命令：",
      "/start — 打开云菜单",
      "/aws /azure /gcp /do — 直接打开某个云服务商",
      "/profile — 管理云凭证",
      "/presets — 管理创建预设",
      "/jobs — 最近的操作",
      "",
      "请先用 /profile 添加云凭证，然后即可在菜单中查看并管理实例。",
    ].join("\n");
    await this.showMenu(
      surface,
      text,
      keyboard([[button("⬅️ 返回", "m:home")]]),
    );
  }

  private async showProvider(
    surface: Surface,
    provider: ProviderId,
  ): Promise<void> {
    const services = providerServices(provider);
    if (services.length <= 1) {
      await this.showService(surface, provider, services[0]?.id ?? "default");
      return;
    }
    const rows = services.map((service) => [
      button(
        service.label,
        `svc:${providerCode(provider)}:${serviceCode(service.id)}`,
      ),
    ]);
    rows.push([button("⬅️ 返回", "m:home")]);
    await this.showMenu(
      surface,
      `${bold(PROVIDER_LABELS[provider])}\n请选择服务：`,
      keyboard(rows),
    );
  }

  private serviceBackTarget(provider: ProviderId): string {
    return providerServices(provider).length > 1
      ? `p:${providerCode(provider)}`
      : "m:home";
  }

  private async showService(
    surface: Surface,
    provider: ProviderId,
    service: string,
  ): Promise<void> {
    const profile = await this.deps.profiles.getActive(provider);
    const pc = providerCode(provider);
    const sc = serviceCode(service);
    if (!profile) {
      await this.showMenu(
        surface,
        `${bold(PROVIDER_LABELS[provider])}\n\n尚未配置凭证，请先添加。`,
        keyboard([
          [button("➕ 添加凭证", `prof:add:${pc}`)],
          [button("⬅️ 返回", this.serviceBackTarget(provider))],
        ]),
      );
      return;
    }

    const region = this.regionFor(surface, provider, profile.defaultRegion);
    const adapter = await this.deps.cloud.getAdapter(provider, {
      service,
      region,
    });
    const caps = adapter.capabilities();
    const serviceLabel = adapter.label;

    const rows = [[button("📋 实例列表", `ls:${pc}:${sc}`)]];
    if (caps.create) rows.push([button("➕ 用预设创建", `cr:${pc}:${sc}`)]);
    if (caps.regions) {
      rows.push([button(`🌐 区域：${region ?? "默认"}`, `rg:${pc}:${sc}`)]);
    }
    rows.push([button(`👤 ${escapeHtml(profile.name)}`, "prof:home")]);
    rows.push([button("⬅️ 返回", this.serviceBackTarget(provider))]);

    await this.showMenu(
      surface,
      `${bold(serviceLabel)}\n凭证：${code(profile.name)}\n区域：${
        code(region ?? "云服务商默认")
      }`,
      keyboard(rows),
    );
  }

  private regionFor(
    surface: Surface,
    provider: ProviderId,
    fallback?: string,
  ): string | undefined {
    const userId = surface.chatId;
    return this.deps.sessions.getRegion(userId, provider) ?? fallback;
  }

  private async showRegions(
    surface: Surface,
    provider: ProviderId,
    service: string,
  ): Promise<void> {
    const adapter = await this.deps.cloud.getAdapter(provider, { service });
    let regions: string[] = [];
    try {
      regions = await adapter.listRegions();
    } catch (error) {
      await this.showMenu(
        surface,
        `无法加载区域列表：${escapeHtml(toUserMessage(error))}`,
        keyboard([[
          button(
            "⬅️ 返回",
            `svc:${providerCode(provider)}:${serviceCode(service)}`,
          ),
        ]]),
      );
      return;
    }
    const pc = providerCode(provider);
    const sc = serviceCode(service);
    const buttons = regions.slice(0, 60).map((region) =>
      button(region, `rgs:${pc}:${sc}:${region}`)
    );
    const rows = [];
    for (let i = 0; i < buttons.length; i += 3) {
      rows.push(buttons.slice(i, i + 3));
    }
    rows.push([button("⬅️ 返回", `svc:${pc}:${sc}`)]);
    await this.showMenu(surface, `${bold("请选择区域")}`, keyboard(rows));
  }

  private async showList(
    user: TgUser,
    surface: Surface,
    provider: ProviderId,
    service: string,
  ): Promise<void> {
    const region = this.regionFor(surface, provider);
    const adapter = await this.deps.cloud.getAdapter(provider, {
      service,
      region,
    });
    const result = await adapter.listInstances({ region });
    const pc = providerCode(provider);
    const sc = serviceCode(service);
    const refs: ListItemRef[] = result.instances.map((instance) => ({
      instanceId: instance.id,
      name: instance.name,
      state: instance.state,
      region: instance.region ?? region,
      zone: instance.zone,
    }));
    this.deps.sessions.setList(user.id, listKey(pc, sc), refs);

    if (refs.length === 0) {
      await this.showMenu(
        surface,
        `${bold(adapter.label)}\n未找到实例。`,
        keyboard([
          [button("➕ 用预设创建", `cr:${pc}:${sc}`)],
          [
            button("🔄 刷新", `ls:${pc}:${sc}`),
            button("⬅️ 返回", `svc:${pc}:${sc}`),
          ],
        ]),
      );
      return;
    }

    const rows = result.instances.map((instance, index) => [
      button(instanceButtonLabel(instance), `i:${pc}:${sc}:${index}`),
    ]);
    rows.push([
      button("🔄 刷新", `ls:${pc}:${sc}`),
      button("⬅️ 返回", `svc:${pc}:${sc}`),
    ]);
    await this.showMenu(
      surface,
      `${bold(adapter.label)} — 共 ${refs.length} 个实例`,
      keyboard(rows),
    );
  }

  private async handleInstanceCallback(
    user: TgUser,
    surface: Surface,
    parts: string[],
    ack: (text?: string, alert?: boolean) => Promise<void>,
  ): Promise<void> {
    const provider = decodeProvider(parts[1]);
    const service = decodeService(parts[2]);
    const index = Number.parseInt(parts[3], 10);
    const verb = parts[4];
    const pc = providerCode(provider);
    const sc = serviceCode(service);
    const ref = this.deps.sessions.getListItem(user.id, listKey(pc, sc), index);
    if (!ref) {
      await ack("列表已过期，正在刷新", true);
      await this.showList(user, surface, provider, service);
      return;
    }

    if (!verb) {
      await this.showDetail(surface, provider, service, ref);
      return;
    }

    switch (verb) {
      case "refresh":
        await this.showDetail(surface, provider, service, ref);
        return;
      case "start":
      case "stop":
      case "reboot":
        await this.runPower(surface, provider, service, ref, verb, ack);
        return;
      case "rename":
        await this.beginRename(user, surface, provider, service, ref, ack);
        return;
      case "del":
        await this.confirmDelete(surface, provider, service, index, ref);
        return;
      case "delok":
        await this.enqueueDelete(user, surface, provider, service, ref, ack);
        return;
      default:
        await this.showDetail(surface, provider, service, ref);
    }
  }

  private async showDetail(
    surface: Surface,
    provider: ProviderId,
    service: string,
    ref: ListItemRef,
  ): Promise<void> {
    const adapter = await this.deps.cloud.getAdapter(provider, {
      service,
      region: ref.region,
    });
    let instance: Instance;
    try {
      instance = await adapter.getInstance(ref.instanceId, {
        region: ref.region,
        zone: ref.zone,
      });
    } catch {
      instance = {
        id: ref.instanceId,
        name: ref.name,
        state: ref.state,
        region: ref.region,
        zone: ref.zone,
      };
    }
    const caps = adapter.capabilities();
    const pc = providerCode(provider);
    const sc = serviceCode(service);
    const index = this.indexOf(surface, provider, service, ref);
    const base = `i:${pc}:${sc}:${index}`;
    const rows = [];
    const powerRow = [];
    if (caps.start) powerRow.push(button("▶️ 启动", `${base}:start`));
    if (caps.stop) powerRow.push(button("⏹ 停止", `${base}:stop`));
    if (caps.reboot) powerRow.push(button("🔁 重启", `${base}:reboot`));
    if (powerRow.length > 0) rows.push(powerRow);
    const manageRow = [];
    if (caps.rename) manageRow.push(button("✏️ 重命名", `${base}:rename`));
    if (caps.delete) manageRow.push(button("🗑 删除", `${base}:del`));
    if (manageRow.length > 0) rows.push(manageRow);
    rows.push([
      button("🔄 刷新", `${base}:refresh`),
      button("⬅️ 返回", `ls:${pc}:${sc}`),
    ]);
    await this.showMenu(
      surface,
      instanceDetail(instance, adapter.label),
      keyboard(rows),
    );
  }

  private indexOf(
    surface: Surface,
    provider: ProviderId,
    service: string,
    ref: ListItemRef,
  ): number {
    const list = this.deps.sessions.get(surface.chatId).lists.get(
      listKey(providerCode(provider), serviceCode(service)),
    );
    const found =
      list?.findIndex((item) => item.instanceId === ref.instanceId) ?? -1;
    return found >= 0 ? found : 0;
  }

  private async runPower(
    surface: Surface,
    provider: ProviderId,
    service: string,
    ref: ListItemRef,
    verb: "start" | "stop" | "reboot",
    ack: (text?: string, alert?: boolean) => Promise<void>,
  ): Promise<void> {
    const adapter = await this.deps.cloud.getAdapter(provider, {
      service,
      region: ref.region,
    });
    const locator = { region: ref.region, zone: ref.zone };
    if (verb === "start") await adapter.startInstance(ref.instanceId, locator);
    else if (verb === "stop") {
      await adapter.stopInstance(ref.instanceId, locator);
    } else await adapter.rebootInstance(ref.instanceId, locator);
    await ack(VERB_LABELS[verb]);
    await this.showDetail(surface, provider, service, ref);
  }

  private async confirmDelete(
    surface: Surface,
    provider: ProviderId,
    service: string,
    index: number,
    ref: ListItemRef,
  ): Promise<void> {
    const pc = providerCode(provider);
    const sc = serviceCode(service);
    const base = `i:${pc}:${sc}:${index}`;
    await this.showMenu(
      surface,
      `${bold("确认删除")}\n\n确定要删除 ${code(ref.name)}（${
        code(ref.instanceId)
      }）吗？\n此操作不可撤销。`,
      keyboard([
        [button("✅ 确认删除", `${base}:delok`)],
        [button("❌ 取消", `${base}`)],
      ]),
    );
  }

  private async beginRename(
    user: TgUser,
    surface: Surface,
    provider: ProviderId,
    service: string,
    ref: ListItemRef,
    ack: (text?: string, alert?: boolean) => Promise<void>,
  ): Promise<void> {
    if (surface.messageId === undefined) return;
    this.deps.sessions.setFlow(user.id, {
      kind: "rename_instance",
      provider,
      service,
      instanceId: ref.instanceId,
      region: ref.region,
      zone: ref.zone,
      chatId: surface.chatId,
      messageId: surface.messageId,
    });
    await ack();
    await this.deps.api.sendMessage({
      chat_id: surface.chatId,
      text: `请发送 ${code(ref.name)} 的新名称：`,
      parse_mode: "HTML",
    });
  }

  private jobStatusText(label: string, job: JobRecord): string {
    if (job.status === "succeeded") {
      return `✅ ${escapeHtml(label)}\n${escapeHtml(job.result ?? "完成")}`;
    }
    if (job.status === "failed") {
      return `❌ ${escapeHtml(label)}\n${escapeHtml(job.error ?? "失败")}`;
    }
    return `⏳ ${escapeHtml(label)}…`;
  }

  private editJobMessage(
    surface: Surface,
    provider: ProviderId,
    service: string,
    label: string,
    job: JobRecord,
  ): void {
    if (surface.messageId === undefined) return;
    const pc = providerCode(provider);
    const sc = serviceCode(service);
    this.deps.api
      .editMessageText({
        chat_id: surface.chatId,
        message_id: surface.messageId,
        text: this.jobStatusText(label, job),
        parse_mode: "HTML",
        reply_markup: keyboard([[button("📋 实例列表", `ls:${pc}:${sc}`)]]),
      })
      .catch(() => {});
  }

  private async enqueueDelete(
    user: TgUser,
    surface: Surface,
    provider: ProviderId,
    service: string,
    ref: ListItemRef,
    ack: (text?: string, alert?: boolean) => Promise<void>,
  ): Promise<void> {
    const label = `删除 ${ref.name}`;
    const job = this.deps.jobs.enqueue({
      kind: "delete",
      label,
      provider,
      userId: user.id,
      run: async () => {
        const adapter = await this.deps.cloud.getAdapter(provider, {
          service,
          region: ref.region,
        });
        await adapter.deleteInstance(ref.instanceId, {
          region: ref.region,
          zone: ref.zone,
        });
        return `已删除 ${ref.name}`;
      },
      onUpdate: (record) =>
        this.editJobMessage(surface, provider, service, label, record),
    });
    await ack("删除任务已加入队列");
    this.editJobMessage(surface, provider, service, label, job);
  }

  private async showCreateMenu(
    surface: Surface,
    provider: ProviderId,
    service: string,
  ): Promise<void> {
    const presets = await this.deps.presets.listByProvider(provider);
    const pc = providerCode(provider);
    const sc = serviceCode(service);
    if (presets.length === 0) {
      await this.showMenu(
        surface,
        `${bold("用预设创建")}\n\n还没有 ${
          PROVIDER_LABELS[provider]
        } 预设，请用 /presets 添加。`,
        keyboard([
          [button("📦 管理预设", "pst:home")],
          [button("⬅️ 返回", `svc:${pc}:${sc}`)],
        ]),
      );
      return;
    }
    const rows = presets.map((preset) => [
      button(
        `📦 ${preset.name}（${preset.size}）`,
        `mk:${pc}:${sc}:${preset.id}`,
      ),
    ]);
    rows.push([button("⬅️ 返回", `svc:${pc}:${sc}`)]);
    await this.showMenu(surface, `${bold("选择要创建的预设")}`, keyboard(rows));
  }

  private async createFromPreset(
    user: TgUser,
    surface: Surface,
    provider: ProviderId,
    service: string,
    presetId: string,
    ack: (text?: string, alert?: boolean) => Promise<void>,
  ): Promise<void> {
    const preset = await this.deps.presets.get(presetId);
    if (!preset) {
      await ack("未找到预设", true);
      return;
    }
    const label = `创建 ${preset.name}`;
    const region = preset.region ??
      this.deps.sessions.getRegion(user.id, provider);
    const job = this.deps.jobs.enqueue({
      kind: "create",
      label,
      provider,
      userId: user.id,
      run: async () => {
        const adapter = await this.deps.cloud.getAdapter(provider, {
          service,
          region,
        });
        const instance = await adapter.createInstance({
          region: preset.region ?? region,
          zone: preset.zone,
          image: preset.image,
          size: preset.size,
          sshKeyId: preset.sshKeyId,
          tags: preset.tags,
          userData: preset.userData,
        });
        return `已创建 ${instance.name}（${instance.id}）`;
      },
      onUpdate: (record) =>
        this.editJobMessage(surface, provider, service, label, record),
    });
    await ack("创建任务已加入队列");
    this.editJobMessage(surface, provider, service, label, job);
  }

  private async handleProfileCallback(
    user: TgUser,
    surface: Surface,
    parts: string[],
    ack: (text?: string, alert?: boolean) => Promise<void>,
  ): Promise<void> {
    const action = parts[1];
    if (action === "home") {
      await this.showProfiles(surface);
      return;
    }
    if (action === "add") {
      const provider = parts[2] ? decodeProvider(parts[2]) : undefined;
      if (!provider) {
        await this.showProfileProviderChooser(surface);
        return;
      }
      this.deps.sessions.setFlow(user.id, {
        kind: "add_profile_name",
        provider,
      });
      await ack();
      await this.deps.api.sendMessage({
        chat_id: surface.chatId,
        text: `正在添加 ${
          PROVIDER_LABELS[provider]
        } 凭证。\n请先发送一个名称（便于区分多个账号）：`,
      });
      return;
    }
    if (action === "use") {
      const profile = await this.deps.profiles.get(parts[2]);
      if (profile) {
        await this.deps.profiles.setActive(profile.provider, profile.id);
        await ack(`已切换为 ${profile.name}`);
      }
      await this.showProfiles(surface);
      return;
    }
    if (action === "del") {
      await this.deps.profiles.remove(parts[2]);
      await ack("凭证已删除");
      await this.showProfiles(surface);
      return;
    }
  }

  private async showProfileProviderChooser(surface: Surface): Promise<void> {
    const rows = PROVIDER_IDS.map((provider) => [
      button(PROVIDER_LABELS[provider], `prof:add:${providerCode(provider)}`),
    ]);
    rows.push([button("⬅️ 返回", "prof:home")]);
    await this.showMenu(
      surface,
      `${bold("添加凭证")}\n请选择云服务商：`,
      keyboard(rows),
    );
  }

  private async showProfiles(surface: Surface): Promise<void> {
    const profiles = await this.deps.profiles.list();
    const lines = [bold("云凭证")];
    const rows = [];
    if (profiles.length === 0) {
      lines.push("", "还没有任何凭证。");
    } else {
      for (const provider of PROVIDER_IDS) {
        const active = await this.deps.profiles.getActive(provider);
        const group = profiles.filter((profile) =>
          profile.provider === provider
        );
        for (const profile of group) {
          const marker = active?.id === profile.id ? "✅ " : "";
          lines.push(
            `${marker}${escapeHtml(PROVIDER_LABELS[provider])} · ${
              escapeHtml(profile.name)
            }`,
          );
          rows.push([
            button(`使用 ${profile.name}`, `prof:use:${profile.id}`),
            button("🗑", `prof:del:${profile.id}`),
          ]);
        }
      }
    }
    rows.push([button("➕ 添加凭证", "prof:add")]);
    rows.push([button("⬅️ 返回", "m:home")]);
    await this.showMenu(surface, lines.join("\n"), keyboard(rows));
  }

  private async handlePresetCallback(
    user: TgUser,
    surface: Surface,
    parts: string[],
    ack: (text?: string, alert?: boolean) => Promise<void>,
  ): Promise<void> {
    const action = parts[1];
    if (action === "home") {
      await this.showPresets(surface);
      return;
    }
    if (action === "add") {
      await this.showPresetProviderChooser(surface);
      return;
    }
    if (action === "addp") {
      const provider = decodeProvider(parts[2]);
      this.deps.sessions.setFlow(user.id, { kind: "add_preset", provider });
      await ack();
      await this.deps.api.sendMessage({
        chat_id: surface.chatId,
        text: `正在添加 ${
          PROVIDER_LABELS[provider]
        } 预设。\n请按以下格式发送：\n${code(PRESET_FORMAT)}`,
        parse_mode: "HTML",
      });
      return;
    }
    if (action === "del") {
      await this.deps.presets.remove(parts[2]);
      await ack("预设已删除");
      await this.showPresets(surface);
      return;
    }
  }

  private async showPresetProviderChooser(surface: Surface): Promise<void> {
    const rows = PROVIDER_IDS.map((provider) => [
      button(PROVIDER_LABELS[provider], `pst:addp:${providerCode(provider)}`),
    ]);
    rows.push([button("⬅️ 返回", "pst:home")]);
    await this.showMenu(
      surface,
      `${bold("添加预设")}\n请选择云服务商：`,
      keyboard(rows),
    );
  }

  private async showPresets(surface: Surface): Promise<void> {
    const presets = await this.deps.presets.list();
    const lines = [bold("创建预设")];
    const rows = [];
    if (presets.length === 0) {
      lines.push("", "还没有任何预设。");
    } else {
      for (const preset of presets) {
        lines.push(
          `${escapeHtml(PROVIDER_LABELS[preset.provider])} · ${
            escapeHtml(preset.name)
          } — ${escapeHtml(preset.image)} / ${escapeHtml(preset.size)}`,
        );
        rows.push([button(`🗑 ${preset.name}`, `pst:del:${preset.id}`)]);
      }
    }
    rows.push([button("➕ 添加预设", "pst:add")]);
    rows.push([button("⬅️ 返回", "m:home")]);
    await this.showMenu(surface, lines.join("\n"), keyboard(rows));
  }

  private async showJobs(surface: Surface): Promise<void> {
    const jobs = await this.deps.jobStore.recent(10);
    const lines = [bold("最近的操作")];
    if (jobs.length === 0) lines.push("", "暂无操作记录。");
    else for (const job of jobs) lines.push(jobLine(job));
    await this.showMenu(
      surface,
      lines.join("\n"),
      keyboard([[button("🔄 刷新", "jobs"), button("⬅️ 返回", "m:home")]]),
    );
  }

  private async handleFlowInput(
    message: TgMessage,
    surface: Surface,
    text: string,
  ): Promise<void> {
    const user = message.from!;
    const session = this.deps.sessions.get(user.id);
    const flow = session.flow!;

    if (flow.kind === "add_profile_name") {
      this.deps.sessions.setFlow(user.id, {
        kind: "add_profile_creds",
        provider: flow.provider,
        name: text,
      });
      await this.deps.api.sendMessage({
        chat_id: surface.chatId,
        text: CREDENTIAL_HINTS[flow.provider],
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return;
    }

    if (flow.kind === "add_profile_creds") {
      const parsed = parseCredentials(flow.provider, text);
      await this.deps.profiles.add({
        name: flow.name,
        provider: flow.provider,
        defaultRegion: parsed.defaultRegion,
        credentials: parsed.credentials,
      });
      this.deps.sessions.clearFlow(user.id);
      await this.deps.api.sendMessage({
        chat_id: surface.chatId,
        text: `✅ 已保存 ${PROVIDER_LABELS[flow.provider]} 凭证 ${
          code(flow.name)
        }。`,
        parse_mode: "HTML",
      });
      await this.showProfiles(surface);
      return;
    }

    if (flow.kind === "add_preset") {
      const input = parsePresetLine(flow.provider, text);
      const preset = await this.deps.presets.add(input);
      this.deps.sessions.clearFlow(user.id);
      await this.deps.api.sendMessage({
        chat_id: surface.chatId,
        text: `✅ 已保存预设 ${code(preset.name)}。`,
        parse_mode: "HTML",
      });
      await this.showPresets(surface);
      return;
    }

    if (flow.kind === "rename_instance") {
      const adapter = await this.deps.cloud.getAdapter(flow.provider, {
        service: flow.service,
        region: flow.region,
      });
      await adapter.renameInstance(flow.instanceId, text, {
        region: flow.region,
        zone: flow.zone,
      });
      this.deps.sessions.clearFlow(user.id);
      await this.deps.api.sendMessage({
        chat_id: surface.chatId,
        text: `✅ 已重命名为 ${code(text)}。`,
        parse_mode: "HTML",
      });
    }
  }
}
