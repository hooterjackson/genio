import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  frenchJazzGuidanceDecisionV3,
  smoothReggaetonHeatGuidanceDecisionV3,
} from "../../server/adaptive-guidance-v3.ts";
import {
  publicGuidanceQuestionV3,
} from "../../server/adaptive-guidance-contract-bridge.ts";
import {
  compilePlaylistContractRevisionV1,
} from "../../server/playlist-contract-v1.ts";
import {
  sitesControlPlaneKeyFingerprint,
  sitesControlPlaneTrustPolicyV1,
  sitesControlPlaneVerificationKeyV1,
} from "../../shared/sites-control-plane-attestation.ts";
import {
  createSitesProductionRollbackTargetV1,
} from "../../shared/sites-production-rollback.ts";
import {
  createStrictSignedEnvelope,
} from "../../shared/signed-artifact.ts";
import {
  releaseGateProducerKeyFingerprint,
  releaseGateProducerTrustPolicyV1,
} from "../../scripts/release-evidence.ts";
import {
  LEGACY_FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1,
  attestReleaseGateArtifact,
  createReleaseFixtureExecutionProof,
  createReleaseGateArtifactFromSources,
  releaseFixtureBindingsForGate,
  releaseFixturePrompt,
  releaseFixtureSha256,
  type ReleaseFixtureId,
  type ReleaseGateArtifactV1,
  type ReleaseGateCandidateBindingV1,
  type ReleaseGateName,
  type ReleaseGateProducerAttestationV1,
} from "../../scripts/release-fixtures.ts";
import {
  STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
  STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE,
  STABLE_PREDECESSOR_BOOTSTRAP_TAG_OBJECT,
  STABLE_PREDECESSOR_BOOTSTRAP_INDEPENDENT_EVIDENCE_SCHEMA_V1,
  type StablePredecessorBootstrapSourceBytesV1,
} from "../../scripts/stable-predecessor-bootstrap.ts";

export function stableBootstrapSourceBytesFixture(
  controllerWorkflowBytes: string | Buffer =
    "name: protected bootstrap controller fixture\n",
): StablePredecessorBootstrapSourceBytesV1 {
  return {
    controllerWorkflowBytes,
    tagObjectBytes: execFileSync("git", [
      "cat-file",
      "tag",
      STABLE_PREDECESSOR_BOOTSTRAP_TAG_OBJECT,
    ]),
    sourceCommitBytes: execFileSync("git", [
      "cat-file",
      "commit",
      STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
    ]),
    sourceTreeObjectBytes: execFileSync("git", [
      "cat-file",
      "tree",
      STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE,
    ]),
  };
}

