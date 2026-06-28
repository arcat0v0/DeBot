import { assert, assertEquals } from "@std/assert";
import { DigitalOceanAdapter } from "./adapter.ts";
import type { FetchLike } from "../../http.ts";

interface Captured {
  url: string;
  init?: RequestInit;
}

function recorder(body: string, status = 200) {
  const calls: Captured[] = [];
  const fakeFetch: FetchLike = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { calls, fakeFetch };
}

function adapterWith(fakeFetch: FetchLike) {
  return new DigitalOceanAdapter({
    credentials: { token: "do-token" },
    fetch: fakeFetch,
  });
}

const DROPLETS = JSON.stringify({
  droplets: [
    {
      id: 1001,
      name: "web",
      status: "active",
      region: { slug: "nyc3" },
      size_slug: "s-1vcpu-1gb",
      image: { slug: "ubuntu-22-04-x64" },
      networks: {
        v4: [
          { ip_address: "10.1.1.1", type: "private" },
          { ip_address: "203.0.113.9", type: "public" },
        ],
      },
      created_at: "2024-01-01T00:00:00Z",
      tags: ["prod"],
    },
  ],
});

Deno.test("DigitalOceanAdapter lists droplets with bearer auth", async () => {
  const { calls, fakeFetch } = recorder(DROPLETS);
  const adapter = adapterWith(fakeFetch);
  const list = await adapter.listInstances();
  assertEquals(list.instances.length, 1);
  assertEquals(list.instances[0].state, "running");
  assertEquals(list.instances[0].publicIp, "203.0.113.9");
  assertEquals(list.instances[0].privateIp, "10.1.1.1");
  const headers = calls[0].init?.headers as Record<string, string>;
  assertEquals(headers.authorization, "Bearer do-token");
  assert(calls[0].url.startsWith("https://api.digitalocean.com/v2/droplets"));
});

Deno.test("DigitalOceanAdapter creates a droplet from a preset", async () => {
  const { calls, fakeFetch } = recorder(
    JSON.stringify({
      droplet: { id: 5, name: "new", status: "new", region: { slug: "nyc3" } },
    }),
  );
  const adapter = adapterWith(fakeFetch);
  const created = await adapter.createInstance({
    name: "new",
    region: "nyc3",
    image: "ubuntu-22-04-x64",
    size: "s-1vcpu-1gb",
    sshKeyId: "12:34",
  });
  assertEquals(created.id, "5");
  assertEquals(calls[0].init?.method, "POST");
  const body = JSON.parse(String(calls[0].init?.body));
  assertEquals(body.region, "nyc3");
  assertEquals(body.ssh_keys, ["12:34"]);
});

Deno.test("DigitalOceanAdapter sends power actions", async () => {
  const { calls, fakeFetch } = recorder(
    JSON.stringify({ action: { status: "in-progress" } }),
  );
  const adapter = adapterWith(fakeFetch);
  await adapter.stopInstance("1001");
  const body = JSON.parse(String(calls[0].init?.body));
  assertEquals(body.type, "power_off");
  assert(calls[0].url.endsWith("/droplets/1001/actions"));
});
