import { ValidationError } from "../shared/errors.ts";
import { PROVIDER_LABELS } from "./types.ts";
import type { ProviderAdapter, ProviderId } from "./types.ts";
import { createAdapter } from "./registry.ts";
import type { CreateAdapterOptions } from "./registry.ts";
import type { FetchLike } from "./http.ts";
import type { ProfileStore } from "../storage/profiles.ts";
import type { ProviderCredentials } from "./types.ts";

export type AdapterFactory = (
  provider: ProviderId,
  credentials: ProviderCredentials,
  options: CreateAdapterOptions,
) => ProviderAdapter;

export interface AdapterRequest {
  service?: string;
  region?: string;
}

export class CloudService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly factory: AdapterFactory = createAdapter,
  ) {}

  async getAdapter(
    provider: ProviderId,
    request: AdapterRequest = {},
  ): Promise<ProviderAdapter> {
    const profile = await this.profiles.getActive(provider);
    if (!profile) {
      throw new ValidationError(
        `No ${PROVIDER_LABELS[provider]} profile configured`,
        `尚未配置 ${PROVIDER_LABELS[provider]} 凭证。请用 /profile 添加。`,
      );
    }
    const credentials = await this.profiles.getCredentials(profile.id);
    return this.factory(provider, credentials, {
      defaultRegion: request.region ?? profile.defaultRegion,
      service: request.service,
      fetch: this.fetchImpl,
    });
  }
}
