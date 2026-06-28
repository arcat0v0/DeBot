const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function shortId(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return text.slice(0, max - 1) + "…";
}

export function parseIdList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10))
    .filter((id) => Number.isInteger(id));
}

export function parseStringList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(noop, noop);
    return result;
  }
}

function noop(): void {}
