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
  };
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
  return {
    id: raw.name ?? "",
    name: raw.name ?? "",
    state: mapPowerState(raw.properties?.instanceView?.statuses),
    region: raw.location,
    size: raw.properties?.hardwareProfile?.vmSize,
    image: imageLabel,
    tags: resourceGroupFromId(raw.id)
      ? { resourceGroup: resourceGroupFromId(raw.id)! }
      : undefined,
  };
}

export class AzureAdapter implements ProviderAdapter {
  readonly id = "azure" as const;
  readonly label = "Azure";
  private readonly auth: AzureAuth;
  private readonly subscriptionId: string;
  private readonly resourceGroup?: string;
  private readonly fetchImpl: FetchLike;

  constructor(ctx: AdapterContext<"azure">) {
    this.fetchImpl = ctx.fetch ?? fetch;
    this.subscriptionId = ctx.credentials.subscriptionId;
    this.resourceGroup = ctx.credentials.resourceGroup;
    this.auth = new AzureAuth(ctx.credentials, this.fetchImpl);
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
    const rg = (locator?.region && locator.region.includes("/"))
      ? undefined
      : this.resourceGroup;
    if (!rg) {
      throw new ValidationError(
        "Azure 操作需要资源组（resourceGroup），请在凭证中设置",
      );
    }
    return rg;
  }

  private vmPath(name: string, rg: string): string {
    return `/subscriptions/${this.subscriptionId}/resourceGroups/${rg}` +
      `/providers/Microsoft.Compute/virtualMachines/${name}`;
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
    const data = await this.request<{ value: { name: string }[] }>(
      "GET",
      `/subscriptions/${this.subscriptionId}/locations`,
      "2022-12-01",
    );
    return data.value.map((location) => location.name);
  }

  async listInstances(_opts?: ListOptions): Promise<InstanceList> {
    const path = this.resourceGroup
      ? `/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}` +
        `/providers/Microsoft.Compute/virtualMachines`
      : `/subscriptions/${this.subscriptionId}/providers/Microsoft.Compute/virtualMachines`;
    const data = await this.request<{ value: AzureVm[] }>(
      "GET",
      `${path}?$expand=instanceView`,
      COMPUTE_API,
    );
    return { instances: (data.value ?? []).map(mapVm) };
  }

  async getInstance(id: string, locator?: InstanceLocator): Promise<Instance> {
    const rg = this.requireResourceGroup(locator);
    const raw = await this.request<AzureVm>(
      "GET",
      `${this.vmPath(id, rg)}?$expand=instanceView`,
      COMPUTE_API,
    );
    if (!raw?.name) throw new NotFoundError(`virtual machine ${id} not found`);
    return mapVm(raw);
  }

  async startInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const rg = this.requireResourceGroup(locator);
    await this.request("POST", `${this.vmPath(id, rg)}/start`, COMPUTE_API);
  }

  async stopInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const rg = this.requireResourceGroup(locator);
    await this.request(
      "POST",
      `${this.vmPath(id, rg)}/deallocate`,
      COMPUTE_API,
    );
  }

  async rebootInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const rg = this.requireResourceGroup(locator);
    await this.request("POST", `${this.vmPath(id, rg)}/restart`, COMPUTE_API);
  }

  async deleteInstance(id: string, locator?: InstanceLocator): Promise<void> {
    const rg = this.requireResourceGroup(locator);
    await this.request("DELETE", this.vmPath(id, rg), COMPUTE_API);
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
    const base =
      `/subscriptions/${this.subscriptionId}/resourceGroups/${rg}/providers`;

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

    await this.request("PUT", this.vmPath(name, rg), COMPUTE_API, {
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
