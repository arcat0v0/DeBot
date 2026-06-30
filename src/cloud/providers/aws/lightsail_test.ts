import { assert, assertEquals } from "@std/assert";
import { LightsailAdapter } from "./lightsail.ts";
import type { FetchLike } from "../../http.ts";

interface Captured {
  url: string;
  init?: RequestInit;
}

function recorder(responses: Record<string, string>, defaultStatus = 200) {
  const calls: Captured[] = [];
  const fakeFetch: FetchLike = (input, init) => {
    calls.push({ url: String(input), init });
    const headers = init?.headers as Record<string, string> | undefined;
    const target = headers?.["x-amz-target"] ?? "";
    const op = target.split(".").pop() ?? "";
    const body = responses[op] ?? "{}";
    return Promise.resolve(
      new Response(body, {
        status: defaultStatus,
        headers: { "content-type": "application/x-amz-json-1.1" },
      }),
    );
  };
  return { calls, fakeFetch };
}

function adapterWith(fakeFetch: FetchLike) {
  return new LightsailAdapter({
    credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    defaultRegion: "us-east-1",
    fetch: fakeFetch,
  });
}

Deno.test("LightsailAdapter lists and maps instances with ipv6", async () => {
  const getInstance = JSON.stringify({
    instances: [
      {
        name: "wordpress-1",
        state: { name: "running" },
        location: { regionName: "us-east-1", availabilityZone: "us-east-1a" },
        bundleId: "small_2_0",
        blueprintId: "wordpress",
        publicIpAddress: "54.0.0.10",
        privateIpAddress: "10.0.0.5",
        ipv6Addresses: ["2600:1f16:abcd::abc"],
        createdAt: 1700000000,
      },
    ],
  });
  const { fakeFetch } = recorder({ GetInstances: getInstance });
  const adapter = adapterWith(fakeFetch);
  const list = await adapter.listInstances();
  assertEquals(list.instances.length, 1);
  const instance = list.instances[0];
  assertEquals(instance.id, "wordpress-1");
  assertEquals(instance.publicIpv6, "2600:1f16:abcd::abc");
  assertEquals(instance.publicIp, "54.0.0.10");
});

Deno.test("LightsailAdapter listBundles maps active bundles", async () => {
  const getBundles = JSON.stringify({
    bundles: [
      {
        bundleId: "small_2_0",
        name: "Small 2 GB",
        cpuCount: 2,
        ramSizeInGb: 2,
        diskSizeInGb: 60,
        transferPerMonthInGb: 3000,
        price: 10,
        isActive: true,
      },
      {
        bundleId: "old_1_0",
        name: "Old",
        isActive: false,
      },
    ],
  });
  const { fakeFetch } = recorder({ GetBundles: getBundles });
  const adapter = adapterWith(fakeFetch);
  const bundles = await adapter.listBundles();
  assertEquals(bundles.length, 1);
  assertEquals(bundles[0].id, "small_2_0");
  assertEquals(bundles[0].name, "Small 2 GB");
  assertEquals(bundles[0].cpuCount, 2);
});

Deno.test("LightsailAdapter listBlueprints maps active blueprints", async () => {
  const getBlueprints = JSON.stringify({
    blueprints: [
      {
        blueprintId: "wordpress",
        name: "WordPress",
        group: "wordpress",
        type: "app",
        version: "6.4",
        isActive: true,
      },
      {
        blueprintId: "old_app",
        name: "Old App",
        isActive: false,
      },
    ],
  });
  const { fakeFetch } = recorder({ GetBlueprints: getBlueprints });
  const adapter = adapterWith(fakeFetch);
  const blueprints = await adapter.listBlueprints();
  assertEquals(blueprints.length, 1);
  assertEquals(blueprints[0].id, "wordpress");
  assertEquals(blueprints[0].version, "6.4");
});

function callCounterRecorder(
  getInstanceBodies: string[],
  others: Record<string, string>,
) {
  const calls: Captured[] = [];
  let getInstanceCalls = 0;
  const fakeFetch: FetchLike = (input, init) => {
    calls.push({ url: String(input), init });
    const headers = init?.headers as Record<string, string> | undefined;
    const target = headers?.["x-amz-target"] ?? "";
    const op = target.split(".").pop() ?? "";
    let body = others[op] ?? "{}";
    if (op === "GetInstance") {
      body = getInstanceBodies[
        Math.min(getInstanceCalls, getInstanceBodies.length - 1)
      ];
      getInstanceCalls++;
    }
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-amz-json-1.1" },
      }),
    );
  };
  return { calls, fakeFetch };
}

Deno.test("LightsailAdapter addPublicIpv6 enables add-on and dualstack", async () => {
  const getInstanceEmpty = JSON.stringify({
    instance: { name: "vm-1", ipv6Addresses: [] },
  });
  const getInstanceAssigned = JSON.stringify({
    instance: { name: "vm-1", ipv6Addresses: ["2600:1f16:abcd::1234"] },
  });
  const { calls, fakeFetch } = callCounterRecorder(
    [getInstanceEmpty, getInstanceAssigned],
    {
      EnableAddOn: "{}",
      SetIpAddressType: JSON.stringify({ operations: [] }),
    },
  );
  const adapter = adapterWith(fakeFetch);
  const address = await adapter.addPublicIpv6("vm-1");
  assertEquals(address, "2600:1f16:abcd::1234");
  const ops = calls.map((call) => {
    const headers = call.init?.headers as Record<string, string>;
    return headers?.["x-amz-target"]?.split(".").pop() ?? "";
  });
  assert(ops.includes("EnableAddOn"));
  assert(ops.includes("SetIpAddressType"));
  assert(ops.includes("GetInstance"));
  const enableBody = String(
    calls.find((c) => {
      const headers = c.init?.headers as Record<string, string>;
      return headers?.["x-amz-target"]?.endsWith("EnableAddOn");
    })?.init?.body,
  );
  assert(enableBody.includes('"addOnType":"ipv6"'));
  assert(enableBody.includes('"resourceName":"vm-1"'));
  const setTypeBody = String(
    calls.find((c) => {
      const headers = c.init?.headers as Record<string, string>;
      return headers?.["x-amz-target"]?.endsWith("SetIpAddressType");
    })?.init?.body,
  );
  assert(setTypeBody.includes('"ipAddressType":"dualstack"'));
  assert(setTypeBody.includes('"acceptBundleUpdate":true'));
});

Deno.test("LightsailAdapter addPublicIpv6 returns existing address immediately", async () => {
  const getInstance = JSON.stringify({
    instance: { name: "vm-1", ipv6Addresses: ["2600:1f16:abcd::already"] },
  });
  const { calls, fakeFetch } = recorder({ GetInstance: getInstance });
  const adapter = adapterWith(fakeFetch);
  const address = await adapter.addPublicIpv6("vm-1");
  assertEquals(address, "2600:1f16:abcd::already");
  assertEquals(calls.length, 1);
});

Deno.test("LightsailAdapter capabilities advertise ipv6 support", () => {
  const { fakeFetch } = recorder({});
  const adapter = adapterWith(fakeFetch);
  const caps = adapter.capabilities();
  assertEquals(caps.ipv6, true);
  assert(adapter.addPublicIpv6 !== undefined);
});
