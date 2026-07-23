import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const workflowUrl = new URL("../.github/workflows/release-candidate.yml", import.meta.url);

describe("release-candidate workflow bootstrap safety", () => {
  test("supports an audited RC-tag bootstrap before workflow_dispatch exists on main", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toMatch(/push:\s*\n\s+tags:\s*\n\s+- "v\*\.\*\.\*-rc\.\*"/u);
    expect(workflow).toContain(
      "CANDIDATE_TAG: ${{ github.event_name == 'push' && github.ref_name || inputs.candidate_tag }}",
    );
    expect(workflow).toContain("ref: ${{ env.CANDIDATE_TAG }}");
    expect(workflow).toContain(
      'node scripts/check-release.mjs --require-exact-tag "$CANDIDATE_TAG"',
    );
    expect(workflow.indexOf("Verify annotated RC identity")).toBeLessThan(
      workflow.indexOf("pnpm install --frozen-lockfile"),
    );
  });

  test("the bootstrap builds evidence but cannot deploy Railway or Sites", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    expect(workflow).toContain("docker/build-push-action@v6");
    expect(workflow).toContain("actions/attest-build-provenance@v3");
    expect(workflow).not.toMatch(/\brailway\s+config\s+(?:apply|stage)\b/iu);
    expect(workflow).not.toMatch(/\b(?:deploy|publish)[^\n]*(?:Railway|Sites)\b/iu);
    expect(workflow).not.toContain("openai/sites");
  });
});
