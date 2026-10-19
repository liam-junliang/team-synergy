import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  extractSubgraph,
  renderMermaid,
  validateGraph,
} from "../tools/context-graph.mjs";

const fixtureUrl = new URL("../examples/context-graph/user-login.graph.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8"));

test("example graph satisfies structural and referential invariants", () => {
  assert.deepEqual(validateGraph(fixture), []);
});

test("validator rejects duplicate node identities", () => {
  const graph = structuredClone(fixture);
  graph.nodes.push(structuredClone(graph.nodes[0]));

  assert.ok(validateGraph(graph).some((error) => error.includes("duplicates actor.end-user")));
});

test("validator rejects dangling edge endpoints", () => {
  const graph = structuredClone(fixture);
  graph.edges[0].to = "service.missing";

  assert.ok(validateGraph(graph).some((error) => error.includes("missing node service.missing")));
});

test("feature projection returns a bounded one-hop context", () => {
  const view = extractSubgraph(fixture, ["feature.user-login"], 1);
  const nodeIds = new Set(view.nodes.map((node) => node.id));

  assert.equal(view.projection.depth, 1);
  assert.ok(nodeIds.has("feature.user-login"));
  assert.ok(nodeIds.has("api.post-login"));
  assert.ok(nodeIds.has("rule.no-account-disclosure"));
  assert.ok(nodeIds.has("service.auth"));
  assert.ok(nodeIds.has("deployment.auth-service"));
  assert.ok(!nodeIds.has("table.users"));
  assert.ok(view.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)));
  assert.deepEqual(validateGraph(view), []);
});

test("direction controls traversal semantics", () => {
  const outgoing = extractSubgraph(fixture, ["api.post-login"], 1, "outgoing");
  const incoming = extractSubgraph(fixture, ["api.post-login"], 1, "incoming");

  assert.deepEqual(
    outgoing.nodes.map((node) => node.id),
    ["api.post-login", "service.auth"],
  );
  assert.deepEqual(
    incoming.nodes.map((node) => node.id),
    ["feature.user-login", "api.post-login"],
  );
});

test("Mermaid rendering uses the same graph instead of a second hand-written model", () => {
  const view = extractSubgraph(fixture, ["feature.user-login"], 1);
  const mermaid = renderMermaid(view);

  assert.match(mermaid, /^flowchart LR/m);
  assert.match(mermaid, /feature: 用户登录/);
  assert.match(mermaid, /entry_point/);
  assert.equal(mermaid.split("\n").filter((line) => line.includes("-->" )).length, view.edges.length);
});
