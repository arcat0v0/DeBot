export type ProviderId = "aws" | "azure" | "gcp" | "digitalocean";

export const PROVIDER_IDS: ProviderId[] = [
  "aws",
  "azure",
  "gcp",
  "digitalocean",
];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "Google Cloud",
  digitalocean: "DigitalOcean",
};

export type InstanceState =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "rebooting"
  | "terminating"
  | "terminated"
  | "unknown";

export interface Instance {
  id: string;
  name: string;
  state: InstanceState;
  region?: string;
  zone?: string;
  resourceGroup?: string;
  size?: string;
  image?: string;
  publicIp?: string;
  publicIpv6?: string;
  privateIp?: string;
  createdAt?: string;
  tags?: Record<string, string>;
}

export interface InstanceLocator {
  region?: string;
  zone?: string;
  resourceGroup?: string;
}

export interface ListOptions extends InstanceLocator {
  pageToken?: string;
}

export interface InstanceList {
  instances: Instance[];
  nextPageToken?: string;
}

export interface CreateInstanceInput {
  name?: string;
  region?: string;
  zone?: string;
  image: string;
  size: string;
  sshKeyId?: string;
  tags?: Record<string, string>;
  userData?: string;
}

export type FirewallProtocol = "Tcp" | "Udp" | "Icmp" | "*";
export type FirewallAccess = "Allow" | "Deny";
export type FirewallDirection = "Inbound" | "Outbound";

export interface FirewallRule {
  id?: string;
  name: string;
  direction: FirewallDirection;
  access: FirewallAccess;
  protocol: FirewallProtocol;
  source?: string;
  destination?: string;
  ports?: string;
  priority?: number;
  description?: string;
}

export interface FirewallRuleInput {
  name?: string;
  protocol: FirewallProtocol;
  port: string;
  source?: string;
  description?: string;
}

export interface Capabilities {
  create: boolean;
  start: boolean;
  stop: boolean;
  reboot: boolean;
  delete: boolean;
  rename: boolean;
  regions: boolean;
  ipv6: boolean;
  firewall: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  capabilities(): Capabilities;
  listRegions(): Promise<string[]>;
  listInstances(opts?: ListOptions): Promise<InstanceList>;
  getInstance(id: string, locator?: InstanceLocator): Promise<Instance>;
  createInstance(input: CreateInstanceInput): Promise<Instance>;
  startInstance(id: string, locator?: InstanceLocator): Promise<void>;
  stopInstance(id: string, locator?: InstanceLocator): Promise<void>;
  rebootInstance(id: string, locator?: InstanceLocator): Promise<void>;
  deleteInstance(id: string, locator?: InstanceLocator): Promise<void>;
  renameInstance(
    id: string,
    name: string,
    locator?: InstanceLocator,
  ): Promise<void>;
  addPublicIpv6?(id: string, locator?: InstanceLocator): Promise<string>;
  listFirewallRules?(
    id: string,
    locator?: InstanceLocator,
  ): Promise<FirewallRule[]>;
  addFirewallRule?(
    id: string,
    rule: FirewallRuleInput,
    locator?: InstanceLocator,
  ): Promise<FirewallRule>;
  deleteFirewallRule?(
    id: string,
    ruleName: string,
    locator?: InstanceLocator,
  ): Promise<void>;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId?: string;
  resourceGroup?: string;
}

export interface GcpCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface DigitalOceanCredentials {
  token: string;
}

export interface ProviderCredentialMap {
  aws: AwsCredentials;
  azure: AzureCredentials;
  gcp: GcpCredentials;
  digitalocean: DigitalOceanCredentials;
}

export type ProviderCredentials = ProviderCredentialMap[ProviderId];

export interface AdapterContext<P extends ProviderId = ProviderId> {
  credentials: ProviderCredentialMap[P];
  defaultRegion?: string;
  fetch?: typeof fetch;
}
