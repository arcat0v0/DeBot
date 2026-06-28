import { assertEquals } from "@std/assert";
import { signRequest } from "./sigv4.ts";

const TEST_CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

const TEST_DATE = new Date("2015-08-30T12:36:00Z");

Deno.test("signRequest matches the AWS get-vanilla test vector", async () => {
  const headers = await signRequest({
    method: "GET",
    url: "https://example.amazonaws.com/",
    region: "us-east-1",
    service: "service",
    credentials: TEST_CREDENTIALS,
    date: TEST_DATE,
  });

  assertEquals(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, " +
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
  assertEquals(headers["x-amz-date"], "20150830T123600Z");
});

Deno.test("signRequest sorts query parameters canonically", async () => {
  const headers = await signRequest({
    method: "GET",
    url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
    region: "us-east-1",
    service: "service",
    credentials: TEST_CREDENTIALS,
    date: TEST_DATE,
  });
  assertEquals(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, " +
      "Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
  );
});

Deno.test("signRequest signs the session token when present", async () => {
  const headers = await signRequest({
    method: "POST",
    url: "https://ec2.us-east-1.amazonaws.com/",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "Action=DescribeInstances&Version=2016-11-15",
    region: "us-east-1",
    service: "ec2",
    credentials: { ...TEST_CREDENTIALS, sessionToken: "session-token-value" },
    date: TEST_DATE,
  });
  assertEquals(headers["x-amz-security-token"], "session-token-value");
  assertEquals(
    headers.authorization.includes(
      "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token",
    ),
    true,
  );
});