function fixtureGuidancePayload(
  fixtureId: Extract<
    ReleaseFixtureId,
    "smooth-reggaeton-heat-50-v1"
      | "french-jazz-guided-constraint-25-v1"
  >,
) {
  const questionSetHash = releaseFixtureSha256({
    fixtureId,
    kind: "bootstrap-guidance-question-set",
  });
  if (fixtureId === "smooth-reggaeton-heat-50-v1") {
    const decision = smoothReggaetonHeatGuidanceDecisionV3({
      prompt: releaseFixturePrompt(fixtureId),
      baseContractRevisionId: "fixture-contract-reggaeton-v1",
      baseContractSemanticHash: releaseFixtureSha256({
        fixtureId,
        kind: "base-contract",
      }),
      preservedTrackPredicate: null,
      ambiguousScopeClauseIds: [],
    });
    if (!decision) throw new Error("missing reggaeton fixture guidance decision");
    return {
      questionSetHash,
      questions: [publicGuidanceQuestionV3(decision)],
    };
  }
  const prompt = releaseFixturePrompt(fixtureId);
  const protectedClauses = [
    {
      id: "genre:jazz",
      kind: "membership" as const,
      scope: "track" as const,
      hardness: "hard" as const,
      axis: "genre",
      operator: "require" as const,
      values: ["jazz"],
      source: { provenance: "prompt" as const, text: "jazz" },
    },
    {
      id: "recording:clean",
      kind: "catalog_version" as const,
      scope: "track" as const,
      hardness: "hard" as const,
      axis: "content",
      operator: "require" as const,
      values: ["clean"],
      source: { provenance: "prompt" as const, text: "clean" },
    },
    {
      id: "recording:original-studio",
      kind: "catalog_version" as const,
      scope: "track" as const,
      hardness: "hard" as const,
      axis: "version",
      operator: "require" as const,
      values: ["original studio"],
      source: { provenance: "prompt" as const, text: "original studio" },
    },
    {
      id: "exclude:live",
      kind: "exclusion" as const,
      scope: "track" as const,
      hardness: "hard" as const,
      axis: "version",
      operator: "exclude" as const,
      values: ["live"],
      source: {
        provenance: "prompt" as const,
        text: "exclude live recordings",
      },
    },
    {
      id: "exclude:remix",
      kind: "exclusion" as const,
      scope: "track" as const,
      hardness: "hard" as const,
      axis: "version",
      operator: "exclude" as const,
      values: ["remix"],
      source: { provenance: "prompt" as const, text: "exclude remixes" },
    },
  ];
  const base = compilePlaylistContractRevisionV1({
    contractId: "release-fixture:french-jazz-guided-constraint-25-v1",
    rawPrompt: prompt,
    requestedTrackCount: 25,
    locale: "en-US",
    storefront: "us",
    clauses: [
      ...protectedClauses,
      {
        id: "prompt:french",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "geography",
        operator: "require",
        values: ["French"],
        source: { provenance: "prompt", text: "French" },
      },
    ],
    trackPredicate: {
      op: "all",
      children: [
        ...protectedClauses.map(({ id }) => ({
          op: "clause" as const,
          clauseId: id,
        })),
        { op: "clause", clauseId: "prompt:french" },
      ],
    },
  });
  const decision = frenchJazzGuidanceDecisionV3({
    prompt,
    baseContract: base,
  });
  if (!decision) throw new Error("missing French-jazz guidance decision");
  return {
    questionSetHash,
    questions: [publicGuidanceQuestionV3(decision)],
  };
}

