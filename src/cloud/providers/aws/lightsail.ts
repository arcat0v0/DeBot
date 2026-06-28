import {
  NotFoundError,
  ProviderError,
  ValidationError,
} from "../../../shared/errors.ts";
import type { FetchLike } from "../../http.ts";
import type {
  AdapterContext,
  Capabilities,
  CreateInstanceInput,
  Instance,
  InstanceList,
  InstanceLocator,
  InstanceState,
  ListOptions,
  ProviderAdapter,
} from "../../types.ts";
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
  return {
    id: raw.name,
    name: raw.name,
    state: mapState(raw.state?.name),
    region: raw.location?.regionName,
    zone: raw.location?.availabilityZone,
    size: raw.bundleId,
    image: raw.blueprintId,
    publicIp: raw.publicIpAddress,
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

  constructor(ctx: AdapterContext<"aws">) {
    this.fetchImpl = ctx.fetch ?? fetch;
    this.region = ctx.defaultRegion ?? "us-east-1";
    this.credentials = ctx.credentials;
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
    };
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
}
