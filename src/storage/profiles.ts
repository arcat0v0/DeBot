import { join } from "@std/path";
import { decryptJson, encryptJson } from "../security/crypto.ts";
import { NotFoundError, ValidationError } from "../shared/errors.ts";
import { nowIso, shortId } from "../shared/util.ts";
import type { ProviderCredentials, ProviderId } from "../cloud/types.ts";
import { readJson, updateJson } from "./db.ts";

export interface Profile {
  id: string;
  name: string;
  provider: ProviderId;
  defaultRegion?: string;
  createdAt: string;
  updatedAt: string;
  secret: string;
}

export interface ProfilesFile {
  profiles: Profile[];
  active: Partial<Record<ProviderId, string>>;
}

export interface NewProfileInput {
  name: string;
  provider: ProviderId;
  defaultRegion?: string;
  credentials: ProviderCredentials;
}

const EMPTY: ProfilesFile = { profiles: [], active: {} };

export class ProfileStore {
  private readonly path: string;

  constructor(dataDir: string, private readonly key: CryptoKey) {
    this.path = join(dataDir, "profiles.json");
  }

  private async file(): Promise<ProfilesFile> {
    return await readJson(this.path, EMPTY);
  }

  async list(): Promise<Profile[]> {
    return (await this.file()).profiles;
  }

  async listByProvider(provider: ProviderId): Promise<Profile[]> {
    return (await this.list()).filter((profile) =>
      profile.provider === provider
    );
  }

  async get(id: string): Promise<Profile | undefined> {
    return (await this.list()).find((profile) => profile.id === id);
  }

  async require(id: string): Promise<Profile> {
    const profile = await this.get(id);
    if (!profile) throw new NotFoundError(`profile ${id} not found`);
    return profile;
  }

  async getActive(provider: ProviderId): Promise<Profile | undefined> {
    const file = await this.file();
    const activeId = file.active[provider];
    if (activeId) {
      const match = file.profiles.find((profile) => profile.id === activeId);
      if (match) return match;
    }
    return file.profiles.find((profile) => profile.provider === provider);
  }

  async setActive(provider: ProviderId, id: string): Promise<void> {
    await updateJson(this.path, EMPTY, (current) => {
      const profile = current.profiles.find((item) => item.id === id);
      if (!profile || profile.provider !== provider) {
        throw new ValidationError(`profile ${id} is not a ${provider} profile`);
      }
      return { ...current, active: { ...current.active, [provider]: id } };
    });
  }

  async add(input: NewProfileInput): Promise<Profile> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new ValidationError("profile name is required");
    }
    const secret = await encryptJson(this.key, input.credentials);
    const profile: Profile = {
      id: shortId(8),
      name,
      provider: input.provider,
      defaultRegion: input.defaultRegion,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      secret,
    };
    await updateJson(this.path, EMPTY, (current) => {
      const active = { ...current.active };
      if (!active[input.provider]) active[input.provider] = profile.id;
      return { profiles: [...current.profiles, profile], active };
    });
    return profile;
  }

  async updateCredentials(
    id: string,
    credentials: ProviderCredentials,
  ): Promise<void> {
    const secret = await encryptJson(this.key, credentials);
    await updateJson(this.path, EMPTY, (current) => {
      const profiles = current.profiles.map((profile) =>
        profile.id === id
          ? { ...profile, secret, updatedAt: nowIso() }
          : profile
      );
      if (!profiles.some((profile) => profile.id === id)) {
        throw new NotFoundError(`profile ${id} not found`);
      }
      return { ...current, profiles };
    });
  }

  async update(
    id: string,
    changes: { name?: string; defaultRegion?: string },
  ): Promise<void> {
    await updateJson(this.path, EMPTY, (current) => {
      let found = false;
      const profiles = current.profiles.map((profile) => {
        if (profile.id !== id) return profile;
        found = true;
        return {
          ...profile,
          name: changes.name?.trim() || profile.name,
          defaultRegion: changes.defaultRegion ?? profile.defaultRegion,
          updatedAt: nowIso(),
        };
      });
      if (!found) throw new NotFoundError(`profile ${id} not found`);
      return { ...current, profiles };
    });
  }

  async remove(id: string): Promise<void> {
    await updateJson(this.path, EMPTY, (current) => {
      const profiles = current.profiles.filter((profile) => profile.id !== id);
      const active: Partial<Record<ProviderId, string>> = {};
      for (const [provider, activeId] of Object.entries(current.active)) {
        if (activeId && activeId !== id) {
          active[provider as ProviderId] = activeId;
        }
      }
      return { profiles, active };
    });
  }

  async getCredentials<T extends ProviderCredentials = ProviderCredentials>(
    id: string,
  ): Promise<T> {
    const profile = await this.require(id);
    return await decryptJson<T>(this.key, profile.secret);
  }
}
