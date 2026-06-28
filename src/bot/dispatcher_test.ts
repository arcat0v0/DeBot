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
import type { ProviderId } from "../cloud/types.ts";
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

async function setup(allowed = [USER]) {
  const dir = await Deno.makeTempDir();
  const key = await importMasterKey(generateMasterKeyBase64());
  const profiles = new ProfileStore(dir, key);
  const presets = new PresetStore(dir);
  const jobStore = new JobStore(dir);
  const logger = createLogger("error", {}, () => {});
  const jobs = new JobQueue(jobStore, logger);
  const adapters = new Map<ProviderId, MockAdapter>();
  const factory: AdapterFactory = (provider) => {
    let adapter = adapters.get(provider);
    if (!adapter) {
      adapter = new MockAdapter({ id: provider, label: `Mock ${provider}` });
      adapters.set(provider, adapter);
    }
    return adapter;
  };
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
