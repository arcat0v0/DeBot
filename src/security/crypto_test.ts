import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  decryptJson,
  decryptString,
  encryptJson,
  encryptString,
  generateMasterKeyBase64,
  importMasterKey,
  loadOrCreateMasterKey,
} from "./crypto.ts";

Deno.test("encrypt/decrypt round trips a string", async () => {
  const key = await importMasterKey(generateMasterKeyBase64());
  const payload = await encryptString(key, "hello secret");
  assertNotEquals(payload, "hello secret");
  assertEquals(await decryptString(key, payload), "hello secret");
});

Deno.test("encrypt produces a fresh nonce each call", async () => {
  const key = await importMasterKey(generateMasterKeyBase64());
  const first = await encryptString(key, "same");
  const second = await encryptString(key, "same");
  assertNotEquals(first, second);
});

Deno.test("encrypt/decrypt round trips json", async () => {
  const key = await importMasterKey(generateMasterKeyBase64());
  const value = { token: "abc123", nested: { region: "us-east-1" } };
  const payload = await encryptJson(key, value);
  assertEquals(await decryptJson(key, payload), value);
});

Deno.test("decrypt with the wrong key fails", async () => {
  const keyA = await importMasterKey(generateMasterKeyBase64());
  const keyB = await importMasterKey(generateMasterKeyBase64());
  const payload = await encryptString(keyA, "secret");
  await assertRejects(() => decryptString(keyB, payload));
});

Deno.test("importMasterKey rejects wrong sized keys", async () => {
  await assertRejects(() => importMasterKey("c2hvcnQ="));
});

Deno.test("loadOrCreateMasterKey persists and reuses a key", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const key = await loadOrCreateMasterKey(dir);
    const payload = await encryptString(key, "persisted");
    const reloaded = await loadOrCreateMasterKey(dir);
    assertEquals(await decryptString(reloaded, payload), "persisted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadOrCreateMasterKey prefers the env key", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const envKey = generateMasterKeyBase64();
    const key = await loadOrCreateMasterKey(dir, envKey);
    const payload = await encryptString(key, "env");
    const fromImport = await importMasterKey(envKey);
    assertEquals(await decryptString(fromImport, payload), "env");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
