import { optionalSecret, requireOneSecret, requireSecret } from "./secrets.ts";

export interface NotificationRecord {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  sentAt: string | null;
}

export interface NotificationRepository {
  getNotification(id: string): Promise<NotificationRecord | null>;
  markNotificationSent(id: string, providerId: string): Promise<void>;
  markNotificationFailed(id: string, message: string, retryAt: Date | null): Promise<void>;
}

function renderNotification(record: NotificationRecord): { subject: string; text: string } {
  const manifestId = typeof record.payload.manifestId === "string" ? record.payload.manifestId : "unknown";
  const runId = typeof record.payload.runId === "string" ? record.payload.runId : "unknown";
  if (record.kind === "apple_reauthorization_required") {
    return {
      subject: "gênio needs Apple Music reauthorization",
      text: `Publication paused safely. Reauthorize the owner Apple Music account in gênio to resume manifest ${manifestId}. Run: ${runId}.`,
    };
  }
  if (record.kind === "publication_complete") {
    const partial = record.payload.status === "partial";
    return {
      subject: partial ? "gênio publication complete with documented gaps" : "gênio publication complete",
      text: partial
        ? `Manifest ${manifestId} was published in ${Number(record.payload.volumeCount ?? 1)} volume(s), with ${Number(record.payload.omittedCandidateCount ?? 0)} non-duplicate candidate omission(s) and ${Number(record.payload.unresolvedCoverageCount ?? 0)} unresolved coverage item(s). Run: ${runId}.`
        : `Manifest ${manifestId} was published successfully in ${Number(record.payload.volumeCount ?? 1)} volume(s). Run: ${runId}.`,
    };
  }
  if (record.kind === "publication_orphaned") {
    return {
      subject: "gênio orphaned a divergent Apple playlist",
      text: `gênio stopped using Apple playlist ${String(record.payload.applePlaylistId ?? "unknown")} because its order diverged from manifest ${manifestId}. Run: ${runId}. Open the owner dashboard for cleanup instructions.`,
    };
  }
  if (record.kind === "worker_stale" || record.kind === "budget_threshold") {
    return {
      subject: `gênio alert: ${record.kind.replaceAll("_", " ")}`,
      text: `gênio recorded ${record.kind}. Open the owner dashboard for current state.`,
    };
  }
  return { subject: "gênio operator alert", text: `gênio recorded ${record.kind}. Open the owner dashboard for details.` };
}

export async function deliverNotification(record: NotificationRecord, signal?: AbortSignal): Promise<string> {
  const apiKey = requireSecret("RESEND_API_KEY");
  const from = requireSecret("RESEND_FROM");
  const to = requireOneSecret(["OWNER_ALERT_EMAIL", "ALERT_EMAIL"]).value;
  const rendered = renderNotification(record);
  signal?.throwIfAborted();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `needle-notification-${record.id}`,
    },
    body: JSON.stringify({ from, to: [to], subject: rendered.subject, text: rendered.text }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const text = (await response.text()).slice(0, 64 * 1024);
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* preserve status-based error */ }
  if (response.ok && payload.id) return String(payload.id);
  throw new Error(payload.message ?? `Resend failed (${response.status})`);
}

export async function processNotificationJob(repository: NotificationRepository, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const notificationId = typeof payload.notificationId === "string" ? payload.notificationId : "";
  if (!notificationId) throw new Error("Notification job payload is invalid");
  const record = await repository.getNotification(notificationId);
  if (!record || record.sentAt) return;
  if (!optionalSecret("RESEND_API_KEY")) {
    await repository.markNotificationFailed(record.id, "Resend is not configured", null);
    return;
  }
  try {
    const providerId = await deliverNotification(record, signal);
    signal?.throwIfAborted();
    await repository.markNotificationSent(record.id, providerId);
  } catch (error) {
    const attempts = record.attempts + 1;
    const retryAt = attempts < 3 ? new Date(Date.now() + Math.min(60_000 * 2 ** attempts, 15 * 60_000)) : null;
    await repository.markNotificationFailed(record.id, error instanceof Error ? error.message.slice(0, 500) : "Notification failed", retryAt);
    if (retryAt) throw error;
  }
}
