import { pathToFileURL } from "node:url";
import {
  collectReleaseConvergenceEvidence,
  parseReleaseConvergenceArgs,
} from "./verify-release-convergence.ts";
import {
  emitReleaseGateProducerArtifacts,
  loadReleaseProducerRuntimeSnapshot,
  preflightReleaseProducerFiles,
  releaseProducerCandidate,
  releaseProducerOption,
} from "./release-gate-producer.ts";

const CONFIRMATION_FLAG = "--confirm-production-probe";
const DEADLINE_MS = 5 * 60_000;

export interface ReleaseConvergenceProducerArgs {
  origin: string;
  scope: "backend" | "full";
  expectedRevision: string;
  expectedVersion: string;
  expectedSitesRevision: string;
  expectedSitesVersion: string;
  candidateTag: string;
  imageDigest: string;
  runtimeSnapshotPath: string;
  samples: number;
  intervalMs: number;
  files: {
    sourceOutputPath: string;
    artifactOutputPath: string;
    attestationOutputPath: string;
    producerSigningKeyPath: string;
    producerKeyId: string;
  };
}

export function parseReleaseConvergenceProducerArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): ReleaseConvergenceProducerArgs {
  const allowed = new Set([
    CONFIRMATION_FLAG,
    "--origin",
    "--scope",
    "--expected-revision",
    "--expected-version",
    "--expected-sites-revision",
    "--expected-sites-version",
    "--candidate-tag",
    "--image-digest",
    "--runtime-snapshot",
    "--samples",
    "--interval-seconds",
    "--source-output",
    "--output",
    "--attestation-output",
    "--producer-signing-key",
    "--producer-key-id",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (argument !== CONFIRMATION_FLAG) index += 1;
  }
  if (argv.filter((value) => value === CONFIRMATION_FLAG).length !== 1) {
    throw new Error(`Production convergence evidence requires ${CONFIRMATION_FLAG}`);
  }
  const configuredOrigin = environment.RELEASE_PRODUCTION_ORIGIN?.trim() ?? "";
  if (!configuredOrigin) {
    throw new Error("RELEASE_PRODUCTION_ORIGIN is required for convergence evidence");
  }
  const origin = releaseProducerOption(argv, "--origin");
  if (new URL(origin).origin !== "https://9enio.com"
    || new URL(configuredOrigin).origin !== "https://9enio.com"
    || origin !== new URL(origin).origin) {
    throw new Error("--origin must exactly identify the configured 9enio.com production origin");
  }
  const expectedRevision = releaseProducerOption(argv, "--expected-revision").toLowerCase();
  const expectedVersion = releaseProducerOption(argv, "--expected-version");
  const scope = releaseProducerOption(argv, "--scope");
  if (scope !== "backend" && scope !== "full") {
    throw new Error("--scope must be backend or full");
  }
  const expectedSitesRevision =
    releaseProducerOption(argv, "--expected-sites-revision").toLowerCase();
  const expectedSitesVersion =
    releaseProducerOption(argv, "--expected-sites-version");
  const candidateTag = releaseProducerOption(argv, "--candidate-tag");
  const imageDigest = releaseProducerOption(argv, "--image-digest");
  releaseProducerCandidate({
    tag: candidateTag,
    version: expectedVersion,
    sourceRevision: expectedRevision,
    imageDigest,
  });
  const convergence = parseReleaseConvergenceArgs([
    "--origin", origin,
    "--scope", scope,
    "--expected-revision", expectedRevision,
    "--expected-version", expectedVersion,
    "--expected-sites-revision", expectedSitesRevision,
    "--expected-sites-version", expectedSitesVersion,
    "--samples", releaseProducerOption(argv, "--samples"),
    "--interval-seconds", releaseProducerOption(argv, "--interval-seconds"),
  ]);
  return {
    origin,
    scope,
    expectedRevision,
    expectedVersion,
    expectedSitesRevision,
    expectedSitesVersion,
    candidateTag,
    imageDigest,
    runtimeSnapshotPath: releaseProducerOption(argv, "--runtime-snapshot"),
    samples: convergence.samples,
    intervalMs: convergence.intervalMs,
    files: {
      sourceOutputPath: releaseProducerOption(argv, "--source-output"),
      artifactOutputPath: releaseProducerOption(argv, "--output"),
      attestationOutputPath: releaseProducerOption(argv, "--attestation-output"),
      producerSigningKeyPath: releaseProducerOption(argv, "--producer-signing-key"),
      producerKeyId: releaseProducerOption(argv, "--producer-key-id"),
    },
  };
}

async function main(): Promise<void> {
  const args = parseReleaseConvergenceProducerArgs(process.argv.slice(2));
  await preflightReleaseProducerFiles(args.files);
  const deadlineAt = Date.now() + DEADLINE_MS;
  const candidate = releaseProducerCandidate({
    tag: args.candidateTag,
    version: args.expectedVersion,
    sourceRevision: args.expectedRevision,
    imageDigest: args.imageDigest,
  });
  const runtimeSnapshot = await loadReleaseProducerRuntimeSnapshot({
    path: args.runtimeSnapshotPath,
    environment: "production",
    expectedScope: args.scope,
    origin: args.origin,
    candidate,
  });
  if (
    runtimeSnapshot.sitesObservation.sourceRevision
      !== args.expectedSitesRevision
    || runtimeSnapshot.sitesObservation.version !== args.expectedSitesVersion
  ) {
    throw new Error(
      "Production convergence Sites identity does not match the runtime snapshot",
    );
  }
  const convergence = await collectReleaseConvergenceEvidence({
    origin: args.origin,
    scope: args.scope,
    expectedRevision: args.expectedRevision,
    expectedVersion: args.expectedVersion,
    expectedSitesRevision: args.expectedSitesRevision,
    expectedSitesVersion: args.expectedSitesVersion,
    samples: args.samples,
    intervalMs: args.intervalMs,
    expectedConfigurationHashes: {
      api: runtimeSnapshot.configuration.apiHash,
      interactiveWorker:
        runtimeSnapshot.configuration.interactiveWorkerHash,
      deepWorker: runtimeSnapshot.configuration.deepWorkerHash,
    },
  }, deadlineAt);
  if (!convergence.passed) {
    throw new Error("Production release convergence did not pass");
  }
  if (Date.now() >= deadlineAt) {
    throw new Error("Production convergence evidence exceeded its hard deadline");
  }
  const produced = await emitReleaseGateProducerArtifacts({
    gate: args.scope === "backend"
      ? "backend_release_convergence"
      : "release_convergence",
    completedAt: new Date().toISOString(),
    candidate,
    runtimeSnapshot,
    fixtures: [],
    sources: { convergence },
    files: args.files,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    gate: produced.artifact.gate,
    convergenceEvidenceHash: convergence.evidenceHash,
    gateEvidenceHash: produced.artifact.evidenceHash,
    producerKeyId: produced.attestation.signature.keyId,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "release_convergence_producer_failed",
      message: "Production convergence producer failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
