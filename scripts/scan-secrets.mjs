import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MAX_SCANNED_BYTES = 5 * 1024 * 1024;

const fixedFormatRules = [
  {
    id: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  {
    id: "openai-api-key",
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    id: "stripe-live-key",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
  },
];

const secretAssignment =
  /\b(?:api[_-]?key|client[_-]?secret|secret|token|password|private[_-]?key)\b\s*(?:=|:)\s*["']?([A-Za-z0-9+/_=.-]{16,})/gi;

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isRepeatedFixtureValue(value) {
  for (let period = 1; period <= Math.min(16, Math.floor(value.length / 2)); period += 1) {
    const unit = value.slice(0, period);
    if (unit.repeat(Math.ceil(value.length / period)).slice(0, value.length) === value) {
      return true;
    }
  }
  return false;
}

function isExplicitPlaceholder(value) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("example")
    || normalized.includes("placeholder")
    || normalized.includes("changeme")
    || normalized.includes("replace-me")
    || normalized.includes("replace_me")
    || normalized.includes("redacted")
    || normalized.includes("dummy")
    || normalized.includes("not-a-secret")
    || normalized.startsWith("sk-test-")
    || normalized.includes("supersecret")
    || normalized.includes("must-never")
    || normalized.includes("never-return")
    || normalized.includes("first-secret")
    || normalized.includes("different-secret")
    || normalized.includes("secret-looking")
    || normalized.includes("integration-")
    || normalized.includes("unit-")
    || normalized.includes("release-canary-")
    || normalized.includes("rotation-")
    || normalized.includes("private-owner-user-token")
    || normalized.includes("abcdefghijklmnop")
    || normalized.includes("1234567890")
    || normalized.includes("test-secret")
    || normalized.startsWith("process.env")
    || normalized.startsWith("environment.")
    || normalized.startsWith("buffer.")
    || normalized.startsWith("${")
    || isRepeatedFixtureValue(value)
  );
}

function lineAt(text, offset) {
  const start = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const end = text.indexOf("\n", offset);
  return text.slice(start, end === -1 ? text.length : end);
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

export function scanSecretText(text) {
  const findings = [];
  for (const rule of fixedFormatRules) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const offset = match.index ?? 0;
      const fixtureContext = text.slice(offset, offset + 256);
      if (
        lineAt(text, offset).includes("secret-scan: allow-fixture")
        || isExplicitPlaceholder(match[0])
        || (rule.id === "private-key" && fixtureContext.includes("secret-key-material"))
      ) {
        continue;
      }
      findings.push({
        rule: rule.id,
        line: lineNumberAt(text, offset),
      });
    }
  }

  secretAssignment.lastIndex = 0;
  for (const match of text.matchAll(secretAssignment)) {
    const value = match[1] ?? "";
    if (
      value.length < 24
      || lineAt(text, match.index ?? 0).includes("secret-scan: allow-fixture")
      || isExplicitPlaceholder(value)
      || shannonEntropy(value) < 3.5
    ) {
      continue;
    }
    findings.push({
      rule: "high-entropy-secret-assignment",
      line: lineNumberAt(text, match.index ?? 0),
    });
  }
  return findings;
}

export function scanSecretBuffer(buffer) {
  if (buffer.length > MAX_SCANNED_BYTES || buffer.includes(0)) {
    return [];
  }
  return scanSecretText(buffer.toString("utf8"));
}

function trackedFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    },
  );
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

export function scanTrackedFiles(files = trackedFiles()) {
  const findings = [];
  for (const file of files) {
    const fileFindings = scanSecretBuffer(readFileSync(file));
    for (const finding of fileFindings) {
      findings.push({ file, ...finding });
    }
  }
  return findings;
}

function main() {
  const findings = scanTrackedFiles();
  if (findings.length === 0) {
    process.stdout.write("Secret scan passed.\n");
    return;
  }
  for (const finding of findings) {
    process.stderr.write(`${finding.file}:${finding.line} ${finding.rule}\n`);
  }
  process.stderr.write(`Secret scan failed with ${findings.length} finding(s).\n`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
