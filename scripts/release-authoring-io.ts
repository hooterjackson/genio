import {
  constants,
  type Stats,
} from "node:fs";
import {
  randomBytes,
  createPrivateKey,
  type KeyObject,
} from "node:crypto";
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  stableSignedArtifactJson,
  type JsonRecord,
} from "../shared/signed-artifact.ts";

const MAXIMUM_JSON_BYTES = 2 * 1024 * 1024;
const MAXIMUM_KEY_BYTES = 16 * 1024;

function regularFile(
  value: Stats,
  label: string,
  maximumBytes: number,
): void {
  if (
    !value.isFile()
    || value.isSymbolicLink()
    || value.nlink !== 1
    || value.size <= 0
    || value.size > maximumBytes
  ) {
    throw new Error(`${label} must be a bounded, singly linked regular file`);
  }
}

function unchangedFile(
  before: Stats,
  after: Stats,
  label: string,
): void {
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`${label} changed while it was being read`);
  }
}

async function canonicalParentPath(
  path: string,
  label: string,
): Promise<{ path: string; parent: string; name: string }> {
  const absolute = resolve(path);
  const name = basename(absolute);
  const parent = await realpath(dirname(absolute)).catch(() => null);
  if (!parent || !name || name === "." || name === "..") {
    throw new Error(`${label} has no existing canonical parent directory`);
  }
  return {
    path: join(parent, name),
    parent,
    name,
  };
}

async function boundedHandleBytes(
  handle: Awaited<ReturnType<typeof open>>,
  before: Stats,
  label: string,
  maximumBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximumBytes) {
    throw new Error(`${label} exceeds its maximum byte size`);
  }
  const after = await handle.stat();
  unchangedFile(before, after, label);
  if (offset !== before.size) {
    throw new Error(`${label} changed while it was being read`);
  }
  return buffer.subarray(0, offset);
}

export async function readBoundedRegularFile(
  path: string,
  label: string,
  maximumBytes = MAXIMUM_JSON_BYTES,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || maximumBytes > MAXIMUM_JSON_BYTES
  ) {
    throw new Error(`${label} maximum byte size is invalid`);
  }
  const canonical = await canonicalParentPath(path, label);
  const handle = await open(
    canonical.path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) {
    throw new Error(`${label} must be an existing non-symlink file`);
  }
  try {
    const before = await handle.stat();
    regularFile(before, label, maximumBytes);
    return await boundedHandleBytes(handle, before, label, maximumBytes);
  } finally {
    await handle.close();
  }
}

export async function readBoundedJsonFile(
  path: string,
  label: string,
  maximumBytes = MAXIMUM_JSON_BYTES,
): Promise<unknown> {
  const bytes = await readBoundedRegularFile(path, label, maximumBytes);
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new Error(`${label} must contain a JSON object`);
  }
}

function safeRelativePath(value: string, label: string): string {
  if (
    !value
    || value.trim() !== value
    || value.includes("\0")
    || isAbsolute(value)
    || normalize(value) !== value
    || value.split(sep).some((component) => (
      !component || component === "." || component === ".."
    ))
  ) {
    throw new Error(
      `${label} must be a normalized relative path without traversal`,
    );
  }
  return value;
}

/**
 * Resolve a manifest-owned file beneath a canonical manifest directory.
 * Every directory component below that boundary must be a real directory,
 * never a symlink. The final component is still opened with O_NOFOLLOW.
 */
export async function resolveContainedFilePath(
  baseDirectory: string,
  manifestPath: string,
  label: string,
): Promise<string> {
  const relativePath = safeRelativePath(manifestPath, label);
  const canonicalBase = await realpath(resolve(baseDirectory)).catch(
    () => null,
  );
  if (!canonicalBase || !(await lstat(canonicalBase)).isDirectory()) {
    throw new Error(`${label} base directory is unavailable`);
  }
  const lexicalPath = resolve(canonicalBase, relativePath);
  const lexicalParent = dirname(lexicalPath);
  const canonicalParent = await realpath(lexicalParent).catch(() => null);
  const fromBase = relative(canonicalBase, lexicalPath);
  const parentFromBase = canonicalParent
    ? relative(canonicalBase, canonicalParent)
    : "..";
  if (
    !canonicalParent
    || canonicalParent !== lexicalParent
    || fromBase === ""
    || fromBase === ".."
    || fromBase.startsWith(`..${sep}`)
    || isAbsolute(fromBase)
    || parentFromBase === ".."
    || parentFromBase.startsWith(`..${sep}`)
    || isAbsolute(parentFromBase)
  ) {
    throw new Error(
      `${label} must remain beneath the manifest directory without symlinks`,
    );
  }
  return join(canonicalParent, basename(lexicalPath));
}

export async function readContainedBoundedRegularFile(
  baseDirectory: string,
  manifestPath: string,
  label: string,
  maximumBytes = MAXIMUM_JSON_BYTES,
): Promise<Buffer> {
  return readBoundedRegularFile(
    await resolveContainedFilePath(baseDirectory, manifestPath, label),
    label,
    maximumBytes,
  );
}

