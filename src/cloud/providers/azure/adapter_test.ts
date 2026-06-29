import { assert, assertEquals, assertRejects } from "@std/assert";
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

Deno.test("AzureAdapter reports subscription info, cost and student SKU regions", async () => {
  const fetchImpl: typeof fetch = (async (input, init) => {
    await Promise.resolve();
    const url = new URL(String(input));
    if (url.hostname === "login.microsoftonline.com") {
      return Response.json({ access_token: "token", expires_in: 3600 });
    }
    const method = init?.method ?? "GET";

    if (method === "GET" && url.pathname === `/subscriptions/${SUB}`) {
      return Response.json({
        subscriptionId: SUB,
        displayName: "Azure for Students",
        state: "Enabled",
        tenantId: "tenant",
        subscriptionPolicies: {
          quotaId: "MS-AZR-0170P",
          spendingLimit: "On",
        },
      });
    }
    if (
      method === "GET" && url.pathname === `/subscriptions/${SUB}/locations`
    ) {
      return Response.json({
        value: [
          {
            name: "eastasia",
            displayName: "East Asia",
            metadata: { regionCategory: "Recommended" },
          },
          { name: "westus", displayName: "West US" },
        ],
      });
    }
    if (
      method === "GET" &&
      url.pathname === `/subscriptions/${SUB}/resourcegroups`
    ) {
      return Response.json({ value: [{ name: "only-rg" }] });
    }
    if (
      method === "GET" &&
      url.pathname ===
        `/subscriptions/${SUB}/providers/Microsoft.Compute/skus`
    ) {
      if (url.searchParams.get("page") === "2") {
        return Response.json({
          value: [
            {
              name: "Standard_B1s",
              resourceType: "virtualMachines",
              locations: ["eastasia", "westus"],
              restrictions: [
                {
                  type: "Location",
                  values: ["westus"],
                  reasonCode: "NotAvailableForSubscription",
                },
              ],
            },
            {
              name: "Standard_B2ats_v2",
              resourceType: "virtualMachines",
              locations: ["EastAsia"],
              restrictions: [
                {
                  type: "Zone",
                  values: ["EastAsia"],
                  reasonCode: "NotAvailableForSubscription",
                },
              ],
            },
          ],
        });
      }
      return Response.json({
        value: [
          {
            name: "Standard_D64s_v5",
            resourceType: "virtualMachines",
            locations: ["eastasia"],
          },
          {
            name: "Standard_B1s",
            resourceType: "disks",
            locations: ["westus"],
          },
        ],
        nextLink:
          `https://management.azure.com/subscriptions/${SUB}/providers/Microsoft.Compute/skus?api-version=2023-09-01&page=2`,
      });
    }
    if (
      method === "POST" &&
      url.pathname ===
        `/subscriptions/${SUB}/providers/Microsoft.CostManagement/query`
    ) {
      return Response.json({
        properties: {
          columns: [{ name: "Cost" }, { name: "Currency" }],
          rows: [[1.23, "USD"]],
        },
      });
    }
    if (
      method === "GET" &&
      url.pathname === "/providers/Microsoft.Billing/billingAccounts"
    ) {
      return Response.json({ error: { message: "billing denied" } }, {
        status: 403,
      });
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
    },
    fetch: fetchImpl,
  });

  const info = await adapter.getSubscriptionInfo();
  assertEquals(info.isStudent, true);
  assertEquals(info.quotaId, "MS-AZR-0170P");

  const availability = await adapter.listRegionAvailability();
  assertEquals(
    availability.find((item) => item.region === "eastasia")
      ?.availableSizes,
    ["Standard_B1s", "Standard_B2ats_v2"],
  );
  assertEquals(
    availability.find((item) => item.region === "westus")
      ?.availableSizes,
    [],
  );

  const option = await adapter.selectDefaultCreateOption("eastasia");
  assertEquals(option.size, "Standard_B1s");
  assertEquals(option.resourceGroup, "only-rg");

  const balance = await adapter.getSubscriptionBalance();
  assertEquals(balance.monthToDateCost, 1.23);
  assertEquals(balance.currency, "USD");
  assert(
    balance.warnings?.some((warning) =>
      warning.includes("无法读取 Azure 信用余额")
    ),
  );
});

