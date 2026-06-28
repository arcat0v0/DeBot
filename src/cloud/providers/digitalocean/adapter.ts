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

const BASE = "https://api.digitalocean.com/v2";

interface DoNetwork {
  ip_address: string;
  type: "public" | "private";
}

interface DoDroplet {
  id: number;
  name: string;
  status: string;
  region?: { slug: string };
  size_slug?: string;
  image?: { slug?: string; distribution?: string; name?: string };
  networks?: { v4?: DoNetwork[] };
  created_at?: string;
  tags?: string[];
}

function mapStatus(status: string): InstanceState {
  switch (status) {
    case "active":
      return "running";
    case "off":
      return "stopped";
    case "new":
      return "pending";
    case "archive":
      return "stopped";
    default:
      return "unknown";
  }
}

function mapDroplet(droplet: DoDroplet): Instance {
  const v4 = droplet.networks?.v4 ?? [];
  const publicIp = v4.find((net) => net.type === "public")?.ip_address;
  const privateIp = v4.find((net) => net.type === "private")?.ip_address;
  const tags: Record<string, string> = {};
  for (const tag of droplet.tags ?? []) tags[tag] = "";
  return {
    id: String(droplet.id),
    name: droplet.name,
    state: mapStatus(droplet.status),
    region: droplet.region?.slug,
    size: droplet.size_slug,
    image: droplet.image?.slug ?? droplet.image?.name,
    publicIp,
    privateIp,
    createdAt: droplet.created_at,
    tags: Object.keys(tags).length > 0 ? tags : undefined,
  };
}

export class DigitalOceanAdapter implements ProviderAdapter {
  readonly id = "digitalocean" as const;
  readonly label = "DigitalOcean";
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(ctx: AdapterContext<"digitalocean">) {
    this.token = ctx.credentials.token;
    this.fetchImpl = ctx.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    return requestJson<T>(this.fetchImpl, "digitalocean", `${BASE}${path}`, {
      method,
      headers: this.headers(),
      body,
      query,
    });
  }

  capabilities(): Capabilities {
    return {
      create: true,
      start: true,
      stop: true,
      reboot: true,
      delete: true,
      rename: true,
      regions: true,
      ipv6: false,
    };
  }

  async listRegions(): Promise<string[]> {
    const data = await this.request<
      { regions: { slug: string; available: boolean }[] }
    >(
      "GET",
      "/regions",
      undefined,
      { per_page: 200 },
    );
    return data.regions.filter((region) => region.available).map((region) =>
      region.slug
    );
  }

  async listInstances(_opts?: ListOptions): Promise<InstanceList> {
    const data = await this.request<{ droplets: DoDroplet[] }>(
      "GET",
      "/droplets",
      undefined,
      { per_page: 200 },
    );
    return { instances: data.droplets.map(mapDroplet) };
  }

  async getInstance(id: string, _locator?: InstanceLocator): Promise<Instance> {
    const data = await this.request<{ droplet: DoDroplet }>(
      "GET",
      `/droplets/${id}`,
    );
    if (!data?.droplet) throw new NotFoundError(`droplet ${id} not found`);
    return mapDroplet(data.droplet);
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    if (!input.region) {
      throw new ValidationError(
        "DigitalOcean 创建云主机需要指定区域（region）",
      );
    }
    const body: Record<string, unknown> = {
      name: input.name ?? `debot-${Date.now()}`,
      region: input.region,
      size: input.size,
      image: input.image,
    };
    if (input.sshKeyId) body.ssh_keys = [input.sshKeyId];
    if (input.userData) body.user_data = input.userData;
    if (input.tags) body.tags = Object.keys(input.tags);
    const data = await this.request<{ droplet: DoDroplet }>(
      "POST",
      "/droplets",
      body,
    );
    return mapDroplet(data.droplet);
  }

  private async action(
    id: string,
    type: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.request("POST", `/droplets/${id}/actions`, { type, ...extra });
  }

  async startInstance(id: string): Promise<void> {
    await this.action(id, "power_on");
  }

  async stopInstance(id: string): Promise<void> {
    await this.action(id, "power_off");
  }

  async rebootInstance(id: string): Promise<void> {
    await this.action(id, "reboot");
  }

  async deleteInstance(id: string): Promise<void> {
    await this.request("DELETE", `/droplets/${id}`);
  }

  async renameInstance(id: string, name: string): Promise<void> {
    if (name.trim().length === 0) {
      throw new ProviderError("digitalocean", "名称不能为空");
    }
    await this.action(id, "rename", { name });
  }
}
