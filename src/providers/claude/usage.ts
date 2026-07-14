import { z } from "zod";
import type { UsageSnapshot, UsageWindow } from "../../domain.ts";
import { ApplicationError } from "../../errors.ts";
import type { FetchImplementation } from "../../http.ts";

const UsageWindowSchema = z
  .object({
    utilization: z.number().min(0).max(1),
    resets_at: z.union([z.string(), z.number()]).nullable().optional(),
    limit_dollars: z.number().nonnegative().optional(),
    used_dollars: z.number().nonnegative().optional(),
    remaining_dollars: z.number().nonnegative().optional(),
  })
  .passthrough();

const ClaudeUsageResponseSchema = z
  .object({
    five_hour: UsageWindowSchema.nullish(),
    seven_day: UsageWindowSchema.nullish(),
    seven_day_opus: UsageWindowSchema.nullish(),
    seven_day_sonnet: UsageWindowSchema.nullish(),
    seven_day_oauth_apps: UsageWindowSchema.nullish(),
  })
  .passthrough();

function resetTimestamp(value: string | number | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const timestamp =
    typeof value === "number"
      ? value > 1_000_000_000_000
        ? value
        : value * 1000
      : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeWindow(
  id: string,
  label: string,
  source: z.infer<typeof UsageWindowSchema>,
): UsageWindow {
  return {
    id,
    label,
    usedPercent: source.utilization * 100,
    resetAt: resetTimestamp(source.resets_at),
    kind:
      id.includes("oauth_apps") || id.includes("extra_usage") || source.limit_dollars !== undefined
        ? "spend"
        : "hard",
  };
}

export async function fetchClaudeUsage(input: {
  accountId: string;
  accessToken: string;
  fetchImplementation?: FetchImplementation;
}): Promise<UsageSnapshot> {
  const response = await (input.fetchImplementation ?? fetch)(
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 401) {
    throw new ApplicationError(
      "ACCESS_TOKEN_REJECTED",
      "Claude usage endpoint rejected the access token",
    );
  }
  if (response.status === 429) {
    throw new ApplicationError(
      "USAGE_RATE_LIMITED",
      "Claude usage endpoint rate-limited the probe",
    );
  }
  if (!response.ok) {
    throw new ApplicationError(
      "PROVIDER_UNREACHABLE",
      `Claude usage endpoint returned HTTP ${response.status}`,
    );
  }
  const body = ClaudeUsageResponseSchema.parse(await response.json());
  const definitions = [
    ["five_hour", "5 hour", body.five_hour],
    ["seven_day", "7 day", body.seven_day],
    ["seven_day_opus", "7 day · Opus", body.seven_day_opus],
    ["seven_day_sonnet", "7 day · Sonnet", body.seven_day_sonnet],
    ["seven_day_oauth_apps", "7 day · OAuth apps", body.seven_day_oauth_apps],
  ] as const;
  const windows = definitions.flatMap(([id, label, window]) =>
    window == null ? [] : [normalizeWindow(id, label, window)],
  );
  const knownWindowIds = new Set<string>(definitions.map(([id]) => id));
  for (const [id, value] of Object.entries(body)) {
    if (knownWindowIds.has(id)) {
      continue;
    }
    const additional = UsageWindowSchema.safeParse(value);
    if (additional.success) {
      const label = id
        .split("_")
        .filter((part) => part.length > 0)
        .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
        .join(" ");
      windows.push(normalizeWindow(id, label, additional.data));
    }
  }
  return {
    accountId: input.accountId,
    provider: "anthropic",
    observedAt: new Date().toISOString(),
    source: "claudeUsageEndpoint",
    windows,
    hardLimitReached: windows.some((window) => window.kind === "hard" && window.usedPercent >= 100),
  };
}
