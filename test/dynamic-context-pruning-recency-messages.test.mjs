import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// The host SDK is an external boundary; pruning itself is the real module.
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

function repeatedReadChain() {
  const messages = [{ role: "user", content: "one long worker request" }];
  for (let i = 0; i < 149; i++) {
    messages.push({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: `call-${i}`,
          name: "read",
          arguments: { path: "/synthetic/source.ts" },
        },
      ],
    });
    messages.push({
      role: "toolResult",
      toolCallId: `call-${i}`,
      toolName: "read",
      content: [{ type: "text", text: "synthetic source\n".repeat(400) }],
      isError: false,
    });
  }
  messages.push({ role: "assistant", content: [{ type: "text", text: "continuing" }] });
  return messages;
}
function run(messages, config) {
  return dcp.runDynamicContextPruningPipeline({
    messages,
    config,
    persistedDecisions: [],
    knownIdempotencyKeys: new Set(),
  });
}

test("TASK-198 one-user 300-message loop exposes old pairs while keeping its recent tail", () => {
  const messages = repeatedReadChain();
  assert.equal(messages.length, 300);
  const config = dcp.defaultConfig();
  config.gate.mode = "off";
  assert.equal(config.protections.recentMessages, 40);
  assert.equal(dcp.computeRecencyBoundaryIndex(messages, 4, 40), 260);
  const result = run(messages, config);
  assert.ok(
    result.newlyAppliedDecisions.length > 0,
    "eligible repeated read outputs must not all be protected by the sole user turn",
  );
  assert.deepEqual(result.messages.slice(260), messages.slice(260));
  assert.equal(result.messages.length, messages.length);
  assert.equal(
    messages[2].content[0].text,
    "synthetic source\n".repeat(400),
    "original transcript is untouched",
  );
  config.protections.recentMessages = 0;
  assert.equal(
    run(messages, config).newlyAppliedDecisions.length,
    0,
    "zero preserves the turn-only compatibility mode",
  );
});

test("TASK-198 a pair straddling the message boundary stays intact", () => {
  const messages = repeatedReadChain();
  const boundary = 260; // call at 259, matching result at 260
  const decision = dcp.proposalToDecisionRecord({
    strategyId: "fixture",
    toolCallId: "call-129",
    kind: "tool_result_content",
    reason: "fixture",
  });
  assert.equal(
    dcp.isDecisionProtected(decision, messages, dcp.defaultConfig().protections, boundary),
    true,
  );
  const config = dcp.defaultConfig();
  config.gate.mode = "off";
  assert.deepEqual(run(messages, config).messages[260], messages[260]);
});

test("TASK-198 message-bound configuration normalizes old, invalid and explicit compatibility values", () => {
  assert.equal(dcp.normalizeConfig({}).protections.recentMessages, 40);
  assert.equal(
    dcp.normalizeConfig({ protections: { recentMessages: -1 } }).protections.recentMessages,
    40,
  );
  assert.equal(
    dcp.normalizeConfig({ protections: { recentMessages: 12.8 } }).protections.recentMessages,
    12,
  );
  assert.equal(
    dcp.normalizeConfig({ protections: { recentMessages: 0 } }).protections.recentMessages,
    0,
  );
});