Deno.test("AzureAdapter reads legacy credit balance when cost query is denied", async () => {
  const fetchImpl: typeof fetch = (async (input, init) => {
    await Promise.resolve();
    const url = new URL(String(input));
    if (url.hostname === "login.microsoftonline.com") {
      return Response.json({ access_token: "token", expires_in: 3600 });
    }
    const method = init?.method ?? "GET";

    if (
      method === "GET" &&
      url.pathname === "/providers/Microsoft.Billing/billingAccounts"
    ) {
      return Response.json({
        value: [
          { name: "legacy-account", properties: { displayName: "Student" } },
        ],
      });
    }
    if (
      method === "GET" &&
      url.pathname ===
        "/providers/Microsoft.Billing/billingAccounts/legacy-account/providers/Microsoft.Consumption/balances"
    ) {
      return Response.json({
        properties: {
          endingBalance: 88,
          utilized: 12,
          beginningBalance: 100,
          currency: "USD",
        },
      });
    }
    if (
      method === "GET" &&
      url.pathname ===
        "/providers/Microsoft.Billing/billingAccounts/legacy-account/billingProfiles"
    ) {
      return Response.json({ value: [] });
    }
    if (
      method === "POST" &&
      url.pathname ===
        `/subscriptions/${SUB}/providers/Microsoft.CostManagement/query`
    ) {
      return Response.json({
        error: { message: "The client does not have authorization" },
      }, { status: 403 });
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
    },
    fetch: fetchImpl,
  });

  const balance = await adapter.getSubscriptionBalance();
  assertEquals(balance.credit?.[0], {
    name: "Student 可用余额",
    amount: 88,
    currency: "USD",
  });
  assert(
    balance.warnings?.some((warning) =>
      warning.includes("Cost Management Reader")
    ),
  );
  assert(
    !balance.warnings?.some((warning) =>
      warning.includes("无法读取 Azure 信用余额")
    ),
  );
});

Deno.test("AzureAdapter parses credit summary properties shape", async () => {
  const fetchImpl: typeof fetch = (async (input, init) => {
    await Promise.resolve();
    const url = new URL(String(input));
    if (url.hostname === "login.microsoftonline.com") {
      return Response.json({ access_token: "token", expires_in: 3600 });
    }
    const method = init?.method ?? "GET";

    if (
      method === "GET" &&
      url.pathname === "/providers/Microsoft.Billing/billingAccounts"
    ) {
      return Response.json({
        value: [
          {
            name: "acct",
            properties: {
              displayName: "Billing",
              billingProfiles: [
                {
                  name: "profile",
                  properties: { displayName: "Credits", currency: "USD" },
                },
              ],
            },
          },
        ],
      });
    }
    if (
      method === "GET" &&
      url.pathname ===
        "/providers/Microsoft.Billing/billingAccounts/acct/providers/Microsoft.Consumption/balances"
    ) {
      return Response.json({ error: { message: "unsupported" } }, {
        status: 404,
      });
    }
    if (
      method === "GET" &&
      url.pathname ===
        "/providers/Microsoft.Billing/billingAccounts/acct/billingProfiles/profile/providers/Microsoft.Consumption/lots"
    ) {
      return Response.json({ value: [] });
    }
    if (
      method === "GET" &&
      url.pathname ===
        "/providers/Microsoft.Billing/billingAccounts/acct/billingProfiles/profile/providers/Microsoft.Consumption/credits/balanceSummary"
    ) {
      return Response.json({
        properties: {
          creditCurrency: "USD",
          balanceSummary: {
            currentBalance: { value: 42, currency: "USD" },
            estimatedBalance: { value: 41.5, currency: "USD" },
          },
        },
      });
    }
    if (
      method === "POST" &&
      url.pathname ===
        `/subscriptions/${SUB}/providers/Microsoft.CostManagement/query`
    ) {
      return Response.json({
        properties: {
          columns: [{ name: "PreTaxCost" }, { name: "Currency" }],
          rows: [[1.25, "USD"]],
        },
      });
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
    },
    fetch: fetchImpl,
  });

  const balance = await adapter.getSubscriptionBalance();
  assertEquals(balance.credit?.map((item) => item.name), [
    "Credits 当前余额",
    "Credits 预估余额",
  ]);
  assertEquals(balance.credit?.[0].amount, 42);
  assertEquals(balance.monthToDateCost, 1.25);
});

