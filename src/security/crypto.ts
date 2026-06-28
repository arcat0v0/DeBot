import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { ConfigError, ValidationError } from "../shared/errors.ts";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export function generateMasterKeyBase64(): string {
  const raw = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(raw);
  return encodeBase64(raw);
}

export async function importMasterKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = decodeBase64(base64Key.trim());
  } catch {
    throw new ConfigError("master key is not valid base64");
  }
  if (raw.byteLength !== KEY_BYTES) {
    throw new ConfigError(
      `master key must decode to ${KEY_BYTES} bytes, got ${raw.byteLength}`,
    );
  }
  return await crypto.subtle.importKey(
    "raw",
    ownedBytes(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function loadOrCreateMasterKey(
  dataDir: string,
  envKey?: string,
): Promise<CryptoKey> {
  if (envKey && envKey.trim().length > 0) {
    return await importMasterKey(envKey);
  }
  const keyPath = join(dataDir, "master.key");
  try {
    const existing = await Deno.readTextFile(keyPath);
    return await importMasterKey(existing);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const generated = generateMasterKeyBase64();
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.writeTextFile(keyPath, generated);
  try {
    await Deno.chmod(keyPath, 0o600);
  } catch {
    void 0;
  }
  return await importMasterKey(generated);
}

export async function encryptString(
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const data = new TextEncoder().encode(plaintext);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ownedBytes(data)),
  );
  const combined = new Uint8Array(iv.byteLength + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(cipher, iv.byteLength);
  return `${VERSION}:${encodeBase64(combined)}`;
}

export async function decryptString(
  key: CryptoKey,
  payload: string,
): Promise<string> {
  const separator = payload.indexOf(":");
  if (separator === -1) {
    throw new ValidationError("malformed encrypted payload");
  }
  const version = payload.slice(0, separator);
  const body = payload.slice(separator + 1);
  if (version !== VERSION) {
    throw new ValidationError(`unsupported encryption version: ${version}`);
  }
  const combined = decodeBase64(body);
  if (combined.byteLength <= IV_BYTES) {
    throw new ValidationError("encrypted payload is too short");
  }
  const iv = ownedBytes(combined.slice(0, IV_BYTES));
  const cipher = ownedBytes(combined.slice(IV_BYTES));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    cipher,
  );
  return new TextDecoder().decode(plain);
}

export async function encryptJson(
  key: CryptoKey,
  value: unknown,
): Promise<string> {
  return await encryptString(key, JSON.stringify(value));
}

export async function decryptJson<T>(
  key: CryptoKey,
  payload: string,
): Promise<T> {
  return JSON.parse(await decryptString(key, payload)) as T;
}
