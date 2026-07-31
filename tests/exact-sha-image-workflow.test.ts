import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const workflowUrl = new URL("../.github/workflows/exact-sha-image.yml", import.meta.url);
const recoveryDockerfileUrl = new URL("../Dockerfile.ghcr-recovery", import.meta.url);

const provenPredecessor =
  "ghcr.io/hooterjackson/genio@sha256:ea5b913d341e9d905545309841b6fdaf768ef3a73e781d58d3ae349abe743890";

describe("exact SHA image workflow", () => {
  test("builds without a Docker Hub BuildKit bootstrap", async () => {
    const [workflow, recoveryDockerfile] = await Promise.all([
      readFile(workflowUrl, "utf8"),
      readFile(recoveryDockerfileUrl, "utf8"),
    ]);

    expect(workflow).not.toContain("docker/setup-buildx-action@");
    expect(workflow).not.toContain("docker/build-push-action@");
    expect(workflow).toContain("--platform linux/amd64");
    expect(workflow).toContain("--file Dockerfile.ghcr-recovery");
    expect(workflow).toContain("docker push \"$IMAGE_TAG\"");
    expect(workflow).toContain("steps.build.outputs.image_digest");
    expect(recoveryDockerfile).toContain(`FROM ${provenPredecessor}`);
    expect(recoveryDockerfile).not.toMatch(/^FROM\s+(?:docker\.io\/)?node:/mu);
    expect(recoveryDockerfile).toContain("node scripts/check-release.mjs");
    expect(recoveryDockerfile).not.toContain("pnpm run release:check");
  });

  test("retains exact source, version, and digest receipts", async () => {
    const workflow = await readFile(workflowUrl, "utf8");

    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_REVISION"');
    expect(workflow).toContain("GENIO_BUILD_VERSION=$RELEASE_VERSION");
    expect(workflow).toContain("GENIO_BUILD_REVISION=$SOURCE_REVISION");
    expect(workflow).toContain("IMAGE_DIGEST=\"${IMAGE_REFERENCE##*@}\"");
    expect(workflow).toContain("image_reference=$IMAGE_REFERENCE");
    expect(workflow).toContain("image_digest=$IMAGE_DIGEST");
  });
});
