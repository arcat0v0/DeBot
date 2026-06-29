import { delay } from "@std/async";
import {
  NotFoundError,
  ProviderError,
  ValidationError,
} from "../../../shared/errors.ts";
import { requestJson } from "../../http.ts";
import type { FetchLike } from "../../http.ts";
import type {
  AdapterContext,
  Capabilities,
  CreateInstanceInput,
  FirewallAccess,
  FirewallDirection,
  FirewallProtocol,
  FirewallRule,
  FirewallRuleInput,
  Instance,
  InstanceList,
  InstanceLocator,
  InstanceState,
  ListOptions,
  ProviderAdapter,
} from "../../types.ts";
import { AzureAuth } from "./auth.ts";

const BASE = "https://management.azure.com";
const COMPUTE_API = "2023-09-01";
const NETWORK_API = "2023-09-01";

interface AzureStatus {
  code?: string;
}

interface AzureVm {
  id?: string;
  name?: string;
  location?: string;
  properties?: {
    provisioningState?: string;
    hardwareProfile?: { vmSize?: string };
    storageProfile?: {
      imageReference?: { publisher?: string; offer?: string; sku?: string };
    };
    instanceView?: { statuses?: AzureStatus[] };
    networkProfile?: { networkInterfaces?: { id?: string }[] };
  };
}

interface AzureSubnet {
  name?: string;
  properties?: {
    addressPrefix?: string;
    addressPrefixes?: string[];
    networkSecurityGroup?: { id?: string };
  };
}

interface AzureVnet {
  properties?: {
    addressSpace?: { addressPrefixes?: string[] };
    subnets?: AzureSubnet[];
  };
}

interface AzureIpConfig {
  name?: string;
  properties?: {
    privateIPAddressVersion?: string;
    primary?: boolean;
    subnet?: { id?: string };
    publicIPAddress?: { id?: string };
  };
}

interface AzureNic {
  id?: string;
  properties?: {
    ipConfigurations?: AzureIpConfig[];
    networkSecurityGroup?: { id?: string };
  };
}

interface AzurePublicIp {
  properties?: {
    ipAddress?: string;
    provisioningState?: string;
  };
}

interface AzureSecurityRule {
  id?: string;
  name?: string;
  properties?: {
    access?: string;
    description?: string;
    destinationAddressPrefix?: string;
    destinationAddressPrefixes?: string[];
    destinationPortRange?: string;
    destinationPortRanges?: string[];
    direction?: string;
    priority?: number;
    protocol?: string;
    sourceAddressPrefix?: string;
    sourceAddressPrefixes?: string[];
  };
}

interface AzureNetworkSecurityGroup {
  id?: string;
  name?: string;
  location?: string;
  properties?: {
    provisioningState?: string;
    securityRules?: AzureSecurityRule[];
  };
}

const IPV6_VNET_PREFIX = "ace:cab:deca::/48";
const IPV6_SUBNET_PREFIX = "ace:cab:deca:deed::/64";

function resourceGroupFromId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const match = id.match(/resourceGroups\/([^/]+)/i);
  return match?.[1];
}

function mapPowerState(statuses: AzureStatus[] | undefined): InstanceState {
  const power = statuses?.find((status) =>
    status.code?.startsWith("PowerState/")
  );
  const value = power?.code?.split("/")[1];
  switch (value) {
    case "running":
      return "running";
    case "starting":
      return "pending";
    case "stopping":
    case "deallocating":
      return "stopping";
    case "stopped":
    case "deallocated":
      return "stopped";
    default:
      return "unknown";
  }
}

function mapVm(raw: AzureVm): Instance {
  const image = raw.properties?.storageProfile?.imageReference;
  const imageLabel = image
    ? [image.publisher, image.offer, image.sku].filter(Boolean).join(":")
    : undefined;
  const resourceGroup = resourceGroupFromId(raw.id);
  return {
    id: raw.name ?? "",
    name: raw.name ?? "",
    state: mapPowerState(raw.properties?.instanceView?.statuses),
    region: raw.location,
    resourceGroup,
    size: raw.properties?.hardwareProfile?.vmSize,
    image: imageLabel,
    tags: resourceGroup ? { resourceGroup } : undefined,
  };
}

