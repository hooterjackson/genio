import { createHash } from "node:crypto";
import {
  createOpenAIResponse,
  type OpenAIRequestContext,
  type ProviderUsageEvent,
} from "./openai.ts";
import { maximumOpenAICallCostUsd } from "./research.ts";
import { OPENAI_PRICING_VERSION } from "./cost-config.ts";

export interface PipelineV3ProviderCostRepository {
  reserveProviderCost(
    subject: { runId: string },
    operation: string,
    maximumCostUsd: number,
  ): Promise<{ reservationId: string }>;
  reconcileProviderCost(
    reservationId: string,
    actualCostUsd: number,
    usage?: unknown,
  ): Promise<void>;
  releaseProviderCost(reservationId: string): Promise<void>;
}

function stableRequestKey(runId: string, operation: string, body: Record<string, unknown>): string {
  return createHash("sha256")
    .update(runId)
    .update("\u0000")
    .update(operation)
    .update("\u0000")
    .update(JSON.stringify(body))
    .digest("hex");
}

/**
 * Meter every Pipeline V3 Responses call through the same atomic reservation
 * and ledger used by the durable V1/V2 research worker. The provider event is
 * reconciled before its result can enter retrieval, so an overrun pauses paid
 * work instead of producing unaccounted evidence.
 */
export function createMeteredPipelineV3Response(
  repository: PipelineV3ProviderCostRepository,
  base: typeof createOpenAIResponse = createOpenAIResponse,
): typeof createOpenAIResponse {
  return async (body: Record<string, unknown>, context: OpenAIRequestContext = {}) => {
    const runId = context.runId?.trim();
    if (!runId) throw new Error("Pipeline V3 provider calls require a durable run id");
    const operation = context.operation?.trim() || "pipeline_v3.responses.create";
    const idempotencyKey = context.idempotencyKey?.trim()
      || stableRequestKey(runId, operation, body);
    const maximumCostUsd = maximumOpenAICallCostUsd(body, 0, 0.05);
    const reservation = await repository.reserveProviderCost(
      { runId },
      `${operation}:${idempotencyKey.slice(0, 16)}`,
      maximumCostUsd,
    );
    let providerResponded = false;
    let reconciled = false;
    const startedAt = Date.now();
    const onUsage = async (event: ProviderUsageEvent): Promise<void> => {
      providerResponded = true;
      await repository.reconcileProviderCost(reservation.reservationId, event.costUsd, {
        ...event.usage,
        providerRequestId: event.requestId,
        providerResponseId: event.responseId,
        model: typeof body.model === "string" ? body.model : null,
        pricingVersion: OPENAI_PRICING_VERSION,
        latencyMs: Math.max(0, Date.now() - startedAt),
      });
      reconciled = true;
      await context.onUsage?.(event);
    };
    try {
      const response = await base(body, {
        ...context,
        runId,
        operation,
        idempotencyKey,
        onUsage,
      });
      if (!reconciled) {
        // A fulfilled provider call may still be billable even when an
        // injected adapter violates the usage-callback contract. Account the
        // entire reservation conservatively before failing the run; releasing
        // it here would make real provider spend disappear from the ledger.
        providerResponded = true;
        await repository.reconcileProviderCost(reservation.reservationId, maximumCostUsd, {
          accountingFallback: "provider_response_omitted_usage",
          model: typeof body.model === "string" ? body.model : null,
          pricingVersion: OPENAI_PRICING_VERSION,
          latencyMs: Math.max(0, Date.now() - startedAt),
        });
        reconciled = true;
        throw new Error("Pipeline V3 provider response omitted usage accounting");
      }
      return response;
    } catch (error) {
      if (!providerResponded) {
        await repository.releaseProviderCost(reservation.reservationId);
      }
      throw error;
    }
  };
}
