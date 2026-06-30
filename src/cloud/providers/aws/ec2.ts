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
  SubscriptionBalance,
} from "../../types.ts";
import { AwsBillingClient } from "./billing.ts";
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

function readCarrierIp(node: XmlElement): string | undefined {
  const interfaces = firstChild(node, "networkInterfaceSet");
  for (const item of childElements(interfaces, "item")) {
    const carrierIp = pathText(item, ["association", "carrierIp"]);
    if (carrierIp) return carrierIp;
  }
  return undefined;
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
    publicIp: childText(node, "ipAddress") ?? readCarrierIp(node),
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
  private readonly billing: AwsBillingClient;

  constructor(ctx: AdapterContext<"aws">) {
    this.fetchImpl = ctx.fetch ?? fetch;
    this.region = ctx.defaultRegion ?? "us-east-1";
    this.credentials = ctx.credentials;
    this.billing = new AwsBillingClient(ctx);
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
  async addPublicIpv6(id: string): Promise<string> {
    const describeRoot = await this.call("DescribeInstances", {
      "InstanceId.1": id,
    });
    const response = firstChild(describeRoot, "DescribeInstancesResponse");
    const reservation = firstChild(
      firstChild(response, "reservationSet"),
      "item",
    );
    const instance = firstChild(
      firstChild(reservation, "instancesSet"),
      "item",
    );
    if (!instance) throw new NotFoundError(`instance ${id} not found`);
    const vpcId = pathText(instance, ["networkInterfaceSet", "item", "vpcId"]);
    const subnetId = pathText(
      instance,
      ["networkInterfaceSet", "item", "subnetId"],
    );
    const eniId = pathText(
      instance,
      ["networkInterfaceSet", "item", "networkInterfaceId"],
    );
    if (!vpcId || !subnetId || !eniId) {
      throw new ProviderError("aws", "instance has no VPC network interface", {
        userMessage: "该实例没有 VPC 网卡，无法添加 IPv6。",
      });
    }
    const existingIpv6 = pathText(
      instance,
      ["networkInterfaceSet", "item", "ipv6sSet", "item"],
    );
    if (existingIpv6) return existingIpv6;

    const vpcRoot = await this.call("DescribeVpcs", { "VpcId.1": vpcId });
    const vpcResp = firstChild(vpcRoot, "DescribeVpcsResponse");
    const vpc = firstChild(firstChild(vpcResp, "vpcSet"), "item");
    if (!vpc) throw new NotFoundError(`vpc ${vpcId} not found`);
    const vpcIpv6Prefix = this.firstIpv6Prefix(vpc);
    if (!vpcIpv6Prefix) {
      await this.call("AssociateVpcCidrBlock", {
        VpcId: vpcId,
        AmazonProvidedIpv6CidrBlock: "true",
      });
    }

    const subnetRoot = await this.call("DescribeSubnets", {
      "SubnetId.1": subnetId,
    });
    const subnetResp = firstChild(subnetRoot, "DescribeSubnetsResponse");
    const subnet = firstChild(firstChild(subnetResp, "subnetSet"), "item");
    if (!subnet) throw new NotFoundError(`subnet ${subnetId} not found`);
    const subnetIpv6Prefix = this.firstIpv6Prefix(subnet);
    if (!subnetIpv6Prefix) {
      let v6Cidr = vpcIpv6Prefix;
      if (!v6Cidr) {
        const refreshedVpcRoot = await this.call("DescribeVpcs", {
          "VpcId.1": vpcId,
        });
        const refreshedVpc = firstChild(
          firstChild(
            firstChild(refreshedVpcRoot, "DescribeVpcsResponse"),
            "vpcSet",
          ),
          "item",
        );
        v6Cidr = this.firstIpv6Prefix(refreshedVpc);
      }
      if (!v6Cidr) {
        throw new ProviderError(
          "aws",
          "vpc has no ipv6 cidr after associate",
          {
            userMessage: "VPC 未拿到 IPv6 CIDR，无法为子网配置 IPv6。",
          },
        );
      }
      const subnetCidr = v6Cidr.replace(/\/\d+$/, "/64");
      await this.call("AssociateSubnetCidrBlock", {
        SubnetId: subnetId,
        Ipv6CidrBlock: subnetCidr,
      });
    }

    const assignRoot = await this.call("AssignIpv6Addresses", {
      NetworkInterfaceId: eniId,
      Ipv6AddressCount: "1",
    });
    const assignResp = firstChild(assignRoot, "AssignIpv6AddressesResponse");
    const assignedItem = pathText(assignResp, [
      "assignedIpv6Addresses",
      "item",
    ]);
    if (assignedItem) return assignedItem;

    const eniRoot = await this.call("DescribeNetworkInterfaces", {
      "NetworkInterfaceId.1": eniId,
    });
    const eniResp = firstChild(eniRoot, "DescribeNetworkInterfacesResponse");
    const eni = firstChild(firstChild(eniResp, "networkInterfaceSet"), "item");
    const fromEni = pathText(eni, ["ipv6sSet", "item"]);
    if (!fromEni) {
      throw new ProviderError("aws", "ipv6 address not assigned", {
        userMessage: "IPv6 已分配，但未能读取到地址，请稍后在面板查看。",
      });
    }
    return fromEni;
  }

  private firstIpv6Prefix(node: XmlElement | undefined): string | undefined {
    const set = node && (
      firstChild(node, "ipv6CidrBlockAssociationSet") ??
        firstChild(node, "ipv6CidrBlockSet")
    );
    for (const item of childElements(set, "item")) {
      const block = childText(item, "ipv6CidrBlock");
      if (block) return block;
    }
    return undefined;
  }
}
