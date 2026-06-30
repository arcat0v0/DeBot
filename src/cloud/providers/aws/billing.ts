import { ProviderError } from "../../../shared/errors.ts";
import type { FetchLike } from "../../http.ts";
import type { AdapterContext, SubscriptionBalance } from "../../types.ts";
import { childText, findElement, firstChild, parseXml } from "../../xml.ts";
import { signedFetch } from "./client.ts";

const COST_REGION = "us-east-1";

interface CostAmount {
  Amount?: string;
  Unit?: string;
}

interface CostAndUsageResponse {
  ResultsByTime?: Array<{
    Total?: {
      UnblendedCost?: CostAmount;
    };
  }>;
}

function jsonErrorMessage(status: number, text: string): string {
  if (text.trim().length === 0) return `HTTP ${status}`;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const message = data.message ?? data.Message;
    if (typeof message === "string") return message;
    const type = data.__type;
    if (typeof type === "string") return type;
  } catch {
    // Fall through to a short raw body.
  }
  return text.slice(0, 300);
}

function warningFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthToDatePeriod(now = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  ));
  return { start: isoDate(start), end: isoDate(end) };
}

export class AwsBillingClient {
  private readonly fetchImpl: FetchLike;
  private readonly credentials: AdapterContext<"aws">["credentials"];

  constructor(ctx: Pick<AdapterContext<"aws">, "credentials" | "fetch">) {
    this.fetchImpl = ctx.fetch ?? fetch;
    this.credentials = ctx.credentials;
  }

  private async callCostExplorer<T>(
    operation: string,
    payload: unknown,
  ): Promise<T> {
    const body = JSON.stringify(payload);
    const response = await signedFetch(this.fetchImpl, {
      credentials: this.credentials,
      region: COST_REGION,
      service: "ce",
      method: "POST",
      url: "https://ce.us-east-1.amazonaws.com/",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSInsightsIndexService.${operation}`,
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError("aws", jsonErrorMessage(response.status, text), {
        status: response.status,
        userMessage: `AWS Cost Explorer error: ${
          jsonErrorMessage(response.status, text)
        }`,
      });
    }
    return (text.trim().length > 0 ? JSON.parse(text) : {}) as T;
  }

  private async callerAccountId(): Promise<string> {
    const form = new URLSearchParams({
      Action: "GetCallerIdentity",
      Version: "2011-06-15",
    });
    const response = await signedFetch(this.fetchImpl, {
      credentials: this.credentials,
      region: COST_REGION,
      service: "sts",
      method: "POST",
      url: "https://sts.amazonaws.com/",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form.toString(),
    });
    const text = await response.text();
    const root = parseXml(text);
    if (!response.ok) {
      const error = findElement(root, "Error");
      const message = childText(error, "Message") ?? text.slice(0, 300);
      throw new ProviderError("aws", message, {
        status: response.status,
        userMessage: `AWS STS error: ${message}`,
      });
    }
    const result = firstChild(
      firstChild(root, "GetCallerIdentityResponse"),
      "GetCallerIdentityResult",
    );
    return childText(result, "Account") ?? "unknown";
  }

  private async monthToDateCost(): Promise<{
    amount?: number;
    currency?: string;
  }> {
    const period = monthToDatePeriod();
    const data = await this.callCostExplorer<CostAndUsageResponse>(
      "GetCostAndUsage",
      {
        TimePeriod: {
          Start: period.start,
          End: period.end,
        },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
      },
    );
    const raw = data.ResultsByTime?.[0]?.Total?.UnblendedCost;
    const amount = raw?.Amount === undefined ? undefined : Number(raw.Amount);
    return {
      amount: Number.isFinite(amount) ? amount : undefined,
      currency: raw?.Unit,
    };
  }

  async getSubscriptionBalance(): Promise<SubscriptionBalance> {
    const warnings: string[] = [];
    let subscriptionId = "unknown";
    try {
      subscriptionId = await this.callerAccountId();
    } catch (error) {
      warnings.push(`账号 ID：${warningFor(error)}`);
    }

    let monthToDateCost: number | undefined;
    let currency: string | undefined;
    try {
      const cost = await this.monthToDateCost();
      monthToDateCost = cost.amount;
      currency = cost.currency;
    } catch (error) {
      warnings.push(
        `Cost Explorer：${
          warningFor(error)
        }。如果账号未启用 Cost Explorer 或 IAM 未授权 ce:GetCostAndUsage，将只能显示账号信息。`,
      );
    }

    return {
      subscriptionId,
      currency,
      monthToDateCost,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}
