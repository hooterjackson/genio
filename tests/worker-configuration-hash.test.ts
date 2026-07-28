import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { DATABASE_SCHEMA_SUPPORT } from "../db/index.ts";
import {
  WORKER_CONFIGURATION_ENV_KEYS,
  workerConfigurationHash,
  workerExecutorRevision,
} from "../server/worker-runner.ts";
import { WORKER_PIPELINE_CAPABILITY } from "../server/worker-protocol.ts";
import {
  API_RELEASE_CONFIGURATION_ENV_KEYS,
  SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1,
  SEMANTIC_EXECUTION_CONFIGURATION_REVIEWED_EXCLUSIONS_V1,
  SERVER_DYNAMIC_ENVIRONMENT_READ_SOURCES_V1,
  SERVER_ENVIRONMENT_READ_REVIEWED_EXCLUSIONS_V1,
} from "../server/runtime-release.ts";

interface EnvironmentReadCensus {
  staticReads: Set<string>;
  dynamicSites: Map<string, number>;
}

function environmentReadCensus(
  sources: readonly { file: string; source: string }[],
): EnvironmentReadCensus {
  const staticReads = new Set<string>();
  const dynamicSites = new Map<string, number>();
  const environmentBase = (node: ts.Expression): string | null => {
    if (ts.isIdentifier(node)
      && (node.text === "environment" || node.text === "env")) {
      return node.text;
    }
    if (ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "process"
      && node.name.text === "env") {
      return "process.env";
    }
    return null;
  };
  for (const { file, source } of sources) {
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const base = environmentBase(node.expression);
        if (base && /^[A-Z][A-Z0-9_]*$/u.test(node.name.text)) {
          staticReads.add(node.name.text);
        }
      }
      if (ts.isElementAccessExpression(node)) {
        const base = environmentBase(node.expression);
        if (base) {
          const argument = node.argumentExpression;
          if (
            argument
            && (ts.isStringLiteral(argument)
              || ts.isNoSubstitutionTemplateLiteral(argument))
            && /^[A-Z][A-Z0-9_]*$/u.test(argument.text)
          ) {
            staticReads.add(argument.text);
          } else if (argument) {
            const keyExpression = argument.getText(sourceFile)
              .trim().replace(/\s+/gu, " ");
            const site = `${file}:${base}[${keyExpression}]`;
            dynamicSites.set(site, (dynamicSites.get(site) ?? 0) + 1);
          }
        }
      }
      if (ts.isVariableDeclaration(node)
        && node.initializer
        && environmentBase(node.initializer)
        && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (element.dotDotDotToken) continue;
          const keyNode = element.propertyName ?? element.name;
          const key = ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode)
            ? keyNode.text
            : "";
          if (/^[A-Z][A-Z0-9_]*$/u.test(key)) staticReads.add(key);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { staticReads, dynamicSites };
}

function configurationHash(
  environment: NodeJS.ProcessEnv,
  queueClass: "interactive" | "deep" = "interactive",
): string {
  return workerConfigurationHash({
    environment,
    queueClass,
    concurrency: queueClass === "deep" ? 1 : 2,
    leaseMs: 300_000,
    renewMs: 60_000,
    heartbeatMs: 30_000,
    pollMs: 1_000,
    controlIntervalMs: 5_000,
    pipelineCapability: WORKER_PIPELINE_CAPABILITY,
    schemaSupport: DATABASE_SCHEMA_SUPPORT,
  });
}

