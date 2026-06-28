import { assert, assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { decodeBase64Url } from "@std/encoding/base64url";
import { GcpAuth } from "./auth.ts";
import type { FetchLike } from "../../http.ts";

async function makeKeyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    encodeBase64(pkcs8)
  }\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

Deno.test("GcpAuth builds a verifiable signed JWT assertion", async () => {
  const { pem, publicKey } = await makeKeyPair();
  let capturedAssertion = "";
  let calls = 0;
  const fakeFetch: FetchLike = (_input, init) => {
    calls += 1;
    const params = new URLSearchParams(String(init?.body));
    capturedAssertion = params.get("assertion") ?? "";
    return Promise.resolve(
      new Response(
        JSON.stringify({ access_token: "token-123", expires_in: 3600 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
  };

  const auth = new GcpAuth(
    {
      projectId: "p",
      clientEmail: "svc@p.iam.gserviceaccount.com",
      privateKey: pem,
    },
    fakeFetch,
    () => 1_700_000_000_000,
  );

  const token = await auth.getAccessToken();
  assertEquals(token, "token-123");

  const [headerB64, claimsB64, signatureB64] = capturedAssertion.split(".");
  const header = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(headerB64)),
  );
  const claims = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(claimsB64)),
  );
  assertEquals(header.alg, "RS256");
  assertEquals(claims.iss, "svc@p.iam.gserviceaccount.com");
  assertEquals(claims.aud, "https://oauth2.googleapis.com/token");
  assertEquals(claims.iat, 1_700_000_000);

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    new Uint8Array(decodeBase64Url(signatureB64)),
    new TextEncoder().encode(`${headerB64}.${claimsB64}`),
  );
  assert(valid, "assertion signature must verify with the public key");

  await auth.getAccessToken();
  assertEquals(calls, 1, "token should be cached");
});
