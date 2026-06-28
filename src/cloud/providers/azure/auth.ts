import { requestJson } from "../../http.ts";
import type { FetchLike } from "../../http.ts";
import type { AzureCredentials } from "../../types.ts";

const RESOURCE_SCOPE = "https://management.azure.com/.default";

export class AzureAuth {
  private cached?: { value: string; expiresAt: number };

  constructor(
    private readonly credentials: AzureCredentials,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) {
      return this.cached.value;
    }
    const url =
      `https://login.microsoftonline.com/${this.credentials.tenantId}/oauth2/v2.0/token`;
    const data = await requestJson<
      { access_token: string; expires_in: number }
    >(
      this.fetchImpl,
      "azure",
      url,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
          scope: RESOURCE_SCOPE,
        }).toString(),
      },
    );
    this.cached = {
      value: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    return data.access_token;
  }
}
