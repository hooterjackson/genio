# Release artifact authoring

Release authoring commands only create local artifacts. They never dispatch a
workflow, publish a Release, move a tag, or overwrite an existing file.
Outputs use sorted canonical JSON, a trailing newline, mode `0600`, and
create-only (`O_EXCL`) semantics.

Private Ed25519 keys must be singly linked regular files with mode `0600`.
Commands that sign accept either the documented `--*-signing-key-file` option
or its fixed protected-environment file-path variable. When both are present
they must resolve to the same file. Raw private-key material is not accepted in
an environment variable and is never included in success or error output.
Keep each release authority in separate custody; separate files on one
operator workstation do not establish independence.

## One-time v2.3.4 predecessor bootstrap

The bootstrap author never creates an “original Railway provenance”
attestation. Railway supplied authenticated deployment/build-log observations
but no recoverable registry reference, manifest, config, or supply-chain
attestation. Every V2 artifact therefore binds the observation and a separately
reconstructed GHCR wrapper while explicitly recording
`historicalArtifactEquivalence: "not_claimed"` and
`historicalArtifactIdentity: null`.

The authoring environment must pin four distinct authorities:

- `RELEASE_VERIFICATION_KEY_ID` and
  `RELEASE_VERIFICATION_KEY_SHA256`;
- `RELEASE_STABLE_AUTHORIZER_KEY_ID` and
  `RELEASE_STABLE_AUTHORIZER_KEY_SHA256`;
- `RELEASE_GATE_PRODUCER_KEY_ID` and
  `RELEASE_GATE_PRODUCER_KEY_SHA256`;
- `RELEASE_SITES_CONTROL_PLANE_KEY_ID` and
  `RELEASE_SITES_CONTROL_PLANE_KEY_SHA256`.

After the digest-only wrapper workflow succeeds and its exact GitHub
attestation verification JSON is downloaded, create the reduced-claim wrapper
attestation:

```sh
pnpm release:bootstrap:author -- image-attestation \
  --repository hooterjackson/genio \
  --default-branch main \
  --controller-source-revision "$BOOTSTRAP_CONTROLLER_SHA" \
  --image-reference "ghcr.io/hooterjackson/genio@$BOOTSTRAP_IMAGE_DIGEST" \
  --recovered-railway-observation recovered-railway-observation.json \
  --github-attestation-verification wrapper-attestation-verification.json \
  --output bootstrap-image-attestation.json
```

Materialize the controller workflow, historical tag object, commit, and tree
object as exact byte files. With the independently signed four-gate evidence
bundle, create the bootstrap release evidence:

```sh
pnpm release:bootstrap:author -- bootstrap-evidence \
  --repository hooterjackson/genio \
  --default-branch main \
  --controller-source-revision "$BOOTSTRAP_CONTROLLER_SHA" \
  --image-reference "ghcr.io/hooterjackson/genio@$BOOTSTRAP_IMAGE_DIGEST" \
  --image-attestation bootstrap-image-attestation.json \
  --recovered-railway-observation recovered-railway-observation.json \
  --independent-evidence bootstrap-independent-evidence.json \
  --controller-workflow-bytes bootstrap-controller-workflow.bytes \
  --tag-object-bytes v2.3.4-tag-object.bytes \
  --source-commit-bytes v2.3.4-commit-object.bytes \
  --source-tree-object-bytes v2.3.4-tree-object.bytes \
  --release-signing-key-file /secure/path/release-signing-key.pem \
  --output bootstrap-evidence.signed.json
```

The signing-key option may be omitted when `RELEASE_SIGNING_KEY_FILE` contains
the protected `0600` file path. The command re-verifies its own Ed25519
signature, key ID/fingerprint, validity window, fixed historical identity,
controller, and wrapper identity before creating the output.

Derive the bootstrap-scoped protected baseline:

```sh
pnpm release:bootstrap:author -- protected-baseline \
  --repository hooterjackson/genio \
  --default-branch main \
  --bootstrap-evidence bootstrap-evidence.signed.json \
  --release-verification-key release-verification-public-key.pem \
  --output bootstrap-protected-semantic-baseline.json
```

In the separately protected stable-authorizer environment, create and
self-verify the authorization:

```sh
pnpm release:bootstrap:author -- bootstrap-authorization \
  --repository hooterjackson/genio \
  --default-branch main \
  --bootstrap-evidence bootstrap-evidence.signed.json \
  --protected-baseline-metadata bootstrap-protected-semantic-baseline.json \
  --image-attestation bootstrap-image-attestation.json \
  --release-verification-key release-verification-public-key.pem \
  --sites-control-plane-verification-key sites-control-plane-key.json \
  --controller-workflow-bytes bootstrap-controller-workflow.bytes \
  --tag-object-bytes v2.3.4-tag-object.bytes \
  --source-commit-bytes v2.3.4-commit-object.bytes \
  --source-tree-object-bytes v2.3.4-tree-object.bytes \
  --authorizer-signing-key-file /secure/path/stable-authorizer-key.pem \
  --output bootstrap-authorization.signed.json
```

Finally, prepare—but do not send—the exact five-key repository dispatch:

