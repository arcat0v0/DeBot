import { assertEquals } from "@std/assert";
import {
  childElements,
  childText,
  firstChild,
  parseXml,
  pathText,
} from "./xml.ts";

const EC2_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet>
    <item>
      <instancesSet>
        <item>
          <instanceId>i-1234567890abcdef0</instanceId>
          <instanceState>
            <code>16</code>
            <name>running</name>
          </instanceState>
          <privateIpAddress>10.0.0.5</privateIpAddress>
          <ipAddress>203.0.113.25</ipAddress>
          <tagSet>
            <item><key>Name</key><value>web &amp; api</value></item>
            <item><key>env</key><value>prod</value></item>
          </tagSet>
        </item>
        <item>
          <instanceId>i-aaaa</instanceId>
          <instanceState><code>80</code><name>stopped</name></instanceState>
        </item>
      </instancesSet>
    </item>
  </reservationSet>
</DescribeInstancesResponse>`;

Deno.test("parseXml reads nested EC2 structures", () => {
  const root = parseXml(EC2_SAMPLE);
  const response = firstChild(root, "DescribeInstancesResponse");
  const reservation = firstChild(
    firstChild(response, "reservationSet"),
    "item",
  );
  const instancesSet = firstChild(reservation, "instancesSet");
  const instances = childElements(instancesSet, "item");
  assertEquals(instances.length, 2);
  assertEquals(childText(instances[0], "instanceId"), "i-1234567890abcdef0");
  assertEquals(pathText(instances[0], ["instanceState", "name"]), "running");
  assertEquals(childText(instances[0], "ipAddress"), "203.0.113.25");
});

Deno.test("parseXml decodes entities", () => {
  const root = parseXml(EC2_SAMPLE);
  const response = firstChild(root, "DescribeInstancesResponse");
  const reservation = firstChild(
    firstChild(response, "reservationSet"),
    "item",
  );
  const instancesSet = firstChild(reservation, "instancesSet");
  const first = childElements(instancesSet, "item")[0];
  const tags = childElements(firstChild(first, "tagSet"), "item");
  assertEquals(childText(tags[0], "key"), "Name");
  assertEquals(childText(tags[0], "value"), "web & api");
});

Deno.test("parseXml handles self-closing tags", () => {
  const root = parseXml("<root><a/><b>x</b></root>");
  const node = firstChild(root, "root");
  assertEquals(childElements(node, "a").length, 1);
  assertEquals(childText(node, "b"), "x");
});
