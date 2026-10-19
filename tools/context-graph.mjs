#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NODE_KINDS = new Set([
  "actor",
  "business_capability",
  "use_case",
  "business_process",
  "business_rule",
  "domain",
  "bounded_context",
  "aggregate",
  "feature",
  "service",
  "module",
  "api",
  "event",
  "entity",
  "table",
  "code_symbol",
  "test",
  "deployment",
  "decision",
  "task",
  "artifact",
  "evidence",
]);

const RELATIONS = new Set([
  "uses",
  "contains",
  "realizes",
  "depends_on",
  "calls",
  "publishes",
  "consumes",
  "reads",
  "writes",
  "constrained_by",
  "governed_by",
  "verified_by",
  "implemented_by",
  "deployed_to",
  "affected_by",
  "entry_point",
  "operates_on",
  "stored_in",
  "owns",
]);

const VERIFICATION_STATES = new Set(["confirmed", "inferred", "proposed"]);
const FRESHNESS_STATES = new Set(["current", "stale", "unknown"]);
const DIRECTIONS = new Set(["both", "incoming", "outgoing"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{2,159}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} must be a non-empty string`);
    return false;
  }
  return true;
}

function validateId(value, path, errors) {
  if (!requireString(value, path, errors)) return false;
  if (!ID_PATTERN.test(value)) {
    errors.push(`${path} must match ${ID_PATTERN}`);
    return false;
  }
  return true;
}

function validateSources(sources, path, errors) {
  if (!Array.isArray(sources) || sources.length === 0) {
    errors.push(`${path} must contain at least one source`);
    return;
  }

  sources.forEach((source, index) => {
    const sourcePath = `${path}[${index}]`;
    if (!isObject(source)) {
      errors.push(`${sourcePath} must be an object`);
      return;
    }
    requireString(source.kind, `${sourcePath}.kind`, errors);
    requireString(source.uri, `${sourcePath}.uri`, errors);
    requireString(source.revision, `${sourcePath}.revision`, errors);
  });
}

export function validateGraph(graph) {
  const errors = [];

  if (!isObject(graph)) return ["graph must be an object"];

  if (graph.format_version !== "0.1") {
    errors.push('format_version must equal "0.1"');
  }
  validateId(graph.graph_id, "graph_id", errors);
  validateId(graph.project_id, "project_id", errors);

  if (!Number.isInteger(graph.snapshot) || graph.snapshot < 1) {
    errors.push("snapshot must be a positive integer");
  }
  if (
    !requireString(graph.generated_at, "generated_at", errors) ||
    Number.isNaN(Date.parse(graph.generated_at))
  ) {
    errors.push("generated_at must be an ISO-8601 timestamp");
  }

  if (!isObject(graph.baseline)) {
    errors.push("baseline must be an object");
  } else {
    if (
      !Number.isInteger(graph.baseline.project_snapshot) ||
      graph.baseline.project_snapshot < 1
    ) {
      errors.push("baseline.project_snapshot must be a positive integer");
    }
    requireString(graph.baseline.git_commit, "baseline.git_commit", errors);
  }

  if (graph.projection !== undefined) {
    const projection = graph.projection;
    if (!isObject(projection)) {
      errors.push("projection must be an object");
    } else {
      if (!Array.isArray(projection.focus_nodes) || projection.focus_nodes.length === 0) {
        errors.push("projection.focus_nodes must contain at least one node id");
      } else {
        projection.focus_nodes.forEach((id, index) =>
          validateId(id, `projection.focus_nodes[${index}]`, errors),
        );
      }
      if (!Number.isInteger(projection.depth) || projection.depth < 0 || projection.depth > 5) {
        errors.push("projection.depth must be an integer between 0 and 5");
      }
      if (!DIRECTIONS.has(projection.direction)) {
        errors.push("projection.direction must be both, incoming, or outgoing");
      }
    }
  }

  if (!Array.isArray(graph.nodes)) errors.push("nodes must be an array");
  if (!Array.isArray(graph.edges)) errors.push("edges must be an array");
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return errors;

  const nodeIds = new Set();
  graph.nodes.forEach((node, index) => {
    const path = `nodes[${index}]`;
    if (!isObject(node)) {
      errors.push(`${path} must be an object`);
      return;
    }

    if (validateId(node.id, `${path}.id`, errors)) {
      if (nodeIds.has(node.id)) errors.push(`${path}.id duplicates ${node.id}`);
      nodeIds.add(node.id);
    }
    if (!NODE_KINDS.has(node.kind)) errors.push(`${path}.kind is unsupported: ${node.kind}`);
    requireString(node.name, `${path}.name`, errors);
    requireString(node.summary, `${path}.summary`, errors);
    if (!VERIFICATION_STATES.has(node.verification)) {
      errors.push(`${path}.verification is unsupported: ${node.verification}`);
    }
    if (!FRESHNESS_STATES.has(node.freshness)) {
      errors.push(`${path}.freshness is unsupported: ${node.freshness}`);
    }
    validateSources(node.sources, `${path}.sources`, errors);
  });

  const edgeIds = new Set();
  graph.edges.forEach((edge, index) => {
    const path = `edges[${index}]`;
    if (!isObject(edge)) {
      errors.push(`${path} must be an object`);
      return;
    }

    if (validateId(edge.id, `${path}.id`, errors)) {
      if (edgeIds.has(edge.id)) errors.push(`${path}.id duplicates ${edge.id}`);
      edgeIds.add(edge.id);
    }
    validateId(edge.from, `${path}.from`, errors);
    validateId(edge.to, `${path}.to`, errors);
    if (!RELATIONS.has(edge.relation)) {
      errors.push(`${path}.relation is unsupported: ${edge.relation}`);
    }
    requireString(edge.summary, `${path}.summary`, errors);
    if (!VERIFICATION_STATES.has(edge.verification)) {
      errors.push(`${path}.verification is unsupported: ${edge.verification}`);
    }
    if (!FRESHNESS_STATES.has(edge.freshness)) {
      errors.push(`${path}.freshness is unsupported: ${edge.freshness}`);
    }
    validateSources(edge.sources, `${path}.sources`, errors);

    if (typeof edge.from === "string" && !nodeIds.has(edge.from)) {
      errors.push(`${path}.from references missing node ${edge.from}`);
    }
    if (typeof edge.to === "string" && !nodeIds.has(edge.to)) {
      errors.push(`${path}.to references missing node ${edge.to}`);
    }
  });

  if (isObject(graph.projection) && Array.isArray(graph.projection.focus_nodes)) {
    graph.projection.focus_nodes.forEach((id) => {
      if (!nodeIds.has(id)) errors.push(`projection references missing focus node ${id}`);
    });
  }

  return errors;
}

export function extractSubgraph(graph, focusNodes, depth = 1, direction = "both") {
  const errors = validateGraph(graph);
  if (errors.length > 0) throw new Error(`Invalid graph:\n${errors.join("\n")}`);
  if (!Array.isArray(focusNodes) || focusNodes.length === 0) {
    throw new Error("At least one focus node is required");
  }
  if (!Number.isInteger(depth) || depth < 0 || depth > 5) {
    throw new Error("Depth must be an integer between 0 and 5");
  }
  if (!DIRECTIONS.has(direction)) throw new Error(`Unsupported direction: ${direction}`);

  const knownNodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const focusNode of focusNodes) {
    if (!knownNodeIds.has(focusNode)) throw new Error(`Unknown focus node: ${focusNode}`);
  }

  const selected = new Set(focusNodes);
  let frontier = new Set(focusNodes);

  for (let level = 0; level < depth; level += 1) {
    const next = new Set();
    for (const edge of graph.edges) {
      const followOutgoing = direction === "both" || direction === "outgoing";
      const followIncoming = direction === "both" || direction === "incoming";

      if (followOutgoing && frontier.has(edge.from) && !selected.has(edge.to)) {
        next.add(edge.to);
      }
      if (followIncoming && frontier.has(edge.to) && !selected.has(edge.from)) {
        next.add(edge.from);
      }
    }
    for (const nodeId of next) selected.add(nodeId);
    frontier = next;
    if (frontier.size === 0) break;
  }

  return {
    ...graph,
    projection: {
      focus_nodes: [...focusNodes],
      depth,
      direction,
    },
    nodes: graph.nodes.filter((node) => selected.has(node.id)),
    edges: graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)),
  };
}

function escapeMermaidLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', "\\\"").replaceAll("\n", " ");
}

export function renderMermaid(graph) {
  const errors = validateGraph(graph);
  if (errors.length > 0) throw new Error(`Invalid graph:\n${errors.join("\n")}`);

  const aliases = new Map(graph.nodes.map((node, index) => [node.id, `N${index}`]));
  const lines = ["flowchart LR"];

  for (const node of graph.nodes) {
    const label = `${node.kind}: ${node.name}`;
    lines.push(`    ${aliases.get(node.id)}["${escapeMermaidLabel(label)}"]`);
  }
  for (const edge of graph.edges) {
    lines.push(
      `    ${aliases.get(edge.from)} -->|"${escapeMermaidLabel(edge.relation)}"| ${aliases.get(edge.to)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function readGraph(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function usage() {
  return [
    "Usage:",
    "  node tools/context-graph.mjs validate <graph.json>",
    "  node tools/context-graph.mjs subgraph <graph.json> <focus-id[,focus-id]> [depth] [direction]",
    "  node tools/context-graph.mjs mermaid <graph.json>",
  ].join("\n");
}

function runCli(argv) {
  const [command, file, focusArgument, depthArgument, directionArgument] = argv;
  if (!command || !file) throw new Error(usage());

  const graph = readGraph(file);
  if (command === "validate") {
    const errors = validateGraph(graph);
    const result = {
      valid: errors.length === 0,
      graph_id: graph.graph_id,
      snapshot: graph.snapshot,
      node_count: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
      edge_count: Array.isArray(graph.edges) ? graph.edges.length : 0,
      errors,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (errors.length > 0) process.exitCode = 1;
    return;
  }

  if (command === "subgraph") {
    if (!focusArgument) throw new Error(usage());
    const focusNodes = focusArgument.split(",").filter(Boolean);
    const depth = depthArgument === undefined ? 1 : Number(depthArgument);
    const direction = directionArgument ?? "both";
    process.stdout.write(
      `${JSON.stringify(extractSubgraph(graph, focusNodes, depth, direction), null, 2)}\n`,
    );
    return;
  }

  if (command === "mermaid") {
    process.stdout.write(renderMermaid(graph));
    return;
  }

  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