function publicationSources(input: {
  gate: Extract<
    ReleaseGateName,
    "staging_fixed_three_track"
      | "staging_affected_regression"
      | "staging_guided_constraint"
  >;
  candidate: ReleaseGateCandidateBindingV1;
  completedAt: string;
  verifierCredentialVersionHash: string;
}) {
  const lineageHashes = {
    "smooth-reggaeton-heat-50-v1": releaseFixtureSha256({
      gate: input.gate,
      fixture: "smooth-reggaeton-heat-50-v1",
      kind: "guidance-lineage",
    }),
    "french-jazz-guided-constraint-25-v1": releaseFixtureSha256({
      gate: input.gate,
      fixture: "french-jazz-guided-constraint-25-v1",
      kind: "guidance-lineage",
    }),
  };
  const fixtures = releaseFixtureBindingsForGate(
    input.gate,
    lineageHashes,
  );
  const fixture = fixtures[0]!;
  const fixtureExecution = createReleaseFixtureExecutionProof({
    fixtureId: fixture.fixtureId,
    guidanceLineageHash: fixture.guidanceLineageHash,
    guidancePayload: fixture.guidanceMode === "recommended"
      ? fixtureGuidancePayload(fixture.fixtureId as Extract<
          ReleaseFixtureId,
          "smooth-reggaeton-heat-50-v1"
            | "french-jazz-guided-constraint-25-v1"
        >)
      : null,
  });
  const canaryId = `bootstrap-${input.gate}-canary`;
  const orderedAppleIdsHash = releaseFixtureSha256({
    gate: input.gate,
    fixtureId: fixture.fixtureId,
    kind: "ordered-apple-ids",
  });
  const manifestContentHash = releaseFixtureSha256({
    gate: input.gate,
    fixtureId: fixture.fixtureId,
    kind: "manifest-content",
  });
  const independentUnsigned = {
    schemaVersion: "genio-independent-apple-release-evidence/v1",
    canaryId,
    environment: "staging",
    candidateRevision: input.candidate.sourceRevision,
    observedAt: input.completedAt,
    verifierCredentialVersionHash: input.verifierCredentialVersionHash,
    verifierCredentialIdentityHash: releaseFixtureSha256({
      gate: input.gate,
      kind: "verifier-credential-identity",
    }),
    playlistCount: 1,
    targetTrackCount: fixture.targetTrackCount,
    expectedOrderedIdsHash: orderedAppleIdsHash,
    observedOrderedIdsHash: orderedAppleIdsHash,
    exactOrderedReadback: true,
    publicNamesHash: releaseFixtureSha256({
      gate: input.gate,
      kind: "public-names",
    }),
    browserChecks: [{
      volumeIndex: 1,
      screenshotHash: releaseFixtureSha256({
        gate: input.gate,
        kind: "playlist-screenshot",
      }),
      titleVisible: true,
      firstTrackVisible: true,
      lastTrackVisible: true,
      countVisible: true,
    }],
  };
  const independentApple = {
    ...independentUnsigned,
    evidenceHash: releaseFixtureSha256(independentUnsigned),
  };
  const hostedUnsigned = {
    schemaVersion: "genio-hosted-publication-smoke/v1",
    canaryId,
    cacheMode: "reuse_disabled",
    targetTrackCount: fixture.targetTrackCount,
    manifestContentHash,
    contractHash: releaseFixtureSha256({
      gate: input.gate,
      kind: "contract",
    }),
    answerLineageHash: releaseFixtureSha256({
      gate: input.gate,
      kind: "answer-lineage",
    }),
    queryPlanRevisionHash: releaseFixtureSha256({
      gate: input.gate,
      kind: "query-plan",
    }),
    guidanceLineageHash:
      fixture.guidanceLineageHash ?? releaseFixtureSha256({
        gate: input.gate,
        kind: "no-guidance-lineage",
      }),
    guidanceRevisionCount: fixture.guidanceLineageHash ? 1 : 0,
    executorRevisions: [input.candidate.sourceRevision],
    executorIdentityHashes: [releaseFixtureSha256({
      gate: input.gate,
      kind: "executor",
    })],
    configurationHashes: [releaseFixtureSha256({
      gate: input.gate,
      kind: "worker-configuration",
    })],
    completedAttemptCount: 1,
    allAttemptsComplete: true,
    serverReportedOrderedAppleReconciliation: true,
    orderedAppleIdsHash,
    independentAppleEvidenceHash: independentApple.evidenceHash,
    volumes: [{
      index: 1,
      trackCount: fixture.targetTrackCount,
      appendedCount: fixture.targetTrackCount,
      shareUrl: `https://music.apple.com/us/playlist/${input.gate}/pl.u-test`,
    }],
  };
  return {
    fixtures,
    sources: {
      hostedPublication: {
        ...hostedUnsigned,
        evidenceHash: createHash("sha256")
          .update(JSON.stringify(hostedUnsigned))
          .digest("hex"),
      },
      independentApple,
      fixtureExecution,
    },
  };
}

