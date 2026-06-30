import {
  NotFoundError,
  ProviderError,
  ValidationError,
} from "../../../shared/errors.ts";
import type { FetchLike } from "../../http.ts";
import type {
  AdapterContext,
  Capabilities,
  CatalogBlueprint,
  CatalogBundle,
  CreateInstanceInput,
  Instance,
  InstanceList,
  InstanceLocator,
  InstanceState,
  ListOptions,
  ProviderAdapter,
  SubscriptionBalance,
} from "../../types.ts";
import { AwsBillingClient } from "./billing.ts";
import { signedFetch } from "./client.ts";

const TARGET_PREFIX = "Lightsail_20161128";

interface LsInstance {
  name: string;
  state?: { name?: string };
  location?: { regionName?: string; availabilityZone?: string };
  bundleId?: string;
  blueprintId?: string;
  publicIpAddress?: string;
  privateIpAddress?: string;
  createdAt?: number;
  ipv6Addresses?: string[];
}

interface LsBundle {
  bundleId?: string;
  name?: string;
  cpuCount?: number;
  ramSizeInGb?: number;
  diskSizeInGb?: number;
  transferPerMonthInGb?: number;
  price?: number;
  isActive?: boolean;
  supportedPlatforms?: string[];
}

interface LsBlueprint {
  blueprintId?: string;
  name?: string;
  group?: string;
  type?: string;
  platform?: string;
  version?: string;
  description?: string;
  isActive?: boolean;
}

function mapState(name: string | undefined): InstanceState {
  switch (name) {
    case "running":
      return "running";
    case "pending":
      return "pending";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "terminated":
      return "terminated";
    default:
      return "unknown";
  }
}

function mapInstance(raw: LsInstance): Instance {
  const ipv6 = raw.ipv6Addresses?.[0];
  return {
    id: raw.name,
    name: raw.name,
    state: mapState(raw.state?.name),
    region: raw.location?.regionName,
    zone: raw.location?.availabilityZone,
    size: raw.bundleId,
    image: raw.blueprintId,
    publicIp: raw.publicIpAddress,
    publicIpv6: ipv6,
    privateIp: raw.privateIpAddress,
    createdAt: raw.createdAt
      ? new Date(raw.createdAt * 1000).toISOString()
      : undefined,
  };
}

export class LightsailAdapter implements ProviderAdapter {
  readonly id = "aws" as const;
  readonly label = "AWS Lightsail";
  private readonly region: string;
  private readonly fetchImpl: FetchLike;
  private readonly credentials: AdapterContext<"aws">["credentials"];
  private readonly billing: AwsBillingClient;

  constructor(ctx: AdapterContext<"aws">) {
    this.fetchImpl = ctx.fetch ?? fetch;
    this.region = ctx.defaultRegion ?? "us-east-1";
    this.credentials = ctx.credentials;
    this.billing = new AwsBillingClient(ctx);
  }

