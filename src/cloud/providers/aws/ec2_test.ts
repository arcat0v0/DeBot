import { assert, assertEquals } from "@std/assert";
import { Ec2Adapter } from "./ec2.ts";
import type { FetchLike } from "../../http.ts";

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet>
    <item>
      <instancesSet>
        <item>
          <instanceId>i-0abc</instanceId>
          <instanceType>t3.micro</instanceType>
          <imageId>ami-123</imageId>
          <instanceState><code>16</code><name>running</name></instanceState>
          <privateIpAddress>10.0.0.7</privateIpAddress>
          <ipAddress>54.0.0.7</ipAddress>
          <placement><availabilityZone>us-east-1a</availabilityZone></placement>
          <networkInterfaceSet>
            <item>
              <ipv6AddressesSet>
                <item><ipv6Address>2600:1f18:abcd::7</ipv6Address></item>
              </ipv6AddressesSet>
            </item>
          </networkInterfaceSet>
          <launchTime>2024-05-01T00:00:00.000Z</launchTime>
          <tagSet><item><key>Name</key><value>api</value></item></tagSet>
        </item>
      </instancesSet>
    </item>
  </reservationSet>
</DescribeInstancesResponse>`;

interface Captured {
  url: string;
  init?: RequestInit;
}

function recorder(responseBody: string, status = 200) {
  const calls: Captured[] = [];
  const fakeFetch: FetchLike = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(responseBody, {
        status,
        headers: { "content-type": "text/xml" },
      }),
    );
  };
  return { calls, fakeFetch };
}

function adapterWith(fakeFetch: FetchLike) {
  return new Ec2Adapter({
    credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    defaultRegion: "us-east-1",
    fetch: fakeFetch,
  });
}

Deno.test("Ec2Adapter lists and maps instances", async () => {
  const { calls, fakeFetch } = recorder(LIST_XML);
  const adapter = adapterWith(fakeFetch);
  const list = await adapter.listInstances();

  assertEquals(list.instances.length, 1);
  const instance = list.instances[0];
  assertEquals(instance.id, "i-0abc");
  assertEquals(instance.name, "api");
  assertEquals(instance.state, "running");
  assertEquals(instance.zone, "us-east-1a");
  assertEquals(instance.publicIp, "54.0.0.7");
  assertEquals(instance.publicIpv6, "2600:1f18:abcd::7");

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://ec2.us-east-1.amazonaws.com/");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert(headers.authorization.startsWith("AWS4-HMAC-SHA256 Credential=AKIA/"));
  assert(String(calls[0].init?.body).includes("Action=DescribeInstances"));
});

Deno.test("Ec2Adapter maps Wavelength carrier IP addresses", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
    <reservationSet>
      <item>
        <instancesSet>
          <item>
            <instanceId>i-wl</instanceId>
            <instanceType>t3.medium</instanceType>
            <imageId>ami-123</imageId>
            <instanceState><name>running</name></instanceState>
            <privateIpAddress>10.64.1.10</privateIpAddress>
            <placement><availabilityZone>us-east-1-wl1-bos-wlz-1</availabilityZone></placement>
            <networkInterfaceSet>
              <item>
                <association><carrierIp>155.146.10.20</carrierIp></association>
              </item>
            </networkInterfaceSet>
          </item>
        </instancesSet>
      </item>
    </reservationSet>
  </DescribeInstancesResponse>`;
  const { fakeFetch } = recorder(xml);
  const adapter = adapterWith(fakeFetch);
  const list = await adapter.listInstances();

  assertEquals(list.instances[0].publicIp, "155.146.10.20");
});

Deno.test("Ec2Adapter issues signed start requests", async () => {
  const ok =
    `<StartInstancesResponse xmlns="x"><instancesSet/></StartInstancesResponse>`;
  const { calls, fakeFetch } = recorder(ok);
  const adapter = adapterWith(fakeFetch);
  await adapter.startInstance("i-0abc");
  const body = String(calls[0].init?.body);
  assert(body.includes("Action=StartInstances"));
  assert(body.includes("InstanceId.1=i-0abc"));
});

