import { assert, assertEquals } from "@std/assert";
import { AzureAdapter } from "./adapter.ts";

const SUB = "sub";
const RG = "rg";
const NIC_ID =
  `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/networkInterfaces/vm1-nic`;
const NSG_ID =
  `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/networkSecurityGroups/vm1-nsg`;

Deno.test("AzureAdapter manages NIC-level firewall rules", async () => {
  const calls: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }[] = [];
  let nicNsgId: string | undefined;
  const rules = new Map<string, Record<string, unknown>>();
  const fetchImpl: typeof fetch = (async (input, init) => {
    await Promise.resolve();
    const url = new URL(String(input));
    if (url.hostname === "login.microsoftonline.com") {
      return Response.json({ access_token: "token", expires_in: 3600 });
    }
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });

    if (
      method === "GET" &&
      url.pathname ===
        `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Compute/virtualMachines/vm1`
    ) {
      return Response.json({
        name: "vm1",
        location: "eastasia",
        properties: {
          networkProfile: { networkInterfaces: [{ id: NIC_ID }] },
        },
      });
    }
    if (method === "GET" && url.pathname === NIC_ID) {
      return Response.json({
        id: NIC_ID,
        properties: {
          provisioningState: "Succeeded",
          networkSecurityGroup: nicNsgId ? { id: nicNsgId } : undefined,
          ipConfigurations: [],
        },
      });
    }
    if (method === "PUT" && url.pathname === NSG_ID) {
      return Response.json({
        id: NSG_ID,
        name: "vm1-nsg",
        location: "eastasia",
        properties: {
          provisioningState: "Succeeded",
          securityRules: [...rules.values()],
        },
      });
    }
    if (method === "GET" && url.pathname === NSG_ID) {
      return Response.json({
        id: NSG_ID,
        name: "vm1-nsg",
        location: "eastasia",
        properties: {
          provisioningState: "Succeeded",
          securityRules: [...rules.values()],
        },
      });
    }
    if (method === "PUT" && url.pathname === NIC_ID) {
      const props = body?.properties as
        | { networkSecurityGroup?: { id?: string } }
        | undefined;
      nicNsgId = props?.networkSecurityGroup?.id;
      return Response.json({
        id: NIC_ID,
        properties: {
          provisioningState: "Succeeded",
          networkSecurityGroup: { id: nicNsgId },
        },
      });
    }
    if (method === "PUT" && url.pathname === `${NSG_ID}/securityRules/ssh`) {
      const rule = {
        id: `${NSG_ID}/securityRules/ssh`,
        name: "ssh",
        properties: body?.properties,
      };
      rules.set("ssh", rule);
      return Response.json(rule);
    }
    if (method === "DELETE" && url.pathname === `${NSG_ID}/securityRules/ssh`) {
      rules.delete("ssh");
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: { message: `${method} ${url.pathname}` } }, {
      status: 404,
    });
  }) as typeof fetch;

  const adapter = new AzureAdapter({
    credentials: {
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
      subscriptionId: SUB,
      resourceGroup: RG,
    },
    fetch: fetchImpl,
  });

  const saved = await adapter.addFirewallRule("vm1", {
    name: "ssh",
    protocol: "Tcp",
    port: "22",
    source: "0.0.0.0/0",
  });
  assertEquals(saved.name, "ssh");
  assertEquals(saved.priority, 1000);
  assertEquals(nicNsgId, NSG_ID);
  assertEquals(rules.get("ssh")?.properties, {
    access: "Allow",
    destinationAddressPrefix: "*",
    destinationPortRange: "22",
    direction: "Inbound",
    priority: 1000,
    protocol: "Tcp",
    sourceAddressPrefix: "0.0.0.0/0",
    sourcePortRange: "*",
  });

  const listed = await adapter.listFirewallRules("vm1");
  assertEquals(listed.map((rule) => rule.name), ["ssh"]);

  await adapter.deleteFirewallRule("vm1", "ssh");
  assertEquals(await adapter.listFirewallRules("vm1"), []);
  assert(calls.some((call) => call.method === "PUT" && call.path === NSG_ID));
});
