import { ValidationError } from "../shared/errors.ts";
import type { FetchLike } from "./http.ts";
import type {
  AzureCredentials,
  DigitalOceanCredentials,
  GcpCredentials,
  ProviderAdapter,
  ProviderCredentials,
  ProviderId,
} from "./types.ts";
import { Ec2Adapter } from "./providers/aws/ec2.ts";
import { LightsailAdapter } from "./providers/aws/lightsail.ts";
import { WavelengthAdapter } from "./providers/aws/wavelength.ts";
import { AzureAdapter } from "./providers/azure/adapter.ts";
import { GcpAdapter } from "./providers/gcp/adapter.ts";
import { DigitalOceanAdapter } from "./providers/digitalocean/adapter.ts";
import type { AwsCredentials } from "./types.ts";

export interface ProviderService {
  id: string;
  label: string;
}

export function providerServices(provider: ProviderId): ProviderService[] {
  if (provider === "aws") {
    return [
      { id: "ec2", label: "EC2" },
      { id: "lightsail", label: "Lightsail" },
      { id: "wavelength", label: "Wavelength" },
    ];
  }
  return [{ id: "default", label: "实例" }];
}

export interface CreateAdapterOptions {
  defaultRegion?: string;
  service?: string;
  fetch?: FetchLike;
}

export function createAdapter(
  provider: ProviderId,
  credentials: ProviderCredentials,
  options: CreateAdapterOptions = {},
): ProviderAdapter {
  const fetchImpl = options.fetch;
  switch (provider) {
    case "aws": {
      const ctx = {
        credentials: credentials as AwsCredentials,
        defaultRegion: options.defaultRegion,
        fetch: fetchImpl,
      };
      if (options.service === "lightsail") return new LightsailAdapter(ctx);
      if (options.service === "wavelength") return new WavelengthAdapter(ctx);
      return new Ec2Adapter(ctx);
    }
    case "azure":
      return new AzureAdapter({
        credentials: credentials as AzureCredentials,
        defaultRegion: options.defaultRegion,
        fetch: fetchImpl,
      });
    case "gcp":
      return new GcpAdapter({
        credentials: credentials as GcpCredentials,
        defaultRegion: options.defaultRegion,
        fetch: fetchImpl,
      });
    case "digitalocean":
      return new DigitalOceanAdapter({
        credentials: credentials as DigitalOceanCredentials,
        defaultRegion: options.defaultRegion,
        fetch: fetchImpl,
      });
    default:
      throw new ValidationError(`unknown provider: ${provider}`);
  }
}
