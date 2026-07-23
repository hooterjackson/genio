import { expect, test } from "vitest";
import {
  defaultJobQueueClass,
  isColdCorpusWork,
  isDeepQueryPlan,
  parseWorkerQueueClass,
  queueClassesForWorker,
} from "../server/job-queue-class.ts";

test("worker queue classes map to physically isolated durable lanes", () => {
  expect(queueClassesForWorker("interactive")).toEqual(["publication", "interactive", "system"]);
  expect(queueClassesForWorker("deep")).toEqual(["deep"]);
  expect(queueClassesForWorker("all")).toEqual(["interactive", "deep", "publication", "system"]);
});

test("queue-class parsing is strict and defaults public workers to interactive", () => {
  expect(parseWorkerQueueClass(undefined)).toBe("interactive");
  expect(parseWorkerQueueClass("deep")).toBe("deep");
  expect(() => parseWorkerQueueClass("publication")).toThrow(/WORKER_QUEUE_CLASS/u);
});

test("reserved Apple-write and system jobs cannot be mislabeled", () => {
  expect(defaultJobQueueClass({ kind: "publication", requested: "deep" })).toBe("publication");
  expect(defaultJobQueueClass({ kind: "apple_authorization", requested: "deep" })).toBe("system");
  expect(defaultJobQueueClass({ kind: "notification" })).toBe("system");
  expect(() => defaultJobQueueClass({ kind: "research", requested: "publication" }))
    .toThrow(/cannot enter the publication queue/u);
  expect(() => defaultJobQueueClass({ kind: "matching", requested: "system" }))
    .toThrow(/cannot enter the system queue/u);
});

test("factual and exhaustive V3 query plans route to deep workers", () => {
  expect(isDeepQueryPlan({ engines: ["factual_relationship"] })).toBe(true);
  expect(isDeepQueryPlan({ engines: ["curated_genre_scene", "exhaustive"] })).toBe(true);
  expect(isDeepQueryPlan({ engine: "exhaustive" })).toBe(true);
  expect(isDeepQueryPlan({ engines: ["curated_genre_scene"] })).toBe(false);
  expect(isDeepQueryPlan(null)).toBe(false);
});

test("expanded curated query plans cannot consume the interactive lane", () => {
  expect(isDeepQueryPlan({
    targetTrackCount: 300,
    engines: ["curated_genre_scene"],
  })).toBe(false);
  expect(isDeepQueryPlan({
    targetTrackCount: 301,
    engines: ["curated_genre_scene"],
  })).toBe(true);
  expect(isDeepQueryPlan({
    targetTrackCount: 1_000,
    engines: ["curated_genre_scene"],
  })).toBe(true);
});

test("legacy and curated work defaults interactive; deep placement must be explicit and verified", () => {
  expect(defaultJobQueueClass({ kind: "research", payload: {} })).toBe("interactive");
  expect(defaultJobQueueClass({ kind: "matching", payload: { fast: false } })).toBe("interactive");
  expect(defaultJobQueueClass({ kind: "research", payload: { fast: true } })).toBe("interactive");
  expect(defaultJobQueueClass({ kind: "brief" })).toBe("interactive");
  expect(defaultJobQueueClass({ kind: "research", requested: "interactive", payload: {} }))
    .toBe("interactive");
  expect(isColdCorpusWork({ workloadClass: "cold_corpus" })).toBe(true);
  expect(isColdCorpusWork({ workloadClass: "interactive" })).toBe(false);
});
