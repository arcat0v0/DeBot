import { NotFoundError, ProviderError } from "../../../shared/errors.ts";
import type { FetchLike } from "../../http.ts";
import {
  childElements,
  childText,
  findElement,
  firstChild,
  parseXml,
  pathText,
} from "../../xml.ts";
import type { XmlElement } from "../../xml.ts";
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

const VERSION = "2016-11-15";

function mapState(name: string | undefined): InstanceState {
  switch (name) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "shutting-down":
      return "terminating";
    case "terminated":
      return "terminated";
    default:
      return "unknown";
  }
}

function readTags(node: XmlElement | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const item of childElements(firstChild(node, "tagSet"), "item")) {
    const key = childText(item, "key");
    if (key) tags[key] = childText(item, "value") ?? "";
  }
  return tags;
}

function mapInstance(node: XmlElement, region: string): Instance {
  const tags = readTags(node);
  return {
    id: childText(node, "instanceId") ?? "",
    name: tags.Name ?? childText(node, "instanceId") ?? "",
    state: mapState(pathText(node, ["instanceState", "name"])),
    region,
    zone: pathText(node, ["placement", "availabilityZone"]),
    size: childText(node, "instanceType"),
    image: childText(node, "imageId"),
    publicIp: childText(node, "ipAddress"),
    privateIp: childText(node, "privateIpAddress"),
    createdAt: childText(node, "launchTime"),
    tags: Object.keys(tags).length > 0 ? tags : undefined,
  };
}

export class Ec2Adapter implements ProviderAdapter {
  readonly id = "aws" as const;
  readonly label = "AWS EC2";
  private readonly region: string;
  private readonly fetchImpl: FetchLike;
  private readonly credentials: AdapterContext<"aws">["credentials"];

  constructor(ctx: AdapterContext<"aws">) {
    this.fetchImpl = ctx.fetch ?? fetch;
    this.region = ctx.defaultRegion ?? "us-east-1";
    this.credentials = ctx.credentials;
  }

  private async call(
    action: string,
    params: Record<string, string> = {},
  ): Promise<XmlElement> {
    const form = new URLSearchParams({
      Action: action,
      Version: VERSION,
      ...params,
    });
    const body = form.toString();
    const url = `https://ec2.${this.region}.amazonaws.com/`;
    const response = await signedFetch(this.fetchImpl, {
      credentials: this.credentials,
      region: this.region,
      service: "ec2",
      method: "POST",
      url,
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body,
    });
    const text = await response.text();
    const root = parseXml(text);
    if (!response.ok) {
      const error = findElement(root, "Error");
      const code = childText(error, "Code") ?? `HTTP ${response.status}`;
      const message = childText(error, "Message") ?? text.slice(0, 200);
      throw new ProviderError("aws", `${code}: ${message}`, {
        status: response.status,
        userMessage: `AWS EC2 error: ${message}`,
      });
    }
    return root;
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
    const root = await this.call("DescribeRegions");
    const response = firstChild(root, "DescribeRegionsResponse");
    const set = firstChild(response, "regionInfo");
    return childElements(set, "item")
      .map((item) => childText(item, "regionName"))
      .filter((name): name is string => Boolean(name));
  }

  async listInstances(_opts?: ListOptions): Promise<InstanceList> {
    const root = await this.call("DescribeInstances");
    const response = firstChild(root, "DescribeInstancesResponse");
    const reservations = childElements(
      firstChild(response, "reservationSet"),
      "item",
    );
    const instances: Instance[] = [];
    for (const reservation of reservations) {
      for (
        const item of childElements(
          firstChild(reservation, "instancesSet"),
          "item",
        )
      ) {
        instances.push(mapInstance(item, this.region));
      }
    }
    return { instances };
  }

  async getInstance(id: string, _locator?: InstanceLocator): Promise<Instance> {
    const root = await this.call("DescribeInstances", { "InstanceId.1": id });
    const response = firstChild(root, "DescribeInstancesResponse");
    const reservation = firstChild(
      firstChild(response, "reservationSet"),
      "item",
    );
    const item = firstChild(firstChild(reservation, "instancesSet"), "item");
    if (!item) throw new NotFoundError(`instance ${id} not found`);
    return mapInstance(item, this.region);
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    const params: Record<string, string> = {
      ImageId: input.image,
      InstanceType: input.size,
      MinCount: "1",
      MaxCount: "1",
    };
    if (input.sshKeyId) params.KeyName = input.sshKeyId;
    if (input.userData) params.UserData = btoa(input.userData);
    const name = input.name;
    const tagEntries = Object.entries(input.tags ?? {});
    if (name) tagEntries.unshift(["Name", name]);
    if (tagEntries.length > 0) {
      params["TagSpecification.1.ResourceType"] = "instance";
      tagEntries.forEach(([key, value], index) => {
        params[`TagSpecification.1.Tag.${index + 1}.Key`] = key;
        params[`TagSpecification.1.Tag.${index + 1}.Value`] = value;
      });
    }
    const root = await this.call("RunInstances", params);
    const response = firstChild(root, "RunInstancesResponse");
    const item = firstChild(firstChild(response, "instancesSet"), "item");
    if (!item) {
      throw new ProviderError("aws", "RunInstances returned no instance");
    }
    return mapInstance(item, this.region);
  }

  async startInstance(id: string): Promise<void> {
    await this.call("StartInstances", { "InstanceId.1": id });
  }

  async stopInstance(id: string): Promise<void> {
    await this.call("StopInstances", { "InstanceId.1": id });
  }

  async rebootInstance(id: string): Promise<void> {
    await this.call("RebootInstances", { "InstanceId.1": id });
  }

  async deleteInstance(id: string): Promise<void> {
    await this.call("TerminateInstances", { "InstanceId.1": id });
  }

  async renameInstance(id: string, name: string): Promise<void> {
    await this.call("CreateTags", {
      "ResourceId.1": id,
      "Tag.1.Key": "Name",
      "Tag.1.Value": name,
    });
  }
}
