import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  generateMasterKeyBase64,
  importMasterKey,
} from "../security/crypto.ts";
import { ProfileStore } from "./profiles.ts";
import { PresetStore } from "./presets.ts";
import type { AwsCredentials } from "../cloud/types.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("ProfileStore stores credentials encrypted and round trips them", async () => {
  await withDir(async (dir) => {
    const key = await importMasterKey(generateMasterKeyBase64());
    const store = new ProfileStore(dir, key);
    const creds: AwsCredentials = {
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "topsecret",
    };
    const profile = await store.add({
      name: "primary",
      provider: "aws",
      defaultRegion: "us-east-1",
      credentials: creds,
    });

    const raw = await Deno.readTextFile(`${dir}/profiles.json`);
    assert(
      !raw.includes("topsecret"),
      "secret must not be stored in plaintext",
    );

    const loaded = await store.getCredentials<AwsCredentials>(profile.id);
    assertEquals(loaded, creds);
  });
});

Deno.test("ProfileStore tracks the active profile per provider", async () => {
  await withDir(async (dir) => {
    const key = await importMasterKey(generateMasterKeyBase64());
    const store = new ProfileStore(dir, key);
    const a = await store.add({
      name: "a",
      provider: "aws",
      credentials: { accessKeyId: "a", secretAccessKey: "a" },
    });
    const b = await store.add({
      name: "b",
      provider: "aws",
      credentials: { accessKeyId: "b", secretAccessKey: "b" },
    });

    assertEquals((await store.getActive("aws"))?.id, a.id);
    await store.setActive("aws", b.id);
    assertEquals((await store.getActive("aws"))?.id, b.id);
  });
});

Deno.test("ProfileStore removing the active profile falls back", async () => {
  await withDir(async (dir) => {
    const key = await importMasterKey(generateMasterKeyBase64());
    const store = new ProfileStore(dir, key);
    const a = await store.add({
      name: "a",
      provider: "do" as never,
      credentials: { token: "x" },
    });
    await store.remove(a.id);
    assertEquals(await store.getActive("digitalocean"), undefined);
  });
});

Deno.test("ProfileStore rejects activating a mismatched provider", async () => {
  await withDir(async (dir) => {
    const key = await importMasterKey(generateMasterKeyBase64());
    const store = new ProfileStore(dir, key);
    const aws = await store.add({
      name: "aws",
      provider: "aws",
      credentials: { accessKeyId: "a", secretAccessKey: "a" },
    });
    await assertRejects(() => store.setActive("gcp", aws.id));
  });
});

Deno.test("PresetStore adds and removes presets", async () => {
  await withDir(async (dir) => {
    const store = new PresetStore(dir);
    const preset = await store.add({
      name: "small",
      provider: "digitalocean",
      region: "nyc3",
      image: "ubuntu-22-04-x64",
      size: "s-1vcpu-1gb",
    });
    assertEquals((await store.listByProvider("digitalocean")).length, 1);
    await store.remove(preset.id);
    assertEquals((await store.list()).length, 0);
  });
});

Deno.test("PresetStore validates required fields", async () => {
  await withDir(async (dir) => {
    const store = new PresetStore(dir);
    await assertRejects(() =>
      store.add({
        name: "bad",
        provider: "aws",
        image: "",
        size: "t3.micro",
      })
    );
  });
});
