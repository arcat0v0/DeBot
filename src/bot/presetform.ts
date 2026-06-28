import { ValidationError } from "../shared/errors.ts";
import type { ProviderId } from "../cloud/types.ts";
import type { NewPresetInput } from "../storage/presets.ts";

export const PRESET_FORMAT =
  "名称 | 镜像 | 规格 | 区域 | 可用区 | SSH密钥\n（区域、可用区、SSH密钥为可选项，用「-」跳过）";

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "-") return undefined;
  return trimmed;
}

export function parsePresetLine(
  provider: ProviderId,
  text: string,
): NewPresetInput {
  const parts = text.split("|").map((part) => part.trim());
  const name = clean(parts[0]);
  const image = clean(parts[1]);
  const size = clean(parts[2]);
  if (!name || !image || !size) {
    throw new ValidationError(`请按以下格式发送预设：${PRESET_FORMAT}`);
  }
  return {
    name,
    provider,
    image,
    size,
    region: clean(parts[3]),
    zone: clean(parts[4]),
    sshKeyId: clean(parts[5]),
  };
}
