import type { ProviderId } from "../cloud/types.ts";
import type { InstanceState } from "../cloud/types.ts";
import type { FirewallAccess, FirewallProtocol } from "../cloud/types.ts";

export interface ListItemRef {
  instanceId: string;
  name: string;
  state: InstanceState;
  region?: string;
  zone?: string;
  resourceGroup?: string;
}

export interface FirewallRuleRef {
  name: string;
  protocol: FirewallProtocol;
  access: FirewallAccess;
  ports?: string;
  source?: string;
  priority?: number;
}

export type Flow =
  | { kind: "add_profile_name"; provider: ProviderId }
  | { kind: "add_profile_creds"; provider: ProviderId; name: string }
  | {
    kind: "rename_instance";
    provider: ProviderId;
    service: string;
    instanceId: string;
    region?: string;
    zone?: string;
    chatId: number;
    messageId: number;
  }
  | {
    kind: "add_firewall_rule";
    provider: ProviderId;
    service: string;
    instanceId: string;
    name: string;
    region?: string;
    zone?: string;
    resourceGroup?: string;
    chatId: number;
    messageId: number;
  }
  | {
    kind: "azure_student_create";
    service: string;
    region?: string;
    enableIpv6: boolean;
    chatId: number;
    messageId?: number;
  }
  | {
    kind: "azure_custom_create";
    service: string;
    region?: string;
    chatId: number;
    messageId?: number;
  }
  | { kind: "add_preset"; provider: ProviderId };

export interface Session {
  userId: number;
  flow?: Flow;
  lists: Map<string, ListItemRef[]>;
  firewallRules: Map<string, FirewallRuleRef[]>;
  regionOverride: Record<string, string>;
}

export class SessionStore {
  private readonly sessions = new Map<number, Session>();

  get(userId: number): Session {
    let session = this.sessions.get(userId);
    if (!session) {
      session = {
        userId,
        lists: new Map(),
        firewallRules: new Map(),
        regionOverride: {},
      };
      this.sessions.set(userId, session);
    }
    return session;
  }

  setFlow(userId: number, flow: Flow): void {
    this.get(userId).flow = flow;
  }

  clearFlow(userId: number): void {
    this.get(userId).flow = undefined;
  }

  setList(userId: number, key: string, items: ListItemRef[]): void {
    this.get(userId).lists.set(key, items);
  }

  getListItem(
    userId: number,
    key: string,
    index: number,
  ): ListItemRef | undefined {
    return this.get(userId).lists.get(key)?.[index];
  }

  setFirewallRules(
    userId: number,
    key: string,
    rules: FirewallRuleRef[],
  ): void {
    this.get(userId).firewallRules.set(key, rules);
  }

  getFirewallRule(
    userId: number,
    key: string,
    index: number,
  ): FirewallRuleRef | undefined {
    return this.get(userId).firewallRules.get(key)?.[index];
  }

  private regionKey(provider: ProviderId, service?: string): string {
    return service ? `${provider}:${service}` : provider;
  }

  setRegion(
    userId: number,
    provider: ProviderId,
    region: string,
    service?: string,
  ): void {
    this.get(userId).regionOverride[this.regionKey(provider, service)] = region;
  }

  getRegion(
    userId: number,
    provider: ProviderId,
    service?: string,
  ): string | undefined {
    const session = this.get(userId);
    return session.regionOverride[this.regionKey(provider, service)] ??
      session.regionOverride[this.regionKey(provider)];
  }
}
