import { describe, expect, test, vi } from "vitest";
import { Repository } from "../server/repository.ts";
import { defaultJobHandlers } from "../server/worker-runner.ts";

function methodProxy(overrides: Record<PropertyKey, unknown> = {}): any {
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  return new Proxy(overrides, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (!methods.has(property)) methods.set(property, vi.fn(async () => undefined));
      return methods.get(property);
    },
  });
}

describe("Pipeline V2 operational alert sweep", () => {
  test("queries a closed UTC window and durably deduplicates every triggered owner alert", async () => {
    const query = vi.fn(async (...args: unknown[]) => args[0] && String(args[0]).includes("WITH recent_outcomes") ? ({
      rows: [{
        terminal_runs: 20,
        zero_result_runs: 3,
        partial_runs: 6,
        local_contract_rejections: 2,
        provider_circuit_openings: 3,
        pagination_loops: 1,
        endpoint_drift_events: 1,
        publication_divergences: 1,
      }],
    }) : ({ rows: [] }));
    const enqueueNotification = vi.fn(async (kind: string) => `notification:${kind}`);
    const repository = Object.create(Repository.prototype) as Repository & {
      pool: { query: typeof query };
      enqueueNotification: typeof enqueueNotification;
    };
    Object.defineProperty(repository, "pool", { value: { query }, configurable: true });
    Object.defineProperty(repository, "enqueueNotification", { value: enqueueNotification, configurable: true });

    const sweep = await repository.runPipelineV2OperationalAlertSweep({
      windowHours: 1,
      windowEndedAt: new Date("2026-07-19T12:47:31.000Z"),
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM pipeline_outcomes"),
      [new Date("2026-07-19T11:00:00.000Z"), new Date("2026-07-19T12:00:00.000Z")],
    );
    expect(query.mock.calls[0]?.[0]).toContain("FROM apple_catalog_cache_events");
    expect(query.mock.calls[0]?.[0]).toContain("provider_state='circuit_open'");
    expect(query.mock.calls[0]?.[0]).toContain("signal LIKE '%pagination_loop%'");
    expect(query.mock.calls[0]?.[0]).toContain("kind='publication_orphaned'");
    expect(sweep.alerts).toHaveLength(7);
    expect(sweep.notificationIds).toHaveLength(7);
    expect(enqueueNotification).toHaveBeenCalledWith(
      "pipeline_zero_result_spike",
      expect.objectContaining({
        deduplicationKey: "pipeline-v2-alert:pipeline_zero_result_spike:2026-07-19T11:00:00.000Z",
        windowEndedAt: "2026-07-19T12:00:00.000Z",
        terminalRuns: 20,
      }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("pipeline_v2_alert_last_window_end"),
      ["2026-07-19T12:00:00.000Z"],
    );
  });

  test("keeps healthy windows silent", async () => {
    const query = vi.fn(async (...args: unknown[]) => args[0] && String(args[0]).includes("WITH recent_outcomes") ? ({
      rows: [{
        terminal_runs: 20,
        zero_result_runs: 2,
        partial_runs: 4,
        local_contract_rejections: 1,
        provider_circuit_openings: 2,
        pagination_loops: 0,
        endpoint_drift_events: 0,
        publication_divergences: 0,
      }],
    }) : ({ rows: [] }));
    const enqueueNotification = vi.fn();
    const repository = Object.create(Repository.prototype) as any;
    Object.defineProperty(repository, "pool", { value: { query }, configurable: true });
    Object.defineProperty(repository, "enqueueNotification", { value: enqueueNotification, configurable: true });

    await expect(repository.runPipelineV2OperationalAlertSweep({
      windowEndedAt: new Date("2026-07-19T12:00:00.000Z"),
    })).resolves.toMatchObject({ alerts: [], notificationIds: [] });
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  test("worker housekeeping executes the durable sweep without exposing it to research facades", async () => {
    const runPipelineV2OperationalAlertSweep = vi.fn(async () => ({ alerts: [] }));
    const repository = methodProxy({ runPipelineV2OperationalAlertSweep });
    const handler = defaultJobHandlers(repository).pipeline_observability!;

    await handler(
      { windowEndedAt: "2026-07-19T12:00:00.000Z" },
      new AbortController().signal,
    );

    expect(runPipelineV2OperationalAlertSweep).toHaveBeenCalledWith({
      windowHours: 1,
      windowEndedAt: new Date("2026-07-19T12:00:00.000Z"),
    });
  });
});
