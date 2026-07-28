import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  parseStableReleaseVerificationArgs,
} from "../scripts/verify-stable-release.ts";
import {
  buildStableReleaseDispatchRequest,
  GITHUB_CLIENT_PAYLOAD_MAX_BYTES,
  parseStableReleaseDispatchArgs,
} from "../scripts/prepare-stable-release-dispatch.ts";
import {
  planStableReleaseAssetReconciliation,
  STABLE_RELEASE_ASSET_NAMES,
} from "../scripts/stable-release-assets.ts";

const workflowUrl = new URL(
  "../.github/workflows/stable-release.yml",
  import.meta.url,
);
const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
const exactContentsWriters = new Set<string>();

type WorkflowPermissionMode = "none" | "contents-write";

function uncommentedYamlLine(line: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    if (
      character === "\""
      && !singleQuoted
      && line[index - 1] !== "\\"
    ) {
      doubleQuoted = !doubleQuoted;
    }
    if (character === "#" && !singleQuoted && !doubleQuoted) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

function yamlKey(value: string, label: string): string {
  const normalized = value.trim();
  const quoted = /^(["'])([^"']+)\1$/u.exec(normalized);
  const key = quoted?.[2] ?? normalized;
  if (!/^[0-9A-Za-z_-]+$/u.test(key)) {
    throw new Error(`${label} uses an unsupported YAML key`);
  }
  return key;
}

function permissionMode(
  lines: readonly string[],
  declarationIndex: number,
  declarationIndent: number,
): WorkflowPermissionMode {
  const declaration = lines[declarationIndex]!;
  const match = /^\s*permissions:\s*(.*?)\s*$/u.exec(declaration);
  if (!match) throw new Error("permissions declaration is malformed");
  const inline = match[1]!;
  if (inline) {
    if (inline === "{}" || inline === "read-all") return "none";
    if (inline === "write-all") return "contents-write";
    if (!inline.startsWith("{") || !inline.endsWith("}")) {
      throw new Error("permissions must be an explicit map, read-all, or write-all");
    }
    const entries = inline.slice(1, -1).trim();
    if (!entries) return "none";
    let contents: string | null = null;
    for (const item of entries.split(",")) {
      const pair = /^\s*(["']?[0-9A-Za-z_-]+["']?)\s*:\s*([0-9A-Za-z_-]+)\s*$/u
        .exec(item);
      if (!pair) throw new Error("inline permissions map is not exact");
      const key = yamlKey(pair[1]!, "inline permissions");
      if (key === "contents") {
        if (contents !== null) throw new Error("permissions.contents is duplicated");
        contents = pair[2]!;
      }
    }
    return contents === "write" ? "contents-write" : "none";
  }
  let contents: string | null = null;
  for (let index = declarationIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= declarationIndent) break;
    if (indent !== declarationIndent + 2) {
      throw new Error("permissions map contains unsupported nesting");
    }
    const pair = /^\s*(["']?[0-9A-Za-z_-]+["']?):\s*([0-9A-Za-z_-]+)\s*$/u
      .exec(line);
    if (!pair) throw new Error("permissions map is not exact");
    const key = yamlKey(pair[1]!, "permissions");
    if (key === "contents") {
      if (contents !== null) throw new Error("permissions.contents is duplicated");
      contents = pair[2]!;
    }
  }
  return contents === "write" ? "contents-write" : "none";
}

function effectiveContentsWriters(workflow: string): string[] {
  if (workflow.includes("\t")) {
    throw new Error("workflow YAML may not use tab indentation");
  }
  const lines = workflow.split(/\r?\n/u).map(uncommentedYamlLine);
  const rootPermissionIndexes: number[] = [];
  const jobs: Array<{
    id: string;
    permissionIndex: number | null;
  }> = [];
  let jobsIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && /^permissions:/u.test(line)) {
      rootPermissionIndexes.push(index);
    }
    if (indent === 0 && /^jobs:\s*$/u.test(line)) jobsIndex = index;
    if (jobsIndex >= 0 && index > jobsIndex && indent === 2) {
      const match = /^\s{2}(["']?[0-9A-Za-z_-]+["']?):\s*$/u.exec(line);
      if (match) {
        jobs.push({
          id: yamlKey(match[1]!, "workflow job"),
          permissionIndex: null,
        });
      }
    }
    if (/^\s*permissions:/u.test(line)
      && indent !== 0
      && indent !== 4) {
      throw new Error("permissions declaration has an unsupported scope");
    }
    if (jobs.length > 0 && indent === 4 && /^    permissions:/u.test(line)) {
      if (jobs.at(-1)!.permissionIndex !== null) {
        throw new Error(`job ${jobs.at(-1)!.id} declares permissions twice`);
      }
      jobs.at(-1)!.permissionIndex = index;
    }
  }
  if (rootPermissionIndexes.length !== 1) {
    throw new Error("every workflow must declare exactly one top-level permissions policy");
  }
  if (jobsIndex < 0 || jobs.length < 1) {
    throw new Error("workflow must declare at least one exact job");
  }
  const rootMode = permissionMode(
    lines,
    rootPermissionIndexes[0]!,
    0,
  );
  return jobs.flatMap((job) => {
    const mode = job.permissionIndex === null
      ? rootMode
      : permissionMode(lines, job.permissionIndex, 4);
    return mode === "contents-write" ? [job.id] : [];
  });
}

describe("stable release workflow trust boundary", () => {
  test("loads from the default branch without granting its built-in token write access", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    expect(workflow).toContain("repository_dispatch:");
    expect(workflow).toContain("types: [genio-stable-release]");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/push:\s*\n\s+tags:/u);
    expect(workflow).toContain(
      "concurrency:\n  group: stable-release-mutation\n  cancel-in-progress: false",
    );
    expect(workflow.match(/environment: release-control-audit/gu)).toHaveLength(2);
    expect(workflow.match(/environment: stable-release/gu)).toHaveLength(1);
    expect(workflow).not.toMatch(/^\s+contents:\s+write\s*$/mu);
    expect(workflow).toContain(
      "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
    );
    expect(workflow).toContain(
      "app-id: ${{ vars.RELEASE_CONTROL_AUDITOR_APP_ID }}",
    );
    expect(workflow).toContain(
      "private-key: ${{ secrets.RELEASE_CONTROL_AUDITOR_APP_PRIVATE_KEY }}",
    );
    expect(workflow).toContain(
      "app-id: ${{ vars.STABLE_RELEASE_WRITER_APP_ID }}",
    );
    expect(workflow).toContain(
      "private-key: ${{ secrets.STABLE_RELEASE_WRITER_APP_PRIVATE_KEY }}",
    );
    expect(workflow).toContain("permission-actions: read");
    expect(workflow).toContain("permission-administration: write");
    expect(workflow).toContain("permission-contents: write");
    expect(workflow).toContain("permission-pull-requests: read");
    expect(workflow).not.toContain("STABLE_RELEASE_CONTROL_PLANE_TOKEN");
    expect(workflow).not.toContain("persist-credentials: true");

    const names = await readdir(workflowsDirectory);
    const observedContentsWriters: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
      const candidate = await readFile(
        new URL(name, workflowsDirectory),
        "utf8",
      );
      for (const job of effectiveContentsWriters(candidate)) {
        const writer = `${name}#${job}`;
        observedContentsWriters.push(writer);
        expect(
          exactContentsWriters.has(writer),
          `${writer} is not an approved release publisher`,
        ).toBe(true);
      }
    }
    expect(observedContentsWriters.sort()).toEqual(
      [...exactContentsWriters].sort(),
    );
  });

  test("permission census rejects write-all, inline, and inherited bypasses", () => {
    expect(effectiveContentsWriters(`
permissions: write-all
jobs:
  test:
    runs-on: ubuntu-latest
`)).toEqual(["test"]);
    expect(effectiveContentsWriters(`
permissions: { contents: read }
jobs:
  test:
    permissions: {contents: write, checks: read}
    runs-on: ubuntu-latest
`)).toEqual(["test"]);
    expect(effectiveContentsWriters(`
permissions:
  contents: write
jobs:
  inherited:
    runs-on: ubuntu-latest
  overridden:
    permissions: read-all
    runs-on: ubuntu-latest
`)).toEqual(["inherited"]);
    expect(() => effectiveContentsWriters(`
jobs:
  implicit:
    runs-on: ubuntu-latest
`)).toThrow(/top-level permissions policy/u);
    expect(() => effectiveContentsWriters(`
permissions: *repository-default
jobs:
  aliased:
    runs-on: ubuntu-latest
`)).toThrow(/explicit map/u);
  });

  test("fails closed on missing GitHub protections before any write", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const verifierIndex = workflow.indexOf("  verify_and_seal:");
    const finalIndex = workflow.indexOf("  final_reauthorize:");
    const publishIndex = workflow.indexOf("  publish:");
    const verifyIndex = workflow.indexOf(
      "Verify finalization evidence and distinct stable authorization",
    );
    const manifestIndex = workflow.indexOf(
      "Seal the bounded stable-release mutation inputs",
    );
    const receiptIndex = workflow.indexOf(
      "Seal the final control authorization receipt",
    );
    const immediateIndex = workflow.indexOf(
      "Reject a stale branch or moved RC immediately before writer minting",
    );
    const writerIndex = workflow.indexOf(
      "Mint the repository-scoped stable writer only for mutation",
    );
    const pushIndex = workflow.indexOf('push origin "refs/tags/$STABLE_TAG"');
    const releaseIndex = workflow.indexOf('gh release create "$STABLE_TAG"');
    expect(verifierIndex).toBeGreaterThan(0);
    expect(verifierIndex).toBeLessThan(verifyIndex);
    expect(verifyIndex).toBeLessThan(manifestIndex);
    expect(manifestIndex).toBeLessThan(finalIndex);
    expect(finalIndex).toBeLessThan(receiptIndex);
    expect(receiptIndex).toBeLessThan(publishIndex);
    expect(publishIndex).toBeLessThan(immediateIndex);
    expect(immediateIndex).toBeLessThan(writerIndex);
    expect(writerIndex).toBeLessThan(pushIndex);
    expect(pushIndex).toBeLessThan(releaseIndex);
    const verifier = workflow.slice(verifierIndex, finalIndex);
    const final = workflow.slice(finalIndex, publishIndex);
    const publish = workflow.slice(publishIndex);
    for (const auditSection of [verifier, final]) {
      expect(auditSection).toContain("environment: release-control-audit");
      expect(auditSection).toContain(
        "private-key: ${{ secrets.RELEASE_CONTROL_AUDITOR_APP_PRIVATE_KEY }}",
      );
      expect(auditSection).toContain("permission-administration: write");
      expect(auditSection).toContain("permission-contents: read");
      expect(auditSection).not.toContain(
        "secrets.STABLE_RELEASE_WRITER_APP_PRIVATE_KEY",
      );
      expect(auditSection).not.toContain("permission-contents: write");
    }
    expect(publish).toContain("environment: stable-release");
    expect(publish).toContain(
      "private-key: ${{ secrets.STABLE_RELEASE_WRITER_APP_PRIVATE_KEY }}",
    );
    expect(publish).not.toContain("RELEASE_CONTROL_AUDITOR_APP_PRIVATE_KEY");
    expect(publish).not.toContain("permission-administration:");
    const writerMutation = publish.slice(
      publish.indexOf("Create the exact immutable stable tag and GitHub Release"),
      publish.indexOf("Verify the published immutable stable Release read-only"),
    );
    expect(writerMutation).not.toContain("node");
    expect(writerMutation).not.toContain("scripts/");
    expect(writerMutation).not.toContain("gh api");
    expect(workflow).not.toContain("persist-credentials: true");
    expect(workflow).not.toContain("|| github.token");
    expect(workflow).toContain("github.rest.repos.getBranchProtection");
    expect(workflow).toContain(
      "GET /repos/{owner}/{repo}/environments/{environment_name}",
    );
    expect(workflow).toContain(
      "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}",
    );
    expect(workflow).toContain(
      "GET /repos/{owner}/{repo}/immutable-releases",
    );
    expect(workflow).toContain("reviewerRule.reviewers.length !== 1");
    expect(workflow).toContain(
      "!== context.repo.owner.toLowerCase()",
    );
    expect(workflow).toContain(
      "environment.data.prevent_self_review === true",
    );
    expect(workflow).not.toContain(
      'actor !== context.actor && state === "APPROVED"',
    );
    expect(workflow).toContain('"production-database-compatibility"');
    expect(workflow).toContain("github.rest.apps.getBySlug");
    expect(workflow).toContain(
      'githubActionsApp.data.slug !== "github-actions"',
    );
    expect(workflow).toContain(
      "const githubActionsAppId = Number(githubActionsApp.data.id)",
    );
    expect(workflow).toContain(
      "Number(process.env.STABLE_RELEASE_WRITER_APP_ID)",
    );
    expect(workflow).toContain("controlAuditorAppId");
    expect(workflow).toContain("]).size !== 3");
    expect(workflow).toContain('ruleset.data.target !== "tag"');
    expect(workflow).toContain('ruleset.data.enforcement !== "active"');
    expect(workflow).toContain(
      'JSON.stringify(["refs/tags/v*"])',
    );
    expect(workflow).toContain(
      'JSON.stringify(["refs/tags/v*-rc.*"])',
    );
    expect(workflow).toContain(
      'bypassActors[0]?.actor_type !== "Integration"',
    );
    expect(workflow).toContain(
      "Number(bypassActors[0]?.actor_id) !== stableWriterAppId",
    );
    expect(workflow).not.toContain("STABLE_RELEASE_BYPASS_ACTOR_ID");
    expect(workflow).toContain("stable-release-mutation-manifest.json");
    expect(workflow).toContain("stable-release-control-authorization.json");
    expect(workflow).toContain("now - authorizedAt > 5 * 60 * 1000");
    expect(workflow).toContain("annotated RC target changed after authorization");
    expect(workflow).toContain("stable annotated tag target changed after authorization");
    expect(workflow).toContain("Tag-Ruleset-ID:");
    expect(workflow).toContain("Tag-Bypass-Integration-ID:");
    expect(workflow).toContain("clientPayloadKeys.length > 10");
    expect(workflow).toContain('>= 64 * 1024');
    expect(workflow).toContain("github.rest.git.listMatchingRefs");
    expect(workflow).toContain("github.rest.repos.listReleases");
    expect(workflow).toContain(
      "stable release would move semantic version backwards",
    );
    expect(workflow).toContain(
      "equal stable tag is not an exact idempotent release identity",
    );
    expect(workflow).toContain(
      "equal stable release is not an exact idempotent reconciliation",
    );
    expect(workflow).toContain(
      "compareVersion(tuple, targetVersion) > 0",
    );
  });

  test("binds the stable release to exact RC, source, image, and evidence", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    expect(workflow).toContain(
      'test "$SOURCE_REVISION" = "$(git rev-parse "origin/$DEFAULT_BRANCH")"',
    );
    expect(workflow).toContain('test "$SOURCE_REVISION" = "$GITHUB_SHA"');
    expect(workflow).toContain(
      "node --experimental-transform-types scripts/verify-stable-release.ts",
    );
    expect(workflow).toContain("--confirm-stable-release-consumption");
    expect(workflow).toContain("--expected-rc-tag \"$CANDIDATE_TAG\"");
    expect(workflow).toContain("--expected-revision \"$EXPECTED_REVISION\"");
    expect(workflow).toContain("--expected-image-digest \"$IMAGE_DIGEST\"");
    expect(workflow).toContain(
      "--expected-image-reference \"$EXPECTED_IMAGE_REFERENCE\"",
    );
    expect(workflow).toContain('gh attestation verify "oci://$IMAGE_REFERENCE"');
    expect(workflow).toContain(
      '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release-candidate.yml"',
    );
    expect(workflow).toContain('--source-ref "refs/heads/$DEFAULT_BRANCH"');
    expect(workflow).toContain('--source-digest "$SOURCE_REVISION"');
    expect(workflow).toContain("--deny-self-hosted-runners");
    expect(workflow).toContain("--no-public-good");
    expect(workflow).toContain("Finalization-Evidence-SHA256:");
    expect(workflow).toContain("Stable-Authorization-SHA256:");
    expect(workflow).toContain(
      "equal stable tag identity changed",
    );
    expect(workflow).toContain('gh release create "$STABLE_TAG"');
    expect(workflow).toContain("--draft");
    expect(workflow).toContain('gh release upload "$STABLE_TAG"');
    expect(workflow).toContain(
      'gh release delete-asset "$STABLE_TAG" "$ASSET" --yes',
    );
    expect(workflow).toContain("immutable stable Release assets differ");
    expect(workflow).not.toContain(
      "pre-existing stable release draft is incomplete",
    );
    expect(workflow).toContain(
      'gh release edit "$STABLE_TAG" --draft=false',
    );
    expect(workflow).toContain(
      "release.target_commitish !== process.env.SOURCE_REVISION",
    );
    expect(workflow).toContain("release.immutable !== true");
  });
});

describe("stable release draft asset reconciliation", () => {
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "genio-stable-assets-"));
    const expectedDirectory = join(directory, "expected");
    const downloadedDirectory = join(directory, "downloaded");
    await Promise.all([
      mkdir(expectedDirectory),
      mkdir(downloadedDirectory),
    ]);
    await Promise.all(STABLE_RELEASE_ASSET_NAMES.map((name) => (
      writeFile(join(expectedDirectory, name), `verified:${name}\n`)
    )));
    return {
      directory,
      expectedDirectory,
      downloadedDirectory,
      release(assetNames: readonly string[], draft = true) {
        return {
          id: 42,
          draft,
          assets: assetNames.map((name, index) => ({
            id: index + 1,
            name,
          })),
        };
      },
    };
  }

  test("plans all five uploads for a newly created empty draft", async () => {
    const value = await fixture();
    try {
      const plan = await planStableReleaseAssetReconciliation({
        release: value.release([]),
        expectedDirectory: value.expectedDirectory,
        downloadedDirectory: value.downloadedDirectory,
      });
      expect(plan).toMatchObject({
        draft: true,
        missing: [...STABLE_RELEASE_ASSET_NAMES],
        replace: [],
        verified: [],
      });
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  });

  test("keeps verified draft assets and uploads only the missing remainder", async () => {
    const value = await fixture();
    const present = STABLE_RELEASE_ASSET_NAMES.slice(0, 2);
    try {
      await Promise.all(present.map(async (name) => {
        await writeFile(
          join(value.downloadedDirectory, name),
          await readFile(join(value.expectedDirectory, name)),
        );
      }));
      const plan = await planStableReleaseAssetReconciliation({
        release: value.release(present),
        expectedDirectory: value.expectedDirectory,
        downloadedDirectory: value.downloadedDirectory,
      });
      expect(plan.missing).toEqual(STABLE_RELEASE_ASSET_NAMES.slice(2));
      expect(plan.replace).toEqual([]);
      expect(plan.verified).toEqual(present);
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  });

  test("accepts an exact complete draft without another upload", async () => {
    const value = await fixture();
    try {
      await Promise.all(STABLE_RELEASE_ASSET_NAMES.map(async (name) => {
        await writeFile(
          join(value.downloadedDirectory, name),
          await readFile(join(value.expectedDirectory, name)),
        );
      }));
      const plan = await planStableReleaseAssetReconciliation({
        release: value.release(STABLE_RELEASE_ASSET_NAMES),
        expectedDirectory: value.expectedDirectory,
        downloadedDirectory: value.downloadedDirectory,
      });
      expect(plan.missing).toEqual([]);
      expect(plan.replace).toEqual([]);
      expect(plan.verified).toEqual(STABLE_RELEASE_ASSET_NAMES);
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  });

  test("replaces mismatched bytes only while the release remains a draft", async () => {
    const value = await fixture();
    const mismatched = STABLE_RELEASE_ASSET_NAMES[0];
    try {
      await writeFile(
        join(value.downloadedDirectory, mismatched),
        "interrupted-or-wrong-upload\n",
      );
      const draftPlan = await planStableReleaseAssetReconciliation({
        release: value.release([mismatched]),
        expectedDirectory: value.expectedDirectory,
        downloadedDirectory: value.downloadedDirectory,
      });
      expect(draftPlan.replace).toEqual([mismatched]);
      expect(draftPlan.missing).toEqual(STABLE_RELEASE_ASSET_NAMES.slice(1));

      await expect(planStableReleaseAssetReconciliation({
        release: value.release([mismatched], false),
        expectedDirectory: value.expectedDirectory,
        downloadedDirectory: value.downloadedDirectory,
      })).rejects.toThrow(
        "published stable release assets differ from the verified immutable evidence",
      );
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  });
});

describe("stable release dispatch preparation", () => {
  const digest = `sha256:${"a".repeat(64)}`;

  test("creates the exact five-key payload within GitHub limits", () => {
    const request = buildStableReleaseDispatchRequest({
      candidateTag: "v2.4.0-rc.1",
      imageDigest: digest,
      finalizationEvidence: Buffer.from('{"finalization":true}'),
      protectedBaselineMetadata: Buffer.from('{"baseline":true}'),
      stableAuthorization: Buffer.from('{"authorized":true}'),
    });
    expect(request.event_type).toBe("genio-stable-release");
    expect(Object.keys(request.client_payload).sort()).toEqual([
      "candidate_tag",
      "finalization_evidence_b64url",
      "image_digest",
      "protected_baseline_metadata_b64url",
      "stable_authorization_b64url",
    ]);
    expect(
      Buffer.byteLength(JSON.stringify(request.client_payload), "utf8"),
    ).toBeLessThan(GITHUB_CLIENT_PAYLOAD_MAX_BYTES);
  });

  test("rejects dispatch inputs that exceed GitHub's payload limit", () => {
    expect(() => buildStableReleaseDispatchRequest({
      candidateTag: "v2.4.0-rc.1",
      imageDigest: digest,
      finalizationEvidence: Buffer.from(JSON.stringify({
        value: "x".repeat(50_000),
      })),
      protectedBaselineMetadata: Buffer.from('{"baseline":true}'),
      stableAuthorization: Buffer.from('{"authorized":true}'),
    })).toThrow(/GitHub requires fewer than 65536 bytes/u);
  });

  test("requires an explicit complete preparation command", () => {
    const args = [
      "--confirm-stable-release-dispatch",
      "--candidate-tag",
      "v2.4.0-rc.1",
      "--image-digest",
      digest,
      "--finalization-evidence",
      "finalization.json",
      "--protected-baseline-metadata",
      "baseline.json",
      "--stable-authorization",
      "authorization.json",
      "--output",
      "dispatch.json",
    ];
    expect(parseStableReleaseDispatchArgs(args)).toMatchObject({
      candidateTag: "v2.4.0-rc.1",
      imageDigest: digest,
      outputPath: "dispatch.json",
    });
    expect(() => parseStableReleaseDispatchArgs(args.slice(1)))
      .toThrow(/requires --confirm-stable-release-dispatch/u);
  });
});

describe("stable release verifier CLI", () => {
  const args = [
    "--confirm-stable-release-consumption",
    "--finalization-evidence",
    "finalization.json",
    "--protected-baseline-metadata",
    "baseline.json",
    "--release-verification-key",
    "release.pem",
    "--stable-authorization",
    "authorization.json",
    "--stable-authorization-verification-key",
    "authorizer.pem",
    "--output",
    "consumer.json",
    "--expected-rc-tag",
    "v2.4.0-rc.1",
    "--expected-version",
    "2.4.0",
    "--expected-revision",
    "A".repeat(40),
    "--expected-image-digest",
    `sha256:${"B".repeat(64)}`,
    "--expected-image-reference",
    `GHCR.IO/OWNER/GENIO@sha256:${"B".repeat(64)}`,
  ];

  test("parses the complete explicitly confirmed target", () => {
    expect(parseStableReleaseVerificationArgs(args)).toMatchObject({
      finalizationEvidencePath: "finalization.json",
      protectedBaselineMetadataPath: "baseline.json",
      stableAuthorizationPath: "authorization.json",
      expectedRcTag: "v2.4.0-rc.1",
      expectedVersion: "2.4.0",
      expectedRevision: "a".repeat(40),
      expectedImageDigest: `sha256:${"b".repeat(64)}`,
      expectedImageReference:
        `ghcr.io/owner/genio@sha256:${"b".repeat(64)}`,
    });
  });

  test("rejects missing confirmation and duplicate or unknown inputs", () => {
    expect(() =>
      parseStableReleaseVerificationArgs(
        args.filter((value) =>
          value !== "--confirm-stable-release-consumption"
        ),
      )
    ).toThrow(/requires --confirm-stable-release-consumption/u);
    expect(() =>
      parseStableReleaseVerificationArgs([...args, "--output", "other.json"])
    ).toThrow(/Duplicate argument: --output/u);
    expect(() =>
      parseStableReleaseVerificationArgs([...args, "--unexpected"])
    ).toThrow(/Unknown argument: --unexpected/u);
  });
});