function finalBrowserSources(input: {
  candidate: ReleaseGateCandidateBindingV1;
  completedAt: string;
  sitesKeys: { privateKey: KeyObject; publicKey: KeyObject };
}) {
  const observedAt = input.completedAt;
  const deploymentRequestedAt = new Date(
    Date.parse(observedAt) - 30_000,
  ).toISOString();
  const capturedAt = new Date(
    Date.parse(observedAt) - 60_000,
  ).toISOString();
  const controlPlaneObservedAt = new Date(
    Date.parse(observedAt) - 120_000,
  ).toISOString();
  const liveObservedAt = new Date(
    Date.parse(observedAt) - 90_000,
  ).toISOString();
  const rollbackTarget = createSitesProductionRollbackTargetV1({
    capturedAt,
    projectId: "bootstrap-project-test",
    productionUrl: "https://9enio.com",
    plannedCandidate: {
      commitSha: input.candidate.sitesSourceRevision,
      buildVersion: input.candidate.version,
    },
    previous: {
      versionId: "bootstrap-prior-version",
      versionNumber: 80,
      commitSha: "f".repeat(40),
      archiveSha256: releaseFixtureSha256("bootstrap-prior-archive"),
      deploymentId: "bootstrap-prior-deployment",
      deploymentStatus: "succeeded",
      controlPlaneObservedAt,
      liveObservedAt,
      liveBuildVersion: "2.3.3",
      liveBuildRevision: "f".repeat(40),
    },
  });
  const sitesUnsigned = {
    schemaVersion: "genio-sites-control-plane-deployment/v2",
    projectId: "bootstrap-project-test",
    versionId: "bootstrap-version-test",
    versionNumber: 81,
    archiveSha256: releaseFixtureSha256("bootstrap-candidate-archive"),
    deploymentId: "bootstrap-deployment-test",
    commitSha: input.candidate.sitesSourceRevision,
    buildVersion: input.candidate.version,
    productionUrl: "https://9enio.com",
    status: "ready",
    deploymentRequestedAt,
    observedAt,
    rollbackTarget,
  };
  const sitesControlPlane = {
    ...sitesUnsigned,
    evidenceHash: releaseFixtureSha256(sitesUnsigned),
  };
  const sitesKeyId = "bootstrap-sites-control-plane-v1";
  const sitesKeySha256 =
    sitesControlPlaneKeyFingerprint(input.sitesKeys.publicKey);
  const sitesControlPlaneAttestation = createStrictSignedEnvelope({
    envelopeSchemaVersion:
      "genio-signed-sites-control-plane-attestation/v1",
    payload: {
      schemaVersion: "genio-sites-control-plane-attestation/v1",
      generatedAt: observedAt,
      expiresAt: new Date(
        Date.parse(observedAt) + 60 * 60_000,
      ).toISOString(),
      issuer: "openai-sites-control-plane",
      operation: "production_deployment_ready",
      receiptHash: sitesControlPlane.evidenceHash,
    },
    signingKey: input.sitesKeys.privateKey,
    keyId: sitesKeyId,
  });
  const sitesTrustUnsigned = {
    schemaVersion: "genio-sites-control-plane-trust-verification/v1",
    receiptHash: sitesControlPlane.evidenceHash,
    attestationPayloadHash: sitesControlPlaneAttestation.payloadHash,
    trustedKeyId: sitesKeyId,
    verificationKeyFingerprint: sitesKeySha256,
    verifiedAt: observedAt,
  };
  const rolloutEvidenceHash = releaseFixtureSha256({
    kind: "bootstrap-public-rollout",
  });
  const browserUnsigned = {
    schemaVersion: "genio-final-custom-domain-browser/v2",
    origin: "https://9enio.com",
    candidateRevision: input.candidate.sourceRevision,
    observedAt,
    tlsValid: true,
    releaseIdentityVisible: true,
    anonymousPlaylistDirectory: true,
    publicPlaylistContentsVisible: true,
    privacyProjectionPassed: true,
    screenshotHashes: [
      releaseFixtureSha256("bootstrap-final-browser-screenshot"),
    ],
    publicAssignmentProbes:
      LEGACY_FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1.map((fixture) => ({
        fixtureId: fixture.fixtureId,
        intentGroup: fixture.intentGroup,
        targetTrackCount: fixture.targetTrackCount,
        rolloutEvidenceHash,
        rolloutStage: "exhaustive:50->100",
        assignmentHash: releaseFixtureSha256({
          fixtureId: fixture.fixtureId,
          kind: "bootstrap-public-assignment",
        }),
        contractVersion: 3,
        cleanupStatus: 204,
      })),
  };
  return {
    browser: {
      ...browserUnsigned,
      evidenceHash: releaseFixtureSha256(browserUnsigned),
    },
    sitesControlPlane,
    sitesControlPlaneAttestation,
    sitesControlPlaneTrust: {
      ...sitesTrustUnsigned,
      evidenceHash: releaseFixtureSha256(sitesTrustUnsigned),
    },
    sitesControlPlaneVerificationKey:
      sitesControlPlaneVerificationKeyV1(input.sitesKeys.publicKey),
    sitesControlPlaneTrustPolicy: sitesControlPlaneTrustPolicyV1({
      approvedKeyId: sitesKeyId,
      approvedKeySha256: sitesKeySha256,
    }),
  };
}

