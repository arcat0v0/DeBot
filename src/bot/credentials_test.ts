import { assertEquals, assertThrows } from "@std/assert";
import { parseCredentials } from "./credentials.ts";
import type { AzureCredentials } from "../cloud/types.ts";

Deno.test("parseCredentials reads az ad sp create-for-rbac JSON (no subscription)", () => {
  const json = JSON.stringify({
    appId: "11111111-1111-1111-1111-111111111111",
    displayName: "debot",
    password: "dummy-secret",
    tenant: "22222222-2222-2222-2222-222222222222",
  });
  const { credentials } = parseCredentials("azure", json);
  const azure = credentials as AzureCredentials;
  assertEquals(azure.clientId, "11111111-1111-1111-1111-111111111111");
  assertEquals(azure.tenantId, "22222222-2222-2222-2222-222222222222");
  assertEquals(azure.clientSecret, "dummy-secret");
  assertEquals(azure.subscriptionId, undefined);
});

Deno.test("parseCredentials still accepts explicit subscription/resourceGroup", () => {
  const json = JSON.stringify({
    appId: "a",
    password: "b",
    tenant: "c",
    subscriptionId: "sub-1",
    resourceGroup: "rg-1",
  });
  const azure = parseCredentials("azure", json).credentials as AzureCredentials;
  assertEquals(azure.subscriptionId, "sub-1");
  assertEquals(azure.resourceGroup, "rg-1");
});

Deno.test("parseCredentials rejects incomplete Azure JSON", () => {
  assertThrows(() => parseCredentials("azure", JSON.stringify({ appId: "a" })));
});

Deno.test("parseCredentials parses DigitalOcean token", () => {
  const { credentials } = parseCredentials("digitalocean", "dop_v1_abc");
  assertEquals((credentials as { token: string }).token, "dop_v1_abc");
});