Deno.test("Ec2Adapter surfaces AWS error XML", async () => {
  const errorXml =
    `<Response><Errors><Error><Code>AuthFailure</Code><Message>bad key</Message></Error></Errors></Response>`;
  const { fakeFetch } = recorder(errorXml, 401);
  const adapter = adapterWith(fakeFetch);
  let threw = false;
  try {
    await adapter.listInstances();
  } catch (error) {
    threw = true;
    assert(String(error).includes("AuthFailure"));
  }
  assert(threw, "expected an error to be thrown");
});

Deno.test("Ec2Adapter builds RunInstances params from a preset", async () => {
  const runXml =
    `<RunInstancesResponse xmlns="x"><instancesSet><item><instanceId>i-new</instanceId><instanceState><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>`;
  const { calls, fakeFetch } = recorder(runXml);
  const adapter = adapterWith(fakeFetch);
  const created = await adapter.createInstance({
    name: "worker",
    image: "ami-123",
    size: "t3.small",
    sshKeyId: "mykey",
    tags: { env: "prod" },
  });
  assertEquals(created.id, "i-new");
  const body = String(calls[0].init?.body);
  assert(body.includes("Action=RunInstances"));
  assert(body.includes("ImageId=ami-123"));
  assert(body.includes("KeyName=mykey"));
  assert(body.includes("TagSpecification.1.Tag.1.Key=Name"));
});
function actionFromBody(body: string): string {
  const params = new URLSearchParams(body);
  return params.get("Action") ?? "";
}

function sequenceRecorder(responses: Record<string, string>) {
  const calls: Captured[] = [];
  const fakeFetch: FetchLike = (input, init) => {
    calls.push({ url: String(input), init });
    const action = actionFromBody(String(init?.body ?? ""));
    const body = responses[action] ?? "<ok/>";
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/xml" },
      }),
    );
  };
  return { calls, fakeFetch };
}

const ROUTE_TABLE_WITH_IGW = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeRouteTablesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <routeTableSet><item>
    <routeTableId>rtb-1</routeTableId>
    <routeSet><item>
      <destinationCidrBlock>0.0.0.0/0</destinationCidrBlock>
      <gatewayId>igw-1</gatewayId>
    </item></routeSet>
  </item></routeTableSet>
</DescribeRouteTablesResponse>`;

const ROUTE_TABLE_WITH_IPV6 = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeRouteTablesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <routeTableSet><item>
    <routeTableId>rtb-1</routeTableId>
    <routeSet>
      <item>
        <destinationCidrBlock>0.0.0.0/0</destinationCidrBlock>
        <gatewayId>igw-1</gatewayId>
      </item>
      <item>
        <destinationIpv6CidrBlock>::/0</destinationIpv6CidrBlock>
        <gatewayId>igw-1</gatewayId>
      </item>
    </routeSet>
  </item></routeTableSet>
</DescribeRouteTablesResponse>`;

const INSTANCE_WITH_SECURITY_GROUP = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet><item><instancesSet><item>
    <instanceId>i-0abc</instanceId>
    <groupSet><item><groupId>sg-1</groupId></item></groupSet>
    <networkInterfaceSet><item>
      <groupSet><item><groupId>sg-1</groupId></item></groupSet>
    </item></networkInterfaceSet>
  </item></instancesSet></item></reservationSet>
