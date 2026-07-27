import { createHash } from "node:crypto";
import {
  execFileSync,
  spawnSync,
} from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const workflowUrl = new URL(
  "../.github/workflows/bootstrap-stable-predecessor-image.yml",
  import.meta.url,
);
const historicalRevision = "7dc877cfc1537a9936974f9699a4b8ba9740b5f5";
const setupOrasRevision = "22ce207df3b08e061f537244349aac6ae1d214f6";
const orasVersion = "1.3.0";
const orasLinuxAmd64Url =
  `https://github.com/oras-project/oras/releases/download/v${orasVersion}/` +
  `oras_${orasVersion}_linux_amd64.tar.gz`;
const orasLinuxAmd64Sha256 =
  "6cdc692f929100feb08aa8de584d02f7bcc30ec7d88bc2adc2054d782db57c64";
const hasHistoricalRevision = spawnSync(
  "git",
  ["cat-file", "-e", `${historicalRevision}^{commit}`],
).status === 0;
const testRequire = createRequire(import.meta.url);

function descriptor(bytes: Buffer, mediaType: string) {
  return {
    mediaType,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.length,
  };
}

function runBlocks(workflow: string): string[] {
  const lines = workflow.split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(lines[index] ?? "");
    if (!match) continue;
    const indent = match[1]!.length;
    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.trim() && line.search(/\S/u) <= indent) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

function githubScriptAfter(workflow: string, stepName: string): string {
  const stepIndex = workflow.indexOf(`name: ${stepName}`);
  expect(stepIndex).toBeGreaterThan(0);
  const scriptIndex = workflow.indexOf("script: |", stepIndex);
  expect(scriptIndex).toBeGreaterThan(stepIndex);
  const lineStart = workflow.lastIndexOf("\n", scriptIndex) + 1;
  const lines = workflow.slice(lineStart).split("\n");
  const declarationIndent = lines[0]!.search(/\S/u);
  const body: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() && line.search(/\S/u) <= declarationIndent) break;
    body.push(line.slice(declarationIndent + 2));
  }
  return body.join("\n");
}