export function createStableBootstrapIndependentEvidenceFixture(input: {
  candidate: ReleaseGateCandidateBindingV1;
  completedAt: string;
}) {
  const producerKeys = generateKeyPairSync("ed25519");
  const sitesKeys = generateKeyPairSync("ed25519");
  const producerKeyId = "bootstrap-gate-producer-v1";
  const producerKeySha256 =
    releaseGateProducerKeyFingerprint(producerKeys.publicKey);
  const gateNames = [
    "staging_fixed_three_track",
    "staging_affected_regression",
    "staging_guided_constraint",
  ] as const;
  const sources: Array<{
    gate: ReleaseGateName;
    artifact: ReleaseGateArtifactV1;
    attestation: ReleaseGateProducerAttestationV1;
  }> = gateNames.map((gate) => {
    const publication = publicationSources({
      gate,
      candidate: input.candidate,
      completedAt: input.completedAt,
      verifierCredentialVersionHash: releaseFixtureSha256({
        gate,
        kind: "verifier-credential-version",
      }),
    });
    const artifact = createReleaseGateArtifactFromSources({
      gate,
      completedAt: input.completedAt,
      candidate: input.candidate,
      configurationHash: releaseFixtureSha256({
        gate,
        kind: "configuration",
      }),
      runtimeHash: releaseFixtureSha256({
        gate,
        kind: "runtime",
      }),
      fixtures: publication.fixtures,
      sources: publication.sources,
    });
    return {
      gate,
      artifact,
      attestation: attestReleaseGateArtifact(
        artifact,
        producerKeys.privateKey,
        producerKeyId,
      ),
    };
  });
  const finalArtifact = createReleaseGateArtifactFromSources({
    gate: "final_custom_domain_browser",
    completedAt: input.completedAt,
    candidate: input.candidate,
    configurationHash: releaseFixtureSha256({
      gate: "final_custom_domain_browser",
      kind: "configuration",
    }),
    runtimeHash: releaseFixtureSha256({
      gate: "final_custom_domain_browser",
      kind: "runtime",
    }),
    fixtures: [],
    sources: finalBrowserSources({
      candidate: input.candidate,
      completedAt: input.completedAt,
      sitesKeys,
    }),
  });
  sources.push({
    gate: "final_custom_domain_browser",
    artifact: finalArtifact,
    attestation: attestReleaseGateArtifact(
      finalArtifact,
      producerKeys.privateKey,
      producerKeyId,
    ),
  });
  return {
    bundle: {
      schemaVersion:
        STABLE_PREDECESSOR_BOOTSTRAP_INDEPENDENT_EVIDENCE_SCHEMA_V1,
      producerVerificationKey: {
        schemaVersion:
          "genio-stable-predecessor-bootstrap-producer-verification-key/v1",
        algorithm: "Ed25519",
        keyId: producerKeyId,
        publicKeyPem: producerKeys.publicKey.export({
          format: "pem",
          type: "spki",
        }).toString(),
        publicKeySha256: producerKeySha256,
      },
      producerTrustPolicy: releaseGateProducerTrustPolicyV1({
        approvedKeyId: producerKeyId,
        approvedKeySha256: producerKeySha256,
      }),
      sources,
    },
    producerKeys,
    producerKeyId,
    producerKeySha256,
    sitesKeys,
    sitesKeySha256:
      sitesControlPlaneKeyFingerprint(sitesKeys.publicKey),
  };
}