Deno.test("AzureAdapter deletes VM dependencies created with the instance", async () => {
  const diskId =
    `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Compute/disks/vm1-os`;
  const pipId =
    `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/publicIPAddresses/vm1-ip`;
  const deleted = new Set<string>();
  const calls: { method: string; path: string; apiVersion?: string }[] = [];
  const fetchImpl: typeof fetch = (async (input, init) => {
    await Promise.resolve();
    const url = new URL(String(input));
    if (url.hostname === "login.microsoftonline.com") {
      return Response.json({ access_token: "token", expires_in: 3600 });
    }
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      apiVersion: url.searchParams.get("api-version") ?? undefined,
    });
    if (method === "GET" && deleted.has(url.pathname)) {
      return Response.json({ error: { message: "not found" } }, {
        status: 404,
      });
    }
    if (
      method === "GET" &&
      url.pathname ===
        `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Compute/virtualMachines/vm1`
    ) {
      return Response.json({
        name: "vm1",
        location: "eastasia",
        properties: {
          storageProfile: { osDisk: { managedDisk: { id: diskId } } },
          networkProfile: { networkInterfaces: [{ id: NIC_ID }] },
        },
      });
    }
    if (method === "GET" && url.pathname === NIC_ID) {
      return Response.json({
        id: NIC_ID,
        properties: {
          ipConfigurations: [
            { properties: { publicIPAddress: { id: pipId } } },
          ],
        },
      });
    }
    if (
      method === "GET" &&
      [diskId, pipId].includes(url.pathname)
    ) {
      return Response.json({ id: url.pathname });
    }
    if (method === "DELETE") {
      deleted.add(url.pathname);
      return new Response(null, { status: 202 });
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

  await adapter.deleteInstance("vm1");

  assert(calls.some((call) =>
    call.method === "DELETE" && call.path ===
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Compute/virtualMachines/vm1`
  ));
  assert(
    calls.some((call) => call.method === "DELETE" && call.path === NIC_ID),
  );
  assert(calls.some((call) => call.method === "DELETE" && call.path === pipId));
  assert(
    calls.some((call) =>
      call.method === "DELETE" && call.path === diskId &&
      call.apiVersion === "2023-10-02"
    ),
  );
});

Deno.test("AzureAdapter cleans partial create resources after failure", async () => {
  const name = "vmfail";
  const paths = {
    rg: `/subscriptions/${SUB}/resourceGroups/${RG}`,
    pip:
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/publicIPAddresses/${name}-ip`,
    ipv6:
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/publicIPAddresses/${name}-ipv6`,
    vnet:
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/virtualNetworks/debot-eastasia-vnet`,
    nic:
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/networkInterfaces/${name}-nic`,
    vm:
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Compute/virtualMachines/${name}`,
    disk:
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Compute/disks/${name}-osdisk`,
  };
  const existing = new Set([paths.rg]);
  const deleted: string[] = [];
  const fetchImpl: typeof fetch = (async (input, init) => {
    await Promise.resolve();
    const url = new URL(String(input));
    if (url.hostname === "login.microsoftonline.com") {
      return Response.json({ access_token: "token", expires_in: 3600 });
    }
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === "GET") {
      if (existing.has(url.pathname)) {
        return Response.json({
          id: url.pathname,
          properties: { provisioningState: "Succeeded" },
        });
      }
      return Response.json({ error: { message: "not found" } }, {
        status: 404,
      });
    }
    if (method === "PUT" && url.pathname === paths.pip) {
      existing.add(paths.pip);
      return Response.json({
        id: paths.pip,
        properties: { provisioningState: "Succeeded" },
      });
    }
    if (method === "PUT" && url.pathname === paths.ipv6) {
      return Response.json({ error: { message: "ipv6 quota" } }, {
        status: 400,
      });
    }
    if (method === "PUT" && url.pathname === paths.vnet) {
      existing.add(paths.vnet);
      return Response.json({
        id: paths.vnet,
        properties: { provisioningState: "Succeeded" },
      });
    }
    if (method === "PUT" && url.pathname === paths.nic) {
      existing.add(paths.nic);
      return Response.json({ id: paths.nic });
    }
    if (method === "PUT" && url.pathname === paths.vm) {
      existing.add(paths.vm);
      const props = body?.properties as Record<string, unknown> | undefined;
      assert(props);
      return Response.json({ id: paths.vm });
    }
    if (method === "DELETE") {
      deleted.push(url.pathname);
      existing.delete(url.pathname);
      return new Response(null, { status: 202 });
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

  await assertRejects(() =>
    adapter.createInstance({
      name,
      region: "eastasia",
      image: "Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest",
      size: "Standard_B2ats_v2",
      sshKeyId: "ssh-ed25519 AAAATEST user@host",
      enableIpv6: true,
    })
  );

  assert(deleted.includes(paths.pip));
  assert(deleted.includes(paths.vnet));
});
