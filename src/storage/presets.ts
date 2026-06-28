import { join } from "@std/path";
import { NotFoundError, ValidationError } from "../shared/errors.ts";
import { nowIso, shortId } from "../shared/util.ts";
import type { ProviderId } from "../cloud/types.ts";
import { readJson, updateJson } from "./db.ts";

export interface Preset {
  id: string;
  name: string;
  provider: ProviderId;
  region?: string;
  zone?: string;
  image: string;
  size: string;
  sshKeyId?: string;
  tags?: Record<string, string>;
  userData?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PresetsFile {
  presets: Preset[];
}

export interface NewPresetInput {
  name: string;
  provider: ProviderId;
  region?: string;
  zone?: string;
  image: string;
  size: string;
  sshKeyId?: string;
  tags?: Record<string, string>;
  userData?: string;
}

const EMPTY: PresetsFile = { presets: [] };

export class PresetStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "presets.json");
  }

  async list(): Promise<Preset[]> {
    return (await readJson(this.path, EMPTY)).presets;
  }

  async listByProvider(provider: ProviderId): Promise<Preset[]> {
    return (await this.list()).filter((preset) => preset.provider === provider);
  }

  async get(id: string): Promise<Preset | undefined> {
    return (await this.list()).find((preset) => preset.id === id);
  }

  async require(id: string): Promise<Preset> {
    const preset = await this.get(id);
    if (!preset) throw new NotFoundError(`preset ${id} not found`);
    return preset;
  }

  async add(input: NewPresetInput): Promise<Preset> {
    const name = input.name.trim();
    if (name.length === 0) throw new ValidationError("preset name is required");
    if (input.image.trim().length === 0) {
      throw new ValidationError("preset image is required");
    }
    if (input.size.trim().length === 0) {
      throw new ValidationError("preset size is required");
    }
    const preset: Preset = {
      id: shortId(8),
      name,
      provider: input.provider,
      region: input.region,
      zone: input.zone,
      image: input.image.trim(),
      size: input.size.trim(),
      sshKeyId: input.sshKeyId,
      tags: input.tags,
      userData: input.userData,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await updateJson(this.path, EMPTY, (current) => ({
      presets: [...current.presets, preset],
    }));
    return preset;
  }

  async remove(id: string): Promise<void> {
    await updateJson(this.path, EMPTY, (current) => ({
      presets: current.presets.filter((preset) => preset.id !== id),
    }));
  }
}
