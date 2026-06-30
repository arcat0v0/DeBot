import { assert, assertEquals } from "@std/assert";
import type { FetchLike } from "../../http.ts";
import { AwsBillingClient } from "./billing.ts";

interface Captured {
  url: string;
  init?: RequestInit;
}

function billingClient(fakeFetch: FetchLike) {
  return new AwsBillingClient({
    credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    fetch: fakeFetch,
  });
}

Deno.test("AwsBillingClient reads caller account and month-to-date cost", async () => {
  const calls: Captured[] = [];
  const fakeFetch: FetchLike = (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).includes("sts.amazonaws.com")) {
      return Promise.resolve(
        new Response(
          `<GetCallerIdentityResponse>
            <GetCallerIdentityResult>
              <Account>123456789012</Account>
            </GetCallerIdentityResult>
          </GetCallerIdentityResponse>`,
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ResultsByTime: [{
            Total: { UnblendedCost: { Amount: "12.3456", Unit: "USD" } },
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };

  const balance = await billingClient(fakeFetch).getSubscriptionBalance();

  assertEquals(balance.subscriptionId, "123456789012");
  assertEquals(balance.monthToDateCost, 12.3456);
  assertEquals(balance.currency, "USD");
  assertEquals(balance.warnings, undefined);
  assertEquals(calls.length, 2);
  assertEquals(calls[1].url, "https://ce.us-east-1.amazonaws.com/");
  const headers = calls[1].init?.headers as Record<string, string>;
  assertEquals(
    headers["x-amz-target"],
    "AWSInsightsIndexService.GetCostAndUsage",
  );
  assert(String(calls[1].init?.body).includes('"Granularity":"MONTHLY"'));
});

Deno.test("AwsBillingClient keeps account information when Cost Explorer is unavailable", async () => {
  const fakeFetch: FetchLike = (input, _init) => {
    if (String(input).includes("sts.amazonaws.com")) {
      return Promise.resolve(
        new Response(
          `<GetCallerIdentityResponse>
            <GetCallerIdentityResult>
              <Account>123456789012</Account>
            </GetCallerIdentityResult>
          </GetCallerIdentityResponse>`,
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ message: "Access denied" }), {
        status: 403,
      }),
    );
  };

  const balance = await billingClient(fakeFetch).getSubscriptionBalance();

  assertEquals(balance.subscriptionId, "123456789012");
  assertEquals(balance.monthToDateCost, undefined);
  assert(
    balance.warnings?.some((warning) => warning.includes("Access denied")),
  );
});
