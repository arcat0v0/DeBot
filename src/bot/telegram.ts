import type { FetchLike } from "../cloud/http.ts";
import { DebotError } from "../shared/errors.ts";
import type {
  AnswerCallbackParams,
  BotApi,
  EditMessageParams,
  SendMessageParams,
  TgMessage,
  TgUpdate,
  TgUser,
} from "./types.ts";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
}

export class TelegramClient implements BotApi {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    options: TelegramClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.telegram.org";
  }

  private async call<T>(method: string, payload?: unknown): Promise<T> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      },
    );
    const data = (await response.json()) as TelegramResponse<T>;
    if (!data.ok) {
      throw new DebotError(
        "telegram_error",
        `telegram ${method} failed: ${data.description ?? response.status}`,
      );
    }
    return data.result as T;
  }

  getMe(): Promise<TgUser> {
    return this.call("getMe");
  }

  getUpdates(
    params: { offset?: number; timeout?: number; limit?: number },
  ): Promise<TgUpdate[]> {
    return this.call("getUpdates", params);
  }

  sendMessage(params: SendMessageParams): Promise<TgMessage> {
    return this.call("sendMessage", params);
  }

  editMessageText(params: EditMessageParams): Promise<TgMessage | boolean> {
    return this.call("editMessageText", params);
  }

  answerCallbackQuery(params: AnswerCallbackParams): Promise<boolean> {
    return this.call("answerCallbackQuery", params);
  }

  setMyCommands(
    commands: { command: string; description: string }[],
  ): Promise<boolean> {
    return this.call("setMyCommands", { commands });
  }

  setWebhook(
    params: { url: string; secret_token?: string; allowed_updates?: string[] },
  ): Promise<boolean> {
    return this.call("setWebhook", params);
  }

  deleteWebhook(): Promise<boolean> {
    return this.call("deleteWebhook", {});
  }
}
