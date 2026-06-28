import type { FetchLike } from "../../http.ts";
import { signRequest } from "./sigv4.ts";
import type { AwsSigningCredentials } from "./sigv4.ts";

export interface SignedFetchOptions {
  credentials: AwsSigningCredentials;
  region: string;
  service: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export async function signedFetch(
  fetchImpl: FetchLike,
  options: SignedFetchOptions,
): Promise<Response> {
  const headers = await signRequest({
    method: options.method,
    url: options.url,
    headers: options.headers,
    body: options.body,
    region: options.region,
    service: options.service,
    credentials: options.credentials,
  });
  return await fetchImpl(options.url, {
    method: options.method,
    headers,
    body: options.body,
  });
}