function oneOrMany(
  one: string | undefined,
  many: string[] | undefined,
): string | undefined {
  if (many && many.length > 0) return many.join(",");
  return one;
}

function mapFirewallProtocol(value: string | undefined): FirewallProtocol {
  switch (value?.toLowerCase()) {
    case "tcp":
      return "Tcp";
    case "udp":
      return "Udp";
    case "icmp":
      return "Icmp";
    default:
      return "*";
  }
}

function mapFirewallAccess(value: string | undefined): FirewallAccess {
  return value === "Deny" ? "Deny" : "Allow";
}

function mapFirewallDirection(value: string | undefined): FirewallDirection {
  return value === "Outbound" ? "Outbound" : "Inbound";
}

function mapSecurityRule(raw: AzureSecurityRule): FirewallRule {
  const props = raw.properties ?? {};
  return {
    id: raw.id,
    name: raw.name ?? "",
    direction: mapFirewallDirection(props.direction),
    access: mapFirewallAccess(props.access),
    protocol: mapFirewallProtocol(props.protocol),
    source: oneOrMany(
      props.sourceAddressPrefix,
      props.sourceAddressPrefixes,
    ),
    destination: oneOrMany(
      props.destinationAddressPrefix,
      props.destinationAddressPrefixes,
    ),
    ports: oneOrMany(
      props.destinationPortRange,
      props.destinationPortRanges,
    ),
    priority: props.priority,
    description: props.description,
  };
}

function nextSecurityRulePriority(rules: AzureSecurityRule[]): number {
  const used = new Set(
    rules
      .map((rule) => rule.properties?.priority)
      .filter((priority): priority is number => priority !== undefined),
  );
  for (let priority = 1000; priority <= 4096; priority += 10) {
    if (!used.has(priority)) return priority;
  }
  for (let priority = 100; priority <= 4096; priority++) {
    if (!used.has(priority)) return priority;
  }
  throw new ProviderError("azure", "no available NSG rule priority", {
    userMessage: "该 NSG 已没有可用规则优先级。",
  });
}

export class AzureAdapter implements ProviderAdapter {
  readonly id = "azure" as const;
  readonly label = "Azure";
  private readonly auth: AzureAuth;
  private subscriptionId?: string;
  private readonly resourceGroup?: string;
  private readonly fetchImpl: FetchLike;

  constructor(ctx: AdapterContext<"azure">) {
    this.fetchImpl = ctx.fetch ?? fetch;
    this.subscriptionId = ctx.credentials.subscriptionId;
    this.resourceGroup = ctx.credentials.resourceGroup;
    this.auth = new AzureAuth(ctx.credentials, this.fetchImpl);
  }

  private async sub(): Promise<string> {
    if (this.subscriptionId) return this.subscriptionId;
    const data = await this.request<
      { value: { subscriptionId: string; state?: string }[] }
    >("GET", "/subscriptions", "2020-01-01");
    const found = data.value.find((item) => item.state === "Enabled") ??
      data.value[0];
    if (!found) {
      throw new ProviderError("azure", "no accessible subscription", {
        userMessage:
          "该服务主体没有可访问的订阅，请确认已为其分配订阅范围的角色。",
      });
    }
    this.subscriptionId = found.subscriptionId;
    return this.subscriptionId;
  }

  private async request<T>(
    method: string,
    path: string,
    apiVersion: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.auth.getAccessToken();
    const separator = path.includes("?") ? "&" : "?";
    return await requestJson<T>(
      this.fetchImpl,
      "azure",
      `${BASE}${path}${separator}api-version=${apiVersion}`,
      {
        method,
        headers: { authorization: `Bearer ${token}` },
        body,
      },
    );
  }

  private requireResourceGroup(locator?: InstanceLocator): string {
    const rg = locator?.resourceGroup ?? this.resourceGroup;
    if (!rg) {
      throw new ValidationError(
        "Azure 操作需要资源组（resourceGroup），请在凭证中设置",
      );
    }
    return rg;
  }

  private vmPath(sub: string, name: string, rg: string): string {
    return `/subscriptions/${sub}/resourceGroups/${rg}` +
      `/providers/Microsoft.Compute/virtualMachines/${name}`;
  }