</DescribeInstancesResponse>`;

const SECURITY_GROUP_RULES = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeSecurityGroupRulesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <securityGroupRuleSet>
    <item>
      <securityGroupRuleId>sgr-1</securityGroupRuleId>
      <groupId>sg-1</groupId>
      <isEgress>false</isEgress>
      <ipProtocol>tcp</ipProtocol>
      <fromPort>22</fromPort>
      <toPort>22</toPort>
      <cidrIpv4>0.0.0.0/0</cidrIpv4>
      <description>ssh</description>
    </item>
    <item>
      <securityGroupRuleId>sgr-2</securityGroupRuleId>
      <groupId>sg-1</groupId>
      <isEgress>false</isEgress>
      <ipProtocol>-1</ipProtocol>
      <cidrIpv6>::/0</cidrIpv6>
      <description>all-v6</description>
    </item>
    <item>
      <securityGroupRuleId>sgr-egress</securityGroupRuleId>
      <groupId>sg-1</groupId>
      <isEgress>true</isEgress>
      <ipProtocol>-1</ipProtocol>
      <cidrIpv4>0.0.0.0/0</cidrIpv4>
    </item>
  </securityGroupRuleSet>
</DescribeSecurityGroupRulesResponse>`;

Deno.test("Ec2Adapter lists inbound security group rules", async () => {
  const { calls, fakeFetch } = sequenceRecorder({
    DescribeInstances: INSTANCE_WITH_SECURITY_GROUP,
    DescribeSecurityGroupRules: SECURITY_GROUP_RULES,
  });
  const adapter = adapterWith(fakeFetch);
  const rules = await adapter.listFirewallRules("i-0abc");

  assertEquals(rules.length, 2);
  assertEquals(rules[0], {
    id: "sgr-1",
    name: "ssh",
    direction: "Inbound",
    access: "Allow",
    protocol: "Tcp",
    source: "0.0.0.0/0",
    ports: "22",
    description: "ssh",
  });
  assertEquals(rules[1].protocol, "*");
  assertEquals(rules[1].source, "::/0");
  assertEquals(rules[1].ports, "*");
  const rulesBody = String(
    calls.find((call) =>
      actionFromBody(String(call.init?.body)) === "DescribeSecurityGroupRules"
    )?.init?.body,
  );
  assert(rulesBody.includes("Filter.1.Name=group-id"));
  assert(rulesBody.includes("Filter.1.Value.1=sg-1"));
});

Deno.test("Ec2Adapter adds IPv4 and IPv6 firewall rules and deletes by rule id", async () => {
  const { calls, fakeFetch } = sequenceRecorder({
    DescribeInstances: INSTANCE_WITH_SECURITY_GROUP,
    AuthorizeSecurityGroupIngress: "<AuthorizeSecurityGroupIngressResponse/>",
    RevokeSecurityGroupIngress: "<RevokeSecurityGroupIngressResponse/>",
  });
  const adapter = adapterWith(fakeFetch);
  await adapter.addFirewallRule("i-0abc", {
    name: "web",
    protocol: "Tcp",
    port: "443",
    source: "*",
    description: "web",
  });
  await adapter.deleteFirewallRule("i-0abc", "sgr-1");

  const authorizeBodies = calls
    .filter((call) =>
      actionFromBody(String(call.init?.body)) ===
        "AuthorizeSecurityGroupIngress"
    )
    .map((call) => String(call.init?.body));
  assertEquals(authorizeBodies.length, 2);
  assert(authorizeBodies[0].includes("GroupId=sg-1"));
  assert(authorizeBodies[0].includes("IpPermissions.1.IpProtocol=tcp"));
  assert(authorizeBodies[0].includes("IpPermissions.1.FromPort=443"));
  assert(authorizeBodies[0].includes("IpPermissions.1.ToPort=443"));
  assert(
    authorizeBodies[0].includes(
      "IpPermissions.1.IpRanges.1.CidrIp=0.0.0.0%2F0",
    ),
  );
  assert(
    authorizeBodies[1].includes(
      "IpPermissions.1.Ipv6Ranges.1.CidrIpv6=%3A%3A%2F0",
    ),
  );
  const revokeBody = String(
    calls.find((call) =>
      actionFromBody(String(call.init?.body)) === "RevokeSecurityGroupIngress"
    )?.init?.body,
  );
  assert(!revokeBody.includes("GroupId="));
  assert(revokeBody.includes("SecurityGroupRuleId.1=sgr-1"));
});

