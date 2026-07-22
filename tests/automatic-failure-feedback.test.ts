import { expect, test, vi } from "vitest";
import { parseFeedbackSubmission } from "../server/feedback.ts";
import { Repository } from "../server/repository.ts";

interface QueryCall {
  text: string;
  values: unknown[];
}

function automaticFailureHarness() {
  const calls: QueryCall[] = [];
  const settings = new Map<string, string>([["schema_version", "15"]]);
  const primaryAccessId = "55555555-5555-4555-8555-555555555555";
  const secondaryAccessId = "77777777-7777-4777-8777-777777777777";
  const activeAccesses = new Map<string, string>([
    [primaryAccessId, "50 Brazilian disco songs"],
  ]);
  const auditEvents: Array<{
    runId: string | null;
    action: string;
    detail: Record<string, unknown>;
  }> = [];
  const run = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "queued",
    phase: "queued",
    error: null as string | null,
    brief_json: { title: "Brazilian Disco", targetSize: { min: 50, max: 50 } },
    selection_plan_json: { targetSize: { min: 50, max: 50 } },
    pipeline_version: "pipeline_v3",
    policy_version: "pipeline_v3",
    pipeline_policy_snapshot_json: { pipelineVersion: "pipeline_v3" },
    pipeline_outcome_json: { rootCause: "provider_contract_failed" },
    estimated_cost_usd: "0.25",
    actual_cost_usd: "0.11",
    approved_budget_usd: "0.75",
    created_at: "2026-07-22T12:00:00.000Z",
    updated_at: "2026-07-22T12:01:00.000Z",
    completed_at: "2026-07-22T12:01:00.000Z",
    raw_prompt: "50 Brazilian disco songs",
    requested_track_count: 50,
    storefront: "us",
    spec_hash: "spec-hash",
    guidance_answers_json: [],
    access_prompt: "50 Brazilian disco songs",
    brief_model: "test-model-snapshot",
    selection_plan_id: "22222222-2222-4222-8222-222222222222",
    selection_plan_revision: 1,
    selection_plan_hash: "selection-hash",
    query_plan_id: "33333333-3333-4333-8333-333333333333",
    query_plan_revision: 1,
    query_plan_hash: "query-hash",
    query_plan_json: { schemaVersion: 2 },
    access_id: primaryAccessId,
  };
  const accessId = primaryAccessId;
  const job = {
    id: "66666666-6666-4666-8666-666666666666",
    attempts: 1,
    max_attempts: 3,
    run_id: run.id,
    brief_request_id: null,
    kind: "research",
    payload_json: {},
  };
  let exhaustedJobs: Array<typeof job> = [];
  let reconciliationEnabled = false;
  let reconcilePromptlessBriefTombstones = false;
  let runSourceRetained = true;
  let briefSourceRetained = true;
  let runRetentionDue = false;
  let injectRunReportOnDelete = false;
  let feedbackPaused = false;
  let checkpointRootCause = "provider_contract_failed";
  let brief: Record<string, unknown> | null = {
    id: "44444444-4444-4444-8444-444444444444",
    prompt: "Influential Berlin techno",
    requested_track_count: 25,
    model: "test-model-snapshot",
    status: "failed",
    error: "Provider response did not satisfy the brief schema",
    brief_json: null,
    questions_json: [],
    answers_json: [],
    guidance_source_hints_json: [],
    guidance_telemetry_json: null,
    guidance_preferences_json: [],
    pipeline_version: "pipeline_v3",
    policy_version: "pipeline_v3",
    selection_plan_json: null,
    estimate_usd: "0.03",
    created_at: "2026-07-22T12:00:00.000Z",
    updated_at: "2026-07-22T12:01:00.000Z",
  };

  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    const normalized = text.replace(/\s+/gu, " ").trim();

    if (normalized === "SELECT value FROM settings WHERE key = 'schema_version'") {
      return { rows: [{ value: settings.get("schema_version") }], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE research_runs SET status='failed'")) {
      run.status = "failed";
      run.phase = String(values[1]);
      run.error = values[2] == null ? null : String(values[2]);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE research_runs SET")) {
      if (values[1] != null) run.status = String(values[1]);
      if (values[2] != null) run.phase = String(values[2]);
      if (values[6] === true) run.error = values[7] == null ? null : String(values[7]);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT r.id,r.status,r.phase,r.error")) {
      return { rows: [{ ...run }], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT 1 FROM research_runs r JOIN run_accesses a")) {
      const requestedAccessId = typeof values[1] === "string" ? values[1] : null;
      const retained = runSourceRetained
        && (requestedAccessId ? activeAccesses.has(requestedAccessId) : activeAccesses.size > 0);
      return retained
        ? { rows: [{ exists: 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized.includes("FROM track_candidates WHERE run_id=$1") && normalized.includes("discovered")) {
      return {
        rows: [{ discovered: 37, sources: 8, evidence: 23, apple_lookups: 12, accepted: 9, manifested: 0, published: 0 }],
        rowCount: 1,
      };
    }
    if (normalized.startsWith("SELECT phase,state_json FROM research_checkpoints")) {
      return { rows: [{ phase: "semantic_outcome", state_json: { rootCause: checkpointRootCause } }], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT id,prompt,requested_track_count,model,status,error")) {
      const matches = brief && String(values[0]) === String(brief.id);
      return { rows: matches ? [{ ...brief }] : [], rowCount: matches ? 1 : 0 };
    }
    if (normalized.startsWith("SELECT 1 FROM brief_requests WHERE id=$1 AND prompt<>''")) {
      return brief && briefSourceRetained
        ? { rows: [{ exists: 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("SELECT attempts,max_attempts,run_id,brief_request_id,kind,payload_json FROM job_queue")) {
      return { rows: [{ ...job }], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE job_queue SET status=$3::varchar")) {
      return { rows: [], rowCount: 1 };
    }
    if (normalized.includes("UPDATE job_queue SET status='failed',completed_at=now()")) {
      const rows = exhaustedJobs.map((item) => ({ ...item }));
      exhaustedJobs = [];
      return { rows, rowCount: rows.length };
    }
    if (normalized.startsWith("SELECT count(*)::int count FROM job_queue") && normalized.includes("status='leased'")) {
      return { rows: [{ count: 0 }], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT candidate.*")) return { rows: [], rowCount: 0 };
    if (normalized === "SELECT run_id,brief_request_id FROM run_accesses WHERE id=$1 AND deleted_at IS NULL FOR UPDATE") {
      return activeAccesses.has(String(values[0]))
        ? { rows: [{ run_id: run.id, brief_request_id: null }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("UPDATE run_accesses SET prompt=NULL,deleted_at=now()")) {
      const deleted = activeAccesses.delete(String(values[0]));
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }
    if (normalized === "DELETE FROM capability_session_accesses WHERE access_id=$1 RETURNING session_id") {
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "SELECT count(*)::int count FROM run_accesses WHERE run_id=$1 AND deleted_at IS NULL") {
      return { rows: [{ count: activeAccesses.size }], rowCount: 1 };
    }
    if (normalized === "SELECT status,actual_cost_usd FROM research_runs WHERE id=$1 FOR UPDATE") {
      return { rows: [{ status: run.status, actual_cost_usd: run.actual_cost_usd }], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT id,content_hash,name FROM manifests WHERE run_id=$1")) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "SELECT outcome,count(*)::int count FROM track_candidates WHERE run_id=$1 GROUP BY outcome") {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("SELECT id FROM notification_outbox")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (normalized.startsWith("SELECT pg_try_advisory_xact_lock")) {
      return { rows: [{ acquired: reconciliationEnabled }], rowCount: 1 };
    }
    if (normalized.includes("feedback_paused")) {
      return { rows: [{ paused: feedbackPaused }], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT r.id FROM research_runs r")
      && normalized.includes("LEFT JOIN settings touch")) {
      return reconciliationEnabled
        && ["failed", "failed_system", "failed_integrity"].includes(run.status)
        ? { rows: [{ id: run.id }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("SELECT brief.id FROM brief_requests brief")) {
      if (reconciliationEnabled && reconcilePromptlessBriefTombstones) {
        if (normalized.includes("brief.prompt<>''")) {
          return brief ? { rows: [{ id: String(brief.id) }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        const rows = Array.from({ length: 20 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("INSERT INTO worker_heartbeats")) return { rows: [], rowCount: 1 };
    if (normalized === "SELECT value FROM settings WHERE key=$1 FOR UPDATE") {
      const value = settings.get(String(values[0]));
      return { rows: value === undefined ? [] : [{ value }], rowCount: value === undefined ? 0 : 1 };
    }
    if (normalized === "SELECT value FROM settings WHERE key=$1") {
      const value = settings.get(String(values[0]));
      return { rows: value === undefined ? [] : [{ value }], rowCount: value === undefined ? 0 : 1 };
    }
    if (normalized.startsWith("INSERT INTO settings(key,value) VALUES($1,$2)")) {
      settings.set(String(values[0]), String(values[1]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE settings SET value=$2")) {
      settings.set(String(values[0]), String(values[1]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO audit_events")) {
      const explicitAction = normalized.match(/'((?:feedback\.)[^']+)'/u)?.[1];
      const action = explicitAction ?? String(values[2] ?? "");
      const rawDetail = explicitAction ? values[1] : values[3];
      let detail: Record<string, unknown> = {};
      try {
        detail = typeof rawDetail === "string" ? JSON.parse(rawDetail) as Record<string, unknown> : {};
      } catch {
        detail = {};
      }
      auditEvents.push({
        runId: values[0] == null ? null : String(values[0]),
        action,
        detail,
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized === "SELECT 1 FROM brief_requests WHERE id=$1 FOR UPDATE") {
      return { rows: brief ? [{ exists: 1 }] : [], rowCount: brief ? 1 : 0 };
    }
    if (normalized.includes("FROM cost_reservations") && normalized.includes("brief_request_id=$1")) {
      return { rows: [{ count: 0 }], rowCount: 1 };
    }
    if (normalized.startsWith("DELETE FROM brief_requests WHERE id=$1")) {
      brief = null;
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT id FROM research_runs WHERE retention_expires_at<=now()")) {
      return runRetentionDue && runSourceRetained
        ? { rows: [{ id: run.id }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized === "SELECT actual_cost_usd FROM research_runs WHERE id=$1 FOR UPDATE") {
      return runSourceRetained
        ? { rows: [{ actual_cost_usd: run.actual_cost_usd }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized === "DELETE FROM research_runs WHERE id=$1") {
      runSourceRetained = false;
      if (injectRunReportOnDelete) {
        const id = "late-retention-report";
        settings.set(`feedback-submission:${id}`, JSON.stringify({
          id,
          origin: "automatic_failure",
          automaticFailure: { runId: run.id, briefRequestId: null },
        }));
        settings.set("feedback-automatic-event:late-retention-event", JSON.stringify({
          id,
          eventFingerprint: "late-retention-event",
          runId: run.id,
          briefRequestId: null,
          suppressed: false,
        }));
      }
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("DELETE FROM settings report")
      && normalized.includes("FROM research_runs run")) {
      let deleted = 0;
      for (const [key, value] of [...settings]) {
        if (!key.startsWith("feedback-submission:")) continue;
        const record = JSON.parse(value) as { automaticFailure?: { runId?: string | null } };
        if (record.automaticFailure?.runId && !runSourceRetained) {
          settings.delete(key);
          deleted += 1;
        }
      }
      return { rows: [], rowCount: deleted };
    }
    if (normalized.startsWith("DELETE FROM settings mapping")) {
      let deleted = 0;
      for (const [key, value] of [...settings]) {
        if (!key.startsWith("feedback-idempotency:") && !key.startsWith("feedback-automatic-event:")) continue;
        const mapping = JSON.parse(value) as {
          id?: string;
          suppressed?: boolean;
          runId?: string | null;
          briefRequestId?: string | null;
        };
        if (mapping.id && settings.has(`feedback-submission:${mapping.id}`)) continue;
        const retainedSource = (mapping.runId === run.id && runSourceRetained)
          || (brief && mapping.briefRequestId === brief.id && briefSourceRetained);
        if (key.startsWith("feedback-automatic-event:") && mapping.suppressed === true && retainedSource) continue;
        settings.delete(key);
        deleted += 1;
      }
      return { rows: [], rowCount: deleted };
    }
    if (normalized.startsWith("DELETE FROM settings") && normalized.includes("automaticFailure")) {
      const deletedRows: Array<{ value: string }> = [];
      const sourceIds = new Set(values.filter((value): value is string => typeof value === "string"));
      for (const [key, value] of settings) {
        if (!key.startsWith("feedback-submission:")) continue;
        const record = JSON.parse(value) as {
          automaticFailure?: { runId?: string | null; runAccessId?: string | null; briefRequestId?: string | null };
        };
        const deletesByAccess = sourceIds.has(String(record.automaticFailure?.runAccessId ?? ""));
        const deletesByRun = sourceIds.has(String(record.automaticFailure?.runId ?? ""))
          && !sourceIds.has(primaryAccessId)
          && !sourceIds.has(secondaryAccessId);
        if (
          deletesByAccess
          || deletesByRun
          || (record.automaticFailure?.briefRequestId && sourceIds.has(record.automaticFailure.briefRequestId))
        ) {
          deletedRows.push({ value });
          settings.delete(key);
        }
      }
      return { rows: deletedRows, rowCount: deletedRows.length };
    }
    if (normalized.startsWith("DELETE FROM settings") && normalized.includes("feedback-automatic-event")) {
      const sourceIds = new Set(values.filter((value): value is string => typeof value === "string"));
      for (const [key, value] of [...settings.entries()]) {
        if (!key.startsWith("feedback-automatic-event:")) continue;
        let mapping: { runId?: string | null; runAccessId?: string | null; briefRequestId?: string | null } = {};
        try {
          mapping = JSON.parse(value) as typeof mapping;
        } catch {
          settings.delete(key);
          continue;
        }
        const deletesByAccess = sourceIds.has(String(mapping.runAccessId ?? ""));
        const deletesByRun = sourceIds.has(String(mapping.runId ?? ""))
          && !sourceIds.has(primaryAccessId)
          && !sourceIds.has(secondaryAccessId);
        if (deletesByAccess || deletesByRun || sourceIds.has(String(mapping.briefRequestId ?? ""))) {
          settings.delete(key);
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (normalized === "DELETE FROM settings WHERE key=$1") {
      const deleted = settings.delete(String(values[0]));
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client), end: vi.fn() };
  const repository = new Repository({ pool, db: {} } as never);
  const reports = () => [...settings.entries()]
    .filter(([key]) => key.startsWith("feedback-submission:"))
    .map(([, value]) => JSON.parse(value) as Record<string, any>);

  return {
    repository,
    calls,
    settings,
    reports,
    run,
    job,
    accessId,
    secondaryAccessId,
    auditEvents,
    exhaustJob: () => { exhaustedJobs = [{ ...job, attempts: job.max_attempts }]; },
    enableReconciliation: () => { reconciliationEnabled = true; },
    enablePromptlessBriefReconciliation: () => {
      reconciliationEnabled = true;
      reconcilePromptlessBriefTombstones = true;
    },
    expireRunForRetention: () => { runRetentionDue = true; },
    injectRunReportAtRetentionDelete: () => { injectRunReportOnDelete = true; },
    deleteRunSourceBeforePersist: () => { runSourceRetained = false; },
    deleteBriefSourceBeforePersist: () => { briefSourceRetained = false; },
    pauseFeedback: () => { feedbackPaused = true; },
    resumeFeedback: () => { feedbackPaused = false; },
    addSecondaryAccess: (prompt = "A reused equivalent Brazilian disco request") => {
      activeAccesses.set(secondaryAccessId, prompt);
    },
    selectAccessForCapture: (selectedAccessId: string) => {
      run.access_id = selectedAccessId;
      run.access_prompt = activeAccesses.get(selectedAccessId) ?? "";
    },
    setActivePlanRevision: (revision: number) => {
      run.query_plan_revision = revision;
      run.query_plan_hash = `query-hash-${revision}`;
    },
    setRootCause: (rootCause: string) => {
      checkpointRootCause = rootCause;
      run.pipeline_outcome_json = { rootCause };
    },
    advanceBriefFailureGeneration: (updatedAt: string) => {
      if (brief) brief.updated_at = updatedAt;
    },
    seedAutomaticRunReport: (input: {
      id: string;
      runAccessId: string;
      prompt: string;
      eventFingerprint: string;
    }) => {
      settings.set(`feedback-submission:${input.id}`, JSON.stringify({
        id: input.id,
        origin: "automatic_failure",
        kind: "bug",
        status: "new",
        message: `Automatic report. Request: ${input.prompt}`,
        automaticFailure: {
          runId: run.id,
          runAccessId: input.runAccessId,
          briefRequestId: null,
          prompt: input.prompt,
          eventFingerprint: input.eventFingerprint,
        },
        qaScenario: { request: { prompt: input.prompt } },
      }));
      settings.set(`feedback-automatic-event:${input.eventFingerprint}`, JSON.stringify({
        id: input.id,
        eventFingerprint: input.eventFingerprint,
        runId: run.id,
        runAccessId: input.runAccessId,
        briefRequestId: null,
        suppressed: false,
      }));
    },
    getBrief: () => brief,
  };
}

test("one terminal search failure creates one private deduplicated report and quarantined QA scenario", async () => {
  const harness = automaticFailureHarness();

  await harness.repository.updateRun(harness.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: "OpenAI request failed after the final retry",
  });
  await harness.repository.updateRun(harness.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: "Retry wrapper reworded the same terminal error",
  });

  expect(harness.reports()).toHaveLength(1);
  expect(harness.reports()[0]).toMatchObject({
    origin: "automatic_failure",
    kind: "bug",
    status: "new",
    qaStatus: "quarantined",
    automaticFailure: {
      failureClass: "system_failure",
      runId: harness.run.id,
      prompt: "50 Brazilian disco songs",
      requestedTrackCount: 50,
      storefront: "us",
      counters: { discovered: 37, apple_lookups: 12, accepted: 9 },
    },
    qaScenario: {
      source: "automatic_failure",
      status: "quarantined",
      request: { prompt: "50 Brazilian disco songs", requestedTrackCount: 50, storefront: "us" },
      expected: { noTerminalFailure: true, requestedTrackCount: 50 },
    },
  });
  expect([...harness.settings.keys()].filter((key) => key.startsWith("feedback-automatic-event:"))).toHaveLength(1);
  expect(harness.reports()[0]?.occurrenceCount).toBe(1);
  expect(harness.calls.some(({ text }) => text.includes("feedback_paused"))).toBe(true);
  expect(harness.calls.some(({ text }) => text.includes("INSERT INTO rate_limit_events"))).toBe(false);
});

test("exact duplicate delivery is idempotent while a genuinely different terminal cause creates a distinct report", async () => {
  const harness = automaticFailureHarness();
  harness.setRootCause("provider_timeout");

  await harness.repository.updateRun(harness.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: "Provider timed out after the final attempt",
  });
  await expect(harness.repository.captureAutomaticRunFailure(harness.run.id)).resolves.toMatchObject({
    created: false,
  });

  expect(harness.reports()).toHaveLength(1);
  expect(harness.reports()[0]?.occurrenceCount).toBe(1);

  harness.setRootCause("provider_contract_failed");
  await expect(harness.repository.captureAutomaticRunFailure(harness.run.id)).resolves.toMatchObject({
    created: true,
  });

  expect(harness.reports()).toHaveLength(2);
  expect(new Set(harness.reports().map((report) => report.automaticFailure?.eventFingerprint)).size).toBe(2);
  expect(new Set(harness.reports().map((report) => report.automaticFailure?.errorCode))).toEqual(new Set([
    "provider_timeout",
    "provider_contract_failed",
  ]));
});

test("a failed brief retry creates a distinct report for a new terminal generation", async () => {
  const harness = automaticFailureHarness();
  const briefId = String(harness.getBrief()?.id);

  await expect(harness.repository.captureAutomaticBriefFailure(briefId)).resolves.toMatchObject({ created: true });
  await expect(harness.repository.captureAutomaticBriefFailure(briefId)).resolves.toMatchObject({ created: false });

  harness.advanceBriefFailureGeneration("2026-07-22T12:02:00.000Z");
  await expect(harness.repository.captureAutomaticBriefFailure(briefId)).resolves.toMatchObject({ created: true });

  expect(harness.reports()).toHaveLength(2);
  expect(new Set(harness.reports().map((report) => report.automaticFailure?.terminalGeneration))).toEqual(new Set([
    String(new Date("2026-07-22T12:01:00.000Z").getTime()),
    String(new Date("2026-07-22T12:02:00.000Z").getTime()),
  ]));
});

test("owner deletion suppresses the same automatic event until its source is removed", async () => {
  const harness = automaticFailureHarness();
  await harness.repository.updateRun(harness.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: "Provider failed after the final attempt",
  });
  const report = harness.reports()[0];
  expect(report?.id).toEqual(expect.any(String));

  await expect(harness.repository.deleteFeedbackSubmission(String(report.id), "owner@example.com"))
    .resolves.toBe(true);
  expect(harness.reports()).toEqual([]);
  const mapping = [...harness.settings.entries()].find(([key]) => key.startsWith("feedback-automatic-event:"));
  expect(mapping).toBeDefined();
  expect(JSON.parse(String(mapping?.[1]))).toMatchObject({
    id: report.id,
    runId: harness.run.id,
    runAccessId: harness.accessId,
    terminalGeneration: String(new Date(harness.run.completed_at).getTime()),
    suppressed: true,
  });

  await expect(harness.repository.captureAutomaticRunFailure(harness.run.id)).resolves.toBeNull();
  expect(harness.reports()).toEqual([]);
  expect(JSON.parse(String(mapping?.[1]))).toMatchObject({ suppressed: true });
});

test("retryable and expected non-error outcomes do not create automatic reports", async () => {
  const harness = automaticFailureHarness();

  await harness.repository.updateRun(harness.run.id, { status: "researching", phase: "source_discovery" });
  await harness.repository.updateRun(harness.run.id, { status: "queued", phase: "provider_retry" });
  await harness.repository.updateRun(harness.run.id, { status: "no_compatible_tracks", phase: "frontier_exhausted" });
  await harness.repository.updateRun(harness.run.id, { status: "failed", phase: "owner_cancelled" });

  expect(harness.reports()).toEqual([]);
  expect([...harness.settings.keys()].some((key) => key.startsWith("feedback-automatic-event:"))).toBe(false);
});

test("the owner emergency pause suppresses automatic prompt capture durably", async () => {
  const harness = automaticFailureHarness();
  harness.pauseFeedback();
  await harness.repository.updateRun(harness.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: "Provider failed after the final attempt",
  });

  expect(harness.reports()).toEqual([]);
  const mapping = [...harness.settings.entries()].find(([key]) => key.startsWith("feedback-automatic-event:"));
  expect(mapping).toBeDefined();
  expect(JSON.parse(String(mapping?.[1]))).toMatchObject({
    runId: harness.run.id,
    suppressed: true,
    suppressionReason: "feedback_paused",
  });

  await expect(harness.repository.captureAutomaticRunFailure(harness.run.id)).resolves.toBeNull();
  expect(harness.auditEvents.filter(({ action }) => (
    action === "feedback.automatic_failure_suppressed"
  ))).toHaveLength(1);
});

test("public feedback parsing cannot inject automatic diagnostics or a promoted QA case", () => {
  expect(() => parseFeedbackSubmission({
    kind: "bug",
    message: "This looks like a manual report but contains private fields.",
    origin: "automatic_failure",
    automaticFailure: { prompt: "untrusted" },
    qaScenario: { status: "promoted" },
    qaStatus: "promoted",
  })).toThrowError(expect.objectContaining({ code: "private_feedback_fields" }));
});

test("deleting a failed brief removes its linked automatic report and dedupe mapping", async () => {
  const harness = automaticFailureHarness();
  const briefId = String(harness.getBrief()?.id);

  await harness.repository.saveBriefResult(briefId, {
    status: "failed",
    error: "Provider response did not satisfy the brief schema",
  });
  expect(harness.reports()).toHaveLength(1);
  expect([...harness.settings.keys()].filter((key) => key.startsWith("feedback-automatic-event:"))).toHaveLength(1);

  await expect(harness.repository.deleteBriefRequest(briefId)).resolves.toBe(true);
  expect(harness.reports()).toEqual([]);
  expect([...harness.settings.keys()].filter((key) => key.startsWith("feedback-automatic-event:"))).toHaveLength(0);
});

test("deleting the final access to a failed run removes its linked diagnostics and QA scenario", async () => {
  const harness = automaticFailureHarness();
  await harness.repository.updateRun(harness.run.id, {
    status: "failed_integrity",
    phase: "manifest_integrity_failed",
    error: "The locked manifest did not match the published sequence",
  });
  expect(harness.reports()).toHaveLength(1);

  await expect(harness.repository.deleteRunAccess(harness.accessId)).resolves.toBe(true);
  expect(harness.reports()).toEqual([]);
  expect([...harness.settings.keys()].filter((key) => key.startsWith("feedback-automatic-event:"))).toHaveLength(0);
});

test("deleting one access to a reused run removes only that access-bound private report", async () => {
  const harness = automaticFailureHarness();
  harness.addSecondaryAccess("Disco for a second visitor without the first visitor's context");
  harness.seedAutomaticRunReport({
    id: "primary-access-report",
    runAccessId: harness.accessId,
    prompt: "First visitor private Rio disco request",
    eventFingerprint: "a".repeat(64),
  });
  harness.seedAutomaticRunReport({
    id: "secondary-access-report",
    runAccessId: harness.secondaryAccessId,
    prompt: "Second visitor Brazilian disco request",
    eventFingerprint: "b".repeat(64),
  });

  await expect(harness.repository.deleteRunAccess(harness.accessId)).resolves.toBe(true);

  expect(harness.reports()).toHaveLength(1);
  const serialized = JSON.stringify(harness.reports()[0]);
  expect(serialized).toContain("Second visitor Brazilian disco request");
  expect(serialized).not.toContain("First visitor private Rio disco request");
  expect(harness.reports()[0]?.automaticFailure?.runAccessId).toBe(harness.secondaryAccessId);
  expect([...harness.settings.values()].some((value) => value.includes(`\"runAccessId\":\"${harness.accessId}\"`))).toBe(false);
});

test("a run deleted after diagnostic collection cannot be resurrected as private feedback", async () => {
  const harness = automaticFailureHarness();
  harness.run.status = "failed_system";
  harness.run.phase = "research_failed";
  harness.run.error = "A terminal failure collected just before visitor deletion";
  harness.deleteRunSourceBeforePersist();

  await expect(harness.repository.captureAutomaticRunFailure(harness.run.id)).resolves.toBeNull();
  expect(harness.reports()).toEqual([]);
  expect([...harness.settings.keys()].filter((key) => key.startsWith("feedback-automatic-event:"))).toHaveLength(0);
  expect(harness.calls.some(({ text }) => text.includes("FOR UPDATE OF a"))).toBe(true);
  expect(harness.calls.some(({ text }) => (
    text.includes("SELECT 1")
    && text.includes("FOR UPDATE OF a")
    && text.includes("a.expires_at>now()")
  ))).toBe(true);
});

test("a brief deleted after diagnostic collection cannot be resurrected as private feedback", async () => {
  const harness = automaticFailureHarness();
  const briefId = String(harness.getBrief()?.id);
  harness.deleteBriefSourceBeforePersist();

  await expect(harness.repository.captureAutomaticBriefFailure(briefId)).resolves.toBeNull();
  expect(harness.reports()).toEqual([]);
  expect([...harness.settings.keys()].filter((key) => key.startsWith("feedback-automatic-event:"))).toHaveLength(0);
  expect(harness.calls.some(({ text }) => text.includes("prompt<>''") && text.includes("FOR UPDATE"))).toBe(true);
  expect(harness.calls.some(({ text }) => text.includes("prompt<>''") && text.includes("expires_at"))).toBe(false);
});

test("run retention serializes capture and removes a report arriving at the delete boundary", async () => {
  const harness = automaticFailureHarness();
  await harness.repository.updateRun(harness.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: "A terminal failure awaiting retention",
  });
  harness.expireRunForRetention();
  harness.injectRunReportAtRetentionDelete();

  await expect(harness.repository.runRetentionSweep(1)).resolves.toBe(1);

  expect(harness.reports()).toEqual([]);
  expect([...harness.settings.keys()].filter((key) => key.startsWith("feedback-automatic-event:"))).toEqual([]);
  const sourceLocks = harness.calls.filter(({ text, values }) => (
    text.includes("pg_advisory_xact_lock(hashtext($1))")
    && String(values[0]).startsWith("feedback-automatic-source:run:")
  ));
  expect(sourceLocks.map(({ values }) => values[0])).toEqual([
    `feedback-automatic-source:run:${harness.run.id}`,
    `feedback-automatic-source:run:${harness.run.id}`,
  ]);
  const runDelete = harness.calls.findIndex(({ text }) => text.includes("DELETE FROM research_runs WHERE id=$1"));
  const feedbackCleanup = harness.calls.findIndex(({ text, values }, index) => (
    index > runDelete
    && text.includes("DELETE FROM settings")
    && text.includes("{automaticFailure,runId}")
    && values[0] === harness.run.id
  ));
  expect(runDelete).toBeGreaterThanOrEqual(0);
  expect(feedbackCleanup).toBeGreaterThan(runDelete);
});

test("retention repairs an orphaned run report and only drops suppression after its source is gone", async () => {
  const orphaned = automaticFailureHarness();
  await orphaned.repository.updateRun(orphaned.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: "Report left by an older retention race",
  });
  orphaned.deleteRunSourceBeforePersist();

  await expect(orphaned.repository.runRetentionSweep()).resolves.toBe(0);
  expect(orphaned.reports()).toEqual([]);
  expect([...orphaned.settings.keys()].filter((key) => key.startsWith("feedback-automatic-event:"))).toEqual([]);
  expect(orphaned.calls.some(({ text }) => (
    text.includes("DELETE FROM settings report") && text.includes("FROM research_runs run")
  ))).toBe(true);
  expect(orphaned.calls.some(({ text }) => (
    text.includes("DELETE FROM settings")
    && text.includes("origin'='automatic_failure' AND created_at<=$1")
    && text.includes("status'='resolved'")
    && text.includes("updated_at<=$1")
  ))).toBe(true);

  const suppressed = automaticFailureHarness();
  await suppressed.repository.updateRun(suppressed.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: "Owner-suppressed report",
  });
  const reportId = String(suppressed.reports()[0]?.id);
  await suppressed.repository.deleteFeedbackSubmission(reportId, "owner@example.com");

  await suppressed.repository.runRetentionSweep();
  expect([...suppressed.settings.values()].some((value) => {
    try {
      return (JSON.parse(value) as { suppressed?: boolean }).suppressed === true;
    } catch {
      return false;
    }
  })).toBe(true);

  suppressed.deleteRunSourceBeforePersist();
  await suppressed.repository.runRetentionSweep();
  expect([...suppressed.settings.keys()].filter((key) => key.startsWith("feedback-automatic-event:"))).toEqual([]);
});

test("failJob reports only its final attempt and never reports a scheduled retry", async () => {
  const retrying = automaticFailureHarness();
  await retrying.repository.failJob(
    retrying.job.id,
    "worker-1",
    "Transient provider timeout",
    new Date(Date.now() + 1_000),
    1,
  );
  expect(retrying.reports()).toEqual([]);

  const terminal = automaticFailureHarness();
  await terminal.repository.failJob(
    terminal.job.id,
    "worker-1",
    "Provider failed after the final attempt",
    null,
    1,
  );
  expect(terminal.reports()).toHaveLength(1);
  expect(terminal.reports()[0]).toMatchObject({
    origin: "automatic_failure",
    automaticFailure: {
      runId: terminal.run.id,
      failureClass: "research_failure",
      status: "failed",
      phase: "research_failed",
    },
  });
});

test("lease exhaustion reports in the background without delaying the next job lease", async () => {
  const harness = automaticFailureHarness();
  harness.exhaustJob();

  await expect(harness.repository.leaseNextJob("worker-1", 60_000)).resolves.toBeNull();
  await vi.waitFor(() => expect(harness.reports()).toHaveLength(1));
  expect(harness.reports()[0]).toMatchObject({
    origin: "automatic_failure",
    automaticFailure: {
      runId: harness.run.id,
      failureClass: "research_failure",
      status: "failed",
      phase: "research_failed",
    },
  });
});

test("worker-heartbeat reconciliation eventually captures a terminal failure missed by its transition hook", async () => {
  const harness = automaticFailureHarness();
  harness.run.status = "failed_system";
  harness.run.phase = "research_failed";
  harness.run.error = "The original best-effort capture was interrupted";
  harness.enableReconciliation();

  await harness.repository.updateWorkerHeartbeat("worker-reconcile", {
    schemaVersion: "15",
    activeJobs: 0,
    capacity: 1,
  });

  expect(harness.reports()).toHaveLength(1);
  expect(harness.reports()[0]).toMatchObject({
    origin: "automatic_failure",
    automaticFailure: {
      runId: harness.run.id,
      failureClass: "system_failure",
      phase: "research_failed",
    },
  });
});

test("a paused automatic event is durably marked so it cannot consume and starve reconciliation", async () => {
  const harness = automaticFailureHarness();
  harness.pauseFeedback();
  await harness.repository.updateRun(harness.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: "Provider failed while owner feedback was paused",
  });

  expect(harness.reports()).toEqual([]);
  expect(harness.auditEvents).toContainEqual(expect.objectContaining({
    runId: harness.run.id,
    action: "feedback.automatic_failure_suppressed",
    detail: expect.objectContaining({
      status: "failed_system",
      phase: "research_failed",
      activePlanRevision: 1,
    }),
  }));

  harness.resumeFeedback();
  harness.enableReconciliation();
  await harness.repository.updateWorkerHeartbeat("worker-paused-reconcile", {
    schemaVersion: "15",
    activeJobs: 0,
    capacity: 1,
  });

  const reconciliationScan = harness.calls.find(({ text }) => (
    text.includes("FROM research_runs r") && text.includes("LEFT JOIN settings touch")
  ));
  expect(reconciliationScan?.text).toContain("touch.updated_at ASC NULLS FIRST");
  expect(reconciliationScan?.text).not.toContain("feedback.automatic_failure_captured");
  expect(harness.reports()).toEqual([]);
});

test("an older captured audit cannot mask a later terminal failure under a new active plan revision", async () => {
  const harness = automaticFailureHarness();
  harness.setRootCause("provider_timeout");
  await harness.repository.updateRun(harness.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: "Revision one failed",
  });
  expect(harness.reports()).toHaveLength(1);
  expect(harness.auditEvents).toContainEqual(expect.objectContaining({
    action: "feedback.automatic_failure_captured",
    detail: expect.objectContaining({ activePlanRevision: 1 }),
  }));

  harness.setActivePlanRevision(2);
  harness.setRootCause("provider_contract_failed");
  harness.enableReconciliation();
  await harness.repository.updateWorkerHeartbeat("worker-plan-reconcile", {
    schemaVersion: "15",
    activeJobs: 0,
    capacity: 1,
  });

  expect(harness.reports()).toHaveLength(2);
  expect(harness.auditEvents).toContainEqual(expect.objectContaining({
    action: "feedback.automatic_failure_captured",
    detail: expect.objectContaining({ activePlanRevision: 2 }),
  }));
});

test("reconciliation uses the full fingerprint when the root cause changes within one plan generation", async () => {
  const harness = automaticFailureHarness();
  harness.setRootCause("provider_timeout");
  await harness.repository.updateRun(harness.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: "The first provider call timed out",
  });
  expect(harness.reports()).toHaveLength(1);

  // Simulate a later transition whose direct capture was interrupted. The
  // active plan and completed timestamp are deliberately unchanged; only the
  // bounded server-owned root cause distinguishes the event.
  harness.setRootCause("provider_contract_failed");
  harness.enableReconciliation();
  await harness.repository.updateWorkerHeartbeat("worker-cause-reconcile", {
    schemaVersion: "15",
    activeJobs: 0,
    capacity: 1,
  });

  expect(harness.reports()).toHaveLength(2);
  expect(new Set(harness.reports().map((report) => report.automaticFailure?.errorCode))).toEqual(new Set([
    "provider_timeout",
    "provider_contract_failed",
  ]));
});

test("secret-shaped terminal root causes never reach persisted error codes or quarantined QA data", async () => {
  const harness = automaticFailureHarness();
  const secret = "sk-proj-SUPERSECRET0123456789";
  harness.setRootCause(secret);

  await harness.repository.updateRun(harness.run.id, {
    status: "failed_system",
    phase: "research_failed",
    error: `Provider rejected credential ${secret}`,
  });

  expect(harness.reports()).toHaveLength(1);
  const serialized = JSON.stringify(harness.reports()[0]);
  expect(serialized).not.toContain(secret);
  expect(harness.reports()[0]?.automaticFailure?.errorCode).toMatch(/^(?:redacted|failure)_/u);
  expect(harness.reports()[0]?.qaScenario?.observed?.errorCode).not.toContain("SUPERSECRET");
});

test("reconciliation skips promptless deleted brief tombstones before applying its twenty-item limit", async () => {
  const harness = automaticFailureHarness();
  harness.enablePromptlessBriefReconciliation();

  await harness.repository.updateWorkerHeartbeat("worker-brief-reconcile", {
    schemaVersion: "15",
    activeJobs: 0,
    capacity: 1,
  });

  expect(harness.reports()).toHaveLength(1);
  expect(harness.reports()[0]).toMatchObject({
    automaticFailure: {
      briefRequestId: harness.getBrief()?.id,
      failureClass: "brief_failure",
    },
  });
  const briefScan = harness.calls.find(({ text }) => (
    text.includes("FROM brief_requests brief") && text.includes("touch.updated_at ASC NULLS FIRST")
  ));
  expect(briefScan?.text).toContain("brief.prompt<>''");
  expect(briefScan?.values).toEqual([10, "feedback-automatic-reconciliation-touch:"]);
});
