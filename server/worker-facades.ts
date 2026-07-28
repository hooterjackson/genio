import type { AppleAuthorizationJobRepository } from "./apple.ts";
import type { MatchingRepository } from "./matching-service.ts";
import type { NotificationRepository } from "./notifications.ts";
import type { PublicationRepository } from "./publisher.ts";
import type { ResearchRepository } from "./research.ts";
import type { SelectionPlan } from "../shared/types.ts";
import { persistedWorkerPipeline } from "./pipeline-worker-routing.ts";

/**
 * These facades are a runtime boundary, not only a TypeScript annotation.
 * Handler code receives a frozen object containing exactly the operations its
 * role needs, so a research bug cannot discover Apple authorization methods on
 * the repository object it was given.
 */
export function createResearchRepositoryFacade(source: ResearchRepository): ResearchRepository {
  return Object.freeze({
    getBriefRequest: (...args: Parameters<ResearchRepository["getBriefRequest"]>) => source.getBriefRequest(...args),
    saveBriefResult: (...args: Parameters<ResearchRepository["saveBriefResult"]>) => source.saveBriefResult(...args),
    saveBriefSelectionPlan: (briefRequestId: string, plan: SelectionPlan) => {
      if (!source.saveBriefSelectionPlan) throw new Error("Pipeline selection-plan persistence is unavailable");
      return source.saveBriefSelectionPlan(briefRequestId, plan);
    },
    getRun: (...args: Parameters<ResearchRepository["getRun"]>) => source.getRun(...args),
    updateRun: (...args: Parameters<ResearchRepository["updateRun"]>) => source.updateRun(...args),
    getCoverage: (...args: Parameters<ResearchRepository["getCoverage"]>) => source.getCoverage(...args),
    addSources: (...args: Parameters<ResearchRepository["addSources"]>) => source.addSources(...args),
    addCitationAttestations: (...args: Parameters<ResearchRepository["addCitationAttestations"]>) => source.addCitationAttestations(...args),
    addCandidates: (...args: Parameters<ResearchRepository["addCandidates"]>) => source.addCandidates(...args),
    listCandidates: (runId: string) => {
      if (!source.listCandidates) throw new Error("Research candidate inventory is unavailable");
      return source.listCandidates(runId);
    },
    upsertFrontier: (...args: Parameters<ResearchRepository["upsertFrontier"]>) => source.upsertFrontier(...args),
    upsertResearchContainers: (...args: Parameters<ResearchRepository["upsertResearchContainers"]>) => source.upsertResearchContainers(...args),
    listResearchContainers: (...args: Parameters<ResearchRepository["listResearchContainers"]>) => source.listResearchContainers(...args),
    getResearchCheckpoint: (...args: Parameters<ResearchRepository["getResearchCheckpoint"]>) => source.getResearchCheckpoint(...args),
    saveResearchCheckpoint: (...args: Parameters<ResearchRepository["saveResearchCheckpoint"]>) => source.saveResearchCheckpoint(...args),
    ...(source.claimResearchProviderRetry ? {
      claimResearchProviderRetry: (
        ...args: Parameters<
          NonNullable<ResearchRepository["claimResearchProviderRetry"]>
        >
      ) => source.claimResearchProviderRetry!(...args),
    } : {}),
    ...(source.persistResearchProviderBlocker ? {
      persistResearchProviderBlocker: (
        ...args: Parameters<
          NonNullable<ResearchRepository["persistResearchProviderBlocker"]>
        >
      ) => source.persistResearchProviderBlocker!(...args),
    } : {}),
    ...(source.validateResearchProviderAttempt ? {
      validateResearchProviderAttempt: (
        ...args: Parameters<
          NonNullable<ResearchRepository["validateResearchProviderAttempt"]>
        >
      ) => source.validateResearchProviderAttempt!(...args),
    } : {}),
    ...(source.resolveResearchProviderBlocker ? {
      resolveResearchProviderBlocker: (
        ...args: Parameters<
          NonNullable<ResearchRepository["resolveResearchProviderBlocker"]>
        >
      ) => source.resolveResearchProviderBlocker!(...args),
    } : {}),
    ...(source.getActivePlaylistContractRevision ? {
      getActivePlaylistContractRevision: (
        ...args: Parameters<NonNullable<ResearchRepository["getActivePlaylistContractRevision"]>>
      ) => source.getActivePlaylistContractRevision!(...args),
    } : {}),
    ...(source.savePlaylistContractRevision ? {
      savePlaylistContractRevision: (
        ...args: Parameters<NonNullable<ResearchRepository["savePlaylistContractRevision"]>>
      ) => source.savePlaylistContractRevision!(...args),
    } : {}),
    ...(source.savePlaylistFeasibilitySnapshot ? {
      savePlaylistFeasibilitySnapshot: (
        ...args: Parameters<NonNullable<ResearchRepository["savePlaylistFeasibilitySnapshot"]>>
      ) => source.savePlaylistFeasibilitySnapshot!(...args),
    } : {}),
    ...(source.openPlaylistRunBlocker ? {
      openPlaylistRunBlocker: (
        ...args: Parameters<NonNullable<ResearchRepository["openPlaylistRunBlocker"]>>
      ) => source.openPlaylistRunBlocker!(...args),
    } : {}),
    ...(source.preparePlaylistRunRescueGuidance ? {
      preparePlaylistRunRescueGuidance: (
        ...args: Parameters<NonNullable<ResearchRepository["preparePlaylistRunRescueGuidance"]>>
      ) => source.preparePlaylistRunRescueGuidance!(...args),
    } : {}),
    ...(source.quarantineCanonicalExecution ? {
      quarantineCanonicalExecution: (
        ...args: Parameters<NonNullable<ResearchRepository["quarantineCanonicalExecution"]>>
      ) => source.quarantineCanonicalExecution!(...args),
    } : {}),
    claimPipelineV3SemanticRecovery: (
      ...args: Parameters<ResearchRepository["claimPipelineV3SemanticRecovery"]>
    ) => source.claimPipelineV3SemanticRecovery(...args),
    ...(source.persistPipelineV3DiscoveryBatch ? {
      persistPipelineV3DiscoveryBatch: (
        ...args: Parameters<NonNullable<ResearchRepository["persistPipelineV3DiscoveryBatch"]>>
      ) => source.persistPipelineV3DiscoveryBatch!(...args),
    } : {}),
    ...(source.persistPipelineV3QualificationBatch ? {
      persistPipelineV3QualificationBatch: (
        ...args: Parameters<NonNullable<ResearchRepository["persistPipelineV3QualificationBatch"]>>
      ) => source.persistPipelineV3QualificationBatch!(...args),
    } : {}),
    ...(source.validatePipelineV3ContinuationQualifications ? {
      validatePipelineV3ContinuationQualifications: (
        ...args: Parameters<
          NonNullable<
            ResearchRepository["validatePipelineV3ContinuationQualifications"]
          >
        >
      ) => source.validatePipelineV3ContinuationQualifications!(...args),
    } : {}),
    ...(source.persistPipelineV3RuntimeFeasibilitySnapshot ? {
      persistPipelineV3RuntimeFeasibilitySnapshot: (
        ...args: Parameters<
          NonNullable<
            ResearchRepository["persistPipelineV3RuntimeFeasibilitySnapshot"]
          >
        >
      ) => source.persistPipelineV3RuntimeFeasibilitySnapshot!(...args),
    } : {}),
    persistPipelineV3RetrievalResult: (
      ...args: Parameters<ResearchRepository["persistPipelineV3RetrievalResult"]>
    ) => source.persistPipelineV3RetrievalResult(...args),
    ...(source.ingestPipelineV3ColdCorpus ? {
      ingestPipelineV3ColdCorpus: (
        ...args: Parameters<NonNullable<ResearchRepository["ingestPipelineV3ColdCorpus"]>>
      ) => source.ingestPipelineV3ColdCorpus!(...args),
    } : {}),
    enqueueJob: (input: Parameters<ResearchRepository["enqueueJob"]>[0]) => {
      if (input.kind !== "research" && input.kind !== "matching") {
        throw new Error(`Research cannot enqueue ${input.kind} jobs`);
      }
      return source.enqueueJob(input);
    },
    reserveProviderCost: (...args: Parameters<ResearchRepository["reserveProviderCost"]>) => source.reserveProviderCost(...args),
    reconcileProviderCost: (...args: Parameters<ResearchRepository["reconcileProviderCost"]>) => source.reconcileProviderCost(...args),
    releaseProviderCost: (...args: Parameters<ResearchRepository["releaseProviderCost"]>) => source.releaseProviderCost(...args),
  });
}

