import { encodeHex } from "@std/encoding/hex";

export interface AwsSigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: AwsSigningCredentials;
  date?: Date;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const encoder = new TextEncoder();

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function encodePath(path: string): string {
  if (path === "" || path === "/") return "/";
  return path
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

function canonicalQuery(url: URL): string {
  const params: [string, string][] = [];
  for (const [key, value] of url.searchParams.entries()) {
    params.push([encodeRfc3986(key), encodeRfc3986(value)]);
  }
  params.sort((
    a,
    b,
  ) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  return params.map(([key, value]) => `${key}=${value}`).join("&");
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return encodeHex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(message),
  );
  return new Uint8Array(signature);
}

function amzDate(date: Date): { full: string; short: string } {
  const full = date.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
  return { full, short: full.slice(0, 8) };
}

async function signingKey(
  secret: string,
  short: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), short);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, "aws4_request");
}

export async function signRequest(
  input: SignInput,
): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const date = input.date ?? new Date();
  const { full, short } = amzDate(date);
  const body = input.body ?? "";
  const payloadHash = await sha256Hex(body);

  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const host = url.port && url.port !== defaultPort
    ? `${url.hostname}:${url.port}`
    : url.hostname;

  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  headers["host"] = host;
  headers["x-amz-date"] = full;
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const canonicalHeaderEntries = Object.entries(headers)
    .map(([key, value]) =>
      [key.toLowerCase(), value.trim().replace(/\s+/g, " ")] as [string, string]
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalHeaders = canonicalHeaderEntries
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");
  const signedHeaders = canonicalHeaderEntries.map(([key]) => key).join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    encodePath(url.pathname),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${short}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    full,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const key = await signingKey(
    input.credentials.secretAccessKey,
    short,
    input.region,
    input.service,
  );
  const signature = encodeHex(await hmac(key, stringToSign));

  const authorization =
    `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...headers,
    "authorization": authorization,
    "x-amz-content-sha256": payloadHash,
  };
}
