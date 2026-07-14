/**
 * Read a fetch response without ever buffering more than the configured byte
 * ceiling. Content-Length is only an early rejection hint; the streamed count
 * remains authoritative because servers can omit or misstate that header.
 */
export async function boundedResponseText(
  response: Response,
  maximumBytes: number,
  failureMessage: string,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(failureMessage);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(failureMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString("utf8");
}
