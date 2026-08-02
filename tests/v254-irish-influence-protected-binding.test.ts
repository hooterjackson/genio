import { describe, expect, test } from "vitest";
import {
  decodeV254IrishInfluenceProtectedBindingV1,
  parseV254IrishInfluenceProtectedBindingV1,
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING,
} from "../scripts/v254-irish-influence-protected-binding.ts";

describe("v2.5.4 protected Irish incident binding", () => {
  test("accepts the exact closed synthetic binding through protected base64", () => {
    const encoded = Buffer.from(
      JSON.stringify(V254_IRISH_INFLUENCE_SYNTHETIC_BINDING),
      "utf8",
    ).toString("base64");
    expect(decodeV254IrishInfluenceProtectedBindingV1(encoded))
      .toEqual(V254_IRISH_INFLUENCE_SYNTHETIC_BINDING);
  });

  test("rejects malformed, incomplete, or extended bindings without echoing values", () => {
    for (const value of [
      "not-base64",
      Buffer.from("{}", "utf8").toString("base64"),
      Buffer.from(JSON.stringify({
        ...V254_IRISH_INFLUENCE_SYNTHETIC_BINDING,
        unexpected: "field",
      }), "utf8").toString("base64"),
    ]) {
      expect(() => decodeV254IrishInfluenceProtectedBindingV1(value))
        .toThrow("v254_irish_influence_protected_binding_invalid");
    }
    expect(() => parseV254IrishInfluenceProtectedBindingV1({
      ...V254_IRISH_INFLUENCE_SYNTHETIC_BINDING,
      accessId: "not-a-uuid",
    })).toThrow("v254_irish_influence_protected_binding_invalid");
  });
});
