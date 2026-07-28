import { readdir, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
const dockerfileUrl = new URL("../Dockerfile", import.meta.url);
const composeUrl = new URL("../compose.yaml", import.meta.url);
const nodeImage =
  "node:22.19.0-alpine@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9";
const postgresImage =
  "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const productionPostgresImage =
  "ghcr.io/railwayapp-templates/postgres-ssl:18@sha256:764fabc5fceb7166414c425a57bed8722a08cfb7fff508efb21a86eb31e172a6";

const approvedPins = new Map([
  [
    "actions/checkout",
    "11d5960a326750d5838078e36cf38b85af677262",
  ],
  [
    "pnpm/action-setup",
    "b906affcce14559ad1aafd4ab0e942779e9f58b1",
  ],
  [
    "actions/setup-node",
    "49933ea5288caeca8642d1e84afbd3f7d6820020",
  ],
  [
    "actions/upload-artifact",
    "ea165f8d65b6e75b540449e92b4886f43607fa02",
  ],
  [
    "actions/download-artifact",
    "d3f86a106a0bac45b974a628896c90dbdf5c8093",
  ],
  [
    "actions/github-script",
    "f28e40c7f34bde8b3046d885e986cb6290c5673b",
  ],
  [
    "docker/setup-buildx-action",
    "8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
  ],
  [
    "docker/login-action",
    "c94ce9fb468520275223c153574b00df6fe4bcc9",
  ],
  [
    "docker/build-push-action",
    "10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
  ],
  [
    "actions/attest-build-provenance",
    "977bb373ede98d70efdf65b84cb5f73e068dcc2a",
  ],
  [
    "actions/attest",
    "f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6",
  ],
  [
    "oras-project/setup-oras",
    "22ce207df3b08e061f537244349aac6ae1d214f6",
  ],
]);

describe("GitHub Actions dependency provenance", () => {
  test("pins every external action to its approved full commit SHA", async () => {
    const names = (await readdir(workflowsDirectory))
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const workflow = await readFile(
        new URL(name, workflowsDirectory),
        "utf8",
      );
      const usesLines = workflow.matchAll(
        /^\s*(?:-\s+)?uses:\s+([^\s#]+)(?:\s+#\s+(\S+))?\s*$/gmu,
      );
      for (const match of usesLines) {
        const reference = match[1]!;
        if (reference.startsWith("./")) continue;
        const parsed =
          /^([0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+)@([0-9a-f]{40})$/u
            .exec(reference);
        expect(parsed, `${name}: ${reference}`).not.toBeNull();
        const action = parsed![1]!;
        expect(
          parsed![2],
          `${name}: ${action} must use the reviewed pin`,
        ).toBe(approvedPins.get(action));
        expect(
          match[2],
          `${name}: ${action} must retain a human-readable version comment`,
        ).toMatch(/^v\d/u);
      }
    }
  });

  test("pins every release container root to its reviewed OCI index digest", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8");
    const fromLines = [...dockerfile.matchAll(/^FROM\s+(\S+)/gmu)]
      .map((match) => match[1]);
    expect(fromLines).toEqual([nodeImage]);

    const compose = await readFile(composeUrl, "utf8");
    const composeImages = [...compose.matchAll(/^\s+image:\s+(\S+)/gmu)]
      .map((match) => match[1]);
    expect(composeImages).toEqual([postgresImage]);

    const names = (await readdir(workflowsDirectory))
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
    const workflowImages: string[] = [];
    for (const name of names) {
      const workflow = await readFile(
        new URL(name, workflowsDirectory),
        "utf8",
      );
      workflowImages.push(
        ...[...workflow.matchAll(/^\s{8,}image:\s+(\S+)/gmu)]
          .map((match) => match[1]!),
      );
    }
    expect(workflowImages.length).toBeGreaterThan(0);
    expect(new Set(workflowImages)).toEqual(
      new Set([postgresImage, productionPostgresImage]),
    );
    expect(workflowImages.every((image) =>
      /@sha256:[0-9a-f]{64}$/u.test(image)
    )).toBe(true);
  });
});
