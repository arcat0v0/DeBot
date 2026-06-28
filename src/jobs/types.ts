export type JobStatus = "pending" | "running" | "succeeded" | "failed";

export interface JobRecord {
  id: string;
  kind: string;
  label: string;
  provider?: string;
  userId?: number;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
}

export interface EnqueueInput {
  kind: string;
  label: string;
  provider?: string;
  userId?: number;
  run: () => Promise<string>;
  onUpdate?: (job: JobRecord) => void;
}
