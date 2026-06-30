import { assert, assertEquals } from "@std/assert";
import type { FetchLike } from "../../http.ts";
import { WavelengthAdapter } from "./wavelength.ts";

interface Captured {
  action: string;
  body: string;
  url: string;
}

function okXml(name: string, inner = ""): Response {
  return new Response(`<${name}>${inner}</${name}>`, { status: 200 });
}

function actionFrom(init?: RequestInit): string {
  return new URLSearchParams(String(init?.body ?? "")).get("Action") ?? "";
}

function adapterWith(fakeFetch: FetchLike, defaultRegion = "us-east-1") {
  return new WavelengthAdapter({
    credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    defaultRegion,
    fetch: fakeFetch,
  });
}

Deno.test("WavelengthAdapter lists US Wavelength zones", async () => {
  const fakeFetch: FetchLike = (input, init) => {
    const action = actionFrom(init);
    if (action !== "DescribeAvailabilityZones") {
      return Promise.reject(new Error(`unexpected action ${action}`));
    }
    const url = String(input);
    if (url.includes("ec2.us-west-2.")) {
      return Promise.resolve(okXml(
        "DescribeAvailabilityZonesResponse",
        `<availabilityZoneInfo>
          <item>
            <zoneName>us-west-2-wl1-las-wlz-1</zoneName>
            <zoneType>wavelength-zone</zoneType>
            <optInStatus>not-opted-in</optInStatus>
            <groupName>us-west-2-wl1-las-wlz-1</groupName>
          </item>
        </availabilityZoneInfo>`,
      ));
    }
    return Promise.resolve(okXml(
      "DescribeAvailabilityZonesResponse",
      `<availabilityZoneInfo>
        <item>
          <zoneName>us-east-1-wl1-bos-wlz-1</zoneName>
          <zoneType>wavelength-zone</zoneType>
          <optInStatus>opted-in</optInStatus>
          <groupName>us-east-1-wl1-bos-wlz-1</groupName>
        </item>
        <item>
          <zoneName>us-east-1a</zoneName>
          <zoneType>availability-zone</zoneType>
        </item>
      </availabilityZoneInfo>`,
    ));
  };

  const zones = await adapterWith(fakeFetch).listRegions();

  assertEquals(zones, [
    "us-east-1-wl1-bos-wlz-1",
    "us-west-2-wl1-las-wlz-1",
  ]);
});

Deno.test("WavelengthAdapter resolves parent region for nonstandard Wavelength zone names", async () => {
  const calls: Captured[] = [];
  const fakeFetch: FetchLike = (input, init) => {
    const body = String(init?.body ?? "");
    const action = actionFrom(init);
    calls.push({ action, body, url: String(input) });
    assertEquals(action, "DescribeInstances");
    return Promise.resolve(okXml(
      "DescribeInstancesResponse",
      `<reservationSet>
        <item>
          <instancesSet>
            <item>
              <instanceId>i-foe</instanceId>
              <instanceState><name>running</name></instanceState>
              <placement><availabilityZone>us-east-1-foe-wlz-1a</availabilityZone></placement>
            </item>
          </instancesSet>
        </item>
      </reservationSet>`,
    ));
  };

  const list = await adapterWith(
    fakeFetch,
    "us-east-1-foe-wlz-1a",
  ).listInstances();

  assertEquals(list.instances[0].zone, "us-east-1-foe-wlz-1a");
  assertEquals(calls[0].url, "https://ec2.us-east-1.amazonaws.com/");
});