export function createMatchingRepositoryFacade(source: MatchingRepository): MatchingRepository {
  return Object.freeze({
    getRun: async (...args: Parameters<MatchingRepository["getRun"]>) => {
      const run = await source.getRun(...args);
      const pipeline = persistedWorkerPipeline(run);
      return {
        ...run,
        pipelineVersion: pipeline.pipelineVersion,
        policyVersion: pipeline.policyVersion,
        selectionPlan: pipeline.selectionPlan,
        queryPlan: pipeline.queryPlan,
      };
    },
    updateRun: (...args: Parameters<MatchingRepository["updateRun"]>) => source.updateRun(...args),
    listCandidates: (...args: Parameters<MatchingRepository["listCandidates"]>) => source.listCandidates(...args),
    listMatches: (...args: Parameters<MatchingRepository["listMatches"]>) => source.listMatches(...args),
    saveMatch: (...args: Parameters<MatchingRepository["saveMatch"]>) => source.saveMatch(...args),
    saveTimeoutMatches: (...args: Parameters<MatchingRepository["saveTimeoutMatches"]>) => source.saveTimeoutMatches(...args),
    getResearchCheckpoint: (...args: Parameters<MatchingRepository["getResearchCheckpoint"]>) => source.getResearchCheckpoint(...args),
    saveResearchCheckpoint: (...args: Parameters<MatchingRepository["saveResearchCheckpoint"]>) => source.saveResearchCheckpoint(...args),
    queueAutomaticCatalogRecovery: (...args: Parameters<MatchingRepository["queueAutomaticCatalogRecovery"]>) => source.queueAutomaticCatalogRecovery(...args),
    queueAutomaticCandidateRefill: (...args: Parameters<MatchingRepository["queueAutomaticCandidateRefill"]>) => source.queueAutomaticCandidateRefill(...args),
    queueAutomaticPublication: (...args: Parameters<MatchingRepository["queueAutomaticPublication"]>) => source.queueAutomaticPublication(...args),
    ...(source.preparePartialPublication ? {
      preparePartialPublication: (...args: Parameters<NonNullable<MatchingRepository["preparePartialPublication"]>>) => source.preparePartialPublication!(...args),
    } : {}),
    ...(source.savePipelineOutcome ? {
      savePipelineOutcome: (...args: Parameters<NonNullable<MatchingRepository["savePipelineOutcome"]>>) => source.savePipelineOutcome!(...args),
    } : {}),
    ...(source.persistCatalogProviderBlocker ? {
      persistCatalogProviderBlocker: (
        ...args: Parameters<
          NonNullable<MatchingRepository["persistCatalogProviderBlocker"]>
        >
      ) => source.persistCatalogProviderBlocker!(...args),
    } : {}),
    ...(source.claimCatalogProviderRetry ? {
      claimCatalogProviderRetry: (
        ...args: Parameters<
          NonNullable<MatchingRepository["claimCatalogProviderRetry"]>
        >
      ) => source.claimCatalogProviderRetry!(...args),
    } : {}),
    ...(source.resolveCatalogProviderBlocker ? {
      resolveCatalogProviderBlocker: (
        ...args: Parameters<
          NonNullable<MatchingRepository["resolveCatalogProviderBlocker"]>
        >
      ) => source.resolveCatalogProviderBlocker!(...args),
    } : {}),
    ...(source.getPipelineStageCounts ? {
      getPipelineStageCounts: (...args: Parameters<NonNullable<MatchingRepository["getPipelineStageCounts"]>>) => source.getPipelineStageCounts!(...args),
    } : {}),
    ...(source.upsertRecordingFamily ? {
      upsertRecordingFamily: (...args: Parameters<NonNullable<MatchingRepository["upsertRecordingFamily"]>>) => source.upsertRecordingFamily!(...args),
    } : {}),
    ...(source.attachCandidateToRecordingFamily ? {
      attachCandidateToRecordingFamily: (...args: Parameters<NonNullable<MatchingRepository["attachCandidateToRecordingFamily"]>>) => source.attachCandidateToRecordingFamily!(...args),
    } : {}),
    ...(source.upsertAlternateCatalogIdentity ? {
      upsertAlternateCatalogIdentity: (...args: Parameters<NonNullable<MatchingRepository["upsertAlternateCatalogIdentity"]>>) => source.upsertAlternateCatalogIdentity!(...args),
    } : {}),
    ...(source.appendCandidateStageEvents ? {
      appendCandidateStageEvents: (...args: Parameters<NonNullable<MatchingRepository["appendCandidateStageEvents"]>>) => source.appendCandidateStageEvents!(...args),
    } : {}),
    ...(source.savePipelineDeficitLedger ? {
      savePipelineDeficitLedger: (...args: Parameters<NonNullable<MatchingRepository["savePipelineDeficitLedger"]>>) => source.savePipelineDeficitLedger!(...args),
    } : {}),
    ...(source.persistCatalogDiscoveredCandidates ? {
      persistCatalogDiscoveredCandidates: (...args: Parameters<NonNullable<MatchingRepository["persistCatalogDiscoveredCandidates"]>>) => source.persistCatalogDiscoveredCandidates!(...args),
    } : {}),
    ...(source.reserveMusicBrainzEnrichmentRequest ? {
      reserveMusicBrainzEnrichmentRequest: (...args: Parameters<NonNullable<MatchingRepository["reserveMusicBrainzEnrichmentRequest"]>>) => source.reserveMusicBrainzEnrichmentRequest!(...args),
    } : {}),
    ...(source.updateCandidateMusicBrainzIdentity ? {
      updateCandidateMusicBrainzIdentity: (...args: Parameters<NonNullable<MatchingRepository["updateCandidateMusicBrainzIdentity"]>>) => source.updateCandidateMusicBrainzIdentity!(...args),
    } : {}),
    ...(source.getAppleCatalogCacheEntry
      && source.putAppleCatalogCacheEntry
      && source.deleteAppleCatalogCacheEntry
      && source.recordAppleCatalogCacheEvent
      && source.tryAcquireAppleCatalogCacheLease
      && source.releaseAppleCatalogCacheLease
      && source.cleanupExpiredAppleCatalogCacheLeases ? {
        getAppleCatalogCacheEntry: (...args: Parameters<NonNullable<MatchingRepository["getAppleCatalogCacheEntry"]>>) => source.getAppleCatalogCacheEntry!(...args),
        putAppleCatalogCacheEntry: (...args: Parameters<NonNullable<MatchingRepository["putAppleCatalogCacheEntry"]>>) => source.putAppleCatalogCacheEntry!(...args),
        deleteAppleCatalogCacheEntry: (...args: Parameters<NonNullable<MatchingRepository["deleteAppleCatalogCacheEntry"]>>) => source.deleteAppleCatalogCacheEntry!(...args),
        recordAppleCatalogCacheEvent: (...args: Parameters<NonNullable<MatchingRepository["recordAppleCatalogCacheEvent"]>>) => source.recordAppleCatalogCacheEvent!(...args),
        tryAcquireAppleCatalogCacheLease: (...args: Parameters<NonNullable<MatchingRepository["tryAcquireAppleCatalogCacheLease"]>>) => source.tryAcquireAppleCatalogCacheLease!(...args),
        releaseAppleCatalogCacheLease: (...args: Parameters<NonNullable<MatchingRepository["releaseAppleCatalogCacheLease"]>>) => source.releaseAppleCatalogCacheLease!(...args),
        cleanupExpiredAppleCatalogCacheLeases: (...args: Parameters<NonNullable<MatchingRepository["cleanupExpiredAppleCatalogCacheLeases"]>>) => source.cleanupExpiredAppleCatalogCacheLeases!(...args),
      } : {}),
  });
}

