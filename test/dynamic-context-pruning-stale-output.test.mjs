import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerHooks } from "node:module";

// Only the host's configuration-directory lookup is replaced by a synthetic SDK.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return {
        url: "data:text/javascript,export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const dcp = await import("../extensions/dynamic-context-pruning/index.ts");

const fixture = mkdtempSync(
  join(process.env.TASK198_FIXTURE_ROOT || "/home/kris/.pi/agent/var", "task-198-dcp-"),
);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = fixture;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(fixture, { recursive: true, force: true });
});
function messagesFor(
  toolName = "bash",
  content = [{ type: "text", text: "large synthetic output\n".repeat(500) }],
) {
  const messages = [
    { role: "user", content: "request" },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "old",
          name: toolName,
          arguments:
            toolName === "read" ? { path: "/synthetic/old.txt" } : { command: "synthetic-command" },
        },
      ],
    },
    { role: "toolResult", toolCallId: "old", toolName, content, isError: false },
  ];
  for (let i = 0; i < 50; i++)
    messages.push({ role: "assistant", content: [{ type: "text", text: `later ${i}` }] });
  return messages;
}
function configFor() {
  const config = dcp.defaultConfig();
  config.gate.mode = "off";
  return config;
}
function run(messages, config = configFor(), extra = {}) {
  return dcp.runDynamicContextPruningPipeline({
    messages,
    config,
    persistedDecisions: [],
    knownIdempotencyKeys: new Set(),
    cacheCold: true,
    ...extra,
  });
}
function entry(type, message) {
  return {
    type,
    id: type,
    parentId: null,
    timestamp: "[REDACTED:credential]",
    ...(message ? { message } : {}),
  };
}

test("TASK-198 cache cold is restart-safe only until the first post-compaction assistant", () => {
  const compacted = [
    entry("message", { role: "assistant", content: [] }),
    entry("compaction"),
    entry("custom"),
  ];
  assert.equal(dcp.isCacheColdBranch(compacted), true);
  assert.equal(
    dcp.isCacheColdBranch([...compacted, entry("message", { role: "user", content: "continue" })]),
    true,
  );
  assert.equal(
    dcp.isCacheColdBranch([...compacted, entry("message", { role: "assistant", content: [] })]),
    false,
  );
  assert.equal(dcp.isCacheColdBranch([entry("branch_summary")]), false);
  assert.equal(dcp.isCacheColdBranch([]), false);
});

test("TASK-198 only cache-cold large text bash/read outputs are replaced, preserving every pair and input", () => {
  for (const toolName of ["bash", "read"]) {
    const messages = messagesFor(toolName);
    const before = structuredClone(messages);
    assert.equal(run(messages, configFor(), { cacheCold: false }).newlyAppliedDecisions.length, 0);
    const result = run(messages);
    assert.equal(result.newlyAppliedDecisions.length, 1);
    assert.equal(result.newlyAppliedDecisions[0].strategyId, "stale-output");
    assert.ok(result.messages[2].content[0].text.startsWith("[pruned by dynamic-context-pruning:"));
    assert.deepEqual(
      result.messages.map((m) => [m.role, m.toolCallId]),
      messages.map((m) => [m.role, m.toolCallId]),
    );
    assert.deepEqual(result.messages[1], messages[1]);
    assert.deepEqual(messages, before);
  }
});

test("TASK-198 stale output respects short/image/tool/path/recency protections and disabled configuration", () => {
  const image = [
    { type: "text", text: "x".repeat(5000) },
    { type: "image", data: "synthetic", mimeType: "image/png" },
  ];
  for (const messages of [
    messagesFor("bash", [{ type: "text", text: "short" }]),
    messagesFor("bash", image),
    messagesFor("skill"),
    messagesFor("write"),
  ]) {
    assert.equal(run(messages).newlyAppliedDecisions.length, 0);
  }
  const sensitive = messagesFor("read");
  sensitive[1].content[0].arguments.path = "/synthetic/.env";
  assert.equal(run(sensitive).newlyAppliedDecisions.length, 0);
  const recent = messagesFor().slice(0, 3);
  assert.equal(run(recent).newlyAppliedDecisions.length, 0);
  const disabled = configFor();
  disabled.enabled = false;
  const messages = messagesFor();
  assert.equal(run(messages, disabled).messages, messages);
  const strategyOff = configFor();
  strategyOff.strategies.staleOutput.enabled = false;
  assert.equal(run(messages, strategyOff).newlyAppliedDecisions.length, 0);
});

test("TASK-198 persisted cold decisions replay warm and restore tombstones still win", () => {
  const messages = messagesFor();
  const first = run(messages);
  assert.equal(first.newlyAppliedDecisions.length, 1);
  const decision = first.newlyAppliedDecisions[0];
  const replay = run(messages, configFor(), {
    cacheCold: false,
    persistedDecisions: [decision],
    knownIdempotencyKeys: new Set([decision.idempotencyKey]),
  });
  assert.deepEqual(replay.messages, first.messages);
  assert.deepEqual(replay.newlyAppliedDecisions, []);
  const restored = run(messages, configFor(), {
    restoredIdempotencyKeys: new Set([decision.idempotencyKey]),
  });
  assert.deepEqual(restored.messages, messages);
  assert.deepEqual(restored.newlyAppliedDecisions, []);
  const manual = dcp.proposalToDecisionRecord(dcp.buildManualPruneProposal("old"));
  const manualResult = run(messages, configFor(), {
    cacheCold: false,
    persistedDecisions: [manual],
    knownIdempotencyKeys: new Set([manual.idempotencyKey]),
  });
  assert.notDeepEqual(manualResult.messages[2].content, messages[2].content);
});

test("TASK-198 cache cold never bypasses the existing net-benefit gate", () => {
  const messages = messagesFor();
  messages.push({ role: "assistant", content: [{ type: "text", text: "tail".repeat(100000) }] });
  const config = configFor();
  config.gate.mode = "on";
  config.gate.breakEvenThresholdByState.idle = 0;
  const result = run(messages, config);
  assert.equal(result.newlyAppliedDecisions.length, 0);
  assert.ok(result.gate.rejected.length > 0);
  assert.deepEqual(result.messages, messages);
});

test("TASK-198 actual context handler reads cold state from the branch and preserves warm replay on restart", async () => {
  mkdirSync(join(fixture, "extensions"), { recursive: true });
  writeFileSync(
    join(fixture, "extensions", "dynamic-context-pruning.json"),
    JSON.stringify(configFor()),
  );
  const handlers = new Map();
  const persisted = [];
  dcp.default({
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    appendEntry(type, data) {
      persisted.push({ ...entry("custom"), customType: type, data });
    },
  });
  let branch = [entry("compaction")];
  const ctx = { sessionManager: { getBranch: () => branch, getCwd: () => "/synthetic/repo" } };
  await handlers.get("session_start")({}, ctx);
  const messages = messagesFor();
  const cold = await handlers.get("context")({ messages }, ctx);
  assert.notDeepEqual(cold.messages[2].content, messages[2].content);
  assert.ok(persisted.some((e) => e.customType === "dynamic-context-pruning:decision"));
  branch = [...branch, ...persisted, entry("message", { role: "assistant", content: [] })];
  await handlers.get("session_start")({}, ctx);
  assert.deepEqual((await handlers.get("context")({ messages }, ctx)).messages, cold.messages);
});