  private nsgPath(sub: string, rg: string, name: string): string {
    return `/subscriptions/${sub}/resourceGroups/${rg}` +
      `/providers/Microsoft.Network/networkSecurityGroups/${name}`;
  }

  private securityRulePath(nsgId: string, ruleName: string): string {
    return `${nsgId}/securityRules/${encodeURIComponent(ruleName)}`;
  }

  private async primaryNic(
    id: string,
    rg: string,
  ): Promise<{ sub: string; vm: AzureVm; nicId: string; nic: AzureNic }> {
    const sub = await this.sub();
    const vm = await this.request<AzureVm>(
      "GET",
      this.vmPath(sub, id, rg),
      COMPUTE_API,
    );
    if (!vm?.name) throw new NotFoundError(`virtual machine ${id} not found`);
    const nicId = vm.properties?.networkProfile?.networkInterfaces?.[0]?.id;
    if (!nicId) {
      throw new ProviderError("azure", "vm has no network interface", {
        userMessage: "该虚拟机没有可用网卡，无法管理防火墙。",
      });
    }
    const nic = await this.request<AzureNic>("GET", nicId, NETWORK_API);
    return { sub, vm, nicId, nic };
  }

  private async nicNetworkSecurityGroup(
    id: string,
    rg: string,
    create: boolean,
  ): Promise<string | undefined> {
    const { sub, vm, nicId, nic } = await this.primaryNic(id, rg);
    const existing = nic.properties?.networkSecurityGroup?.id;
    if (existing) return existing;
    if (!create) return undefined;
    if (!vm.location || !vm.name) {
      throw new ProviderError("azure", "vm location is missing", {
        userMessage: "无法读取虚拟机区域，无法创建 NSG。",
      });
    }
    const nsgId = this.nsgPath(sub, rg, `${vm.name}-nsg`);
    await this.request("PUT", nsgId, NETWORK_API, {
      location: vm.location,
      properties: { securityRules: [] },
    });
    await this.pollProvisioning(nsgId, NETWORK_API);
    if (!nic.properties) nic.properties = {};
    nic.properties.networkSecurityGroup = { id: nsgId };
    await this.request("PUT", nicId, NETWORK_API, nic);
    await this.pollProvisioning(nicId, NETWORK_API);
    return nsgId;
  }

  capabilities(): Capabilities {
    return {
      create: true,
      start: true,
      stop: true,
      reboot: true,
      delete: true,
      rename: false,
      regions: true,
      ipv6: true,
      firewall: true,
    };
  }

  async listRegions(): Promise<string[]> {
    const sub = await this.sub();
    const data = await this.request<{ value: { name: string }[] }>(
      "GET",
      `/subscriptions/${sub}/locations`,
      "2022-12-01",
    );
    return data.value.map((location) => location.name);
  }

  async listInstances(_opts?: ListOptions): Promise<InstanceList> {
    const sub = await this.sub();
    if (this.resourceGroup) {
      const data = await this.request<{ value: AzureVm[] }>(
        "GET",
        `/subscriptions/${sub}/resourceGroups/${this.resourceGroup}` +
          `/providers/Microsoft.Compute/virtualMachines?$expand=instanceView`,
        COMPUTE_API,
      );
      return { instances: (data.value ?? []).map(mapVm) };
    }
    const data = await this.request<{ value: AzureVm[] }>(
      "GET",
      `/subscriptions/${sub}/providers/Microsoft.Compute/virtualMachines`,
      COMPUTE_API,
    );
    const instances: Instance[] = [];
    for (const vm of data.value ?? []) {
      if (vm.id) {
        try {
          const view = await this.request<{ statuses?: AzureStatus[] }>(
            "GET",
            `${vm.id}/instanceView`,
            COMPUTE_API,
          );
          vm.properties = { ...vm.properties, instanceView: view };
        } catch {
          void 0;
        }
      }
      instances.push(mapVm(vm));
    }
    return { instances };
  }

