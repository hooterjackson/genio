import type { AppleAuthorizationJobRepository } from "./apple.ts";
import type { MatchingRepository } from "./matching-service.ts";
import type { NotificationRepository } from "./notifications.ts";
import type { PublicationRepository } from "./publisher.ts";
import type { ResearchRepository } from "./research.ts";

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
    getRun: (...args: Parameters<ResearchRepository["getRun"]>) => source.getRun(...args),
    updateRun: (...args: Parameters<ResearchRepository["updateRun"]>) => source.updateRun(...args),
    getCoverage: (...args: Parameters<ResearchRepository["getCoverage"]>) => source.getCoverage(...args),
    addSources: (...args: Parameters<ResearchRepository["addSources"]>) => source.addSources(...args),
    addCitationAttestations: (...args: Parameters<ResearchRepository["addCitationAttestations"]>) => source.addCitationAttestations(...args),
    addCandidates: (...args: Parameters<ResearchRepository["addCandidates"]>) => source.addCandidates(...args),
    upsertFrontier: (...args: Parameters<ResearchRepository["upsertFrontier"]>) => source.upsertFrontier(...args),
    upsertResearchContainers: (...args: Parameters<ResearchRepository["upsertResearchContainers"]>) => source.upsertResearchContainers(...args),
    listResearchContainers: (...args: Parameters<ResearchRepository["listResearchContainers"]>) => source.listResearchContainers(...args),
    getResearchCheckpoint: (...args: Parameters<ResearchRepository["getResearchCheckpoint"]>) => source.getResearchCheckpoint(...args),
    saveResearchCheckpoint: (...args: Parameters<ResearchRepository["saveResearchCheckpoint"]>) => source.saveResearchCheckpoint(...args),
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
    getRun: (...args: Parameters<MatchingRepository["getRun"]>) => source.getRun(...args),
    updateRun: (...args: Parameters<MatchingRepository["updateRun"]>) => source.updateRun(...args),
    listCandidates: (...args: Parameters<MatchingRepository["listCandidates"]>) => source.listCandidates(...args),
    listMatches: (...args: Parameters<MatchingRepository["listMatches"]>) => source.listMatches(...args),
    saveMatch: (...args: Parameters<MatchingRepository["saveMatch"]>) => source.saveMatch(...args),
    saveTimeoutMatches: (...args: Parameters<MatchingRepository["saveTimeoutMatches"]>) => source.saveTimeoutMatches(...args),
    getResearchCheckpoint: (...args: Parameters<MatchingRepository["getResearchCheckpoint"]>) => source.getResearchCheckpoint(...args),
    saveResearchCheckpoint: (...args: Parameters<MatchingRepository["saveResearchCheckpoint"]>) => source.saveResearchCheckpoint(...args),
    queueAutomaticCatalogRecovery: (...args: Parameters<MatchingRepository["queueAutomaticCatalogRecovery"]>) => source.queueAutomaticCatalogRecovery(...args),
    queueAutomaticPublication: (...args: Parameters<MatchingRepository["queueAutomaticPublication"]>) => source.queueAutomaticPublication(...args),
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
    updatePublicationVolume: (...args: Parameters<PublicationRepository["updatePublicationVolume"]>) => source.updatePublicationVolume(...args),
    markPlaylistOrphan: (...args: Parameters<PublicationRepository["markPlaylistOrphan"]>) => source.markPlaylistOrphan(...args),
    updateRun: (...args: Parameters<PublicationRepository["updateRun"]>) => source.updateRun(...args),
    enqueueNotification: (...args: Parameters<PublicationRepository["enqueueNotification"]>) => source.enqueueNotification(...args),
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