Deno.test("Ec2Adapter allowAllInboundTraffic opens IPv4 and IPv6 all inbound", async () => {
  const emptyRules = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeSecurityGroupRulesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <securityGroupRuleSet/>
</DescribeSecurityGroupRulesResponse>`;
  const { calls, fakeFetch } = sequenceRecorder({
    DescribeInstances: INSTANCE_WITH_SECURITY_GROUP,
    DescribeSecurityGroupRules: emptyRules,
    AuthorizeSecurityGroupIngress: "<AuthorizeSecurityGroupIngressResponse/>",
  });
  const adapter = adapterWith(fakeFetch);
  await adapter.allowAllInboundTraffic("i-0abc");

  const authorizeBodies = calls
    .filter((call) =>
      actionFromBody(String(call.init?.body)) ===
        "AuthorizeSecurityGroupIngress"
    )
    .map((call) => String(call.init?.body));
  assertEquals(authorizeBodies.length, 2);
  assert(authorizeBodies[0].includes("IpPermissions.1.IpProtocol=-1"));
  assert(
    authorizeBodies[0].includes(
      "IpPermissions.1.IpRanges.1.CidrIp=0.0.0.0%2F0",
    ),
  );
  assert(
    authorizeBodies[1].includes(
      "IpPermissions.1.Ipv6Ranges.1.CidrIpv6=%3A%3A%2F0",
    ),
  );
});

Deno.test("Ec2Adapter addPublicIpv6 assigns an address when none exists", async () => {
  const describeInstances = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet><item><instancesSet><item>
    <instanceId>i-0abc</instanceId>
    <networkInterfaceSet><item>
      <networkInterfaceId>eni-1</networkInterfaceId>
      <vpcId>vpc-1</vpcId>
      <subnetId>subnet-1</subnetId>
    </item></networkInterfaceSet>
  </item></instancesSet></item></reservationSet>
</DescribeInstancesResponse>`;
  const describeVpcs = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeVpcsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <vpcSet><item>
    <vpcId>vpc-1</vpcId>
    <ipv6CidrBlockAssociationSet>
      <item><ipv6CidrBlock>2600:1f16:abcd::/56</ipv6CidrBlock></item>
    </ipv6CidrBlockAssociationSet>
  </item></vpcSet>
</DescribeVpcsResponse>`;
  const describeSubnets = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeSubnetsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <subnetSet><item>
    <subnetId>subnet-1</subnetId>
    <ipv6CidrBlockAssociationSet>
      <item><ipv6CidrBlock>2600:1f16:abcd::/64</ipv6CidrBlock></item>
    </ipv6CidrBlockAssociationSet>
  </item></subnetSet>
</DescribeSubnetsResponse>`;
  const assignIpv6 = `<?xml version="1.0" encoding="UTF-8"?>
<AssignIpv6AddressesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <assignedIpv6Addresses><item>2600:1f16:abcd::5</item></assignedIpv6Addresses>
</AssignIpv6AddressesResponse>`;
  const { calls, fakeFetch } = sequenceRecorder({
    DescribeInstances: describeInstances,
    DescribeVpcs: describeVpcs,
    DescribeSubnets: describeSubnets,
    DescribeRouteTables: ROUTE_TABLE_WITH_IGW,
    CreateRoute: "<CreateRouteResponse/>",
    AssignIpv6Addresses: assignIpv6,
  });
  const adapter = adapterWith(fakeFetch);
  const address = await adapter.addPublicIpv6("i-0abc");
  assertEquals(address, "2600:1f16:abcd::5");
  const actions = calls.map((call) => actionFromBody(String(call.init?.body)));
  assert(actions.includes("DescribeInstances"));
  assert(actions.includes("DescribeVpcs"));
  assert(actions.includes("DescribeSubnets"));
  assert(actions.includes("DescribeRouteTables"));
  assert(actions.includes("CreateRoute"));
  assert(actions.includes("AssignIpv6Addresses"));
  const routeBody = String(
    calls.find((c) => actionFromBody(String(c.init?.body)) === "CreateRoute")
      ?.init?.body,
  );
  assert(routeBody.includes("RouteTableId=rtb-1"));
  assert(routeBody.includes("DestinationIpv6CidrBlock=%3A%3A%2F0"));
  assert(routeBody.includes("GatewayId=igw-1"));
  const assignBody = String(
    calls.find((c) =>
      actionFromBody(String(c.init?.body)) === "AssignIpv6Addresses"
    )?.init?.body,
  );
  assert(assignBody.includes("NetworkInterfaceId=eni-1"));
  assert(assignBody.includes("Ipv6AddressCount=1"));
});

