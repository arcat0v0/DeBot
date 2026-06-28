import type { Logger } from "../app/logger.ts";
import { errorMessage } from "../shared/errors.ts";
import { nowIso, shortId } from "../shared/util.ts";
import type { JobStore } from "./store.ts";
import type { EnqueueInput, JobRecord } from "./types.ts";

interface InternalJob {
  record: JobRecord;
  run: () => Promise<string>;
  onUpdate?: (job: JobRecord) => void;
}

export class JobQueue {
  private active = 0;
  private readonly pending: InternalJob[] = [];
  private readonly idleResolvers: (() => void)[] = [];

  constructor(
    private readonly store: JobStore,
    private readonly logger: Logger,
    private readonly concurrency = 2,
  ) {}

  enqueue(input: EnqueueInput): JobRecord {
    const record: JobRecord = {
      id: shortId(8),
      kind: input.kind,
      label: input.label,
      provider: input.provider,
      userId: input.userId,
      status: "pending",
      createdAt: nowIso(),
    };
    this.store.save(record).catch((error) => {
      this.logger.error("failed to persist job", {
        error: errorMessage(error),
      });
    });
    this.pending.push({ record, run: input.run, onUpdate: input.onUpdate });
    this.pump();
    return record;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.active += 1;
      this.runJob(job).finally(() => {
        this.active -= 1;
        this.pump();
        this.checkIdle();
      });
    }
    this.checkIdle();
  }

  private async runJob(job: InternalJob): Promise<void> {
    await this.transition(job, { status: "running", startedAt: nowIso() });
    try {
      const result = await job.run();
      await this.transition(job, {
        status: "succeeded",
        finishedAt: nowIso(),
        result,
      });
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error("job failed", { jobId: job.record.id, error: message });
      await this.transition(job, {
        status: "failed",
        finishedAt: nowIso(),
        error: message,
      });
    }
  }

  private async transition(
    job: InternalJob,
    changes: Partial<JobRecord>,
  ): Promise<void> {
    job.record = { ...job.record, ...changes };
    try {
      await this.store.save(job.record);
    } catch (error) {
      this.logger.error("failed to persist job", {
        error: errorMessage(error),
      });
    }
    job.onUpdate?.(job.record);
  }

  private checkIdle(): void {
    if (this.active === 0 && this.pending.length === 0) {
      const resolvers = this.idleResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  idle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }
}
