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
  Instance,
  InstanceList,
  InstanceLocator,
  InstanceState,
  ListOptions,
  ProviderAdapter,
} from "../../types.ts";
import { GcpAuth } from "./auth.ts";

const BASE = "https://compute.googleapis.com/compute/v1/projects";

interface GceAccessConfig {
  natIP?: string;
}

interface GceNetworkInterface {
  networkIP?: string;
  accessConfigs?: GceAccessConfig[];
}

interface GceInstance {
  name: string;
  status: string;
  zone?: string;
  machineType?: string;
  networkInterfaces?: GceNetworkInterface[];
  creationTimestamp?: string;
  labels?: Record<string, string>;
}

function lastSegment(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const parts = url.split("/");
  return parts[parts.length - 1];
}

function zoneToRegion(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  return zone.replace(/-[a-z]$/, "");
}

function mapStatus(status: string): InstanceState {
  switch (status) {
    case "RUNNING":
      return "running";
    case "PROVISIONING":
    case "STAGING":
      return "pending";
    case "STOPPING":
      return "stopping";
    case "STOPPED":
    case "SUSPENDED":
    case "SUSPENDING":
      return "stopped";
    case "TERMINATED":
      return "stopped";
    default:
      return "unknown";
  }
}

function mapInstance(raw: GceInstance): Instance {
  const zone = lastSegment(raw.zone);
  const nic = raw.networkInterfaces?.[0];
  return {
    id: raw.name,
    name: raw.name,
    state: mapStatus(raw.status),
    region: zoneToRegion(zone),
    zone,
    size: lastSegment(raw.machineType),
    publicIp: nic?.accessConfigs?.find((config) => config.natIP)?.natIP,
    privateIp: nic?.networkIP,
    createdAt: raw.creationTimestamp,
    tags: raw.labels && Object.keys(raw.labels).length > 0
      ? raw.labels
      : undefined,
  };
}

export class GcpAdapter implements ProviderAdapter {
  readonly id = "gcp" as const;
  readonly label = "Google Cloud";
  private readonly auth: GcpAuth;
  private readonly project: string;
  private readonly fetchImpl: FetchLike;

  constructor(ctx: AdapterContext<"gcp">) {
    this.fetchImpl = ctx.fetch ?? fetch;
    this.project = ctx.credentials.projectId;
    this.auth = new GcpAuth(ctx.credentials, this.fetchImpl);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.auth.getAccessToken();
    return await requestJson<T>(
      this.fetchImpl,
      "gcp",
      `${BASE}/${this.project}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${token}` },
        body,
      },
    );
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
      ipv6: false,
    };
  }

  async listRegions(): Promise<string[]> {
    const data = await this.request<{ items?: { name: string }[] }>(
      "GET",
      "/zones",
    );
    return (data.items ?? []).map((zone) => zone.name);
  }

  async listInstances(_opts?: ListOptions): Promise<InstanceList> {
    const data = await this.request<
      { items?: Record<string, { instances?: GceInstance[] }> }
    >("GET", "/aggregated/instances");
    const instances: Instance[] = [];
    for (const group of Object.values(data.items ?? {})) {
      for (const instance of group.instances ?? []) {
        instances.push(mapInstance(instance));
      }
    }
    return { instances };
  }

  private requireZone(locator?: InstanceLocator): string {
    const zone = locator?.zone;
    if (!zone) {
      throw new ValidationError("GCP 操作需要指定可用区（zone）");
    }
    return zone;
  }

  async getInstance(id: string, locator?: InstanceLocator): Promise<Instance> {
    const zone = this.requireZone(locator);
    const raw = await this.request<GceInstance>(
      "GET",
      `/zones/${zone}/instances/${id}`,
    );
    if (!raw?.name) throw new NotFoundError(`instance ${id} not found`);
    return mapInstance(raw);
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    const zone = input.zone;
    if (!zone) {
      throw new ValidationError("GCP 创建实例需要指定可用区（zone）");
    }
    const name = input.name ?? `debot-${Date.now()}`;
    const metadataItems: { key: string; value: string }[] = [];
    if (input.sshKeyId) {
      metadataItems.push({ key: "ssh-keys", value: `debot:${input.sshKeyId}` });
    }
    if (input.userData) {
      metadataItems.push({ key: "startup-script", value: input.userData });
    }
    const body = {
      name,
      machineType: `zones/${zone}/machineTypes/${input.size}`,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: { sourceImage: input.image },
        },
      ],
      networkInterfaces: [
        {
          network: "global/networks/default",
          accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
        },
      ],
      labels: input.tags,
      metadata: metadataItems.length > 0 ? { items: metadataItems } : undefined,
    };
    await this.request("POST", `/zones/${zone}/instances`, body);
    return {
      id: name,
      name,
      state: "pending",
      zone,
      region: zoneToRegion(zone),
      size: input.size,
      image: input.image,
    };
  }

  async startInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const zone = this.requireZone(locator);
    await this.request("POST", `/zones/${zone}/instances/${id}/start`);
  }

  async stopInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const zone = this.requireZone(locator);
    await this.request("POST", `/zones/${zone}/instances/${id}/stop`);
  }

  async rebootInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const zone = this.requireZone(locator);
    await this.request("POST", `/zones/${zone}/instances/${id}/reset`);
  }

  async deleteInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const zone = this.requireZone(locator);
    await this.request("DELETE", `/zones/${zone}/instances/${id}`);
  }

  renameInstance(): Promise<void> {
    throw new ProviderError("gcp", "GCP does not support renaming instances", {
      userMessage: "Google Cloud 不支持重命名实例。",
    });
  }
}
