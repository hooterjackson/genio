import { describe, expect, test, vi } from "vitest";
import { createMeteredPipelineV3Response } from "../server/pipeline-v3-provider-meter.ts";

function repositoryFixture() {
  return {
    reserveProviderCost: vi.fn(async () => ({ reservationId: "reservation-1" })),
    reconcileProviderCost: vi.fn(async () => undefined),
    releaseProviderCost: vi.fn(async () => undefined),
  };
}

describe("Pipeline V3 provider metering", () => {
  test("reserves before the call and reconciles provider usage before returning", async () => {
    const repository = repositoryFixture();
    const order: string[] = [];
    repository.reserveProviderCost.mockImplementation(async () => {
      order.push("reserve");
      return { reservationId: "reservation-1" };
    });
    repository.reconcileProviderCost.mockImplementation(async () => {
      order.push("reconcile");
    });
    const base = vi.fn(async (_body: Record<string, unknown>, context: any) => {
      order.push("provider");
      await context.onUsage({
        provider: "openai",
        operation: context.operation,
        runId: context.runId,
        requestId: "request-1",
        responseId: "response-1",
        usage: { input_tokens: 10, output_tokens: 5 },
        costUsd: 0.012,
      });
      return { id: "response-1" };
    });
    const response = createMeteredPipelineV3Response(repository, base as any);

    await expect(response(
      { model: "snapshot", max_output_tokens: 100, max_tool_calls: 2 },
      { runId: "run-1", operation: "pipeline_v3.live_retrieval" },
    )).resolves.toEqual({ id: "response-1" });

    expect(order).toEqual(["reserve", "provider", "reconcile"]);
    expect(repository.reserveProviderCost).toHaveBeenCalledWith(
      { runId: "run-1" },
      expect.stringMatching(/^pipeline_v3\.live_retrieval:[a-f0-9]{16}$/u),
      expect.any(Number),
    );
    expect(repository.reconcileProviderCost).toHaveBeenCalledWith(
      "reservation-1",
      0.012,
      expect.objectContaining({ providerResponseId: "response-1", input_tokens: 10 }),
    );
    expect(repository.releaseProviderCost).not.toHaveBeenCalled();
  });

  test("releases the reservation when no provider response was received", async () => {
    const repository = repositoryFixture();
    const response = createMeteredPipelineV3Response(
      repository,
      vi.fn(async () => { throw new Error("network unavailable"); }) as any,
    );

    await expect(response({ model: "snapshot" }, {
      runId: "run-2",
      operation: "pipeline_v3.live_retrieval",
    })).rejects.toThrow("network unavailable");
    expect(repository.releaseProviderCost).toHaveBeenCalledWith("reservation-1");
    expect(repository.reconcileProviderCost).not.toHaveBeenCalled();
  });

  test("does not release a response whose reconciliation rejects an overrun", async () => {
    const repository = repositoryFixture();
    repository.reconcileProviderCost.mockRejectedValue(new Error("approved ceiling crossed"));
    const response = createMeteredPipelineV3Response(repository, vi.fn(async (_body, context: any) => {
      await context.onUsage({
        provider: "openai",
        operation: context.operation,
        runId: context.runId,
        usage: {},
        costUsd: 0.5,
      });
      return { id: "response-2" };
    }) as any);

    await expect(response({ model: "snapshot" }, {
      runId: "run-3",
      operation: "pipeline_v3.live_retrieval",
    })).rejects.toThrow("approved ceiling crossed");
    expect(repository.releaseProviderCost).not.toHaveBeenCalled();
  });

  test("fails closed when a provider response omits usage", async () => {
    const repository = repositoryFixture();
    const response = createMeteredPipelineV3Response(
      repository,
      vi.fn(async () => ({ id: "unmetered" })) as any,
    );

    await expect(response({ model: "snapshot" }, {
      runId: "run-4",
      operation: "pipeline_v3.live_retrieval",
    })).rejects.toThrow("omitted usage accounting");
    expect(repository.reconcileProviderCost).toHaveBeenCalledWith(
      "reservation-1",
      expect.any(Number),
      expect.objectContaining({
        accountingFallback: "provider_response_omitted_usage",
        model: "snapshot",
      }),
    );
    expect(repository.releaseProviderCost).not.toHaveBeenCalled();
  });
});
