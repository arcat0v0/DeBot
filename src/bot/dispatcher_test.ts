import { assert, assertEquals } from "@std/assert";
import { createLogger } from "../app/logger.ts";
import {
  generateMasterKeyBase64,
  importMasterKey,
} from "../security/crypto.ts";
import { ProfileStore } from "../storage/profiles.ts";
import { PresetStore } from "../storage/presets.ts";
import { JobStore } from "../jobs/store.ts";
import { JobQueue } from "../jobs/queue.ts";
import { CloudService } from "../cloud/service.ts";
import type { AdapterFactory } from "../cloud/service.ts";
import { MockAdapter } from "../cloud/providers/mock.ts";
import type {
  Capabilities,
  CreateInstanceInput,
  DefaultCreateOption,
  FirewallRule,
  FirewallRuleInput,
  InstanceLocator,
  ProviderId,
  RegionAvailability,
  SubscriptionBalance,
  SubscriptionInfo,
} from "../cloud/types.ts";
import { SessionStore } from "./sessions.ts";
import { Dispatcher } from "./dispatcher.ts";
import type {
  AnswerCallbackParams,
  BotApi,
  EditMessageParams,
  SendMessageParams,
  TgMessage,
  TgUpdate,
} from "./types.ts";

class FakeApi implements BotApi {
  sent: SendMessageParams[] = [];
  edits: EditMessageParams[] = [];
  answers: AnswerCallbackParams[] = [];

  sendMessage(params: SendMessageParams): Promise<TgMessage> {
    this.sent.push(params);
    return Promise.resolve({
      message_id: this.sent.length,
      chat: { id: params.chat_id, type: "private" },
      date: 0,
    });
  }

  editMessageText(params: EditMessageParams): Promise<boolean> {
    this.edits.push(params);
    return Promise.resolve(true);
  }

  answerCallbackQuery(params: AnswerCallbackParams): Promise<boolean> {
    this.answers.push(params);
    return Promise.resolve(true);
  }

  lastEditText(): string {
    return this.edits[this.edits.length - 1]?.text ?? "";
  }

  lastSendText(): string {
    return this.sent[this.sent.length - 1]?.text ?? "";
  }
}

const USER = 123;

class FirewallMockAdapter extends MockAdapter {
  rules: FirewallRule[] = [];

  override capabilities(): Capabilities {
    return { ...super.capabilities(), firewall: true };
  }

  listFirewallRules(): Promise<FirewallRule[]> {
    return Promise.resolve(this.rules.map((rule) => ({ ...rule })));
  }

  addFirewallRule(
    _id: string,
    input: FirewallRuleInput,
    _locator?: InstanceLocator,
  ): Promise<FirewallRule> {
    const existing = this.rules.find((rule) => rule.name === input.name);
    const rule: FirewallRule = {
      name: input.name ?? "rule",
      direction: "Inbound",
      access: "Allow",
      protocol: input.protocol,
      source: input.source,
      ports: input.port,
      priority: existing?.priority ?? 1000 + this.rules.length * 10,
      description: input.description,
    };
    if (existing) Object.assign(existing, rule);
    else this.rules.push(rule);
    return Promise.resolve({ ...rule });
  }

  deleteFirewallRule(
    _id: string,
    ruleName: string,
    _locator?: InstanceLocator,
  ): Promise<void> {
    this.rules = this.rules.filter((rule) => rule.name !== ruleName);
    return Promise.resolve();
  }
}

class AzureFeatureMockAdapter extends MockAdapter {
  createInputs: CreateInstanceInput[] = [];

  override capabilities(): Capabilities {
    return {
      ...super.capabilities(),
      regionAvailability: true,
      balance: true,
      subscriptionInfo: true,
      ipv6: true,
      customCreate: true,
    };
  }

  getSubscriptionInfo(): Promise<SubscriptionInfo> {
    return Promise.resolve({
      id: "sub",
      displayName: "Azure for Students",
      state: "Enabled",
      quotaId: "MS-AZR-0170P",
      spendingLimit: "On",
      isStudent: true,
      studentReason: "quota matched",
    });
  }

  getSubscriptionBalance(): Promise<SubscriptionBalance> {
    return Promise.resolve({
      subscriptionId: "sub",
      currency: "USD",
      credit: [{ name: "可用余额", amount: 88, currency: "USD" }],
      monthToDateCost: 1.5,
    });
  }

