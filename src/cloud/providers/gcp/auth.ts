import { encodeBase64Url } from "@std/encoding/base64url";
import { decodeBase64 } from "@std/encoding/base64";
import { ConfigError } from "../../../shared/errors.ts";
import { requestJson } from "../../http.ts";
import type { FetchLike } from "../../http.ts";
import type { GcpCredentials } from "../../types.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const encoder = new TextEncoder();

function pemToDer(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  if (body.length === 0) throw new ConfigError("GCP private key is empty");
  return decodeBase64(body);
}

function base64UrlJson(value: unknown): string {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)));
}

export class GcpAuth {
  private cached?: { value: string; expiresAt: number };

  constructor(
    private readonly credentials: GcpCredentials,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) {
      return this.cached.value;
    }
    const assertion = await this.buildAssertion(now);
    const data = await requestJson<
      { access_token: string; expires_in: number }
    >(
      this.fetchImpl,
      "gcp",
      TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      },
    );
    this.cached = {
      value: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    return data.access_token;
  }

  private async buildAssertion(now: number): Promise<string> {
    const iat = Math.floor(now / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: this.credentials.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      exp: iat + 3600,
      iat,
    };
    const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(pemToDer(this.credentials.privateKey)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new Uint8Array(encoder.encode(signingInput)),
    );
    return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
  }
}
