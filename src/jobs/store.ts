import { join } from "@std/path";
import { readJson, updateJson } from "../storage/db.ts";
import type { JobRecord } from "./types.ts";

interface JobsFile {
  jobs: JobRecord[];
}

const EMPTY: JobsFile = { jobs: [] };

export class JobStore {
  private readonly path: string;

  constructor(dataDir: string, private readonly max = 100) {
    this.path = join(dataDir, "jobs.json");
  }

  async list(): Promise<JobRecord[]> {
    return (await readJson(this.path, EMPTY)).jobs;
  }

  async recent(limit = 10): Promise<JobRecord[]> {
    const jobs = await this.list();
    return jobs.slice(-limit).reverse();
  }

  async get(id: string): Promise<JobRecord | undefined> {
    return (await this.list()).find((job) => job.id === id);
  }

  async save(record: JobRecord): Promise<void> {
    await updateJson(this.path, EMPTY, (current) => {
      const others = current.jobs.filter((job) => job.id !== record.id);
      const jobs = [...others, record].slice(-this.max);
      return { jobs };
    });
  }
}
