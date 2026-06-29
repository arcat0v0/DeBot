import { NotFoundError } from "../../shared/errors.ts";
import { nowIso, shortId } from "../../shared/util.ts";
import type {
  Capabilities,
  CreateInstanceInput,
  Instance,
  InstanceList,
  InstanceLocator,
  ListOptions,
  ProviderAdapter,
  ProviderId,
} from "../types.ts";

export class MockAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  private readonly instances = new Map<string, Instance>();
  private readonly regions: string[];

  constructor(options: {
    id?: ProviderId;
    label?: string;
    regions?: string[];
    seed?: Instance[];
  } = {}) {
    this.id = options.id ?? "aws";
    this.label = options.label ?? "Mock";
    this.regions = options.regions ?? ["us-east-1", "eu-west-1"];
    for (const instance of options.seed ?? defaultSeed()) {
      this.instances.set(instance.id, { ...instance });
    }
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
      regionAvailability: false,
      balance: false,
      subscriptionInfo: false,
      ipv6: false,
      firewall: false,
      customCreate: true,
    };
  }

  listRegions(): Promise<string[]> {
    return Promise.resolve([...this.regions]);
  }

  listInstances(_opts?: ListOptions): Promise<InstanceList> {
    return Promise.resolve({
      instances: [...this.instances.values()].map((item) => ({ ...item })),
    });
  }

  getInstance(id: string, _locator?: InstanceLocator): Promise<Instance> {
    const instance = this.instances.get(id);
    if (!instance) throw new NotFoundError(`instance ${id} not found`);
    return Promise.resolve({ ...instance });
  }

  createInstance(input: CreateInstanceInput): Promise<Instance> {
    const instance: Instance = {
      id: `mock-${shortId(6)}`,
      name: input.name ?? `mock-${shortId(4)}`,
      state: "running",
      region: input.region ?? this.regions[0],
      size: input.size,
      image: input.image,
      publicIp: "203.0.113.10",
      privateIp: "10.0.0.10",
      createdAt: nowIso(),
      tags: input.tags,
    };
    this.instances.set(instance.id, instance);
    return Promise.resolve({ ...instance });
  }

  startInstance(id: string): Promise<void> {
    return this.setState(id, "running");
  }

  stopInstance(id: string): Promise<void> {
    return this.setState(id, "stopped");
  }

  rebootInstance(id: string): Promise<void> {
    return this.setState(id, "running");
  }

  deleteInstance(id: string): Promise<void> {
    if (!this.instances.delete(id)) {
      throw new NotFoundError(`instance ${id} not found`);
    }
    return Promise.resolve();
  }

  renameInstance(id: string, name: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) throw new NotFoundError(`instance ${id} not found`);
    instance.name = name;
    return Promise.resolve();
  }

  private setState(id: string, state: Instance["state"]): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) throw new NotFoundError(`instance ${id} not found`);
    instance.state = state;
    return Promise.resolve();
  }
}

function defaultSeed(): Instance[] {
  return [
    {
      id: "mock-web-1",
      name: "web-1",
      state: "running",
      region: "us-east-1",
      size: "t3.micro",
      image: "ubuntu-22.04",
      publicIp: "203.0.113.1",
      privateIp: "10.0.0.1",
      createdAt: "2024-01-01T00:00:00.000Z",
    },
    {
      id: "mock-db-1",
      name: "db-1",
      state: "stopped",
      region: "us-east-1",
      size: "t3.small",
      image: "debian-12",
      privateIp: "10.0.0.2",
      createdAt: "2024-01-02T00:00:00.000Z",
    },
  ];
}
