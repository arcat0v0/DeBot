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
  DefaultCreateOption,
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
  RegionAvailability,
  RegionInfo,
  SubscriptionBalance,
  SubscriptionInfo,
} from "../../types.ts";
import { AzureAuth } from "./auth.ts";

const BASE = "https://management.azure.com";
const COMPUTE_API = "2023-09-01";
const DISK_API = "2023-10-02";
const NETWORK_API = "2023-09-01";
const SUBSCRIPTION_API = "2022-12-01";
const RESOURCE_GROUP_API = "2022-09-01";
const RESOURCE_SKU_API = "2023-09-01";
const COST_MANAGEMENT_API = "2025-03-01";
const BILLING_API = "2024-04-01";
const BILLING_ACCOUNT_EXPAND_API = "2019-10-01-preview";
const CONSUMPTION_API = "2024-08-01";
const CONSUMPTION_CREDITS_API = "2023-03-01";
const AZURE_STUDENT_FREE_SIZES = [
  "Standard_B1s",
  "Standard_B2ats_v2",
  "Standard_B2pts_v2",
];
const AZURE_STUDENT_REGION_PREFERENCE = [
  "indonesiacentral",
  "southeastasia",
  "eastasia",
  "japaneast",
  "japanwest",
  "koreacentral",
  "centralindia",
  "australiaeast",
  "westus2",
  "canadacentral",
  "francecentral",
  "swedencentral",
];
const AZURE_STUDENT_DEFAULT_RG = "debot";
const AZURE_STUDENT_DEFAULT_IMAGE =
  "Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest";
const AZURE_STUDENT_ARM_IMAGE =
  "Canonical:0001-com-ubuntu-server-jammy:22_04-lts-arm64:latest";
const AZURE_STUDENT_OS_DISK_SIZE_GB = 64;
const AZURE_STUDENT_OS_DISK_STORAGE = "Premium_LRS";

type CreditLines = NonNullable<SubscriptionBalance["credit"]>;

interface AzureStatus {
  code?: string;
}

interface AzureSubscription {
  subscriptionId?: string;
  displayName?: string;
  state?: string;
  tenantId?: string;
  authorizationSource?: string;
  subscriptionPolicies?: {
    locationPlacementId?: string;
    quotaId?: string;
    spendingLimit?: string;
  };
}

interface AzureLocation {
  name?: string;
  displayName?: string;
  regionalDisplayName?: string;
  metadata?: {
    regionCategory?: string;
    regionType?: string;
    geographyGroup?: string;
  };
}

interface AzureSkuRestriction {
  type?: string;
  values?: string[];
  reasonCode?: string;
  restrictionInfo?: { locations?: string[]; zones?: string[] };
}

interface AzureResourceSku {
  name?: string;
  resourceType?: string;
  locations?: string[];
  locationInfo?: { location?: string; zones?: string[] }[];
  restrictions?: AzureSkuRestriction[];
}

interface AzureResourceSkuPage {
  value?: AzureResourceSku[];
  nextLink?: string;
}

interface AzureMoney {
  amount?: number;
  value?: number;
  currency?: string;
}

interface AzureCreditSummary {
  properties?: {
    balanceSummary?: {
      availableBalance?: AzureMoney;
      currentBalance?: AzureMoney;
      estimatedBalance?: AzureMoney;
    };
    billingCurrency?: string;
    creditCurrency?: string;
  };
  balanceSummary?: {
    availableBalance?: AzureMoney;
    currentBalance?: AzureMoney;
    estimatedBalance?: AzureMoney;
  };
}

interface AzureCreditLot {
  properties?: {
    closedBalance?: AzureMoney;
    originalAmount?: AzureMoney;
    source?: string;
    status?: string;
  };
}

interface AzureLegacyBalance {
  properties?: {
    beginningBalance?: number;
    endingBalance?: number;
    totalUsage?: number;
    utilized?: number;
    currency?: string;
  };
}