describe("one-time v2.3.4 wrapper-image workflow", () => {
  test.skipIf(!hasHistoricalRevision)(
    "pins a deterministic historical export with no VCS metadata",
    () => {
      const archive = execFileSync(
        "git",
        ["archive", "--format=tar", historicalRevision],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      expect(createHash("sha256").update(archive).digest("hex")).toBe(
        "bc599443f33e37ec100f2daa21d7e6da100315912cdf97bad8a2c65450c4d922",
      );
      const entries = execFileSync("tar", ["-tf", "-"], {
        input: archive,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }).trim().split("\n");
      expect(entries.some((entry) =>
        entry === ".git"
        || entry.startsWith(".git/")
        || entry.includes("/.git/")
      )).toBe(false);
    },
  );

  test("has no operator-selected identity and no ref or contents-write authority", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    expect(workflow).toContain(
      "types: [genio-stable-predecessor-wrapper-image-v2-3-4]",
    );
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+push:\s*$/mu);
    expect(workflow).toContain(
      "CLIENT_PAYLOAD_JSON: ${{ toJSON(github.event.client_payload) }}",
    );
    for (const block of runBlocks(workflow)) {
      expect(block).not.toContain(
        "${{ toJSON(github.event.client_payload) }}",
      );
    }
    expect(workflow).not.toMatch(/^\s+contents:\s+write\s*$/mu);
    expect(workflow).toMatch(/^\s+contents:\s+read\s*$/mu);
    expect(workflow).toMatch(/^\s+packages:\s+write\s*$/mu);
    expect(workflow).toMatch(/^\s+attestations:\s+write\s*$/mu);
    expect(workflow).not.toMatch(/^\s+git\s+(?:tag|push|update-ref)\b/mu);
    expect(workflow).not.toContain("gh release");
    expect(workflow).not.toContain("github.rest.git.createRef");
    expect(workflow).toContain(
      "concurrency:\n  group: stable-release-mutation\n  cancel-in-progress: false",
    );
  });

  test("binds the pinned setup action to a checksum-verified ORAS release it can install", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const setupStart = workflow.indexOf(
      `uses: oras-project/setup-oras@${setupOrasRevision}`,
    );
    const loginStart = workflow.indexOf(
      "uses: docker/login-action@",
      setupStart,
    );
    expect(setupStart).toBeGreaterThan(0);
    expect(loginStart).toBeGreaterThan(setupStart);
    const setupBlock = workflow.slice(setupStart, loginStart);
    expect(setupBlock).toContain(`url: ${orasLinuxAmd64Url}`);
    expect(setupBlock).toContain(
      `checksum: ${orasLinuxAmd64Sha256}`,
    );
    expect(setupBlock).not.toContain("version:");
    expect(setupBlock).not.toContain("1.3.2");
  });

  test("separates the protected controller recipe from the exact historical context", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    expect(workflow).toContain("path: controller");
    expect(workflow).toContain("path: historical");
    expect(workflow).toContain(
      "ref: 7dc877cfc1537a9936974f9699a4b8ba9740b5f5",
    );
    expect(workflow).toContain(
      "ORIGINAL_SOURCE_TREE: 91076c2f06de9d562532981c3a602f1c6366f057",
    );
    expect(workflow).toContain(
      "CONTROLLER_DOCKERFILE_SHA256: 67bef0595e27b3bfff80a6208b25c6da04de6535018f6c83a4e6dee4aeeabb08",
    );
    expect(workflow).toContain(
      "HISTORICAL_BUILD_INTENT_SHA256: ae81d5d22a4ebbdb56f284e9c5cd673dfd690c87bb9f9d5b8195b11d8e74bb99",
    );
    expect(workflow).toContain(
      "HISTORICAL_SOURCE_ARCHIVE_SHA256: bc599443f33e37ec100f2daa21d7e6da100315912cdf97bad8a2c65450c4d922",
    );
    expect(workflow).toContain(
      'test ! -e historical/Dockerfile',
    );
    expect(workflow).toContain(
      'git -C historical archive',
    );
    expect(workflow).toContain(
      'test "$(sha256sum "$RUNNER_TEMP/v2.3.4-source.tar" | cut -d\' \' -f1)" = "$HISTORICAL_SOURCE_ARCHIVE_SHA256"',
    );
    expect(workflow).toContain("mkdir historical-context");
    expect(workflow).toContain(
      "tar -xf \"$RUNNER_TEMP/v2.3.4-source.tar\" -C historical-context",
    );
    expect(workflow).toContain("test ! -e historical-context/.git");
    expect(workflow).toContain("context: historical-context");
    expect(workflow).not.toContain("context: historical\n");
    expect(workflow).toContain("file: controller/Dockerfile");
    expect(workflow).toContain("GENIO_BUILD_VERSION=2.3.4");
    expect(workflow).toContain(
      "GENIO_BUILD_REVISION=7dc877cfc1537a9936974f9699a4b8ba9740b5f5",
    );
  });

  test("pushes no tag, attests only the wrapper digest, and records the limitation", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    expect(workflow).toContain(
      '"$OCI_ARCHIVE@$SEALED_DIGEST" \\\n            "$IMAGE"',
    );
    expect(workflow).not.toMatch(/^\s+tags:\s*$/mu);
    expect(workflow).not.toContain("docker push");
    expect(workflow).not.toContain("oras tag");
    expect(workflow).toContain("actions/attest-build-provenance@");
    expect(workflow).toContain(
      "subject-digest: ${{ steps.seal.outputs.digest }}",
    );
    expect(workflow).not.toContain(
      "subject-digest: ${{ steps.push.outputs.digest }}",
    );
    expect(workflow).toContain(
      '--signer-workflow "$GITHUB_REPOSITORY/$BOOTSTRAP_WORKFLOW"',
    );
    expect(workflow).toContain(
      "separate_reconstruction_wrapper_not_historical_railway_artifact",
    );
    expect(workflow).toContain(
      "railway_observations_cannot_satisfy_this_image_attestation",
    );
    expect(workflow).toContain(
      "sourceArchiveSha256:process.env.HISTORICAL_SOURCE_ARCHIVE_SHA256",
    );
    expect(workflow).toContain(
      "ociArchiveSha256:process.env.OCI_ARCHIVE_SHA256",
    );
    expect(workflow).toContain(
      "ociGraphSha256:process.env.OCI_GRAPH_SHA256",
    );
    expect(workflow).toContain(
      "JSON.stringify(sort(verification))",
    );
    expect(workflow).toContain(
      "name: stable-predecessor-wrapper-${{ steps.digest_id.outputs.value }}",
    );
    expect(workflow).not.toContain(
      "name: stable-predecessor-wrapper-${{ steps.push.outputs.digest }}",
    );
    expect(workflow).toContain(
      '/^sha256:([0-9a-f]{64})$/.exec',
    );
  });

  test("closes before image publication when v2.3.4 is no longer the greatest stable", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const build = workflow.indexOf(
      "Build the explicit non-historical wrapper without registry mutation",
    );
    const seal = workflow.indexOf(
      "Seal the registry-free OCI archive and image digest",
    );
    const reachability = workflow.indexOf(
      "Recheck full stable semver immediately before wrapper push",
    );
    const publication = workflow.indexOf(
      "Push exactly the sealed OCI archive without rebuilding or tagging",
    );
    const attestation = workflow.indexOf(
      "Attest only the separately reconstructed wrapper",
    );
    expect(build).toBeGreaterThan(0);
    expect(seal).toBeGreaterThan(build);
    expect(reachability).toBeGreaterThan(seal);
    expect(publication).toBeGreaterThan(reachability);
    expect(attestation).toBeGreaterThan(publication);
    expect(workflow.match(/docker\/build-push-action@/gu)).toHaveLength(1);
    expect(workflow.match(/^\s+oras cp \\/gmu)).toHaveLength(1);
    expect(workflow.slice(build, seal)).toContain(
      "outputs: type=oci,dest=${{ runner.temp }}/stable-predecessor-wrapper.oci.tar",
    );
    const beforeFinalFence = workflow.slice(0, reachability);
    expect(beforeFinalFence).not.toContain("oras cp");
    expect(beforeFinalFence).not.toContain("push=true");
    expect(beforeFinalFence).not.toContain("docker push");
    expect(beforeFinalFence).not.toContain("oras manifest push");
    expect(beforeFinalFence).not.toContain(
      "push-to-registry: true",
    );
    expect(workflow.slice(publication, attestation)).toContain(
      "SEALED_ARCHIVE_SHA256: ${{ steps.seal.outputs.archive_sha256 }}",
    );
    expect(workflow.slice(publication, attestation)).toContain(
      "SEALED_DIGEST: ${{ steps.seal.outputs.digest }}",
    );
    expect(workflow.slice(publication, attestation)).toContain(
      'test "$(sha256sum "$OCI_ARCHIVE" | cut -d\' \' -f1)" = "$SEALED_ARCHIVE_SHA256"',
    );
    expect(workflow.slice(publication, attestation)).toContain(
      '"$OCI_ARCHIVE@$SEALED_DIGEST"',
    );
    expect(workflow.slice(publication, attestation)).toContain(
      '"$IMAGE@$SEALED_DIGEST"',
    );
    expect(workflow.slice(publication, attestation)).toContain(
      'cmp "$RUNNER_TEMP/wrapper-local-manifest.json" "$RUNNER_TEMP/wrapper-remote-manifest.json"',
    );
    expect(workflow.slice(publication, attestation)).toContain(
      'echo "digest=$SEALED_DIGEST" >> "$GITHUB_OUTPUT"',
    );
    expect(workflow).toContain(
      "one-time v2.3.4 wrapper publication is closed by a later stable tag or Release",
    );
    expect(workflow).not.toContain("v2.5.0-rc.");
  });

  test("behaviorally seals one complete OCI graph and binds it to the BuildKit digest", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "genio-wrapper-seal-"));
    try {
      const layout = join(workspace, "layout");
      const blobs = join(layout, "blobs", "sha256");
      await mkdir(blobs, { recursive: true });
      const configBytes = Buffer.from(JSON.stringify({
        architecture: "amd64",
        os: "linux",
        rootfs: { type: "layers", diff_ids: [] },
      }));
      const config = descriptor(
        configBytes,
        "application/vnd.oci.image.config.v1+json",
      );
      const layerBytes = Buffer.from("sealed-wrapper-layer");
      const layer = descriptor(
        layerBytes,
        "application/vnd.oci.image.layer.v1.tar",
      );
      const manifestBytes = Buffer.from(JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config,
        layers: [layer],
      }));
      const manifest = descriptor(
        manifestBytes,
        "application/vnd.oci.image.manifest.v1+json",
      );
      for (const [item, bytes] of [
        [config, configBytes],
        [layer, layerBytes],
        [manifest, manifestBytes],
      ] as const) {
        await writeFile(
          join(blobs, item.digest.slice("sha256:".length)),
          bytes,
        );
      }
      await writeFile(
        join(layout, "oci-layout"),
        JSON.stringify({ imageLayoutVersion: "1.0.0" }),
      );
      await writeFile(
        join(layout, "index.json"),
        JSON.stringify({
          schemaVersion: 2,
          manifests: [manifest],
        }),
      );
      const archive = join(workspace, "wrapper.oci.tar");
      execFileSync("tar", ["-cf", archive, "-C", layout, "."]);

      const workflow = await readFile(workflowUrl, "utf8");
      const script = githubScriptAfter(
        workflow,
        "Seal the registry-free OCI archive and image digest",
      );
      const outputs = new Map<string, string>();
      const core = {
        setOutput: (name: string, value: unknown) => {
          outputs.set(name, String(value));
        },
      };
      const processValue = {
        env: {
          OCI_ARCHIVE: archive,
          BUILD_DIGEST: manifest.digest,
          RUNNER_TEMP: workspace,
          SEAL_EVIDENCE: join(workspace, "seal.json"),
        },
      };
      const AsyncFunction = Object.getPrototypeOf(async () => undefined)
        .constructor as new (...args: string[]) => (
          ...values: unknown[]
        ) => Promise<void>;
      const run = new AsyncFunction(
        "require",
        "process",
        "core",
        script,
      );
      await expect(
        run(testRequire, processValue, core),
      ).resolves.toBeUndefined();
      const expectedArchiveSha256 = createHash("sha256")
        .update(await readFile(archive))
        .digest("hex");
      expect(outputs.get("digest")).toBe(manifest.digest);
      expect(outputs.get("archive_sha256")).toBe(expectedArchiveSha256);
      expect(outputs.get("graph_sha256")).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.parse(
        await readFile(processValue.env.SEAL_EVIDENCE, "utf8"),
      )).toEqual({
        schemaVersion: "genio-sealed-oci-wrapper/v1",
        archiveSha256: expectedArchiveSha256,
        imageDigest: manifest.digest,
        graphSha256: outputs.get("graph_sha256"),
      });

      processValue.env.BUILD_DIGEST = `sha256:${"0".repeat(64)}`;
      processValue.env.SEAL_EVIDENCE = join(workspace, "wrong-seal.json");
      await expect(
        run(testRequire, processValue, core),
      ).rejects.toThrow(
        /BuildKit digest differs from the OCI root digest/u,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("the final fence rejects a v2.3.5 release even when the greatest tag remains v2.3.4", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const script = githubScriptAfter(
      workflow,
      "Recheck full stable semver immediately before wrapper push",
    );
    const AsyncFunction = Object.getPrototypeOf(async () => undefined)
      .constructor as new (...args: string[]) => (
        ...values: unknown[]
      ) => Promise<void>;
    const refs = [{
      ref: "refs/tags/v2.3.4",
    }];
    const releases = [{
      tag_name: "v2.3.5",
    }];
    const listMatchingRefs = () => undefined;
    const listReleases = () => undefined;
    const github = {
      rest: {
        git: { listMatchingRefs },
        repos: { listReleases },
      },
      paginate: async (method: unknown) =>
        method === listMatchingRefs ? refs : releases,
    };
    const context = {
      repo: { owner: "hooterjackson", repo: "genio" },
    };
    const run = new AsyncFunction("github", "context", script);
    await expect(run(github, context)).rejects.toThrow(
      /closed by a later stable tag or Release/u,
    );

    releases[0]!.tag_name = "v2.3.4";
    await expect(run(github, context)).resolves.toBeUndefined();
  });
});
