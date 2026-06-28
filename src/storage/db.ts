import { dirname } from "@std/path";
import { Mutex } from "../shared/util.ts";
import { shortId } from "../shared/util.ts";

const locks = new Map<string, Mutex>();

function lockFor(path: string): Mutex {
  let mutex = locks.get(path);
  if (!mutex) {
    mutex = new Mutex();
    locks.set(path, mutex);
  }
  return mutex;
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await Deno.readTextFile(path);
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return structuredClone(fallback);
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${path}.${shortId(6)}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(value, null, 2));
  await Deno.rename(tmp, path);
}

export async function updateJson<T>(
  path: string,
  fallback: T,
  mutate: (current: T) => T | Promise<T>,
): Promise<T> {
  return await lockFor(path).run(async () => {
    const current = await readJson(path, fallback);
    const next = await mutate(current);
    await writeJson(path, next);
    return next;
  });
}

export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await lockFor(path).run(async () => {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(value) + "\n", {
      append: true,
    });
  });
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push(JSON.parse(trimmed) as T);
  }
  return out;
}