interface AzureBillingProfile {
  name?: string;
  displayName?: string;
  properties?: {
    displayName?: string;
    currency?: string;
    hasReadAccess?: boolean;
  };
}

interface AzureBillingAccount {
  name?: string;
  displayName?: string;
  properties?: {
    displayName?: string;
    billingProfiles?: AzureBillingProfile[];
  };
}

interface AzureResourceGroup {
  name?: string;
  location?: string;
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
      osDisk?: { managedDisk?: { id?: string } };
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

function inferStudentSubscription(sub: AzureSubscription): {
  isStudent: boolean;
  reason?: string;
} {
  const haystack = [
    sub.displayName,
    sub.subscriptionPolicies?.quotaId,
    sub.subscriptionPolicies?.spendingLimit,
  ].filter(Boolean).join(" ").toLowerCase();
  if (haystack.includes("student")) {
    return { isStudent: true, reason: "订阅字段包含 student" };
  }
  if (haystack.includes("ms-azr-0170") || haystack.includes("0170p")) {
    return { isStudent: true, reason: "订阅 offer 与 Azure for Students 匹配" };
  }
  return { isStudent: false };
}

function mapSubscription(raw: AzureSubscription): SubscriptionInfo {
  const inferred = inferStudentSubscription(raw);
  return {
    id: raw.subscriptionId ?? "",
    displayName: raw.displayName,
    state: raw.state,
    tenantId: raw.tenantId,
    authorizationSource: raw.authorizationSource,
    quotaId: raw.subscriptionPolicies?.quotaId,
    spendingLimit: raw.subscriptionPolicies?.spendingLimit,
    isStudent: inferred.isStudent,
    studentReason: inferred.reason,
  };
}

function mapLocation(raw: AzureLocation): RegionInfo {
  return {
    name: raw.name ?? "",
    displayName: raw.displayName,
    regionalDisplayName: raw.regionalDisplayName,
    regionCategory: raw.metadata?.regionCategory,
    regionType: raw.metadata?.regionType,
    geographyGroup: raw.metadata?.geographyGroup,
  };
}

function azureMoneyAmount(value?: AzureMoney): number | undefined {
  return value?.amount ?? value?.value;
}

function azureMoneyCurrency(
  value?: AzureMoney,
  fallback?: string,
): string | undefined {
  return value?.currency?.trim() || fallback?.trim() || undefined;
}

function creditLine(
  name: string,
  amount: number | undefined,
  currency?: string,
): CreditLines {
  if (amount === undefined) return [];
  return [{ name, amount, currency: currency?.trim() || undefined }];
}

function errorSummary(error: unknown): string {
  if (error instanceof ProviderError && error.status === 403) {
    return `权限不足：${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

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

function restrictionAppliesToLocation(
  restriction: AzureSkuRestriction,
  location: string,
): boolean {
  const normalized = location.toLowerCase();
  const values = restriction.values ?? [];
  const locations = restriction.restrictionInfo?.locations ?? [];
  if (values.length === 0 && locations.length === 0) return true;
  return values.some((value) => value.toLowerCase() === normalized) ||
    locations.some((value) => value.toLowerCase() === normalized);
}

function skuAvailableInLocation(
  sku: AzureResourceSku,
  location: string,
): boolean {
  if (sku.resourceType !== "virtualMachines") return false;
  const normalized = location.toLowerCase();
  const locations = new Set([
    ...(sku.locations ?? []),
    ...((sku.locationInfo ?? []).map((item) => item.location).filter(
      (item): item is string => Boolean(item),
    )),
  ].map((item) => item.toLowerCase()));
  if (!locations.has(normalized)) return false;
  for (const restriction of sku.restrictions ?? []) {
    if (
      restriction.reasonCode === "NotAvailableForSubscription" &&
      restriction.type === "Location" &&
      restrictionAppliesToLocation(restriction, location)
    ) {
      return false;
    }
  }
  return true;
}

function azureStudentImageForSize(size: string): string {
  return size.toLowerCase().includes("pts")
    ? AZURE_STUDENT_ARM_IMAGE
    : AZURE_STUDENT_DEFAULT_IMAGE;
}

function regionPreferenceIndex(region: string): number {
  const index = AZURE_STUDENT_REGION_PREFERENCE.indexOf(region.toLowerCase());
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export class AzureAdapter implements ProviderAdapter {
  readonly id = "azure" as const;
  readonly label = "Azure";
  private readonly auth: AzureAuth;
  private subscriptionId?: string;
  private readonly resourceGroup?: string;
  private readonly fetchImpl: FetchLike;
  private inferredResourceGroup?: string;

  constructor(ctx: AdapterContext<"azure">) {
    this.fetchImpl = ctx.fetch ?? fetch;
    this.subscriptionId = ctx.credentials.subscriptionId;
    this.resourceGroup = ctx.credentials.resourceGroup;
    this.auth = new AzureAuth(ctx.credentials, this.fetchImpl);
  }

  private async sub(): Promise<string> {
    if (this.subscriptionId) return this.subscriptionId;
    const data = await this.request<
      { value: AzureSubscription[] }
    >("GET", "/subscriptions", "2020-01-01");
    const found = data.value.find((item) => item.state === "Enabled") ??
      data.value[0];
    if (!found) {
      throw new ProviderError("azure", "no accessible subscription", {
        userMessage:
          "该服务主体没有可访问的订阅，请确认已为其分配订阅范围的角色。",
      });
    }
    if (!found.subscriptionId) {
      throw new ProviderError("azure", "subscription id missing", {
        userMessage: "Azure 返回的订阅缺少 subscriptionId。",
      });
    }
    this.subscriptionId = found.subscriptionId;
    return this.subscriptionId;
  }

  private async subscription(): Promise<AzureSubscription> {
    const sub = await this.sub();
    return await this.request<AzureSubscription>(
      "GET",
      `/subscriptions/${sub}`,
      SUBSCRIPTION_API,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    apiVersion: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.auth.getAccessToken();
    const separator = path.includes("?") ? "&" : "?";
    return await this.requestUrl<T>(
      method,
      `${BASE}${path}${separator}api-version=${apiVersion}`,
      body,
      token,
    );
  }

  private async requestUrl<T>(
    method: string,
    url: string,
    body?: unknown,
    accessToken?: string,
  ): Promise<T> {
    const token = accessToken ?? await this.auth.getAccessToken();
    return await requestJson<T>(
      this.fetchImpl,
      "azure",
      url,
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

  private resourceGroupPath(sub: string, rg: string): string {
    return `/subscriptions/${sub}/resourceGroups/${rg}`;
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

  private async ensureResourceGroup(
    sub: string,
    rg: string,
    location: string,
  ): Promise<void> {
    try {
      await this.request(
        "GET",
        this.resourceGroupPath(sub, rg),
        RESOURCE_GROUP_API,
      );
      return;
    } catch (error) {
      if (!(error instanceof ProviderError) || error.status !== 404) {
        throw error;
      }
    }
    await this.request(
      "PUT",
      this.resourceGroupPath(sub, rg),
      RESOURCE_GROUP_API,
      { location },
    );
  }

  private async defaultResourceGroup(): Promise<string> {
    if (this.resourceGroup) return this.resourceGroup;
    if (this.inferredResourceGroup) return this.inferredResourceGroup;
    try {
      const sub = await this.sub();
      const data = await this.request<{ value?: AzureResourceGroup[] }>(
        "GET",
        `/subscriptions/${sub}/resourcegroups`,
        RESOURCE_GROUP_API,
      );
      const groups = (data.value ?? [])
        .map((group) => group.name)
        .filter((name): name is string => Boolean(name));
      if (groups.length === 1) {
        this.inferredResourceGroup = groups[0];
        return groups[0];
      }
    } catch {
      void 0;
    }
    return AZURE_STUDENT_DEFAULT_RG;
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
      regionAvailability: true,
      balance: true,
      subscriptionInfo: true,
      ipv6: true,
      firewall: true,
      customCreate: true,
    };
  }

  async listRegions(): Promise<string[]> {
    return (await this.listRegionInfo()).map((location) => location.name);
  }

  async listRegionInfo(): Promise<RegionInfo[]> {
    const sub = await this.sub();
    const data = await this.request<{ value: AzureLocation[] }>(
      "GET",
      `/subscriptions/${sub}/locations`,
      SUBSCRIPTION_API,
    );
    return data.value.map(mapLocation).filter((location) =>
      location.name.length > 0
    );
  }

  private async listResourceSkus(
    names?: readonly string[],
  ): Promise<AzureResourceSku[]> {
    const sub = await this.sub();
    let url: string | undefined =
      `${BASE}/subscriptions/${sub}/providers/Microsoft.Compute/skus?api-version=${RESOURCE_SKU_API}`;
    const wantedNames = names ? new Set(names) : undefined;
    const out: AzureResourceSku[] = [];
    while (url) {
      const page: AzureResourceSkuPage = await this.requestUrl<
        AzureResourceSkuPage
      >("GET", url);
      for (const sku of page.value ?? []) {
        if (sku.resourceType !== "virtualMachines" || !sku.name) continue;
        if (wantedNames && !wantedNames.has(sku.name)) continue;
        out.push(sku);
      }
      url = page.nextLink;
    }
    return out;
  }

  async listRegionAvailability(
    sizes = AZURE_STUDENT_FREE_SIZES,
  ): Promise<RegionAvailability[]> {
    const [regions, skus] = await Promise.all([
      this.listRegionInfo(),
      this.listResourceSkus(sizes),
    ]);
    const skuMap = new Map<string, AzureResourceSku[]>();
    for (const sku of skus) {
      const list = skuMap.get(sku.name!) ?? [];
      list.push(sku);
      skuMap.set(sku.name!, list);
    }
    return regions.map((region) => {
      const availableSizes = sizes.filter((size) => {
        const entries = skuMap.get(size) ?? [];
        return entries.some((sku) => skuAvailableInLocation(sku, region.name));
      });
      return {
        region: region.name,
        displayName: region.displayName,
        availableSizes,
        restrictedSizes: sizes.filter((size) => !availableSizes.includes(size)),
      };
    });
  }

  async getSubscriptionInfo(): Promise<SubscriptionInfo> {
    return mapSubscription(await this.subscription());
  }

  async getSubscriptionBalance(): Promise<SubscriptionBalance> {
    const sub = await this.sub();
    const warnings: string[] = [];
    const credit = await this.tryCreditBalance(warnings);
    const cost = await this.tryMonthToDateCost(sub, warnings);
    return {
      subscriptionId: sub,
      currency: credit.currency ?? cost.currency,
      credit: credit.lines,
      monthToDateCost: cost.amount,
      warnings,
    };
  }

  async selectDefaultCreateOption(
    region?: string,
  ): Promise<DefaultCreateOption> {
    const availability = await this.listRegionAvailability(
      AZURE_STUDENT_FREE_SIZES,
    );
    const candidates = region
      ? availability.filter((item) => item.region === region)
      : [...availability].sort((a, b) =>
        regionPreferenceIndex(a.region) - regionPreferenceIndex(b.region)
      );
    const found = candidates.find((item) => item.availableSizes.length > 0);
    if (!found) {
      throw new ProviderError("azure", "no free student vm size available", {
        userMessage:
          "当前订阅没有找到可用的 Azure 学生免费规格区域，请先查看「免费规格区域」或手动选择规格。",
      });
    }
    const size = AZURE_STUDENT_FREE_SIZES.find((item) =>
      found.availableSizes.includes(item)
    )!;
    return {
      region: found.region,
      size,
      image: azureStudentImageForSize(size),
      resourceGroup: await this.defaultResourceGroup(),
      osDiskSizeGb: AZURE_STUDENT_OS_DISK_SIZE_GB,
      osDiskStorageAccountType: AZURE_STUDENT_OS_DISK_STORAGE,
    };
  }

  private async tryCreditBalance(
    warnings: string[],
  ): Promise<{ currency?: string; lines?: SubscriptionBalance["credit"] }> {
    const errors: string[] = [];
    let accounts: AzureBillingAccount[] = [];
    try {
      const response = await this.requestUrl<{ value?: AzureBillingAccount[] }>(
        "GET",
        `${BASE}/providers/Microsoft.Billing/billingAccounts?api-version=${BILLING_ACCOUNT_EXPAND_API}&$expand=billingProfiles`,
      );
      accounts = response.value ?? [];
    } catch (error) {
      errors.push(`账单账户列表：${errorSummary(error)}`);
    }

    const lines: CreditLines = [];
    let currency: string | undefined;
    for (const account of accounts) {
      if (!account.name) continue;
      const accountLabel = account.properties?.displayName ??
        account.displayName ?? account.name;

      const legacy = await this.tryLegacyBillingBalance(account, errors);
      for (const line of legacy.lines ?? []) {
        currency ??= line.currency;
        lines.push(line);
      }

      const profiles = await this.billingProfilesForAccount(account, errors);
      for (const profile of profiles) {
        if (!profile.name) continue;
        const profileLabel = profile.properties?.displayName ??
          profile.displayName ?? profile.name;
        const lotLines = await this.tryCreditLots(
          account.name,
          profile.name,
          `${profileLabel} 可用余额`,
          errors,
        );
        const summaryLines = lotLines.length > 0 ? [] : await this
          .tryCreditSummary(
            account.name,
            profile.name,
            profileLabel,
            profile.properties?.currency,
            errors,
          );
        const collected = lotLines.length > 0 ? lotLines : summaryLines;
        for (const line of collected) {
          currency ??= line.currency;
          lines.push(line);
        }
      }
      if ((legacy.lines?.length ?? 0) === 0 && profiles.length === 0) {
        errors.push(`${accountLabel}：没有可读取的 billing profile 或余额`);
      }
    }

    if (lines.length === 0) {
      const detail = dedupeStrings(errors).slice(0, 2).join("；");
      warnings.push(
        detail
          ? `无法读取 Azure 信用余额：${detail}`
          : "无法读取 Azure 信用余额：当前订阅没有暴露可读取的账单余额接口。",
      );
    }
    return { currency, lines: lines.length > 0 ? lines : undefined };
  }

  private async billingProfilesForAccount(
    account: AzureBillingAccount,
    errors: string[],
  ): Promise<AzureBillingProfile[]> {
    const expanded = account.properties?.billingProfiles ?? [];
    if (expanded.length > 0 || !account.name) return expanded;
    try {
      const profiles = await this.requestUrl<
        { value?: AzureBillingProfile[] }
      >(
        "GET",
        `${BASE}/providers/Microsoft.Billing/billingAccounts/${
          encodeURIComponent(account.name)
        }/billingProfiles?api-version=${BILLING_API}`,
      );
      return profiles.value ?? [];
    } catch (error) {
      errors.push(
        `${account.displayName ?? account.name} billing profiles：${
          errorSummary(error)
        }`,
      );
      return [];
    }
  }

  private async tryLegacyBillingBalance(
    account: AzureBillingAccount,
    errors: string[],
  ): Promise<{ lines?: CreditLines }> {
    if (!account.name) return {};
    try {
      const balance = await this.requestUrl<AzureLegacyBalance>(
        "GET",
        `${BASE}/providers/Microsoft.Billing/billingAccounts/${
          encodeURIComponent(account.name)
        }/providers/Microsoft.Consumption/balances?api-version=${CONSUMPTION_API}`,
      );
      const props = balance.properties;
      const accountLabel = account.properties?.displayName ??
        account.displayName ?? account.name;
      const lines: CreditLines = [
        ...creditLine(
          `${accountLabel} 可用余额`,
          props?.endingBalance,
          props?.currency,
        ),
        ...creditLine(
          `${accountLabel} 本期已使用`,
          props?.utilized ?? props?.totalUsage,
          props?.currency,
        ),
        ...creditLine(
          `${accountLabel} 期初余额`,
          props?.beginningBalance,
          props?.currency,
        ),
      ];
      return { lines: lines.length > 0 ? lines : undefined };
    } catch (error) {
      errors.push(
        `${account.displayName ?? account.name} legacy balance：${
          errorSummary(error)
        }`,
      );
      return {};
    }
  }

  private async tryCreditLots(
    accountName: string,
    profileName: string,
    label: string,
    errors: string[],
  ): Promise<CreditLines> {
    try {
      const lots = await this.requestUrl<{ value?: AzureCreditLot[] }>(
        "GET",
        `${BASE}/providers/Microsoft.Billing/billingAccounts/${
          encodeURIComponent(accountName)
        }/billingProfiles/${
          encodeURIComponent(profileName)
        }/providers/Microsoft.Consumption/lots?api-version=${CONSUMPTION_CREDITS_API}`,
      );
      const totals = new Map<string, number>();
      for (const lot of lots.value ?? []) {
        const amount = azureMoneyAmount(lot.properties?.closedBalance);
        if (amount === undefined) continue;
        const currency = azureMoneyCurrency(lot.properties?.closedBalance) ??
          "UNKNOWN";
        totals.set(currency, (totals.get(currency) ?? 0) + amount);
      }
      return [...totals.entries()]
        .filter(([, amount]) => amount !== 0)
        .map(([currency, amount]) => ({
          name: label,
          amount,
          currency: currency === "UNKNOWN" ? undefined : currency,
        }));
    } catch (error) {
      errors.push(`${profileName} credit lots：${errorSummary(error)}`);
      return [];
    }
  }

  private async tryCreditSummary(
    accountName: string,
    profileName: string,
    profileLabel: string,
    fallbackCurrency: string | undefined,
    errors: string[],
  ): Promise<CreditLines> {
    try {
      const summary = await this.requestUrl<AzureCreditSummary>(
        "GET",
        `${BASE}/providers/Microsoft.Billing/billingAccounts/${
          encodeURIComponent(accountName)
        }/billingProfiles/${
          encodeURIComponent(profileName)
        }/providers/Microsoft.Consumption/credits/balanceSummary?api-version=${CONSUMPTION_API}`,
      );
      const balance = summary.properties?.balanceSummary ??
        summary.balanceSummary;
      const currency = summary.properties?.creditCurrency ??
        summary.properties?.billingCurrency ?? fallbackCurrency;
      const lines: CreditLines = [];
      for (
        const [name, amount] of [
          ["可用余额", balance?.availableBalance],
          ["当前余额", balance?.currentBalance],
          ["预估余额", balance?.estimatedBalance],
        ] as const
      ) {
        const value = azureMoneyAmount(amount);
        if (value === undefined) continue;
        lines.push({
          name: `${profileLabel} ${name}`,
          amount: value,
          currency: azureMoneyCurrency(amount, currency),
        });
      }
      return lines;
    } catch (error) {
      errors.push(`${profileName} credit summary：${errorSummary(error)}`);
      return [];
    }
  }

  private async tryMonthToDateCost(
    sub: string,
    warnings: string[],
  ): Promise<{ amount?: number; currency?: string }> {
    try {
      const data = await this.request<
        {
          properties?: {
            columns?: { name?: string }[];
            rows?: unknown[][];
          };
        }
      >(
        "POST",
        `/subscriptions/${sub}/providers/Microsoft.CostManagement/query`,
        COST_MANAGEMENT_API,
        {
          type: "Usage",
          timeframe: "MonthToDate",
          dataset: {
            granularity: "None",
            aggregation: {
              totalCost: { name: "PreTaxCost", function: "Sum" },
            },
          },
        },
      );
      const columns = data.properties?.columns ?? [];
      const row = data.properties?.rows?.[0] ?? [];
      const costIndex = columns.findIndex((item) =>
        item.name?.toLowerCase().includes("cost")
      );
      const currencyIndex = columns.findIndex((item) =>
        item.name?.toLowerCase().includes("currency")
      );
      const amount = typeof row[costIndex] === "number"
        ? row[costIndex]
        : undefined;
      const currency = typeof row[currencyIndex] === "string"
        ? row[currencyIndex]
        : undefined;
      return { amount, currency };
    } catch (error) {
      const message = error instanceof ProviderError && error.status === 403
        ? `当前服务主体没有 Cost Management Query 权限；请在订阅或账单范围授予 Cost Management Reader 后重试。原始错误：${error.message}`
        : error instanceof Error
        ? error.message
        : String(error);
      warnings.push(
        `无法读取本月成本：${message}`,
      );
      return {};
    }
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
    const path = this.vmPath(sub, id, rg);
    const vm = await this.request<AzureVm>("GET", path, COMPUTE_API);
    const nicIds = (vm.properties?.networkProfile?.networkInterfaces ?? [])
      .map((nic) => nic.id)
      .filter((nicId): nicId is string => Boolean(nicId));
    const diskId = vm.properties?.storageProfile?.osDisk?.managedDisk?.id;
    const publicIpIds: string[] = [];
    for (const nicId of nicIds) {
      try {
        const nic = await this.request<AzureNic>("GET", nicId, NETWORK_API);
        for (const config of nic.properties?.ipConfigurations ?? []) {
          const pipId = config.properties?.publicIPAddress?.id;
          if (pipId) publicIpIds.push(pipId);
        }
      } catch {
        void 0;
      }
    }
    await this.deleteIfExists(path, COMPUTE_API);
    for (const nicId of nicIds) {
      await this.deleteIfExists(nicId, NETWORK_API);
    }
    for (const pipId of publicIpIds) {
      await this.deleteIfExists(pipId, NETWORK_API);
    }
    if (diskId) await this.deleteIfExists(diskId, DISK_API);
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

  private async waitDeleted(
    path: string,
    apiVersion: string,
  ): Promise<void> {
    for (let i = 0; i < 60; i++) {
      try {
        await this.request("GET", path, apiVersion);
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) return;
        throw error;
      }
      await delay(2000);
    }
  }

  private async deleteIfExists(
    path: string,
    apiVersion: string,
  ): Promise<void> {
    try {
      await this.request("DELETE", path, apiVersion);
      await this.waitDeleted(path, apiVersion);
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return;
      throw error;
    }
  }

  private async bestEffortDelete(
    resources: { path: string; apiVersion: string }[],
  ): Promise<void> {
    for (const resource of resources) {
      try {
        await this.deleteIfExists(resource.path, resource.apiVersion);
      } catch {
        void 0;
      }
    }
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    const rg = input.resourceGroup ?? await this.defaultResourceGroup();
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
    await this.ensureResourceGroup(sub, rg, location);

    const pipName = `${name}-ip`;
    const pipPath = `${base}/Microsoft.Network/publicIPAddresses/${pipName}`;
    const ipv6PipName = `${name}-ipv6`;
    const ipv6PipPath =
      `${base}/Microsoft.Network/publicIPAddresses/${ipv6PipName}`;
    const vnetName = `debot-${location}-vnet`;
    const vnetPath = `${base}/Microsoft.Network/virtualNetworks/${vnetName}`;
    const nicName = `${name}-nic`;
    const nicPath = `${base}/Microsoft.Network/networkInterfaces/${nicName}`;
    const vmCreatePath = this.vmPath(sub, name, rg);
    const diskPath = `${base}/Microsoft.Compute/disks/${name}-osdisk`;
    let vnetExisted = false;
    try {
      await this.request("GET", vnetPath, NETWORK_API);
      vnetExisted = true;
    } catch (error) {
      if (!(error instanceof ProviderError) || error.status !== 404) {
        throw error;
      }
    }

    try {
      const pip = await this.request<{ id: string }>(
        "PUT",
        pipPath,
        NETWORK_API,
        {
          location,
          sku: { name: "Standard" },
          properties: {
            publicIPAllocationMethod: "Static",
            publicIPAddressVersion: "IPv4",
          },
        },
      );
      await this.pollProvisioning(
        pipPath,
        NETWORK_API,
      );

      let ipv6PipId: string | undefined;
      if (input.enableIpv6) {
        const ipv6Pip = await this.request<{ id: string }>(
          "PUT",
          ipv6PipPath,
          NETWORK_API,
          {
            location,
            sku: { name: "Standard" },
            properties: {
              publicIPAllocationMethod: "Static",
              publicIPAddressVersion: "IPv6",
            },
          },
        );
        ipv6PipId = ipv6Pip.id;
        await this.pollProvisioning(
          ipv6PipPath,
          NETWORK_API,
        );
      }

      const subnetProperties = input.enableIpv6
        ? { addressPrefixes: ["10.20.0.0/24", IPV6_SUBNET_PREFIX] }
        : { addressPrefix: "10.20.0.0/24" };
      await this.request(
        "PUT",
        vnetPath,
        NETWORK_API,
        {
          location,
          properties: {
            addressSpace: {
              addressPrefixes: input.enableIpv6
                ? ["10.20.0.0/16", IPV6_VNET_PREFIX]
                : ["10.20.0.0/16"],
            },
            subnets: [
              { name: "default", properties: subnetProperties },
            ],
          },
        },
      );
      await this.pollProvisioning(vnetPath, NETWORK_API);
      const subnetId =
        `${base}/Microsoft.Network/virtualNetworks/${vnetName}/subnets/default`;

      const ipConfigurations = [
        {
          name: "ipconfig1",
          properties: {
            primary: true,
            privateIPAddressVersion: "IPv4",
            subnet: { id: subnetId },
            publicIPAddress: { id: pip.id },
          },
        },
      ];
      if (ipv6PipId) {
        ipConfigurations.push({
          name: "ipv6config",
          properties: {
            primary: false,
            privateIPAddressVersion: "IPv6",
            subnet: { id: subnetId },
            publicIPAddress: { id: ipv6PipId },
          },
        });
      }
      const nic = await this.request<{ id: string }>(
        "PUT",
        nicPath,
        NETWORK_API,
        {
          location,
          properties: {
            ipConfigurations,
          },
        },
      );
      await this.pollProvisioning(nicPath, NETWORK_API);

      await this.request("PUT", vmCreatePath, COMPUTE_API, {
        location,
        tags: input.tags,
        properties: {
          hardwareProfile: { vmSize: input.size },
          storageProfile: {
            imageReference: imageRef,
            osDisk: {
              name: `${name}-osdisk`,
              createOption: "FromImage",
              diskSizeGB: input.osDiskSizeGb,
              managedDisk: {
                storageAccountType: input.osDiskStorageAccountType ??
                  "Standard_LRS",
              },
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
        resourceGroup: rg,
        size: input.size,
        image: input.image,
      };
    } catch (error) {
      await this.bestEffortDelete([
        { path: vmCreatePath, apiVersion: COMPUTE_API },
        { path: nicPath, apiVersion: NETWORK_API },
        { path: ipv6PipPath, apiVersion: NETWORK_API },
        { path: pipPath, apiVersion: NETWORK_API },
        { path: diskPath, apiVersion: DISK_API },
        ...(vnetExisted ? [] : [{ path: vnetPath, apiVersion: NETWORK_API }]),
      ]);
      throw error;
    }
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
