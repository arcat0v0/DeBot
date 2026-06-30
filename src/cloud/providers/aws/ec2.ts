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
  FirewallProtocol,
  FirewallRule,
  FirewallRuleInput,
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

function firstAddressInSet(
  node: XmlElement | undefined,
  setName: string,
  childName: string,
): string | undefined {
  for (const item of childElements(firstChild(node, setName), "item")) {
    const address = childText(item, childName) ?? item.text;
    if (address) return address;
  }
  return undefined;
}

function readIpv6FromNetworkInterface(
  node: XmlElement | undefined,
): string | undefined {
  return firstAddressInSet(node, "ipv6AddressesSet", "ipv6Address") ??
    firstAddressInSet(node, "ipv6sSet", "ipv6Address");
}

function readIpv6Address(node: XmlElement): string | undefined {
  const direct = readIpv6FromNetworkInterface(node);
  if (direct) return direct;
  const interfaces = firstChild(node, "networkInterfaceSet");
  for (const item of childElements(interfaces, "item")) {
    const address = readIpv6FromNetworkInterface(item);
    if (address) return address;
  }
  return undefined;
}

function isDuplicateOrAlreadyExists(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return text.includes("already") || text.includes("duplicate") ||
    text.includes("routealreadyexists");
}

function mapEc2FirewallProtocol(value: string | undefined): FirewallProtocol {
  switch (value?.toLowerCase()) {
    case "tcp":
    case "6":
      return "Tcp";
    case "udp":
    case "17":
      return "Udp";
    case "icmp":
    case "1":
      return "Icmp";
    case "icmpv6":
    case "58":
      return "Icmpv6";
    case "-1":
      return "*";
    default:
      return "*";
  }
}

function ec2IpProtocol(protocol: FirewallProtocol): string {
  switch (protocol) {
    case "Tcp":
      return "tcp";
    case "Udp":
      return "udp";
    case "Icmp":
      return "icmp";
    case "Icmpv6":
      return "icmpv6";
    case "*":
      return "-1";
  }
}

function ec2RulePorts(
  protocol: FirewallProtocol,
  from: string | undefined,
  to: string | undefined,
): string {
  if (protocol === "*" || !from || !to || (from === "-1" && to === "-1")) {
    return "*";
  }
  return from === to ? from : `${from}-${to}`;
}

function ec2PermissionPorts(
  protocol: FirewallProtocol,
  port: string,
): { from?: string; to?: string } {
  if (protocol === "*") return {};
  if (port === "*") {
    if (protocol === "Tcp" || protocol === "Udp") {
      return { from: "0", to: "65535" };
    }
    return { from: "-1", to: "-1" };
  }
  const [from, to] = port.split("-");
  return { from, to: to ?? from };
}

function securityGroupIdsFromInstance(instance: XmlElement | undefined) {
  const ids = new Set<string>();
  for (const item of childElements(firstChild(instance, "groupSet"), "item")) {
    const groupId = childText(item, "groupId");
    if (groupId) ids.add(groupId);
  }
  for (
    const networkInterface of childElements(
      firstChild(instance, "networkInterfaceSet"),
      "item",
    )
  ) {
    for (
      const group of childElements(
        firstChild(networkInterface, "groupSet"),
        "item",
      )
    ) {
      const groupId = childText(group, "groupId");
      if (groupId) ids.add(groupId);
    }
  }
  return [...ids];
}

function ec2FirewallSource(rule: XmlElement): string | undefined {
  return childText(rule, "cidrIpv4") ??
    childText(rule, "cidrIpv6") ??
    pathText(rule, ["referencedGroupInfo", "groupId"]) ??
    childText(rule, "prefixListId");
}

function mapSecurityGroupRule(rule: XmlElement): FirewallRule | undefined {
  if (childText(rule, "isEgress") === "true") return undefined;
  const protocol = mapEc2FirewallProtocol(childText(rule, "ipProtocol"));
  const ports = ec2RulePorts(
    protocol,
    childText(rule, "fromPort"),
    childText(rule, "toPort"),
  );
  const id = childText(rule, "securityGroupRuleId");
  const description = childText(rule, "description");
  const source = ec2FirewallSource(rule);
  return {
    id,
    name: description || id || `${protocol}-${ports}-${source ?? "*"}`,
    direction: "Inbound",
    access: "Allow",
    protocol,
    source,
    ports,
    description,
  };
}

