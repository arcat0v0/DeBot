import type { ProviderId } from "../cloud/types.ts";

const PROVIDER_TO_CODE: Record<ProviderId, string> = {
  aws: "a",
  azure: "z",
  gcp: "g",
  digitalocean: "d",
};

const CODE_TO_PROVIDER: Record<string, ProviderId> = {
  a: "aws",
  z: "azure",
  g: "gcp",
  d: "digitalocean",
};

const SERVICE_TO_CODE: Record<string, string> = {
  ec2: "e",
  lightsail: "l",
  default: "x",
};

const CODE_TO_SERVICE: Record<string, string> = {
  e: "ec2",
  l: "lightsail",
  x: "default",
};

export function providerCode(provider: ProviderId): string {
  return PROVIDER_TO_CODE[provider];
}

export function decodeProvider(code: string): ProviderId {
  const provider = CODE_TO_PROVIDER[code];
  if (!provider) throw new Error(`unknown provider code: ${code}`);
  return provider;
}

export function serviceCode(service: string): string {
  return SERVICE_TO_CODE[service] ?? "x";
}

export function decodeService(code: string): string {
  return CODE_TO_SERVICE[code] ?? "default";
}

export function listKey(
  providerCodeValue: string,
  serviceCodeValue: string,
): string {
  return `${providerCodeValue}:${serviceCodeValue}`;
}