Deno.test("Ec2Adapter addPublicIpv6 associates CIDRs when missing", async () => {
  const describeInstances = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet><item><instancesSet><item>
    <instanceId>i-0abc</instanceId>
    <networkInterfaceSet><item>
      <networkInterfaceId>eni-1</networkInterfaceId>
      <vpcId>vpc-1</vpcId>
      <subnetId>subnet-1</subnetId>
    </item></networkInterfaceSet>
  </item></instancesSet></item></reservationSet>
</DescribeInstancesResponse>`;
  const describeVpcs = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeVpcsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <vpcSet><item>
    <vpcId>vpc-1</vpcId>
    <ipv6CidrBlockAssociationSet>
      <item><ipv6CidrBlock>2600:1f16:abcd::/56</ipv6CidrBlock></item>
    </ipv6CidrBlockAssociationSet>
  </item></vpcSet>
</DescribeVpcsResponse>`;
  const describeSubnets = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeSubnetsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <subnetSet><item>
    <subnetId>subnet-1</subnetId>
  </item></subnetSet>
</DescribeSubnetsResponse>`;
  const assignIpv6 = `<?xml version="1.0" encoding="UTF-8"?>
<AssignIpv6AddressesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <assignedIpv6Addresses><item>2600:1f16:abcd::5</item></assignedIpv6Addresses>
</AssignIpv6AddressesResponse>`;
  const { calls, fakeFetch } = sequenceRecorder({
    DescribeInstances: describeInstances,
    DescribeVpcs: describeVpcs,
    DescribeSubnets: describeSubnets,
    AssociateVpcCidrBlock: "<AssociateVpcCidrBlockResponse/>",
    AssociateSubnetCidrBlock: "<AssociateSubnetCidrBlockResponse/>",
    DescribeRouteTables: ROUTE_TABLE_WITH_IPV6,
    AssignIpv6Addresses: assignIpv6,
  });
  const adapter = adapterWith(fakeFetch);
  const address = await adapter.addPublicIpv6("i-0abc");
  assertEquals(address, "2600:1f16:abcd::5");
  const actions = calls.map((call) => actionFromBody(String(call.init?.body)));
  assert(actions.includes("AssociateSubnetCidrBlock"));
  assert(!actions.includes("AssociateVpcCidrBlock"));
  assert(actions.includes("DescribeRouteTables"));
  assert(!actions.includes("CreateRoute"));
});

Deno.test("Ec2Adapter addPublicIpv6 returns existing IPv6 after ensuring route", async () => {
  const describeInstances = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet><item><instancesSet><item>
    <instanceId>i-0abc</instanceId>
    <networkInterfaceSet><item>
      <networkInterfaceId>eni-1</networkInterfaceId>
      <vpcId>vpc-1</vpcId>
      <subnetId>subnet-1</subnetId>
      <ipv6AddressesSet>
        <item><ipv6Address>2600:1f16:abcd::existing</ipv6Address></item>
      </ipv6AddressesSet>
    </item></networkInterfaceSet>
  </item></instancesSet></item></reservationSet>
</DescribeInstancesResponse>`;
  const describeVpcs = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeVpcsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <vpcSet><item>
    <vpcId>vpc-1</vpcId>
    <ipv6CidrBlockAssociationSet>
      <item><ipv6CidrBlock>2600:1f16:abcd::/56</ipv6CidrBlock></item>
    </ipv6CidrBlockAssociationSet>
  </item></vpcSet>
</DescribeVpcsResponse>`;
  const describeSubnets = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeSubnetsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <subnetSet><item>
    <subnetId>subnet-1</subnetId>
    <ipv6CidrBlockAssociationSet>
      <item><ipv6CidrBlock>2600:1f16:abcd::/64</ipv6CidrBlock></item>
    </ipv6CidrBlockAssociationSet>
  </item></subnetSet>
</DescribeSubnetsResponse>`;
  const { calls, fakeFetch } = sequenceRecorder({
    DescribeInstances: describeInstances,
    DescribeVpcs: describeVpcs,
    DescribeSubnets: describeSubnets,
    DescribeRouteTables: ROUTE_TABLE_WITH_IGW,
    CreateRoute: "<CreateRouteResponse/>",
  });
  const adapter = adapterWith(fakeFetch);
  const address = await adapter.addPublicIpv6("i-0abc");
  assertEquals(address, "2600:1f16:abcd::existing");
  const actions = calls.map((call) => actionFromBody(String(call.init?.body)));
  assert(actions.includes("CreateRoute"));
  assert(!actions.includes("AssignIpv6Addresses"));
});

