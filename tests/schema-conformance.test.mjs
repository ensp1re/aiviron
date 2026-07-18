import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "schemas", "v1alpha1");

const schemaFiles = [
  "common.schema.json",
  "runtime-event.schema.json",
  "context-manifest.schema.json",
  "memory-record.schema.json",
  "action.schema.json",
  "plugin-manifest.schema.json",
  "handoff-capsule.schema.json"
];

const cases = [
  ["runtime-event.schema.json", "runtime-event/valid.json", true],
  ["runtime-event.schema.json", "runtime-event/invalid-missing-actor.json", false],
  ["context-manifest.schema.json", "context-manifest/valid.json", true],
  ["context-manifest.schema.json", "context-manifest/invalid-untrusted-instruction.json", false],
  ["memory-record.schema.json", "memory-record/valid.json", true],
  ["memory-record.schema.json", "memory-record/invalid-accepted-without-actor.json", false],
  ["action.schema.json", "action/valid-protected-receipt.json", true],
  ["action.schema.json", "action/invalid-protected-without-grant.json", false],
  ["plugin-manifest.schema.json", "plugin-manifest/valid.json", true],
  ["plugin-manifest.schema.json", "plugin-manifest/invalid-path-traversal.json", false],
  ["handoff-capsule.schema.json", "handoff-capsule/valid.json", true],
  ["handoff-capsule.schema.json", "handoff-capsule/invalid-embedded-secret.json", false]
];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function buildValidator() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true
  });
  addFormats(ajv);

  const schemas = new Map();
  for (const file of schemaFiles) {
    const schema = await readJson(join(schemaDir, file));
    schemas.set(file, schema);
    ajv.addSchema(schema);
  }

  return { ajv, schemas };
}

const setup = await buildValidator();

test("all v1alpha1 schemas compile in strict JSON Schema 2020-12 mode", () => {
  for (const schema of setup.schemas.values()) {
    assert.doesNotThrow(() => setup.ajv.getSchema(schema.$id));
    assert.equal(typeof setup.ajv.getSchema(schema.$id), "function");
  }
});

for (const [schemaFile, fixtureFile, expected] of cases) {
  test(`${fixtureFile} is ${expected ? "valid" : "rejected"}`, async () => {
    const schema = setup.schemas.get(schemaFile);
    const validate = setup.ajv.getSchema(schema.$id);
    const data = await readJson(join(root, "tests", "fixtures", fixtureFile));
    const actual = validate(data);

    assert.equal(
      actual,
      expected,
      `${fixtureFile}: ${setup.ajv.errorsText(validate.errors, { separator: "\n" })}`
    );
  });
}

test("valid context manifest stays inside its declared usable token budget", async () => {
  const manifest = await readJson(join(root, "tests", "fixtures", "context-manifest", "valid.json"));
  const usable = manifest.budget.maxTokens - manifest.budget.reserveOutput - manifest.budget.reserveTools;
  assert.ok(manifest.budget.usedTokens <= usable);

  const includedTokens = manifest.items
    .filter((item) => item.status === "included" || item.status === "transformed")
    .reduce((sum, item) => sum + item.tokenEstimate, 0);
  assert.ok(includedTokens <= manifest.budget.usedTokens);
});

test("valid capsule references every mandatory artifact with the same digest", async () => {
  const capsule = await readJson(join(root, "tests", "fixtures", "handoff-capsule", "valid.json"));
  const artifactByName = new Map(capsule.artifacts.map((artifact) => [artifact.name, artifact.ref]));
  const mandatory = {
    objective: "objective",
    state: "state",
    evidence: "evidence",
    decisions: "decisions",
    failures: "failures",
    contextManifest: "context-manifest",
    nextActions: "next-actions",
    permissions: "permissions",
    environment: "environment"
  };

  for (const [field, name] of Object.entries(mandatory)) {
    assert.equal(artifactByName.get(name)?.digest, capsule[field].digest, `${field} digest mismatch`);
  }
});

test("valid capsule manifest contains references rather than secret-shaped values", async () => {
  const capsule = await readJson(join(root, "tests", "fixtures", "handoff-capsule", "valid.json"));
  const forbiddenKey = /(api[-_]?key|access[-_]?token|refresh[-_]?token|password|private[-_]?key|secret)/i;
  const forbiddenValue = /(?:sk-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

  function inspect(value, path = "$") {
    if (typeof value === "string") {
      assert.doesNotMatch(value, forbiddenValue, `secret-shaped value at ${path}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        assert.doesNotMatch(key, forbiddenKey, `secret-shaped key at ${path}.${key}`);
        inspect(child, `${path}.${key}`);
      }
    }
  }

  inspect(capsule);
});

test("protected successful action receipt is linked to preview, grant, and policy", async () => {
  const receipt = await readJson(join(root, "tests", "fixtures", "action", "valid-protected-receipt.json"));
  assert.match(receipt.risk, /^R[34]$/);
  assert.ok(receipt.previewId);
  assert.ok(receipt.grantId);
  assert.ok(receipt.policyDecisionId);
  assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
});