export async function readContainedBoundedJsonFile(
  baseDirectory: string,
  manifestPath: string,
  label: string,
  maximumBytes = MAXIMUM_JSON_BYTES,
): Promise<unknown> {
  const bytes = await readContainedBoundedRegularFile(
    baseDirectory,
    manifestPath,
    label,
    maximumBytes,
  );
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new Error(`${label} must contain a JSON object`);
  }
}

export function protectedPath(input: {
  cliPath?: string;
  environmentName: string;
  environment?: NodeJS.ProcessEnv;
  label: string;
}): string {
  const environment = input.environment ?? process.env;
  const cliPath = input.cliPath?.trim() ?? "";
  const environmentPath =
    environment[input.environmentName]?.trim() ?? "";
  if (!cliPath && !environmentPath) {
    throw new Error(
      `${input.label} requires its CLI path or `
      + `${input.environmentName}`,
    );
  }
  if (
    cliPath
    && environmentPath
    && resolve(cliPath) !== resolve(environmentPath)
  ) {
    throw new Error(
      `${input.label} received conflicting CLI and `
      + `${input.environmentName} paths`,
    );
  }
  return cliPath || environmentPath;
}

export async function readProtectedEd25519PrivateKey(input: {
  cliPath?: string;
  environmentName: string;
  environment?: NodeJS.ProcessEnv;
  label: string;
}): Promise<KeyObject> {
  const path = protectedPath(input);
  const canonical = await canonicalParentPath(path, input.label);
  const handle = await open(
    canonical.path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) {
    throw new Error(
      `${input.label} must be an existing non-symlink private-key file`,
    );
  }
  try {
    const before = await handle.stat();
    regularFile(before, input.label, MAXIMUM_KEY_BYTES);
    if ((before.mode & 0o777) !== 0o600) {
      throw new Error(`${input.label} must have mode 0600`);
    }
    const bytes = await boundedHandleBytes(
      handle,
      before,
      input.label,
      MAXIMUM_KEY_BYTES,
    );
    let key: KeyObject;
    try {
      key = createPrivateKey(bytes);
    } catch {
      throw new Error(`${input.label} must contain a private Ed25519 key`);
    }
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
      throw new Error(`${input.label} must contain a private Ed25519 key`);
    }
    return key;
  } finally {
    await handle.close();
  }
}

export function requiredProtectedEnvironment(
  name: string,
  pattern: RegExp,
  label: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment[name]?.trim() ?? "";
  if (!pattern.test(value)) {
    throw new Error(`${label} is missing or invalid in ${name}`);
  }
  return value;
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${stableSignedArtifactJson(value)}\n`, "utf8");
}

export async function writeCanonicalJsonCreateOnly(
  path: string,
  value: unknown,
): Promise<void> {
  const bytes = canonicalJsonBytes(value);
  const canonical = await canonicalParentPath(path, "authoring output");
  const temporaryName = `.${canonical.name}.tmp-${
    randomBytes(16).toString("hex")
  }`;
  const temporaryPath = join(canonical.parent, temporaryName);
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | constants.O_NOFOLLOW,
    0o600,
  );
  const created = await handle.stat();
  let published = false;
  let closed = false;
  const cleanupCreatedTemporary = async (): Promise<void> => {
    const current = await lstat(temporaryPath).catch(() => null);
    if (
      current
      && current.dev === created.dev
      && current.ino === created.ino
      && current.isFile()
      && !current.isSymbolicLink()
    ) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  };
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesWritten < 1) {
        throw new Error("authoring output write made no progress");
      }
      offset += bytesWritten;
    }
    await handle.sync();
    const completed = await handle.stat();
    if (
      !completed.isFile()
      || completed.isSymbolicLink()
      || completed.dev !== created.dev
      || completed.ino !== created.ino
      || completed.nlink !== 1
      || completed.size !== bytes.length
      || (completed.mode & 0o777) !== 0o600
    ) {
      throw new Error("authoring output temporary file changed while writing");
    }
    await link(temporaryPath, canonical.path);
    published = true;
    await handle.close();
    closed = true;
    await cleanupCreatedTemporary();
    const directory = await open(
      canonical.parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!closed) {
      await handle.close().catch(() => undefined);
      closed = true;
    }
    await cleanupCreatedTemporary();
    if (published) {
      throw new Error(
        "authoring output was published but final directory sync failed",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
  }
}

export function jsonRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

export function parseCreateOnlyCliOptions(
  args: readonly string[],
  input: {
    required: readonly string[];
    optional?: readonly string[];
    flags?: readonly string[];
  },
): Record<string, string> {
  const required = new Set(input.required);
  const optional = new Set(input.optional ?? []);
  const flags = new Set(input.flags ?? []);
  const allowed = new Set([...required, ...optional, ...flags]);
  const seen = new Set<string>();
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!allowed.has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (seen.has(argument)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    seen.add(argument);
    if (flags.has(argument)) {
      parsed[argument] = "true";
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    parsed[argument] = value;
    index += 1;
  }
  for (const name of required) {
    if (!seen.has(name)) {
      throw new Error(`${name} must be supplied exactly once`);
    }
  }
  return parsed;
}