Deno.test("Ec2Adapter addPublicIpv6 reads assigned IPv6 from network interface fallback", async () => {
  const describeInstances = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet><item><instancesSet><item>
    <instanceId>i-0abc</instanceId>
    <networkInterfaceSet><item>
      <networkInterfaceId>eni-1</networkInterfaceId>
      <vpcId>vpc-1</vpcId>
      <subnetId>subnet-1</subnetId>
    </item></networkInterfaceSet>
  </item></instancesSet></item></reservationSet>
</DescribeInstancesResponse>`;
  const describeVpcs = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeVpcsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <vpcSet><item>
    <vpcId>vpc-1</vpcId>
    <ipv6CidrBlockAssociationSet>
      <item><ipv6CidrBlock>2600:1f16:abcd::/56</ipv6CidrBlock></item>
    </ipv6CidrBlockAssociationSet>
  </item></vpcSet>
</DescribeVpcsResponse>`;
  const describeSubnets = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeSubnetsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <subnetSet><item>
    <subnetId>subnet-1</subnetId>
    <ipv6CidrBlockAssociationSet>
      <item><ipv6CidrBlock>2600:1f16:abcd::/64</ipv6CidrBlock></item>
    </ipv6CidrBlockAssociationSet>
  </item></subnetSet>
</DescribeSubnetsResponse>`;
  const assignIpv6 = `<?xml version="1.0" encoding="UTF-8"?>
<AssignIpv6AddressesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <networkInterfaceId>eni-1</networkInterfaceId>
</AssignIpv6AddressesResponse>`;
  const describeEni = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeNetworkInterfacesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <networkInterfaceSet><item>
    <networkInterfaceId>eni-1</networkInterfaceId>
    <ipv6AddressesSet>
      <item><ipv6Address>2600:1f16:abcd::fallback</ipv6Address></item>
    </ipv6AddressesSet>
  </item></networkInterfaceSet>
</DescribeNetworkInterfacesResponse>`;
  const { calls, fakeFetch } = sequenceRecorder({
    DescribeInstances: describeInstances,
    DescribeVpcs: describeVpcs,
    DescribeSubnets: describeSubnets,
    DescribeRouteTables: ROUTE_TABLE_WITH_IPV6,
    AssignIpv6Addresses: assignIpv6,
    DescribeNetworkInterfaces: describeEni,
  });
  const adapter = adapterWith(fakeFetch);
  const address = await adapter.addPublicIpv6("i-0abc");
  assertEquals(address, "2600:1f16:abcd::fallback");
  const actions = calls.map((call) => actionFromBody(String(call.init?.body)));
  assert(actions.includes("DescribeNetworkInterfaces"));
});