  async getInstance(id: string, locator?: InstanceLocator): Promise<Instance> {
    const rg = this.requireResourceGroup(locator);
    const sub = await this.sub();
    const raw = await this.request<AzureVm>(
      "GET",
      `${this.vmPath(sub, id, rg)}?$expand=instanceView`,
      COMPUTE_API,
    );
    if (!raw?.name) throw new NotFoundError(`virtual machine ${id} not found`);
    return mapVm(raw);
  }

  async startInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const rg = this.requireResourceGroup(locator);
    const sub = await this.sub();
    await this.request(
      "POST",
      `${this.vmPath(sub, id, rg)}/start`,
      COMPUTE_API,
    );
  }

  async stopInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const rg = this.requireResourceGroup(locator);
    const sub = await this.sub();
    await this.request(
      "POST",
      `${this.vmPath(sub, id, rg)}/deallocate`,
      COMPUTE_API,
    );
  }

  async rebootInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const rg = this.requireResourceGroup(locator);
    const sub = await this.sub();
    await this.request(
      "POST",
      `${this.vmPath(sub, id, rg)}/restart`,
      COMPUTE_API,
    );
  }

  async deleteInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const rg = this.requireResourceGroup(locator);
    const sub = await this.sub();
    await this.request("DELETE", this.vmPath(sub, id, rg), COMPUTE_API);
  }

  renameInstance(): Promise<void> {
    throw new ProviderError(
      "azure",
      "Azure does not support renaming virtual machines",
      {
        userMessage: "Azure 不支持重命名虚拟机。",
      },
    );
  }

  async listFirewallRules(
    id: string,
    locator?: InstanceLocator,
  ): Promise<FirewallRule[]> {
    const rg = this.requireResourceGroup(locator);
    const nsgId = await this.nicNetworkSecurityGroup(id, rg, false);
    if (!nsgId) return [];
    const nsg = await this.request<AzureNetworkSecurityGroup>(
      "GET",
      nsgId,
      NETWORK_API,
    );
    return (nsg.properties?.securityRules ?? [])
      .map(mapSecurityRule)
      .filter((rule) => rule.direction === "Inbound")
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  }

  async addFirewallRule(
    id: string,
    rule: FirewallRuleInput,
    locator?: InstanceLocator,
  ): Promise<FirewallRule> {
    const rg = this.requireResourceGroup(locator);
    const nsgId = await this.nicNetworkSecurityGroup(id, rg, true);
    if (!nsgId) {
      throw new ProviderError("azure", "network security group not found", {
        userMessage: "未找到或创建网卡 NSG。",
      });
    }
    const nsg = await this.request<AzureNetworkSecurityGroup>(
      "GET",
      nsgId,
      NETWORK_API,
    );
    const rules = nsg.properties?.securityRules ?? [];
    const name = rule.name ??
      `debot-${rule.protocol.toLowerCase()}-${rule.port.replace("*", "all")}`;
    const existing = rules.find((item) => item.name === name);
    const priority = existing?.properties?.priority ??
      nextSecurityRulePriority(rules);
    const saved = await this.request<AzureSecurityRule>(
      "PUT",
      this.securityRulePath(nsgId, name),
      NETWORK_API,
      {
        properties: {
          access: "Allow",
          description: rule.description,
          destinationAddressPrefix: "*",
          destinationPortRange: rule.port,
          direction: "Inbound",
          priority,
          protocol: rule.protocol,
          sourceAddressPrefix: rule.source ?? "*",
          sourcePortRange: "*",
        },
      },
    );
    await this.pollProvisioning(nsgId, NETWORK_API);
    return mapSecurityRule(saved);
  }

  async deleteFirewallRule(
    id: string,
    ruleName: string,
    locator?: InstanceLocator,
  ): Promise<void> {
    const rg = this.requireResourceGroup(locator);
    const nsgId = await this.nicNetworkSecurityGroup(id, rg, false);
    if (!nsgId) {
      throw new NotFoundError(
        "network security group not found",
        "未找到网卡 NSG。",
      );
    }
    await this.request(
      "DELETE",
      this.securityRulePath(nsgId, ruleName),
      NETWORK_API,
    );
    await this.pollProvisioning(nsgId, NETWORK_API);
  }

  async addPublicIpv6(id: string, locator?: InstanceLocator): Promise<string> {
    const rg = this.requireResourceGroup(locator);
    const sub = await this.sub();
    const vm = await this.request<AzureVm>(
      "GET",
      this.vmPath(sub, id, rg),
      COMPUTE_API,
    );
    if (!vm?.name) throw new NotFoundError(`virtual machine ${id} not found`);
    const location = vm.location;
    const nicId = vm.properties?.networkProfile?.networkInterfaces?.[0]?.id;
    if (!location || !nicId) {
      throw new ProviderError("azure", "vm has no network interface", {
        userMessage: "该虚拟机没有可用网卡，无法添加 IPv6。",
      });
    }

    let nic = await this.request<AzureNic>("GET", nicId, NETWORK_API);
    const subnetId = nic.properties?.ipConfigurations?.[0]?.properties?.subnet
      ?.id;
    if (!subnetId) {
      throw new ProviderError("azure", "no subnet on nic", {
        userMessage: "未找到网卡所在子网，无法添加 IPv6。",
      });
    }
    const parsed = subnetId.match(
      /virtualNetworks\/([^/]+)\/subnets\/([^/]+)/i,
    );
    if (!parsed) {
      throw new ProviderError("azure", "cannot parse subnet id", {
        userMessage: "无法解析子网信息，无法添加 IPv6。",
      });
    }
    const vnetName = parsed[1];
    const subnetName = parsed[2];
    const vnetPath = `/subscriptions/${sub}/resourceGroups/${rg}` +
      `/providers/Microsoft.Network/virtualNetworks/${vnetName}`;

    const vnet = await this.request<AzureVnet>("GET", vnetPath, NETWORK_API);
    const space = vnet.properties?.addressSpace?.addressPrefixes ?? [];
    if (!space.some((prefix) => prefix.includes(":"))) {
      space.push(IPV6_VNET_PREFIX);
    }
    if (vnet.properties?.addressSpace) {
      vnet.properties.addressSpace.addressPrefixes = space;
    }
    const subnet = vnet.properties?.subnets?.find((item) =>
      item.name === subnetName
    );
    if (!subnet?.properties) {
      throw new ProviderError("azure", "subnet not found in vnet", {
        userMessage: "在虚拟网络中找不到对应子网，无法添加 IPv6。",
      });
    }
    const v4 = subnet.properties.addressPrefix ??
      (subnet.properties.addressPrefixes ?? []).find((p) => !p.includes(":"));
    if (!v4) {
      throw new ProviderError("azure", "subnet has no ipv4 prefix", {
        userMessage: "读不到子网现有 IPv4 段，已中止以免破坏 IPv4。",
      });
    }
    subnet.properties.addressPrefixes = Array.from(
      new Set([v4, IPV6_SUBNET_PREFIX]),
    );
    delete subnet.properties.addressPrefix;
    await this.request("PUT", vnetPath, NETWORK_API, vnet);
    await this.pollProvisioning(vnetPath, NETWORK_API);

    const pipName = `${vm.name}-ipv6`;
    const pipPath = `/subscriptions/${sub}/resourceGroups/${rg}` +
      `/providers/Microsoft.Network/publicIPAddresses/${pipName}`;
    await this.request("PUT", pipPath, NETWORK_API, {
      location,
      sku: { name: "Standard" },
      properties: {
        publicIPAllocationMethod: "Static",
        publicIPAddressVersion: "IPv6",
      },
    });
    await this.pollProvisioning(pipPath, NETWORK_API);

    nic = await this.request<AzureNic>("GET", nicId, NETWORK_API);
    const configs = nic.properties?.ipConfigurations ?? [];
    if (!configs.some((cfg) => cfg.name === "ipv6config")) {
      configs.push({
        name: "ipv6config",
        properties: {
          privateIPAddressVersion: "IPv6",
          primary: false,
          subnet: { id: subnetId },
          publicIPAddress: { id: pipPath },
        },
      });
    }
    if (nic.properties) nic.properties.ipConfigurations = configs;
    await this.request("PUT", nicId, NETWORK_API, nic);
    await this.pollProvisioning(nicId, NETWORK_API);

    const pip = await this.request<AzurePublicIp>("GET", pipPath, NETWORK_API);
    const address = pip.properties?.ipAddress;
    if (!address) {
      throw new ProviderError("azure", "ipv6 address not assigned", {
        userMessage: "IPv6 已配置，但未能读取到地址，请稍后在面板查看。",
      });
    }
    return address;
  }

  private async pollProvisioning(
    path: string,
    apiVersion: string,
  ): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const res = await this.request<
        { properties?: { provisioningState?: string } }
      >("GET", path, apiVersion);
      const state = res.properties?.provisioningState;
      if (state === "Succeeded") return;
      if (state === "Failed") {
        throw new ProviderError("azure", `provisioning failed: ${path}`, {
          userMessage: "Azure 资源置备失败，请稍后重试。",
        });
      }
      await delay(2000);
    }
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    const rg = this.resourceGroup;
    if (!rg) {
      throw new ValidationError("Azure 创建虚拟机需要资源组（resourceGroup）");
    }
    const location = input.region;
    if (!location) {
      throw new ValidationError("Azure 需要区域（region/location）");
    }
    if (!input.sshKeyId) {
      throw new ValidationError(
        "Azure 需要 SSH 公钥（在预设的「SSH密钥」字段填写 ssh-rsa 公钥）",
      );
    }
    const name = input.name ?? `debot-${Date.now()}`;
    const imageRef = parseImageReference(input.image);
    const sub = await this.sub();
    const base = `/subscriptions/${sub}/resourceGroups/${rg}/providers`;

    const pipName = `${name}-ip`;
    const pip = await this.request<{ id: string }>(
      "PUT",
      `${base}/Microsoft.Network/publicIPAddresses/${pipName}`,
      NETWORK_API,
      {
        location,
        sku: { name: "Standard" },
        properties: { publicIPAllocationMethod: "Static" },
      },
    );

    const vnetName = "debot-vnet";
    await this.request(
      "PUT",
      `${base}/Microsoft.Network/virtualNetworks/${vnetName}`,
      NETWORK_API,
      {
        location,
        properties: {
          addressSpace: { addressPrefixes: ["10.20.0.0/16"] },
          subnets: [
            { name: "default", properties: { addressPrefix: "10.20.0.0/24" } },
          ],
        },
      },
    );
    const subnetId =
      `${base}/Microsoft.Network/virtualNetworks/${vnetName}/subnets/default`;

    const nicName = `${name}-nic`;
    const nic = await this.request<{ id: string }>(
      "PUT",
      `${base}/Microsoft.Network/networkInterfaces/${nicName}`,
      NETWORK_API,
      {
        location,
        properties: {
          ipConfigurations: [
            {
              name: "ipconfig1",
              properties: {
                subnet: { id: subnetId },
                publicIPAddress: { id: pip.id },
              },
            },
          ],
        },
      },
    );

    await this.request("PUT", this.vmPath(sub, name, rg), COMPUTE_API, {
      location,
      tags: input.tags,
      properties: {
        hardwareProfile: { vmSize: input.size },
        storageProfile: {
          imageReference: imageRef,
          osDisk: {
            createOption: "FromImage",
            managedDisk: { storageAccountType: "Standard_LRS" },
          },
        },
        osProfile: {
          computerName: name,
          adminUsername: "azureuser",
          linuxConfiguration: {
            disablePasswordAuthentication: true,
            ssh: {
              publicKeys: [
                {
                  path: "/home/azureuser/.ssh/authorized_keys",
                  keyData: input.sshKeyId,
                },
              ],
            },
          },
          customData: input.userData ? btoa(input.userData) : undefined,
        },
        networkProfile: {
          networkInterfaces: [{ id: nic.id }],
        },
      },
    });

    return {
      id: name,
      name,
      state: "pending",
      region: location,
      size: input.size,
      image: input.image,
    };
  }
}

function parseImageReference(image: string): Record<string, string> {
  const parts = image.split(":");
  if (parts.length === 4) {
    return {
      publisher: parts[0],
      offer: parts[1],
      sku: parts[2],
      version: parts[3],
    };
  }
  throw new ValidationError(
    "Azure 镜像格式必须为 publisher:offer:sku:version（例如 Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest）",
  );
}