export function createPublicationRepositoryFacade(source: PublicationRepository): PublicationRepository {
  return Object.freeze({
    getAppleAuthorization: (...args: Parameters<PublicationRepository["getAppleAuthorization"]>) => source.getAppleAuthorization(...args),
    updateAppleAuthorizationStatus: (...args: Parameters<PublicationRepository["updateAppleAuthorizationStatus"]>) => source.updateAppleAuthorizationStatus(...args),
    getSetting: (...args: Parameters<PublicationRepository["getSetting"]>) => source.getSetting(...args),
    getRunControlState: (...args: Parameters<PublicationRepository["getRunControlState"]>) => source.getRunControlState(...args),
    getPublicationCompleteness: (...args: Parameters<PublicationRepository["getPublicationCompleteness"]>) => source.getPublicationCompleteness(...args),
    getManifestById: (...args: Parameters<PublicationRepository["getManifestById"]>) => source.getManifestById(...args),
    listPublicationVolumes: (...args: Parameters<PublicationRepository["listPublicationVolumes"]>) => source.listPublicationVolumes(...args),
    createPublicationVolume: (...args: Parameters<PublicationRepository["createPublicationVolume"]>) => source.createPublicationVolume(...args),
    retirePublicationVolume: (...args: Parameters<PublicationRepository["retirePublicationVolume"]>) => source.retirePublicationVolume(...args),
    hidePublicPlaylistsForRun: (...args: Parameters<PublicationRepository["hidePublicPlaylistsForRun"]>) => source.hidePublicPlaylistsForRun(...args),
    updatePublicationVolume: (...args: Parameters<PublicationRepository["updatePublicationVolume"]>) => source.updatePublicationVolume(...args),
    markPlaylistOrphan: (...args: Parameters<PublicationRepository["markPlaylistOrphan"]>) => source.markPlaylistOrphan(...args),
    updateRun: (...args: Parameters<PublicationRepository["updateRun"]>) => source.updateRun(...args),
    enqueueNotification: (...args: Parameters<PublicationRepository["enqueueNotification"]>) => source.enqueueNotification(...args),
    ...(source.getPublicationGuard ? {
      getPublicationGuard: (...args: Parameters<NonNullable<PublicationRepository["getPublicationGuard"]>>) => source.getPublicationGuard!(...args),
    } : {}),
    ...(source.acquireAppleWritePermit ? {
      acquireAppleWritePermit: (...args: Parameters<NonNullable<PublicationRepository["acquireAppleWritePermit"]>>) => source.acquireAppleWritePermit!(...args),
    } : {}),
    ...(source.commitPublicationCompletion ? {
      commitPublicationCompletion: (...args: Parameters<NonNullable<PublicationRepository["commitPublicationCompletion"]>>) => source.commitPublicationCompletion!(...args),
    } : {}),
    ...(source.beginPublicationReconciliation ? {
      beginPublicationReconciliation: (
        ...args: Parameters<NonNullable<PublicationRepository["beginPublicationReconciliation"]>>
      ) => source.beginPublicationReconciliation!(...args),
    } : {}),
    ...(source.advancePublicationReconciliation ? {
      advancePublicationReconciliation: (
        ...args: Parameters<NonNullable<PublicationRepository["advancePublicationReconciliation"]>>
      ) => source.advancePublicationReconciliation!(...args),
    } : {}),
    ...(source.commitCanonicalPublicationPreflightDecision ? {
      commitCanonicalPublicationPreflightDecision: (
        ...args: Parameters<NonNullable<PublicationRepository["commitCanonicalPublicationPreflightDecision"]>>
      ) => source.commitCanonicalPublicationPreflightDecision!(...args),
    } : {}),
    ...(source.updateCanonicalPublicationRun ? {
      updateCanonicalPublicationRun: (
        ...args: Parameters<NonNullable<PublicationRepository["updateCanonicalPublicationRun"]>>
      ) => source.updateCanonicalPublicationRun!(...args),
    } : {}),
    ...(source.openPlaylistRunBlocker ? {
      openPlaylistRunBlocker: (
        ...args: Parameters<NonNullable<PublicationRepository["openPlaylistRunBlocker"]>>
      ) => source.openPlaylistRunBlocker!(...args),
    } : {}),
    ...(source.getManifestPreflightTracks ? {
      getManifestPreflightTracks: (...args: Parameters<NonNullable<PublicationRepository["getManifestPreflightTracks"]>>) => source.getManifestPreflightTracks!(...args),
    } : {}),
    ...(source.getManifestPreflightReserveTracks ? {
      getManifestPreflightReserveTracks: (...args: Parameters<NonNullable<PublicationRepository["getManifestPreflightReserveTracks"]>>) => source.getManifestPreflightReserveTracks!(...args),
    } : {}),
    ...(source.revalidateCanonicalPublicationManifest ? {
      revalidateCanonicalPublicationManifest: (
        ...args: Parameters<NonNullable<PublicationRepository["revalidateCanonicalPublicationManifest"]>>
      ) => source.revalidateCanonicalPublicationManifest!(...args),
    } : {}),
    ...(source.createManifestRevision ? {
      createManifestRevision: (...args: Parameters<NonNullable<PublicationRepository["createManifestRevision"]>>) => source.createManifestRevision!(...args),
    } : {}),
    ...(source.getManifestRevision ? {
      getManifestRevision: (...args: Parameters<NonNullable<PublicationRepository["getManifestRevision"]>>) => source.getManifestRevision!(...args),
    } : {}),
    ...(source.markManifestRevisionStatus ? {
      markManifestRevisionStatus: (...args: Parameters<NonNullable<PublicationRepository["markManifestRevisionStatus"]>>) => source.markManifestRevisionStatus!(...args),
    } : {}),
    ...(source.getPipelineOutcome ? {
      getPipelineOutcome: (...args: Parameters<NonNullable<PublicationRepository["getPipelineOutcome"]>>) => source.getPipelineOutcome!(...args),
    } : {}),
    ...(source.savePipelineOutcome ? {
      savePipelineOutcome: (...args: Parameters<NonNullable<PublicationRepository["savePipelineOutcome"]>>) => source.savePipelineOutcome!(...args),
    } : {}),
    ...(source.getPipelineStageCounts ? {
      getPipelineStageCounts: (...args: Parameters<NonNullable<PublicationRepository["getPipelineStageCounts"]>>) => source.getPipelineStageCounts!(...args),
    } : {}),
    ...(source.appendCandidateStageEvents ? {
      appendCandidateStageEvents: (...args: Parameters<NonNullable<PublicationRepository["appendCandidateStageEvents"]>>) => source.appendCandidateStageEvents!(...args),
    } : {}),
    ...(source.sealManifestRevisionPublication ? {
      sealManifestRevisionPublication: (...args: Parameters<NonNullable<PublicationRepository["sealManifestRevisionPublication"]>>) => source.sealManifestRevisionPublication!(...args),
    } : {}),
  });
}