Deno.test("WavelengthAdapter creates a minimal instance with carrier IP networking", async () => {
  const calls: Captured[] = [];
  const fakeFetch: FetchLike = (input, init) => {
    const body = String(init?.body ?? "");
    const action = actionFrom(init);
    calls.push({ action, body, url: String(input) });
    switch (action) {
      case "DescribeAvailabilityZones":
        return Promise.resolve(okXml(
          "DescribeAvailabilityZonesResponse",
          `<availabilityZoneInfo>
            <item>
              <zoneName>us-east-1-wl1-bos-wlz-1</zoneName>
              <zoneType>wavelength-zone</zoneType>
              <optInStatus>opted-in</optInStatus>
              <groupName>us-east-1-wl1-bos-wlz-1</groupName>
            </item>
          </availabilityZoneInfo>`,
        ));
      case "DescribeVpcs":
        return Promise.resolve(okXml("DescribeVpcsResponse", "<vpcSet/>"));
      case "CreateVpc":
        return Promise.resolve(okXml(
          "CreateVpcResponse",
          "<vpc><vpcId>vpc-1</vpcId></vpc>",
        ));
      case "CreateTags":
      case "ModifyVpcAttribute":
      case "AssociateRouteTable":
      case "CreateRoute":
      case "AuthorizeSecurityGroupIngress":
        return Promise.resolve(okXml(`${action}Response`));
      case "DescribeCarrierGateways":
        if (body.includes("CarrierGatewayId.1")) {
          return Promise.resolve(okXml(
            "DescribeCarrierGatewaysResponse",
            `<carrierGatewaySet>
              <item>
                <carrierGatewayId>cagw-1</carrierGatewayId>
                <state>available</state>
              </item>
            </carrierGatewaySet>`,
          ));
        }
        return Promise.resolve(okXml(
          "DescribeCarrierGatewaysResponse",
          "<carrierGatewaySet/>",
        ));
      case "CreateCarrierGateway":
        return Promise.resolve(okXml(
          "CreateCarrierGatewayResponse",
          "<carrierGateway><carrierGatewayId>cagw-1</carrierGatewayId></carrierGateway>",
        ));
      case "DescribeSubnets":
        return Promise.resolve(
          okXml("DescribeSubnetsResponse", "<subnetSet/>"),
        );
      case "CreateSubnet":
        return Promise.resolve(okXml(
          "CreateSubnetResponse",
          "<subnet><subnetId>subnet-1</subnetId></subnet>",
        ));
      case "DescribeRouteTables":
        return Promise.resolve(okXml(
          "DescribeRouteTablesResponse",
          "<routeTableSet/>",
        ));
      case "CreateRouteTable":
        return Promise.resolve(okXml(
          "CreateRouteTableResponse",
          "<routeTable><routeTableId>rtb-1</routeTableId></routeTable>",
        ));
      case "DescribeSecurityGroups":
        return Promise.resolve(okXml(
          "DescribeSecurityGroupsResponse",
          "<securityGroupInfo/>",
        ));
      case "CreateSecurityGroup":
        return Promise.resolve(okXml(
          "CreateSecurityGroupResponse",
          "<groupId>sg-1</groupId>",
        ));
      case "DescribeImages":
        return Promise.resolve(okXml(
          "DescribeImagesResponse",
          `<imagesSet>
            <item>
              <imageId>ami-latest</imageId>
              <name>al2023-ami-2023.8.20260623.0-kernel-6.1-x86_64</name>
              <creationDate>2026-06-23T00:00:00.000Z</creationDate>
              <rootDeviceName>/dev/xvda</rootDeviceName>
              <blockDeviceMapping>
                <item>
                  <deviceName>/dev/xvda</deviceName>
                  <ebs><volumeSize>8</volumeSize></ebs>
                </item>
              </blockDeviceMapping>
            </item>
          </imagesSet>`,
        ));
      case "DescribeInstanceTypeOfferings":
        return Promise.resolve(okXml(
          "DescribeInstanceTypeOfferingsResponse",
          `<instanceTypeOfferingSet>
            <item>
              <instanceType>t3.medium</instanceType>
              <locationType>availability-zone</locationType>
              <location>us-east-1-wl1-bos-wlz-1</location>
            </item>
          </instanceTypeOfferingSet>`,
        ));
      case "RunInstances":
        return Promise.resolve(okXml(
          "RunInstancesResponse",
          `<instancesSet>
            <item>
              <instanceId>i-wl</instanceId>
              <instanceType>t3.medium</instanceType>
              <imageId>ami-latest</imageId>
              <instanceState><name>pending</name></instanceState>
              <placement><availabilityZone>us-east-1-wl1-bos-wlz-1</availabilityZone></placement>
            </item>
          </instancesSet>`,
        ));
      case "DescribeInstances":
        return Promise.resolve(okXml(
          "DescribeInstancesResponse",
          `<reservationSet>
            <item>
              <instancesSet>
                <item>
                  <instanceId>i-wl</instanceId>
                  <instanceType>t3.medium</instanceType>
                  <imageId>ami-latest</imageId>
                  <instanceState><name>running</name></instanceState>
                  <privateIpAddress>10.64.1.10</privateIpAddress>
                  <placement><availabilityZone>us-east-1-wl1-bos-wlz-1</availabilityZone></placement>
                  <networkInterfaceSet>
                    <item>
                      <association><carrierIp>155.146.10.20</carrierIp></association>
                    </item>
                  </networkInterfaceSet>
                  <tagSet><item><key>Name</key><value>edge</value></item></tagSet>
                </item>
              </instancesSet>
            </item>
          </reservationSet>`,
        ));
      default:
        return Promise.reject(new Error(`unexpected action ${action}`));
    }
  };

  const created = await adapterWith(
    fakeFetch,
    "us-east-1-wl1-bos-wlz-1",
  ).createInstance({
    name: "edge",
    image: "auto",
    size: "auto",
  });

  assertEquals(created.id, "i-wl");
  assertEquals(created.zone, "us-east-1-wl1-bos-wlz-1");
  assertEquals(created.publicIp, "155.146.10.20");

  const run = calls.find((call) => call.action === "RunInstances");
  assert(run);
  assert(run.body.includes("ImageId=ami-latest"));
  assert(run.body.includes("InstanceType=t3.medium"));
  assert(
    run.body.includes("Placement.AvailabilityZone=us-east-1-wl1-bos-wlz-1"),
  );
  assert(run.body.includes("NetworkInterface.1.SubnetId=subnet-1"));
  assert(run.body.includes("NetworkInterface.1.SecurityGroupId.1=sg-1"));
  assert(
    run.body.includes("NetworkInterface.1.AssociateCarrierIpAddress=true"),
  );
  assert(run.body.includes("BlockDeviceMapping.1.Ebs.VolumeType=gp2"));

  const route = calls.find((call) => call.action === "CreateRoute");
  assert(route?.body.includes("CarrierGatewayId=cagw-1"));
});
