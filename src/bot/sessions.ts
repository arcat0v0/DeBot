import type { ProviderId } from "../cloud/types.ts";
import type { InstanceState } from "../cloud/types.ts";

export interface ListItemRef {
  instanceId: string;
  name: string;
  state: InstanceState;
  region?: string;
  zone?: string;
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
  | { kind: "add_preset"; provider: ProviderId };

export interface Session {
  userId: number;
  flow?: Flow;
  lists: Map<string, ListItemRef[]>;
  regionOverride: Partial<Record<ProviderId, string>>;
}

export class SessionStore {
  private readonly sessions = new Map<number, Session>();

  get(userId: number): Session {
    let session = this.sessions.get(userId);
    if (!session) {
      session = { userId, lists: new Map(), regionOverride: {} };
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

  setRegion(userId: number, provider: ProviderId, region: string): void {
    this.get(userId).regionOverride[provider] = region;
  }

  getRegion(userId: number, provider: ProviderId): string | undefined {
    return this.get(userId).regionOverride[provider];
  }
}
