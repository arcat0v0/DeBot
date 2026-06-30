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
const WAVELENGTH_MIN_INSTANCE_TYPE = "t3.medium";
const WAVELENGTH_PARENT_REGIONS = ["us-east-1", "us-west-2"];
const NETWORK_CIDR = "10.64.0.0/16";
const SUBNET_CIDR = "10.64.1.0/24";
const REGION_PREFIX = /^([a-z]{2}(?:-gov)?-[a-z]+-\d+)/;
const WAVELENGTH_INSTANCE_TYPE_CANDIDATES = [
  WAVELENGTH_MIN_INSTANCE_TYPE,
  "t3.xlarge",
  "c5.large",
  "c5.xlarge",
  "r5.large",
  "g4dn.xlarge",
];

interface WavelengthZoneInfo {
  zoneName: string;
  groupName?: string;
  optInStatus?: string;
  parentRegion: string;
}

interface WavelengthAmi {
  imageId: string;
  rootDeviceName?: string;
  rootVolumeSize?: number;
}

interface WavelengthNetwork {
  vpcId: string;
  subnetId: string;
  securityGroupId: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWavelengthZone(value: string | undefined): value is string {
  return Boolean(value?.includes("-wlz-") && REGION_PREFIX.test(value));
}

function parentRegionForZone(zone: string): string {
  return REGION_PREFIX.exec(zone)?.[1] ?? zone;
}

function resourceName(zone: string, suffix: string): string {
  return `debot-wavelength-${zone}-${suffix}`.slice(0, 240);
}

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

function mapInstance(node: XmlElement, parentRegion: string): Instance {
  const tags = readTags(node);
  return {
    id: childText(node, "instanceId") ?? "",
    name: tags.Name ?? childText(node, "instanceId") ?? "",
    state: mapState(pathText(node, ["instanceState", "name"])),
    region: parentRegion,
    zone: pathText(node, ["placement", "availabilityZone"]),
    size: childText(node, "instanceType"),
    image: childText(node, "imageId"),
    publicIp: readCarrierIp(node) ?? childText(node, "ipAddress"),
    privateIp: childText(node, "privateIpAddress"),
    createdAt: childText(node, "launchTime"),
    tags: Object.keys(tags).length > 0 ? tags : undefined,
  };
}

function responseNode(root: XmlElement, name: string): XmlElement | undefined {
  return firstChild(root, name) ?? firstChild(firstChild(root, "#root"), name);
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isDuplicateOrAlreadyExists(error: unknown): boolean {
  return error instanceof Error &&
    /AlreadyExists|AlreadyAssociated|InvalidPermission\.Duplicate/.test(
      error.message,
    );
}

function paramsWithTags(
  params: Record<string, string>,
  index: number,
  resourceType: string,
  tags: Record<string, string>,
): void {
  params[`TagSpecification.${index}.ResourceType`] = resourceType;
  let tagIndex = 1;
  for (const [key, value] of Object.entries(tags)) {
    params[`TagSpecification.${index}.Tag.${tagIndex}.Key`] = key;
    params[`TagSpecification.${index}.Tag.${tagIndex}.Value`] = value;
    tagIndex++;
  }
}

export class WavelengthAdapter implements ProviderAdapter {
  readonly id = "aws" as const;
  readonly label = "AWS Wavelength";
  private readonly region: string;
  private readonly selectedZone?: string;
  private readonly fetchImpl: FetchLike;
  private readonly credentials: AdapterContext<"aws">["credentials"];
  private readonly billing: AwsBillingClient;

  constructor(ctx: AdapterContext<"aws">) {
    this.fetchImpl = ctx.fetch ?? fetch;
    this.selectedZone = isWavelengthZone(ctx.defaultRegion)
      ? ctx.defaultRegion
      : undefined;
    this.region = this.selectedZone
      ? parentRegionForZone(this.selectedZone)
      : ctx.defaultRegion ?? "us-east-1";
    this.credentials = ctx.credentials;
    this.billing = new AwsBillingClient(ctx);
  }

  private async callRegion(
    region: string,
    action: string,
    params: Record<string, string> = {},
  ): Promise<XmlElement> {
    const form = new URLSearchParams({
      Action: action,
      Version: VERSION,
      ...params,
    });
    const body = form.toString();
    const url = `https://ec2.${region}.amazonaws.com/`;
    const response = await signedFetch(this.fetchImpl, {
      credentials: this.credentials,
      region,
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

  private candidateParentRegions(): string[] {
    const regions = new Set<string>([
      this.region,
      ...WAVELENGTH_PARENT_REGIONS,
    ]);
    return [...regions].filter((region) => region.startsWith("us-"));
  }

  private async describeWavelengthZones(
    parentRegion: string,
    zoneName?: string,
  ): Promise<WavelengthZoneInfo[]> {
    const params: Record<string, string> = { AllAvailabilityZones: "true" };
    if (zoneName) {
      params["ZoneName.1"] = zoneName;
    } else {
      params["Filter.1.Name"] = "zone-type";
      params["Filter.1.Value.1"] = "wavelength-zone";
    }
    const root = await this.callRegion(
      parentRegion,
      "DescribeAvailabilityZones",
      params,
    );
    const response = responseNode(root, "DescribeAvailabilityZonesResponse");
    const zones = childElements(
      firstChild(response, "availabilityZoneInfo"),
      "item",
    );
    return zones
      .map((item) => ({
        zoneName: childText(item, "zoneName") ?? "",
        groupName: childText(item, "groupName"),
        optInStatus: childText(item, "optInStatus"),
        parentRegion,
      }))
      .filter((item) => isWavelengthZone(item.zoneName));
  }

  private async resolveZone(input?: CreateInstanceInput): Promise<string> {
    if (isWavelengthZone(input?.zone)) return input.zone;
    if (isWavelengthZone(input?.region)) return input.region;
    if (this.selectedZone) return this.selectedZone;
    const zones = await this.listRegions();
    const zone = zones[0];
    if (!zone) {
      throw new ProviderError("aws", "no Wavelength zones are available");
    }
    return zone;
  }

  private async ensureZoneOptedIn(zone: string): Promise<void> {
    const parentRegion = parentRegionForZone(zone);
    const [info] = await this.describeWavelengthZones(parentRegion, zone);
    if (!info) {
      throw new ProviderError("aws", `Wavelength zone ${zone} not found`);
    }
    if (info.optInStatus === "opted-in") return;
    await this.callRegion(parentRegion, "ModifyAvailabilityZoneGroup", {
      GroupName: info.groupName ?? zone,
      OptInStatus: "opted-in",
    });
    for (let attempt = 0; attempt < 24; attempt++) {
      const [current] = await this.describeWavelengthZones(parentRegion, zone);
      if (current?.optInStatus === "opted-in") return;
      await delay(5000);
    }
    throw new ProviderError(
      "aws",
      `Wavelength zone ${zone} did not become opted-in`,
    );
  }

  private async tagResources(
    parentRegion: string,
    resourceIds: string[],
    tags: Record<string, string>,
  ): Promise<void> {
    if (resourceIds.length === 0) return;
    const params: Record<string, string> = {};
    resourceIds.forEach((id, index) => {
      params[`ResourceId.${index + 1}`] = id;
    });
    let tagIndex = 1;
    for (const [key, value] of Object.entries(tags)) {
      params[`Tag.${tagIndex}.Key`] = key;
      params[`Tag.${tagIndex}.Value`] = value;
      tagIndex++;
    }
    await this.callRegion(parentRegion, "CreateTags", params);
  }

  private baseTags(zone: string, suffix: string): Record<string, string> {
    return {
      Name: resourceName(zone, suffix),
      CreatedBy: "DeBot",
      Service: "AWS Wavelength",
      WavelengthZone: zone,
    };
  }

  private async ensureVpc(parentRegion: string, zone: string): Promise<string> {
    const name = resourceName(zone, "vpc");
    const existing = await this.callRegion(parentRegion, "DescribeVpcs", {
      "Filter.1.Name": "tag:Name",
      "Filter.1.Value.1": name,
      "Filter.2.Name": "state",
      "Filter.2.Value.1": "available",
    });
    const response = responseNode(existing, "DescribeVpcsResponse");
    const vpc = firstChild(firstChild(response, "vpcSet"), "item");
    const existingId = childText(vpc, "vpcId");
    if (existingId) return existingId;

    const root = await this.callRegion(parentRegion, "CreateVpc", {
      CidrBlock: NETWORK_CIDR,
    });
    const created = responseNode(root, "CreateVpcResponse");
    const vpcId = pathText(created, ["vpc", "vpcId"]);
    if (!vpcId) throw new ProviderError("aws", "CreateVpc returned no VpcId");
    await this.tagResources(parentRegion, [vpcId], this.baseTags(zone, "vpc"));
    await this.callRegion(parentRegion, "ModifyVpcAttribute", {
      VpcId: vpcId,
      "EnableDnsSupport.Value": "true",
    });
    await this.callRegion(parentRegion, "ModifyVpcAttribute", {
      VpcId: vpcId,
      "EnableDnsHostnames.Value": "true",
    });
    return vpcId;
  }

  private async ensureCarrierGateway(
    parentRegion: string,
    zone: string,
    vpcId: string,
  ): Promise<string> {
    const existing = await this.callRegion(
      parentRegion,
      "DescribeCarrierGateways",
      {
        "Filter.1.Name": "vpc-id",
        "Filter.1.Value.1": vpcId,
      },
    );
    const response = responseNode(existing, "DescribeCarrierGatewaysResponse");
    const gateways = childElements(
      firstChild(response, "carrierGatewaySet"),
      "item",
    );
    for (const gateway of gateways) {
      const state = childText(gateway, "state");
      const id = childText(gateway, "carrierGatewayId");
      if (id && state !== "deleted" && state !== "deleting") return id;
    }

    const created = await this.callRegion(
      parentRegion,
      "CreateCarrierGateway",
      {
        VpcId: vpcId,
      },
    );
    const gatewayId = pathText(
      responseNode(created, "CreateCarrierGatewayResponse"),
      ["carrierGateway", "carrierGatewayId"],
    );
    if (!gatewayId) {
      throw new ProviderError("aws", "CreateCarrierGateway returned no id");
    }
    await this.tagResources(
      parentRegion,
      [gatewayId],
      this.baseTags(zone, "carrier-gateway"),
    );
    return gatewayId;
  }

  private async waitForCarrierGateway(
    parentRegion: string,
    gatewayId: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const root = await this.callRegion(
        parentRegion,
        "DescribeCarrierGateways",
        { "CarrierGatewayId.1": gatewayId },
      );
      const response = responseNode(root, "DescribeCarrierGatewaysResponse");
      const gateway = firstChild(
        firstChild(response, "carrierGatewaySet"),
        "item",
      );
      const state = childText(gateway, "state");
      if (state === "available") return;
      await delay(2000);
    }
  }

  private async ensureSubnet(
    parentRegion: string,
    zone: string,
    vpcId: string,
  ): Promise<string> {
    const name = resourceName(zone, "subnet");
    const existing = await this.callRegion(parentRegion, "DescribeSubnets", {
      "Filter.1.Name": "vpc-id",
      "Filter.1.Value.1": vpcId,
      "Filter.2.Name": "availability-zone",
      "Filter.2.Value.1": zone,
      "Filter.3.Name": "tag:Name",
      "Filter.3.Value.1": name,
    });
    const response = responseNode(existing, "DescribeSubnetsResponse");
    const subnet = firstChild(firstChild(response, "subnetSet"), "item");
    const existingId = childText(subnet, "subnetId");
    if (existingId) return existingId;

    const root = await this.callRegion(parentRegion, "CreateSubnet", {
      VpcId: vpcId,
      CidrBlock: SUBNET_CIDR,
      AvailabilityZone: zone,
    });
    const subnetId = pathText(
      responseNode(root, "CreateSubnetResponse"),
      ["subnet", "subnetId"],
    );
    if (!subnetId) {
      throw new ProviderError("aws", "CreateSubnet returned no SubnetId");
    }
    await this.tagResources(
      parentRegion,
      [subnetId],
      this.baseTags(zone, "subnet"),
    );
    return subnetId;
  }

  private async ensureRouteTable(
    parentRegion: string,
    zone: string,
    vpcId: string,
    subnetId: string,
    carrierGatewayId: string,
  ): Promise<void> {
    const name = resourceName(zone, "route-table");
    const existing = await this.callRegion(
      parentRegion,
      "DescribeRouteTables",
      {
        "Filter.1.Name": "vpc-id",
        "Filter.1.Value.1": vpcId,
        "Filter.2.Name": "tag:Name",
        "Filter.2.Value.1": name,
      },
    );
    const response = responseNode(existing, "DescribeRouteTablesResponse");
    const routeTable = firstChild(
      firstChild(response, "routeTableSet"),
      "item",
    );
    let routeTableId = childText(routeTable, "routeTableId");
    if (!routeTableId) {
      const root = await this.callRegion(parentRegion, "CreateRouteTable", {
        VpcId: vpcId,
      });
      routeTableId = pathText(
        responseNode(root, "CreateRouteTableResponse"),
        ["routeTable", "routeTableId"],
      );
      if (!routeTableId) {
        throw new ProviderError("aws", "CreateRouteTable returned no id");
      }
      await this.tagResources(
        parentRegion,
        [routeTableId],
        this.baseTags(zone, "route-table"),
      );
    }

    try {
      await this.callRegion(parentRegion, "AssociateRouteTable", {
        RouteTableId: routeTableId,
        SubnetId: subnetId,
      });
    } catch (error) {
      if (!isDuplicateOrAlreadyExists(error)) throw error;
    }

    try {
      await this.callRegion(parentRegion, "CreateRoute", {
        RouteTableId: routeTableId,
        DestinationCidrBlock: "0.0.0.0/0",
        CarrierGatewayId: carrierGatewayId,
      });
    } catch (error) {
      if (!isDuplicateOrAlreadyExists(error)) throw error;
    }
  }

  private async ensureSecurityGroup(
    parentRegion: string,
    zone: string,
    vpcId: string,
  ): Promise<string> {
    const name = resourceName(zone, "sg");
    const existing = await this.callRegion(
      parentRegion,
      "DescribeSecurityGroups",
      {
        "Filter.1.Name": "vpc-id",
        "Filter.1.Value.1": vpcId,
        "Filter.2.Name": "group-name",
        "Filter.2.Value.1": name,
      },
    );
    const response = responseNode(existing, "DescribeSecurityGroupsResponse");
    const group = firstChild(firstChild(response, "securityGroupInfo"), "item");
    let groupId = childText(group, "groupId");
    if (!groupId) {
      const root = await this.callRegion(parentRegion, "CreateSecurityGroup", {
        GroupName: name,
        GroupDescription: "DeBot Wavelength minimal instance access",
        VpcId: vpcId,
      });
      groupId = pathText(
        responseNode(root, "CreateSecurityGroupResponse"),
        ["groupId"],
      );
      if (!groupId) {
        throw new ProviderError("aws", "CreateSecurityGroup returned no id");
      }
      await this.tagResources(
        parentRegion,
        [groupId],
        this.baseTags(zone, "sg"),
      );
    }

    try {
      await this.callRegion(parentRegion, "AuthorizeSecurityGroupIngress", {
        GroupId: groupId,
        "IpPermissions.1.IpProtocol": "tcp",
        "IpPermissions.1.FromPort": "22",
        "IpPermissions.1.ToPort": "22",
        "IpPermissions.1.IpRanges.1.CidrIp": "0.0.0.0/0",
        "IpPermissions.1.IpRanges.1.Description": "DeBot SSH",
      });
    } catch (error) {
      if (!isDuplicateOrAlreadyExists(error)) throw error;
    }
    return groupId;
  }

  private async ensureNetwork(
    parentRegion: string,
    zone: string,
  ): Promise<WavelengthNetwork> {
    const vpcId = await this.ensureVpc(parentRegion, zone);
    const carrierGatewayId = await this.ensureCarrierGateway(
      parentRegion,
      zone,
      vpcId,
    );
    await this.waitForCarrierGateway(parentRegion, carrierGatewayId);
    const subnetId = await this.ensureSubnet(parentRegion, zone, vpcId);
    await this.ensureRouteTable(
      parentRegion,
      zone,
      vpcId,
      subnetId,
      carrierGatewayId,
    );
    const securityGroupId = await this.ensureSecurityGroup(
      parentRegion,
      zone,
      vpcId,
    );
    return { vpcId, subnetId, securityGroupId };
  }

  private async latestAmazonLinuxAmi(
    parentRegion: string,
  ): Promise<WavelengthAmi> {
    const root = await this.callRegion(parentRegion, "DescribeImages", {
      "Owner.1": "amazon",
      "Filter.1.Name": "name",
      "Filter.1.Value.1": "al2023-ami-2023.*-kernel-6.1-x86_64",
      "Filter.2.Name": "state",
      "Filter.2.Value.1": "available",
      "Filter.3.Name": "architecture",
      "Filter.3.Value.1": "x86_64",
    });
    const response = responseNode(root, "DescribeImagesResponse");
    const images = childElements(firstChild(response, "imagesSet"), "item")
      .map((item) => {
        const mappings = childElements(
          firstChild(item, "blockDeviceMapping"),
          "item",
        );
        const rootDeviceName = childText(item, "rootDeviceName");
        const rootMapping = mappings.find((mapping) =>
          childText(mapping, "deviceName") === rootDeviceName
        ) ?? mappings[0];
        return {
          imageId: childText(item, "imageId") ?? "",
          creationDate: childText(item, "creationDate") ?? "",
          rootDeviceName,
          rootVolumeSize: parseNumber(pathText(rootMapping, [
            "ebs",
            "volumeSize",
          ])),
        };
      })
      .filter((image) => image.imageId.length > 0)
      .sort((a, b) => b.creationDate.localeCompare(a.creationDate));
    const latest = images[0];
    if (!latest) {
      throw new ProviderError("aws", "no Amazon Linux 2023 AMI found");
    }
    return latest;
  }

  private async selectInstanceType(
    parentRegion: string,
    zone: string,
    requested?: string,
  ): Promise<string> {
    if (requested && requested !== "auto") return requested;
    const root = await this.callRegion(
      parentRegion,
      "DescribeInstanceTypeOfferings",
      {
        LocationType: "availability-zone",
        "Filter.1.Name": "location",
        "Filter.1.Value.1": zone,
      },
    );
    const response = responseNode(
      root,
      "DescribeInstanceTypeOfferingsResponse",
    );
    const offered = new Set(
      childElements(firstChild(response, "instanceTypeOfferingSet"), "item")
        .map((item) => childText(item, "instanceType"))
        .filter((value): value is string => Boolean(value)),
    );
    if (offered.size === 0) return WAVELENGTH_MIN_INSTANCE_TYPE;
    const selected = WAVELENGTH_INSTANCE_TYPE_CANDIDATES.find((type) =>
      offered.has(type)
    );
    if (!selected) {
      throw new ProviderError(
        "aws",
        `no supported minimal Wavelength instance type found in ${zone}`,
      );
    }
    return selected;
  }

  private async waitForCarrierIp(
    parentRegion: string,
    zone: string,
    id: string,
    fallback: Instance,
  ): Promise<Instance> {
    let last = fallback;
    for (let attempt = 0; attempt < 10; attempt++) {
      last = await this.getInstance(id, { region: parentRegion, zone });
      if (last.publicIp) return last;
      await delay(3000);
    }
    return last;
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
      ipv6: false,
      firewall: false,
      customCreate: false,
    };
  }

  getSubscriptionBalance(): Promise<SubscriptionBalance> {
    return this.billing.getSubscriptionBalance();
  }

  async listRegions(): Promise<string[]> {
    const zones = new Set<string>();
    let lastError: unknown;
    for (const parentRegion of this.candidateParentRegions()) {
      try {
        for (const zone of await this.describeWavelengthZones(parentRegion)) {
          zones.add(zone.zoneName);
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (zones.size === 0 && lastError) throw lastError;
    return [...zones].sort();
  }

  async listInstances(opts?: ListOptions): Promise<InstanceList> {
    const selectedZone = isWavelengthZone(opts?.zone)
      ? opts.zone
      : isWavelengthZone(opts?.region)
      ? opts.region
      : this.selectedZone;
    const zones = selectedZone ? [selectedZone] : await this.listRegions();
    const instances: Instance[] = [];
    const byParent = new Map<string, string[]>();
    for (const zone of zones) {
      const parent = parentRegionForZone(zone);
      byParent.set(parent, [...(byParent.get(parent) ?? []), zone]);
    }
    for (const [parentRegion, parentZones] of byParent.entries()) {
      const params: Record<string, string> = {
        "Filter.1.Name": "availability-zone",
      };
      parentZones.forEach((zone, index) => {
        params[`Filter.1.Value.${index + 1}`] = zone;
      });
      const root = await this.callRegion(
        parentRegion,
        "DescribeInstances",
        params,
      );
      const response = responseNode(root, "DescribeInstancesResponse");
      const reservations = childElements(
        firstChild(response, "reservationSet"),
        "item",
      );
      for (const reservation of reservations) {
        for (
          const item of childElements(
            firstChild(reservation, "instancesSet"),
            "item",
          )
        ) {
          instances.push(mapInstance(item, parentRegion));
        }
      }
    }
    return { instances };
  }

  async getInstance(id: string, locator?: InstanceLocator): Promise<Instance> {
    const zone = locator?.zone ?? this.selectedZone;
    const parentRegion = locator?.region ??
      (zone ? parentRegionForZone(zone) : this.region);
    const root = await this.callRegion(parentRegion, "DescribeInstances", {
      "InstanceId.1": id,
    });
    const response = responseNode(root, "DescribeInstancesResponse");
    const reservation = firstChild(
      firstChild(response, "reservationSet"),
      "item",
    );
    const item = firstChild(firstChild(reservation, "instancesSet"), "item");
    if (!item) throw new NotFoundError(`instance ${id} not found`);
    return mapInstance(item, parentRegion);
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    const zone = await this.resolveZone(input);
    const parentRegion = parentRegionForZone(zone);
    await this.ensureZoneOptedIn(zone);
    const network = await this.ensureNetwork(parentRegion, zone);
    const ami = input.image && input.image !== "auto"
      ? { imageId: input.image }
      : await this.latestAmazonLinuxAmi(parentRegion);
    const name = input.name ?? `debot-wl-${Date.now()}`;
    const size = await this.selectInstanceType(parentRegion, zone, input.size);
    const params: Record<string, string> = {
      ImageId: ami.imageId,
      InstanceType: size,
      MinCount: "1",
      MaxCount: "1",
      "Placement.AvailabilityZone": zone,
      "NetworkInterface.1.DeviceIndex": "0",
      "NetworkInterface.1.SubnetId": network.subnetId,
      "NetworkInterface.1.SecurityGroupId.1": network.securityGroupId,
      "NetworkInterface.1.AssociateCarrierIpAddress": "true",
    };
    const rootDeviceName = ami.rootDeviceName ?? "/dev/xvda";
    params["BlockDeviceMapping.1.DeviceName"] = rootDeviceName;
    params["BlockDeviceMapping.1.Ebs.VolumeType"] = "gp2";
    params["BlockDeviceMapping.1.Ebs.DeleteOnTermination"] = "true";
    params["BlockDeviceMapping.1.Ebs.VolumeSize"] = String(
      ami.rootVolumeSize ?? 8,
    );
    if (input.sshKeyId) params.KeyName = input.sshKeyId;
    if (input.userData) params.UserData = btoa(input.userData);

    const instanceTags = {
      CreatedBy: "DeBot",
      Service: "AWS Wavelength",
      WavelengthZone: zone,
      ...(input.tags ?? {}),
      Name: name,
    };
    paramsWithTags(params, 1, "instance", instanceTags);
    paramsWithTags(params, 2, "volume", {
      CreatedBy: "DeBot",
      Service: "AWS Wavelength",
      WavelengthZone: zone,
      Name: `${name}-root`,
    });

    let root: XmlElement;
    try {
      root = await this.callRegion(parentRegion, "RunInstances", params);
    } catch (error) {
      if (
        error instanceof ProviderError && /Free Tier/i.test(error.message)
      ) {
        throw new ProviderError("aws", error.message, {
          status: error.status,
          userMessage:
            "AWS Wavelength 的最小可用规格不是 Free Tier 规格；当前 AWS 账号限制为只能开通 Free Tier eligible 实例，无法创建 Wavelength 机器。",
        });
      }
      throw error;
    }
    const response = responseNode(root, "RunInstancesResponse");
    const item = firstChild(firstChild(response, "instancesSet"), "item");
    if (!item) {
      throw new ProviderError("aws", "RunInstances returned no instance");
    }
    const instance = mapInstance(item, parentRegion);
    return await this.waitForCarrierIp(
      parentRegion,
      zone,
      instance.id,
      instance,
    );
  }

  async startInstance(id: string, locator?: InstanceLocator): Promise<void> {
    await this.callRegion(locator?.region ?? this.region, "StartInstances", {
      "InstanceId.1": id,
    });
  }

  async stopInstance(id: string, locator?: InstanceLocator): Promise<void> {
    await this.callRegion(locator?.region ?? this.region, "StopInstances", {
      "InstanceId.1": id,
    });
  }

  async rebootInstance(id: string, locator?: InstanceLocator): Promise<void> {
    await this.callRegion(locator?.region ?? this.region, "RebootInstances", {
      "InstanceId.1": id,
    });
  }

  async deleteInstance(id: string, locator?: InstanceLocator): Promise<void> {
    await this.callRegion(
      locator?.region ?? this.region,
      "TerminateInstances",
      {
        "InstanceId.1": id,
      },
    );
  }

  async renameInstance(
    id: string,
    name: string,
    locator?: InstanceLocator,
  ): Promise<void> {
    await this.callRegion(locator?.region ?? this.region, "CreateTags", {
      "ResourceId.1": id,
      "Tag.1.Key": "Name",
      "Tag.1.Value": name,
    });
  }
}
