"use client";

import { useEffect, useState } from "react";
import { currentRelease } from "../../shared/release-metadata";

type RuntimeBuildPayload = {
  build?: {
    identifier?: unknown;
    revision?: unknown;
    version?: unknown;
  };
};

type RuntimeBuildState =
  | { status: "checking" }
  | { status: "available"; identifier: string; version: string }
  | { status: "unavailable" };

function safeBuildText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(normalized)) return null;
  return normalized;
}

export function RuntimeBuild() {
  const [runtime, setRuntime] = useState<RuntimeBuildState>({ status: "checking" });

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/health/live", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("The API build endpoint is unavailable");
      const payload = await response.json() as RuntimeBuildPayload;
      const identifier = safeBuildText(payload.build?.identifier, 140);
      const version = safeBuildText(payload.build?.version, 64);
      if (!identifier || !version) throw new Error("The API build response is invalid");
      setRuntime({ status: "available", identifier, version });
    }).catch((caught: unknown) => {
      if ((caught as { name?: string })?.name !== "AbortError") setRuntime({ status: "unavailable" });
    });
    return () => controller.abort();
  }, []);

  const apiBuild = runtime.status === "checking"
    ? "CHECKING…"
    : runtime.status === "unavailable"
      ? "UNAVAILABLE"
      : runtime.identifier;
  const deploymentState = runtime.status === "available"
    ? runtime.version === currentRelease.version ? "IN SYNC" : "VERSION MISMATCH"
    : runtime.status === "checking" ? "CHECKING" : "STATUS UNKNOWN";

  return (
    <section className="about-builds" aria-labelledby="about-builds-title">
      <div className="about-section-heading">
        <h2 id="about-builds-title">Running now</h2>
        <span className={deploymentState === "VERSION MISMATCH" ? "is-warning" : ""}>{deploymentState}</span>
      </div>
      <dl className="about-build-grid" aria-live="polite">
        <div>
          <dt>WEB RELEASE</dt>
          <dd>v{currentRelease.version}</dd>
        </div>
        <div>
          <dt>API BUILD</dt>
          <dd>{apiBuild}</dd>
        </div>
      </dl>
    </section>
  );
}
