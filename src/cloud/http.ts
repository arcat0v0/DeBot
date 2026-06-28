import { ProviderError } from "../shared/errors.ts";

export type FetchLike = typeof fetch;

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, QueryValue>;
}

export function withQuery(
  url: string,
  query?: Record<string, QueryValue>,
): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  if (qs.length === 0) return url;
  return url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
}

function extractMessage(status: number, text: string): string {
  if (text.trim().length === 0) return `HTTP ${status}`;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const error = data.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof data.message === "string") return data.message;
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      const first = data.errors[0] as Record<string, unknown>;
      if (typeof first.message === "string") return first.message;
    }
  } catch {
    void 0;
  }
  return text.slice(0, 300);
}

export async function requestJson<T>(
  fetchImpl: FetchLike,
  provider: string,
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "accept": "application/json",
    ...options.headers,
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body);
    if (!headers["content-type"]) headers["content-type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetchImpl(withQuery(url, options.query), {
      method: options.method ?? "GET",
      headers,
      body,
    });
  } catch (error) {
    throw new ProviderError(provider, `network error: ${String(error)}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new ProviderError(provider, extractMessage(response.status, text), {
      status: response.status,
      userMessage: `${provider} API error (${response.status}): ${
        extractMessage(response.status, text)
      }`,
    });
  }

  if (text.trim().length === 0) return undefined as T;
  return JSON.parse(text) as T;
}
