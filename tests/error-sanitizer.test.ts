import { describe, expect, test } from "vitest";
import {
  failureContextForJob,
  failureContextForRun,
  publicToolFailure,
  safeAppleAuthorizationFailure,
  sanitizeFailure,
  sanitizeOptionalFailure,
  type FailureContext,
} from "../server/error-sanitizer.ts";

const privateFailure = new Error(
  "upstream rejected sk-proj-PRIVATE at postgres://user:password@private.example/needle for mrcloblima@example.com",
);

describe("durable and public error sanitization", () => {
  test.each<FailureContext>([
    "brief",
    "research",
    "matching",
    "publication",
    "notification",
    "apple_authorization",
    "background",
  ])("%s failures never retain raw diagnostics", (context) => {
    const result = sanitizeFailure(privateFailure, context);
    expect(result).not.toContain("sk-proj-PRIVATE");
    expect(result).not.toContain("postgres://");
    expect(result).not.toContain("password");
    expect(result).not.toContain("mrcloblima@example.com");
    expect(result.length).toBeGreaterThan(20);
  });

  test("publication outcomes are classified without copying provider text", () => {
    expect(sanitizeFailure("private share link failure: sk-proj-PRIVATE", "publication"))
      .toBe("Apple did not expose a stable public playlist link after the final attempt.");
    expect(sanitizeFailure("ordered prefix diverged: postgres://private", "publication"))
      .toBe("Apple playlist ordering diverged from the approved manifest after the final attempt.");
    expect(sanitizeFailure("provider timed out with password=private", "publication"))
      .toBe("Apple Music remained unavailable after the final attempt.");
    const alreadySafe = "Apple Music remained unavailable after the final attempt.";
    expect(sanitizeFailure(sanitizeFailure(alreadySafe, "publication"), "publication")).toBe(alreadySafe);
  });

  test("Apple authorization diagnostics retain only a safe failure class", () => {
    const rateLimit = Object.assign(new Error("private upstream body sk-proj-PRIVATE"), {
      name: "AppleApiError",
      status: 429,
    });
    const unavailable = Object.assign(new Error("private provider detail"), {
      name: "AppleApiError",
      status: 503,
    });
    const unreachable = Object.assign(new Error("private DNS host"), {
      name: "AppleApiError",
      status: null,
    });
    expect(safeAppleAuthorizationFailure(rateLimit)).toBe(
      "Apple Music temporarily rate-limited authorization validation (HTTP 429).",
    );
    expect(safeAppleAuthorizationFailure(unavailable)).toBe(
      "Apple Music authorization validation was temporarily unavailable.",
    );
    expect(safeAppleAuthorizationFailure(unreachable)).toBe(
      "Needle could not reach Apple Music while validating authorization.",
    );
    for (const error of [rateLimit, unavailable, unreachable]) {
      const result = sanitizeFailure(safeAppleAuthorizationFailure(error), "apple_authorization");
      expect(result).not.toContain("private");
      expect(result).not.toContain("sk-proj");
    }
  });

  test("job and run phases select fixed public contexts", () => {
    expect(failureContextForJob("brief")).toBe("brief");
    expect(failureContextForJob("notification")).toBe("notification");
    expect(failureContextForJob("unrecognized-provider-job")).toBe("background");
    expect(failureContextForRun("catalog_matching")).toBe("matching");
    expect(failureContextForRun("publication_failed")).toBe("publication");
    expect(failureContextForRun("track_verification")).toBe("research");
  });

  test("nullable fields and model tool feedback remain bounded", () => {
    expect(sanitizeOptionalFailure(null, "research")).toBeNull();
    expect(publicToolFailure()).toBe("The source operation failed; continue with other documented sources.");
  });
});