describe("worker release configuration evidence", () => {
  test("classifies every API and worker configuration key exactly once", () => {
    const inventory = new Set([
      ...API_RELEASE_CONFIGURATION_ENV_KEYS,
      ...WORKER_CONFIGURATION_ENV_KEYS,
    ]);
    const categories = [
      new Set<string>(SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1),
      ...Object.values(
        SEMANTIC_EXECUTION_CONFIGURATION_REVIEWED_EXCLUSIONS_V1,
      ).map((values) => new Set<string>(values)),
    ];
    for (const key of inventory) {
      expect(
        categories.filter((category) => category.has(key)),
        `${key} must have exactly one reviewed semantic classification`,
      ).toHaveLength(1);
    }
    expect(
      SEMANTIC_EXECUTION_CONFIGURATION_REVIEWED_EXCLUSIONS_V1
        .rolloutLineage,
    ).toEqual(expect.arrayContaining([
      "RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH",
      "RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH",
    ]));
  });

  test("classifies every static server environment read exactly once", () => {
    const serverDirectory = new URL("../server/", import.meta.url);
    const files = readdirSync(serverDirectory, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".ts"));
    const census = environmentReadCensus(files.map((file) => ({
      file,
      source: readFileSync(join(serverDirectory.pathname, file), "utf8"),
    })));
    const reads = census.staticReads;
    const reviewedReads = new Set([
      ...reads,
      ...SERVER_DYNAMIC_ENVIRONMENT_READ_SOURCES_V1.flatMap(
        (source) => [...source.keys],
      ),
    ]);
    const categories = [
      new Set<string>(SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1),
      ...Object.values(
        SEMANTIC_EXECUTION_CONFIGURATION_REVIEWED_EXCLUSIONS_V1,
      ).map((values) => new Set<string>(values)),
      ...Object.values(
        SERVER_ENVIRONMENT_READ_REVIEWED_EXCLUSIONS_V1,
      ).map((values) => new Set<string>(values)),
    ];
    for (const key of reads) {
      expect(
        categories.filter((category) => category.has(key)),
        `${key} must have exactly one reviewed server environment classification`,
      ).toHaveLength(1);
    }
    for (const values of Object.values(
      SERVER_ENVIRONMENT_READ_REVIEWED_EXCLUSIONS_V1,
    )) {
      for (const key of values) {
        expect(
          reviewedReads.has(key),
          `${key} is a stale environment-read exclusion`,
        ).toBe(true);
      }
    }
    const expectedDynamicSites = new Map(
      SERVER_DYNAMIC_ENVIRONMENT_READ_SOURCES_V1.map((source) => [
        source.site,
        source.occurrences,
      ]),
    );
    expect(
      [...census.dynamicSites.entries()].sort(),
      "every dynamic environment read must originate from an exact reviewed source site",
    ).toEqual([...expectedDynamicSites.entries()].sort());
    for (const source of SERVER_DYNAMIC_ENVIRONMENT_READ_SOURCES_V1) {
      for (const key of source.keys) {
        expect(
          categories.filter((category) => category.has(key)),
          `${source.site} key ${key} must have exactly one reviewed classification`,
        ).toHaveLength(1);
      }
    }
  });

  test("censuses bracket, destructured, and dynamic environment reads", () => {
    const census = environmentReadCensus([{
      file: "fixture.ts",
      source: `
        const bracket = process.env["BRACKET_KEY"];
        const optional = environment?.['OPTIONAL_KEY'];
        const { DESTRUCTURED_KEY, RENAMED_KEY: local } = env;
        const dynamic = process.env[name];
      `,
    }]);
    expect([...census.staticReads].sort()).toEqual([
      "BRACKET_KEY",
      "DESTRUCTURED_KEY",
      "OPTIONAL_KEY",
      "RENAMED_KEY",
    ]);
    expect([...census.dynamicSites.entries()]).toEqual([
      ["fixture.ts:process.env[name]", 1],
    ]);
  });

  test("uses the immutable image source revision when Railway has no repository SHA", () => {
    expect(workerExecutorRevision({
      SOURCE_COMMIT_SHA: "a".repeat(40),
      APP_VERSION: "2.4.0",
    })).toBe("a".repeat(40));
    expect(workerExecutorRevision({
      RAILWAY_GIT_COMMIT_SHA: "b".repeat(40),
      SOURCE_COMMIT_SHA: "a".repeat(40),
      APP_VERSION: "2.4.0",
    })).toBe("a".repeat(40));
  });

  test("is deterministic, secret-insensitive, and behavior-sensitive", () => {
    const environment = {
      NODE_ENV: "production",
      PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
      PIPELINE_V3_MAX_ROUNDS: "4",
      OPENAI_API_KEY: "sk-proj-first-secret",
      APPLE_TOKEN_ENCRYPTION_KEY: "first-apple-secret",
    };
    const first = configurationHash(environment);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(configurationHash({
      ...environment,
      OPENAI_API_KEY: "sk-proj-different-secret",
      APPLE_TOKEN_ENCRYPTION_KEY: "different-apple-secret",
    })).toBe(first);
    expect(configurationHash({
      ...environment,
      PIPELINE_V3_MAX_ROUNDS: "5",
    })).not.toBe(first);
    for (const [key, value] of [
      ["RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION", "2"],
      ["RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION", "1"],
      ["RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION", "1"],
      ["PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION", "5"],
      ["OPENAI_TIMEOUT_MS", "45000"],
      ["GUIDANCE_SCOUT_TIMEOUT_MS", "15000"],
      ["APPLE_SHARE_URL_TIMEOUT_SECONDS", "420"],
      ["APPLE_WRITE_TOKEN_CAPACITY", "9"],
      ["APPLE_WRITE_TOKEN_REFILL_PER_SECOND", "2"],
      ["APPLE_WRITE_LOCK_WAIT_MS", "12000"],
      ["APPLE_TOKEN_ENCRYPTION_KEY_ID", "apple-token-v2"],
    ] as const) {
      expect(configurationHash({
        ...environment,
        [key]: value,
      })).not.toBe(first);
    }
    expect(configurationHash(environment, "deep")).not.toBe(first);
  });
});
