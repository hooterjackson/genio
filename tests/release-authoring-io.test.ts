import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  canonicalJsonBytes,
  parseCreateOnlyCliOptions,
  protectedPath,
  readBoundedRegularFile,
  readContainedBoundedJsonFile,
  readProtectedEd25519PrivateKey,
  writeCanonicalJsonCreateOnly,
} from "../scripts/release-authoring-io.ts";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "genio-release-authoring-"));
  directories.push(value);
  return value;
}

describe("release authoring I/O", () => {
  test("uses locale-independent code-unit ordering for canonical JSON", () => {
    expect(canonicalJsonBytes({
      "\u00e4": 3,
      z: 2,
      a: 1,
    }).toString("utf8")).toBe(
      '{"a":1,"z":2,"\u00e4":3}\n',
    );
  });

  test("loads only a singly linked 0600 Ed25519 private-key file", async () => {
    const base = await directory();
    const keyPath = join(base, "release-signing-key.pem");
    const keys = generateKeyPairSync("ed25519");
    await writeFile(
      keyPath,
      keys.privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );

    const key = await readProtectedEd25519PrivateKey({
      cliPath: keyPath,
      environmentName: "UNUSED_TEST_KEY_FILE",
      environment: {},
      label: "release signing key",
    });
    expect(key.type).toBe("private");
    expect(key.asymmetricKeyType).toBe("ed25519");

    await chmod(keyPath, 0o640);
    await expect(readProtectedEd25519PrivateKey({
      cliPath: keyPath,
      environmentName: "UNUSED_TEST_KEY_FILE",
      environment: {},
      label: "release signing key",
    })).rejects.toThrow(/mode 0600/u);
  });

  test("rejects symlinked private keys and ambiguous path sources", async () => {
    const base = await directory();
    const keyPath = join(base, "key.pem");
    const linkPath = join(base, "key-link.pem");
    const keys = generateKeyPairSync("ed25519");
    await writeFile(
      keyPath,
      keys.privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    await symlink(keyPath, linkPath);

    await expect(readProtectedEd25519PrivateKey({
      cliPath: linkPath,
      environmentName: "UNUSED_TEST_KEY_FILE",
      environment: {},
      label: "release signing key",
    })).rejects.toThrow(/non-symlink/u);
    expect(() => protectedPath({
      cliPath: keyPath,
      environmentName: "RELEASE_SIGNING_KEY_FILE",
      environment: { RELEASE_SIGNING_KEY_FILE: `${keyPath}.different` },
      label: "release signing key",
    })).toThrow(/conflicting/u);
  });

  test("writes sorted canonical JSON once with mode 0600", async () => {
    const base = await directory();
    const output = join(base, "artifact.json");
    const value = { z: 1, a: { d: 2, b: 3 } };
    await writeCanonicalJsonCreateOnly(output, value);
    expect(await readFile(output)).toEqual(canonicalJsonBytes(value));
    await expect(
      writeCanonicalJsonCreateOnly(output, value),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(output)).toEqual(canonicalJsonBytes(value));
    expect((await readdir(base)).filter((name) => name.includes(".tmp-")))
      .toEqual([]);
    const { stat } = await import("node:fs/promises");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  test("caps reads and rejects symlinked manifest path components", async () => {
    const base = await directory();
    const oversized = join(base, "oversized.bin");
    await writeFile(oversized, Buffer.alloc(33, 1));
    await expect(readBoundedRegularFile(
      oversized,
      "bounded input",
      32,
    )).rejects.toThrow(/bounded, singly linked regular file/u);

    const outside = await directory();
    await writeFile(join(outside, "artifact.json"), '{"ok":true}\n');
    await symlink(outside, join(base, "linked"));
    await expect(readContainedBoundedJsonFile(
      base,
      "linked/artifact.json",
      "manifest artifact",
    )).rejects.toThrow(/without symlinks/u);
    await expect(readContainedBoundedJsonFile(
      base,
      "../artifact.json",
      "manifest artifact",
    )).rejects.toThrow(/without traversal/u);
  });

  test("parses exact create-only options and rejects extras or duplicates", () => {
    expect(parseCreateOnlyCliOptions(
      ["--input", "source.json", "--output", "result.json", "--confirm"],
      {
        required: ["--input", "--output"],
        flags: ["--confirm"],
      },
    )).toEqual({
      "--input": "source.json",
      "--output": "result.json",
      "--confirm": "true",
    });
    expect(() => parseCreateOnlyCliOptions(
      ["--input", "one", "--input", "two", "--output", "result"],
      { required: ["--input", "--output"] },
    )).toThrow(/Duplicate/u);
    expect(() => parseCreateOnlyCliOptions(
      ["--input", "one", "--output", "result", "--unknown", "value"],
      { required: ["--input", "--output"] },
    )).toThrow(/Unknown/u);
  });
});