export function createAppleAuthorizationRepositoryFacade(source: AppleAuthorizationJobRepository): AppleAuthorizationJobRepository {
  return Object.freeze({
    getAppleAuthorization: (...args: Parameters<AppleAuthorizationJobRepository["getAppleAuthorization"]>) => source.getAppleAuthorization(...args),
    saveAppleAuthorization: (...args: Parameters<AppleAuthorizationJobRepository["saveAppleAuthorization"]>) => source.saveAppleAuthorization(...args),
    updateAppleAuthorizationStatus: (...args: Parameters<AppleAuthorizationJobRepository["updateAppleAuthorizationStatus"]>) => source.updateAppleAuthorizationStatus(...args),
    updateAppleAuthorizationValidation: (...args: Parameters<AppleAuthorizationJobRepository["updateAppleAuthorizationValidation"]>) => source.updateAppleAuthorizationValidation(...args),
  });
}

export function createNotificationRepositoryFacade(source: NotificationRepository): NotificationRepository {
  return Object.freeze({
    getNotification: (...args: Parameters<NotificationRepository["getNotification"]>) => source.getNotification(...args),
    markNotificationSent: (...args: Parameters<NotificationRepository["markNotificationSent"]>) => source.markNotificationSent(...args),
    markNotificationFailed: (...args: Parameters<NotificationRepository["markNotificationFailed"]>) => source.markNotificationFailed(...args),
  });
}
