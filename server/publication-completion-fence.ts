import type { PipelineOutcome } from "../shared/types.ts";
import type { PublicationExecutionFence } from "./publication-reconciliation-persistence.ts";

/**
 * The durable generation of one Apple playlist volume. `attempt` changes
 * whenever reconciliation abandons an Apple playlist and starts a replacement,
 * so an older publisher cannot finalize a newer publication attempt.
 */
export interface PublicationCompletionVolumeFence {
  publicationVolumeId: string;
  attempt: number;
  applePlaylistId: string;
  appendedCount: number;
  startPosition: number;
  endPosition: number;
}

/**
 * Everything that must still be current at the instant publication becomes
 * user-visible. The repository validates and commits this fence in one
 * transaction after Apple membership reconciliation has completed.
 */
export interface PublicationCompletionFence {
  runId: string;
  manifestId: string;
  manifestRevisionId: string | null;
  manifestRevisionHash: string;
  contractRevisionId: string | null;
  contractHash: string | null;
  /**
   * Canonical publications must still own this exact lease when terminal
   * state is committed. Legacy V1/V2 bridge publications use null.
   */
  executionFence: PublicationExecutionFence | null;
  selectedCount: number;
  terminalStatus: "complete" | "partial";
  publicationVolumes: PublicationCompletionVolumeFence[];
  pipelineOutcome: PipelineOutcome | null;
}