  private async call<T>(operation: string, payload: unknown = {}): Promise<T> {
    const body = JSON.stringify(payload);
    const url = `https://lightsail.${this.region}.amazonaws.com/`;
    const response = await signedFetch(this.fetchImpl, {
      credentials: this.credentials,
      region: this.region,
      service: "lightsail",
      method: "POST",
      url,
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `${TARGET_PREFIX}.${operation}`,
      },
      body,
    });
    const text = await response.text();
    const data = text.trim().length > 0 ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = data.message ?? data.Message ?? `HTTP ${response.status}`;
      throw new ProviderError("aws", String(message), {
        status: response.status,
        userMessage: `AWS Lightsail error: ${message}`,
      });
    }
    return data as T;
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
      regionAvailability: false,
      balance: true,
      subscriptionInfo: false,
      ipv6: true,
      firewall: false,
      customCreate: true,
    };
  }

  getSubscriptionBalance(): Promise<SubscriptionBalance> {
    return this.billing.getSubscriptionBalance();
  }

  async listRegions(): Promise<string[]> {
    const data = await this.call<{ regions: { name: string }[] }>("GetRegions");
    return data.regions.map((region) => region.name);
  }

  async listInstances(_opts?: ListOptions): Promise<InstanceList> {
    const data = await this.call<{ instances: LsInstance[] }>("GetInstances");
    return { instances: (data.instances ?? []).map(mapInstance) };
  }

  async getInstance(id: string, _locator?: InstanceLocator): Promise<Instance> {
    const data = await this.call<{ instance: LsInstance }>("GetInstance", {
      instanceName: id,
    });
    if (!data?.instance) throw new NotFoundError(`instance ${id} not found`);
    return mapInstance(data.instance);
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    const availabilityZone = input.zone ?? `${input.region ?? this.region}a`;
    const name = input.name ?? `debot-${Date.now()}`;
    await this.call("CreateInstances", {
      instanceNames: [name],
      availabilityZone,
      blueprintId: input.image,
      bundleId: input.size,
      keyPairName: input.sshKeyId,
      userData: input.userData,
    });
    return {
      id: name,
      name,
      state: "pending",
      region: input.region ?? this.region,
      zone: availabilityZone,
      size: input.size,
      image: input.image,
    };
  }

  async startInstance(id: string): Promise<void> {
    await this.call("StartInstance", { instanceName: id });
  }

  async stopInstance(id: string): Promise<void> {
    await this.call("StopInstance", { instanceName: id });
  }

  async rebootInstance(id: string): Promise<void> {
    await this.call("RebootInstance", { instanceName: id });
  }

  async deleteInstance(id: string): Promise<void> {
    await this.call("DeleteInstance", { instanceName: id });
  }

  renameInstance(): Promise<void> {
    throw new ValidationError(
      "AWS Lightsail 不支持重命名实例",
    );
  }

  async listBundles(): Promise<CatalogBundle[]> {
    const data = await this.call<{ bundles: LsBundle[] }>("GetBundles", {
      includeInactive: false,
    });
    return (data.bundles ?? [])
      .filter((bundle) => bundle.isActive !== false)
      .map((bundle) => ({
        id: bundle.bundleId ?? "",
        name: bundle.name ?? bundle.bundleId ?? "",
        cpuCount: bundle.cpuCount,
        ramSizeInGb: bundle.ramSizeInGb,
        diskSizeInGb: bundle.diskSizeInGb,
        transferPerMonthInGb: bundle.transferPerMonthInGb,
        price: bundle.price,
      }));
  }

  async listBlueprints(): Promise<CatalogBlueprint[]> {
    const data = await this.call<{ blueprints: LsBlueprint[] }>(
      "GetBlueprints",
      { includeInactive: false },
    );
    return (data.blueprints ?? [])
      .filter((bp) => bp.isActive !== false)
      .map((bp) => ({
        id: bp.blueprintId ?? "",
        name: bp.name ?? bp.blueprintId ?? "",
        group: bp.group,
        type: bp.type,
        platform: bp.platform,
        version: bp.version,
        description: bp.description,
      }));
  }

  async addPublicIpv6(id: string, _locator?: InstanceLocator): Promise<string> {
    const existing = await this.call<{ instance: LsInstance }>(
      "GetInstance",
      { instanceName: id },
    );
    const current = existing?.instance?.ipv6Addresses?.[0];
    if (current) return current;

    await this.call("EnableAddOn", {
      resourceName: id,
      addOnRequest: { addOnType: "ipv6" },
    });

    await this.call("SetIpAddressType", {
      resourceName: id,
      resourceType: "Instance",
      ipAddressType: "dualstack",
      acceptBundleUpdate: true,
    });

    for (let attempt = 0; attempt < 12; attempt++) {
      const data = await this.call<{ instance: LsInstance }>(
        "GetInstance",
        { instanceName: id },
      );
      const address = data?.instance?.ipv6Addresses?.[0];
      if (address) return address;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new ProviderError("aws", "ipv6 address not assigned", {
      userMessage: "IPv6 已启用，但未能读取到地址，请稍后在面板查看。",
    });
  }
}
