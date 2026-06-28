import { assertEquals } from "@std/assert";
import { createLogger } from "../app/logger.ts";
import { JobStore } from "./store.ts";
import { JobQueue } from "./queue.ts";
import type { JobRecord } from "./types.ts";

function silentLogger() {
  return createLogger("error", {}, () => {});
}

Deno.test("JobQueue runs a job to success and persists it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = new JobStore(dir);
    const queue = new JobQueue(store, silentLogger());
    const record = queue.enqueue({
      kind: "test",
      label: "do thing",
      run: () => Promise.resolve("done"),
    });
    assertEquals(record.status, "pending");
    await queue.idle();
    const saved = await store.get(record.id);
    assertEquals(saved?.status, "succeeded");
    assertEquals(saved?.result, "done");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("JobQueue records failures", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = new JobStore(dir);
    const queue = new JobQueue(store, silentLogger());
    const record = queue.enqueue({
      kind: "test",
      label: "boom",
      run: () => Promise.reject(new Error("kaboom")),
    });
    await queue.idle();
    const saved = await store.get(record.id);
    assertEquals(saved?.status, "failed");
    assertEquals(saved?.error, "kaboom");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("JobQueue emits update callbacks through each transition", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = new JobStore(dir);
    const queue = new JobQueue(store, silentLogger());
    const states: string[] = [];
    queue.enqueue({
      kind: "test",
      label: "watch",
      run: () => Promise.resolve("ok"),
      onUpdate: (job: JobRecord) => states.push(job.status),
    });
    await queue.idle();
    assertEquals(states, ["running", "succeeded"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("JobQueue honours its concurrency limit", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = new JobStore(dir);
    const queue = new JobQueue(store, silentLogger(), 2);
    let active = 0;
    let peak = 0;
    const makeJob = () => () => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<string>((resolve) =>
        setTimeout(() => {
          active -= 1;
          resolve("ok");
        }, 10)
      );
    };
    for (let i = 0; i < 5; i++) {
      queue.enqueue({ kind: "test", label: `job-${i}`, run: makeJob() });
    }
    await queue.idle();
    assertEquals(peak <= 2, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