  listRegionAvailability(): Promise<RegionAvailability[]> {
    return Promise.resolve([
      {
        region: "eastasia",
        displayName: "East Asia",
        availableSizes: ["Standard_B1s"],
        restrictedSizes: ["Standard_B2ats_v2", "Standard_B2pts_v2"],
      },
    ]);
  }

  selectDefaultCreateOption(region?: string): Promise<DefaultCreateOption> {
    return Promise.resolve({
      region: region ?? "eastasia",
      size: "Standard_B1s",
      image: "Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest",
      resourceGroup: "debot",
      osDiskSizeGb: 64,
      osDiskStorageAccountType: "Premium_LRS",
    });
  }

  override createInstance(input: CreateInstanceInput) {
    this.createInputs.push(input);
    return super.createInstance(input);
  }
}

class SlowAzureSubscriptionMockAdapter extends AzureFeatureMockAdapter {
  gate: Promise<void> = Promise.resolve();

  override async getSubscriptionInfo(): Promise<SubscriptionInfo> {
    await this.gate;
    return await super.getSubscriptionInfo();
  }
}

class SlowAzureRegionsMockAdapter extends AzureFeatureMockAdapter {
  gate: Promise<void> = Promise.resolve();

  override async listRegions(): Promise<string[]> {
    await this.gate;
    return ["eastasia", "westus"];
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function message(text: string, userId = USER): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: userId, is_bot: false, first_name: "U" },
      chat: { id: userId, type: "private" },
      date: 0,
      text,
    },
  };
}

function callback(data: string, userId = USER): TgUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: "q1",
      from: { id: userId, is_bot: false, first_name: "U" },
      message: {
        message_id: 50,
        chat: { id: userId, type: "private" },
        date: 0,
      },
      data,
    },
  };
}

async function setup(allowed = [USER], factoryOverride?: AdapterFactory) {
  const dir = await Deno.makeTempDir();
  const key = await importMasterKey(generateMasterKeyBase64());
  const profiles = new ProfileStore(dir, key);
  const presets = new PresetStore(dir);
  const jobStore = new JobStore(dir);
  const logger = createLogger("error", {}, () => {});
  const jobs = new JobQueue(jobStore, logger);
  const adapters = new Map<ProviderId, MockAdapter>();
  const factory: AdapterFactory = factoryOverride ?? ((provider) => {
    let adapter = adapters.get(provider);
    if (!adapter) {
      adapter = new MockAdapter({ id: provider, label: `Mock ${provider}` });
      adapters.set(provider, adapter);
    }
    return adapter;
  });
  const cloud = new CloudService(profiles, fetch, factory);
  const api = new FakeApi();
  const dispatcher = new Dispatcher({
    api,
    cloud,
    profiles,
    presets,
    jobs,
    jobStore,
    sessions: new SessionStore(),
    logger,
    allowedUsers: allowed,
  });
  return { dir, api, dispatcher, profiles, presets, jobStore, jobs };
}

async function cleanup(dir: string) {
  await Deno.remove(dir, { recursive: true });
}

Deno.test("/start shows the provider menu", async () => {
  const { dir, api, dispatcher } = await setup();
  try {
    await dispatcher.handleUpdate(message("/start"));
    assert(api.lastSendText().includes("DeBot"));
    const markup = api.sent[0].reply_markup;
    assert(markup && markup.inline_keyboard.length >= 2);
  } finally {
    await cleanup(dir);
  }
});

Deno.test("unauthorized users are rejected", async () => {
  const { dir, api, dispatcher } = await setup([999]);
  try {
    await dispatcher.handleUpdate(message("/start", USER));
    assert(api.lastSendText().includes("权限"));
  } finally {
    await cleanup(dir);
  }
});

Deno.test("listing and stopping an instance works end to end", async () => {
  const { dir, api, dispatcher, profiles } = await setup();
  try {
    await profiles.add({
      name: "primary",
      provider: "aws",
      credentials: { accessKeyId: "a", secretAccessKey: "b" },
    });

    await dispatcher.handleUpdate(callback("svc:a:e"));
    assert(api.lastEditText().includes("Mock aws"));

    await dispatcher.handleUpdate(callback("ls:a:e"));
    assert(api.lastEditText().includes("实例"));

    await dispatcher.handleUpdate(callback("i:a:e:0"));
    assert(api.lastEditText().includes("web-1"));

    await dispatcher.handleUpdate(callback("i:a:e:0:stop"));
    assert(
      api.answers.some((answer) => answer.text?.includes("停止")),
      "expected a stop acknowledgement",
    );
    assert(api.lastEditText().includes("已停止"));
  } finally {
    await cleanup(dir);
  }
});

