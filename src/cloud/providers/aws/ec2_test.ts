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
    AssignIpv6Addresses: assignIpv6,
  });
  const adapter = adapterWith(fakeFetch);
  const address = await adapter.addPublicIpv6("i-0abc");
  assertEquals(address, "2600:1f16:abcd::5");
  const actions = calls.map((call) => actionFromBody(String(call.init?.body)));
  assert(actions.includes("DescribeInstances"));
  assert(actions.includes("DescribeVpcs"));
  assert(actions.includes("DescribeSubnets"));
  assert(actions.includes("AssignIpv6Addresses"));
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
    AssignIpv6Addresses: assignIpv6,
  });
  const adapter = adapterWith(fakeFetch);
  const address = await adapter.addPublicIpv6("i-0abc");
  assertEquals(address, "2600:1f16:abcd::5");
  const actions = calls.map((call) => actionFromBody(String(call.init?.body)));
  assert(actions.includes("AssociateSubnetCidrBlock"));
  assert(!actions.includes("AssociateVpcCidrBlock"));
});

Deno.test("Ec2Adapter addPublicIpv6 returns existing IPv6 without changes", async () => {
  const describeInstances = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet><item><instancesSet><item>
    <instanceId>i-0abc</instanceId>
    <networkInterfaceSet><item>
      <networkInterfaceId>eni-1</networkInterfaceId>
      <vpcId>vpc-1</vpcId>
      <subnetId>subnet-1</subnetId>
      <ipv6sSet><item>2600:1f16:abcd::existing</item></ipv6sSet>
    </item></networkInterfaceSet>
  </item></instancesSet></item></reservationSet>
</DescribeInstancesResponse>`;
  const { calls, fakeFetch } = sequenceRecorder({
    DescribeInstances: describeInstances,
  });
  const adapter = adapterWith(fakeFetch);
  const address = await adapter.addPublicIpv6("i-0abc");
  assertEquals(address, "2600:1f16:abcd::existing");
  assertEquals(calls.length, 1);
});
