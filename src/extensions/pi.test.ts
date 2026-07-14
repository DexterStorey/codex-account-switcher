import { describe, expect, test } from "bun:test";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createManagedCodexStreamSimple, managedCredentialsDiffer } from "./pi.ts";

const credential = {
  provider: "openai" as const,
  generation: 3,
  accessToken: "access-one",
  accountId: "account-one",
};

describe("managed Pi credentials", () => {
  test("reprojects refreshed access tokens within the same auth generation", () => {
    expect(managedCredentialsDiffer(null, credential)).toBe(true);
    expect(managedCredentialsDiffer(credential, credential)).toBe(false);
    expect(managedCredentialsDiffer(credential, { ...credential, accessToken: "access-two" })).toBe(
      true,
    );
  });

  test("overrides Pi auth storage at the stream boundary", () => {
    let received: SimpleStreamOptions | undefined;
    const stream = createManagedCodexStreamSimple(
      () => credential,
      (_model, _context, options) => {
        received = options;
        return "stream";
      },
    );
    const result = stream({ provider: "openai-codex" } as Model<Api>, {} as Context, {
      apiKey: "pi-stored-oauth",
    });
    expect(result).toBe("stream");
    expect(received?.apiKey).toBe("access-one");
  });

  test("does not override another provider sharing the Codex API", () => {
    let received: SimpleStreamOptions | undefined;
    const stream = createManagedCodexStreamSimple(
      () => credential,
      (_model, _context, options) => {
        received = options;
        return "stream";
      },
    );
    stream({ provider: "custom" } as Model<Api>, {} as Context, { apiKey: "custom-token" });
    expect(received?.apiKey).toBe("custom-token");
  });
});