Deno.test("delete requires confirmation and runs as a job", async () => {
  const { dir, api, dispatcher, profiles, jobs, jobStore } = await setup();
  try {
    await profiles.add({
      name: "primary",
      provider: "aws",
      credentials: { accessKeyId: "a", secretAccessKey: "b" },
    });
    await dispatcher.handleUpdate(callback("ls:a:e"));
    await dispatcher.handleUpdate(callback("i:a:e:1:del"));
    assert(api.lastEditText().includes("确认删除"));

    await dispatcher.handleUpdate(callback("i:a:e:1:delok"));
    await jobs.idle();
    const recent = await jobStore.recent(5);
    assert(
      recent.some((job) => job.kind === "delete" && job.status === "succeeded"),
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("azure firewall rules can be added and deleted", async () => {
  const firewall = new FirewallMockAdapter({
    id: "azure",
    label: "Mock Azure",
  });
  const { dir, api, dispatcher, profiles } = await setup(
    [USER],
    (provider) =>
      provider === "azure"
        ? firewall
        : new MockAdapter({ id: provider, label: `Mock ${provider}` }),
  );
  try {
    await profiles.add({
      name: "primary",
      provider: "azure",
      credentials: {
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
        subscriptionId: "sub",
        resourceGroup: "rg",
      },
    });

    await dispatcher.handleUpdate(callback("ls:z:x"));
    await dispatcher.handleUpdate(callback("fw:z:x:0"));
    assert(api.lastEditText().includes("Azure 防火墙"));

    await dispatcher.handleUpdate(callback("fw:z:x:0:add"));
    assert(api.lastSendText().includes("开放的端口规则"));

    await dispatcher.handleUpdate(message("tcp 22 ssh"));
    assertEquals(firewall.rules.length, 1);
    assertEquals(firewall.rules[0].source, "*");
    assert(api.lastEditText().includes("ssh"));

    await dispatcher.handleUpdate(callback("fw:z:x:0:del:0"));
    assert(api.lastEditText().includes("确认删除防火墙规则"));

    await dispatcher.handleUpdate(callback("fw:z:x:0:delok:0"));
    assertEquals(firewall.rules.length, 0);
  } finally {
    await cleanup(dir);
  }
});

Deno.test("azure subscription tools and student default create are available", async () => {
  const azure = new AzureFeatureMockAdapter({
    id: "azure",
    label: "Mock Azure",
  });
  const { dir, api, dispatcher, profiles, jobs, jobStore } = await setup(
    [USER],
    (provider) =>
      provider === "azure"
        ? azure
        : new MockAdapter({ id: provider, label: `Mock ${provider}` }),
  );
  try {
    await profiles.add({
      name: "primary",
      provider: "azure",
      credentials: {
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
        subscriptionId: "sub",
      },
    });

    await dispatcher.handleUpdate(callback("svc:z:x"));
    assert(
      JSON.stringify(api.edits.at(-1)?.reply_markup).includes("订阅余额"),
    );

    await dispatcher.handleUpdate(callback("az:z:x:sub"));
    assert(api.lastEditText().includes("学生订阅：是"));

    await dispatcher.handleUpdate(callback("az:z:x:bal"));
    assert(api.lastEditText().includes("88 USD"));

    await dispatcher.handleUpdate(callback("az:z:x:avail"));
    assert(api.lastEditText().includes("Standard_B1s"));

    await dispatcher.handleUpdate(callback("cr:z:x"));
    assert(api.lastEditText().includes("学生免费默认"));
    assert(
      JSON.stringify(api.edits.at(-1)?.reply_markup).includes("手动填写创建"),
    );

    await dispatcher.handleUpdate(callback("az:z:x:student:1"));
    assert(api.lastSendText().includes("SSH 公钥"));

    await dispatcher.handleUpdate(message("ssh-rsa AAAATEST user@host"));
    await jobs.idle();
    assertEquals(azure.createInputs.length, 1);
    assertEquals(azure.createInputs[0].enableIpv6, true);
    assertEquals(azure.createInputs[0].size, "Standard_B1s");
    assertEquals(azure.createInputs[0].resourceGroup, "debot");
    const recent = await jobStore.recent(5);
    assert(
      recent.some((job) => job.kind === "create" && job.status === "succeeded"),
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("azure info callbacks are acknowledged before slow API calls", async () => {
  const gate = deferred();
  const azure = new SlowAzureSubscriptionMockAdapter({
    id: "azure",
    label: "Mock Azure",
  });
  azure.gate = gate.promise;
  const { dir, api, dispatcher, profiles } = await setup(
    [USER],
    (provider) =>
      provider === "azure"
        ? azure
        : new MockAdapter({ id: provider, label: `Mock ${provider}` }),
  );
  try {
    await profiles.add({
      name: "primary",
      provider: "azure",
      credentials: {
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
        subscriptionId: "sub",
      },
    });

    const pending = dispatcher.handleUpdate(callback("az:z:x:sub"));
    assertEquals(api.answers.length, 1);
    assertEquals(api.answers[0].text, "正在处理...");
    assertEquals(api.edits.length, 0);
    gate.resolve();
    await pending;
    assert(api.lastEditText().includes("学生订阅：是"));
  } finally {
    gate.resolve();
    await cleanup(dir);
  }
});

Deno.test("azure region picker is acknowledged before loading regions", async () => {
  const gate = deferred();
  const azure = new SlowAzureRegionsMockAdapter({
    id: "azure",
    label: "Mock Azure",
  });
  azure.gate = gate.promise;
  const { dir, api, dispatcher, profiles } = await setup(
    [USER],
    (provider) =>
      provider === "azure"
        ? azure
        : new MockAdapter({ id: provider, label: `Mock ${provider}` }),
  );
  try {
    await profiles.add({
      name: "primary",
      provider: "azure",
      credentials: {
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
        subscriptionId: "sub",
      },
    });

    const pending = dispatcher.handleUpdate(callback("rg:z:x"));
    assertEquals(api.answers.length, 1);
    assertEquals(api.answers[0].text, "正在处理...");
    assertEquals(api.edits.length, 0);
    gate.resolve();
    await pending;
    assert(api.lastEditText().includes("请选择区域"));
  } finally {
    gate.resolve();
    await cleanup(dir);
  }
});

Deno.test("azure custom create accepts parameters without presets", async () => {
  const azure = new AzureFeatureMockAdapter({
    id: "azure",
    label: "Mock Azure",
  });
  const { dir, api, dispatcher, profiles, jobs } = await setup(
    [USER],
    (provider) =>
      provider === "azure"
        ? azure
        : new MockAdapter({ id: provider, label: `Mock ${provider}` }),
  );
  try {
    await profiles.add({
      name: "primary",
      provider: "azure",
      defaultRegion: "eastasia",
      credentials: {
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
        subscriptionId: "sub",
      },
    });

    await dispatcher.handleUpdate(callback("az:z:x:custom"));
    assert(api.lastSendText().includes("创建参数"));

    await dispatcher.handleUpdate(
      message(
        "myvm | - | custom-rg | img:offer:sku:latest | Standard_B1s | ssh-ed25519 AAAATEST user@host | yes",
      ),
    );
    await jobs.idle();
    assertEquals(azure.createInputs.length, 1);
    assertEquals(azure.createInputs[0].name, "myvm");
    assertEquals(azure.createInputs[0].region, "eastasia");
    assertEquals(azure.createInputs[0].resourceGroup, "custom-rg");
    assertEquals(azure.createInputs[0].enableIpv6, true);
  } finally {
    await cleanup(dir);
  }
});

Deno.test("adding a profile via conversation persists credentials", async () => {
  const { dir, api, dispatcher, profiles } = await setup();
  try {
    await dispatcher.handleUpdate(callback("prof:add:d"));
    assert(api.lastSendText().includes("名称"));

    await dispatcher.handleUpdate(message("my-do"));
    assert(api.lastSendText().includes("DigitalOcean"));

    await dispatcher.handleUpdate(message("dop_v1_secrettoken"));
    const saved = await profiles.listByProvider("digitalocean");
    assertEquals(saved.length, 1);
    assertEquals(saved[0].name, "my-do");
    const creds = await profiles.getCredentials(saved[0].id);
    assertEquals((creds as { token: string }).token, "dop_v1_secrettoken");
  } finally {
    await cleanup(dir);
  }
});