```sh
pnpm release:bootstrap:author -- dispatch \
  --repository hooterjackson/genio \
  --default-branch main \
  --image-digest "$BOOTSTRAP_IMAGE_DIGEST" \
  --bootstrap-evidence bootstrap-evidence.signed.json \
  --protected-baseline-metadata bootstrap-protected-semantic-baseline.json \
  --recovered-railway-observation recovered-railway-observation.json \
  --stable-authorization bootstrap-authorization.signed.json \
  --release-verification-key release-verification-public-key.pem \
  --stable-authorization-verification-key stable-authorizer-public-key.pem \
  --output bootstrap-dispatch.json

gh api repos/hooterjackson/genio/dispatches \
  --method POST \
  --input bootstrap-dispatch.json
```

Preparation checks exact cross-artifact hashes, reduced-provenance claims,
canonical base64url round trips, the per-artifact 18,000-byte limit, GitHub’s
64 KiB payload limit, and exact payload-key inventory.

## Ordinary stable-release artifacts

After the full post-Sites finalization envelope exists, derive the next
protected semantic baseline from that signed envelope:

```sh
pnpm release:artifact:author -- protected-baseline \
  --finalization-evidence finalization-evidence.signed.json \
  --release-verification-key release-verification-public-key.pem \
  --expected-rc-tag "$RELEASE_RC_TAG" \
  --expected-version "$RELEASE_VERSION" \
  --expected-revision "$RELEASE_SHA" \
  --expected-image-digest "$RELEASE_IMAGE_DIGEST" \
  --output protected-semantic-baseline.json
```

The command requires `RELEASE_VERIFICATION_KEY_ID` and
`RELEASE_VERIFICATION_KEY_SHA256`. It verifies the finalization signature and
expiry, exact candidate identity, full final-browser gate, image reference,
and independently reviewed candidate fixture identities before creating the
metadata.

Stable authorization also consumes the exact, independently verifiable
sources behind finalization. Create an authoring manifest with this exact
schema; every file path is resolved relative to the manifest:

```json
{
  "schemaVersion": "genio-stable-release-finalization-source-authoring-manifest/v1",
  "promotionEvidenceFile": "promotion-evidence.signed.json",
  "publicRolloutEvidenceFile": "public-rollout-evidence.signed.json",
  "stagingControlPlaneEvidenceFile": "staging-control-plane-evidence.signed.json",
  "stagingControlPlaneVerificationKeyFile": "staging-control-plane-key.json",
  "stagingControlPlaneTrustPolicyFile": "staging-control-plane-policy.json",
  "controlPlaneReceiptFiles": {
    "apple": "apple-receipt.signed.json",
    "provider": "provider-receipt.signed.json",
    "qaBudget": "qa-budget-receipt.signed.json"
  },
  "controlPlaneReceiptVerificationKeyFiles": {
    "apple": "apple-receipt-key.json",
    "provider": "provider-receipt-key.json",
    "qaBudget": "qa-budget-receipt-key.json"
  },
  "controlPlaneReceiptTrustPolicyFiles": {
    "apple": "apple-receipt-policy.json",
    "provider": "provider-receipt-policy.json",
    "qaBudget": "qa-budget-receipt-policy.json"
  },
  "gateArtifactFiles": {
    "production_fixed_three_track": "gate-production_fixed_three_track.json",
    "production_affected_regression": "gate-production_affected_regression.json",
    "backend_release_convergence": "gate-backend_release_convergence.json",
    "release_convergence": "gate-release_convergence.json",
    "final_custom_domain_browser": "gate-final_custom_domain_browser.json"
  },
  "gateProducerAttestationFiles": {
    "production_fixed_three_track": "gate-production_fixed_three_track.attestation.json",
    "production_affected_regression": "gate-production_affected_regression.attestation.json",
    "backend_release_convergence": "gate-backend_release_convergence.attestation.json",
    "release_convergence": "gate-release_convergence.attestation.json",
    "final_custom_domain_browser": "gate-final_custom_domain_browser.attestation.json"
  }
}
```

Then create and self-verify the source bundle:

```sh
pnpm release:artifact:author -- finalization-source \
  --manifest finalization-source-authoring-manifest.json \
  --finalization-evidence finalization-evidence.signed.json \
  --release-verification-key release-verification-public-key.pem \
  --release-gate-producer-verification-key release-gate-producer-public-key.pem \
  --expected-rc-tag "$RELEASE_RC_TAG" \
  --expected-revision "$RELEASE_SHA" \
  --expected-image-digest "$RELEASE_IMAGE_DIGEST" \
  --output finalization-source-evidence.json
```

The verification uses the protected release, gate-producer, semantic-review,
Sites, staging-control-plane, Apple, provider, and QA-budget pins documented in
`deployment.md`. It replays the promotion/rollout lineage, all five source gate
validators and detached producer signatures, and every control-plane receipt.
The command does not create a summary-only substitute when any source is
missing.

Only after both artifacts exist should the isolated stable authorizer run
`release:stable:authorize`, followed by
`release:stable:dispatch:prepare`. Dispatch remains a separate explicit
operator action.