function ec2RuleSources(source: string | undefined): string[] {
  const value = source?.trim() || "*";
  if (value === "*" || value.toLowerCase() === "internet") {
    return ["0.0.0.0/0", "::/0"];
  }
  if (value.includes(":") && !value.includes("/")) return [`${value}/128`];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return [`${value}/32`];
  return [value];
}

function isIpv6Cidr(source: string): boolean {
  return source.includes(":");
}

function firstRouteTable(node: XmlElement | undefined): XmlElement | undefined {
  return firstChild(firstChild(node, "routeTableSet"), "item");
}

function hasIpv6DefaultRoute(routeTable: XmlElement | undefined): boolean {
  for (
    const item of childElements(firstChild(routeTable, "routeSet"), "item")
  ) {
    if (childText(item, "destinationIpv6CidrBlock") === "::/0") return true;
  }
  return false;
}

function internetGatewayForDefaultRoute(
  routeTable: XmlElement | undefined,
): string | undefined {
  for (
    const item of childElements(firstChild(routeTable, "routeSet"), "item")
  ) {
    if (childText(item, "destinationCidrBlock") !== "0.0.0.0/0") continue;
    const gatewayId = childText(item, "gatewayId");
    if (gatewayId?.startsWith("igw-")) return gatewayId;
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
    publicIpv6: readIpv6Address(node),
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
      firewall: true,
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

  async listFirewallRules(
    id: string,
    _locator?: InstanceLocator,
  ): Promise<FirewallRule[]> {
    const groupIds = await this.securityGroupIds(id);
    const params: Record<string, string> = { "Filter.1.Name": "group-id" };
    groupIds.forEach((groupId, index) => {
      params[`Filter.1.Value.${index + 1}`] = groupId;
    });
    const root = await this.call("DescribeSecurityGroupRules", params);
    const response = firstChild(root, "DescribeSecurityGroupRulesResponse");
    return childElements(firstChild(response, "securityGroupRuleSet"), "item")
      .map(mapSecurityGroupRule)
      .filter((rule): rule is FirewallRule => Boolean(rule));
  }

  async addFirewallRule(
    id: string,
    rule: FirewallRuleInput,
    _locator?: InstanceLocator,
  ): Promise<FirewallRule> {
    const [groupId] = await this.securityGroupIds(id);
    for (const source of ec2RuleSources(rule.source)) {
      await this.authorizeFirewallRule(groupId, rule, source);
    }
    return {
      name: rule.name ?? `debot-${rule.protocol}-${rule.port}`,
      direction: "Inbound",
      access: "Allow",
      protocol: rule.protocol,
      ports: rule.port,
      source: rule.source ?? "*",
      description: rule.description,
    };
  }

  async deleteFirewallRule(
    _id: string,
    ruleId: string,
    _locator?: InstanceLocator,
  ): Promise<void> {
    if (!ruleId.startsWith("sgr-")) {
      throw new ProviderError("aws", "security group rule id is required", {
        userMessage:
          "AWS 删除防火墙规则需要 SecurityGroupRuleId，请刷新规则后重试。",
      });
    }
    await this.call("RevokeSecurityGroupIngress", {
      "SecurityGroupRuleId.1": ruleId,
    });
  }

  async allowAllInboundTraffic(
    id: string,
    _locator?: InstanceLocator,
  ): Promise<FirewallRule[]> {
    const [groupId] = await this.securityGroupIds(id);
    const existing = await this.listFirewallRules(id);
    const hasIpv4All = existing.some((rule) =>
      rule.protocol === "*" && rule.ports === "*" && rule.source === "0.0.0.0/0"
    );
    const hasIpv6All = existing.some((rule) =>
      rule.protocol === "*" && rule.ports === "*" && rule.source === "::/0"
    );
    if (!hasIpv4All) {
      await this.authorizeFirewallRule(groupId, {
        name: "debot-allow-all-inbound-ipv4",
        protocol: "*",
        port: "*",
        source: "0.0.0.0/0",
        description: "DeBot allow all inbound IPv4",
      }, "0.0.0.0/0");
    }
    if (!hasIpv6All) {
      await this.authorizeFirewallRule(groupId, {
        name: "debot-allow-all-inbound-ipv6",
        protocol: "*",
        port: "*",
        source: "::/0",
        description: "DeBot allow all inbound IPv6",
      }, "::/0");
    }
    return await this.listFirewallRules(id);
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
    const existingIpv6 = readIpv6Address(instance);

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

    await this.ensureIpv6DefaultRoute(vpcId, subnetId);
    if (existingIpv6) return existingIpv6;

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
    const fromEni = eni && readIpv6FromNetworkInterface(eni);
    if (!fromEni) {
      throw new ProviderError("aws", "ipv6 address not assigned", {
        userMessage: "IPv6 已分配，但未能读取到地址，请稍后在面板查看。",
      });
    }
    return fromEni;
  }

  private async ensureIpv6DefaultRoute(
    vpcId: string,
    subnetId: string,
  ): Promise<void> {
    const associatedRoot = await this.call("DescribeRouteTables", {
      "Filter.1.Name": "association.subnet-id",
      "Filter.1.Value.1": subnetId,
    });
    let routeTable = firstRouteTable(
      firstChild(associatedRoot, "DescribeRouteTablesResponse"),
    );
    if (!routeTable) {
      const mainRoot = await this.call("DescribeRouteTables", {
        "Filter.1.Name": "vpc-id",
        "Filter.1.Value.1": vpcId,
        "Filter.2.Name": "association.main",
        "Filter.2.Value.1": "true",
      });
      routeTable = firstRouteTable(
        firstChild(mainRoot, "DescribeRouteTablesResponse"),
      );
    }
    const routeTableId = childText(routeTable, "routeTableId");
    if (!routeTable || !routeTableId) {
      throw new ProviderError("aws", "route table not found", {
        userMessage:
          "IPv6 已准备，但未找到该子网的路由表，无法配置公网 IPv6 默认路由。",
      });
    }
    if (hasIpv6DefaultRoute(routeTable)) return;
    const gatewayId = internetGatewayForDefaultRoute(routeTable);
    if (!gatewayId) {
      throw new ProviderError("aws", "internet gateway route not found", {
        userMessage:
          "IPv6 已准备，但路由表没有指向 Internet Gateway 的 IPv4 默认路由，无法自动补公网 IPv6 默认路由。",
      });
    }
    try {
      await this.call("CreateRoute", {
        RouteTableId: routeTableId,
        DestinationIpv6CidrBlock: "::/0",
        GatewayId: gatewayId,
      });
    } catch (error) {
      if (!isDuplicateOrAlreadyExists(error)) throw error;
    }
  }

  private async securityGroupIds(id: string): Promise<string[]> {
    const root = await this.call("DescribeInstances", { "InstanceId.1": id });
    const response = firstChild(root, "DescribeInstancesResponse");
    const reservation = firstChild(
      firstChild(response, "reservationSet"),
      "item",
    );
    const instance = firstChild(
      firstChild(reservation, "instancesSet"),
      "item",
    );
    if (!instance) throw new NotFoundError(`instance ${id} not found`);
    const groupIds = securityGroupIdsFromInstance(instance);
    if (groupIds.length === 0) {
      throw new ProviderError("aws", "instance has no security groups", {
        userMessage: "该 EC2 实例没有可管理的 Security Group。",
      });
    }
    return groupIds;
  }

  private async authorizeFirewallRule(
    groupId: string,
    rule: FirewallRuleInput,
    source: string,
  ): Promise<void> {
    const ports = ec2PermissionPorts(rule.protocol, rule.port);
    const params: Record<string, string> = {
      GroupId: groupId,
      "IpPermissions.1.IpProtocol": ec2IpProtocol(rule.protocol),
    };
    if (ports.from !== undefined) {
      params["IpPermissions.1.FromPort"] = ports.from;
    }
    if (ports.to !== undefined) {
      params["IpPermissions.1.ToPort"] = ports.to;
    }
    const description = rule.name ?? rule.description;
    if (isIpv6Cidr(source)) {
      params["IpPermissions.1.Ipv6Ranges.1.CidrIpv6"] = source;
      if (description) {
        params["IpPermissions.1.Ipv6Ranges.1.Description"] = description;
      }
    } else {
      params["IpPermissions.1.IpRanges.1.CidrIp"] = source;
      if (description) {
        params["IpPermissions.1.IpRanges.1.Description"] = description;
      }
    }
    try {
      await this.call("AuthorizeSecurityGroupIngress", params);
    } catch (error) {
      if (!isDuplicateOrAlreadyExists(error)) throw error;
    }
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
