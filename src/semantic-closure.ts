import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  explainSemanticSource,
  type GeneratedIntegrity,
  type SemanticExplanationStatus,
} from "./semantic-explain";
import { workspaceRelativePath } from "./semantic-fingerprint";

export type SemanticClosureManifestNode = {
  id: string;
  source: string;
  dependsOn: string[];
};

export type SemanticClosureManifest = {
  version: 1;
  nodes: SemanticClosureManifestNode[];
};

export type SemanticClosureNode = {
  id: string;
  kind: "predicate" | "static-judgment";
  source: string;
  symbol: string;
  conceptId: string;
  status: SemanticExplanationStatus;
  generated: GeneratedIntegrity | null;
  dependsOn: string[];
};

export type SemanticClosureEdge = {
  from: string;
  to: string;
  kind: "depends-on";
};

export type SemanticClosureBlocker = {
  nodeId: string;
  code: Exclude<SemanticExplanationStatus, "current">;
  message: string;
};

export type SemanticClosureReport = {
  version: 1;
  scope: "artifact";
  status: "closed" | "open";
  approval: "unknown";
  manifest: string;
  nodes: SemanticClosureNode[];
  edges: SemanticClosureEdge[];
  blockers: SemanticClosureBlocker[];
  summary: {
    total: number;
    current: number;
    stale: number;
    unlocked: number;
    integrityError: number;
  };
  limitations: string[];
};

export type CheckSemanticClosureOptions = {
  manifestPath: string;
  workspaceRoot?: string;
  lockPath?: string;
};

const limitations = [
  "Closure is limited to artifacts explicitly declared in the manifest.",
  "Dependencies are explicit declarations; imports and undeclared semantic sources are not discovered.",
  "Human approval is unknown because semantic.lock does not record approval provenance.",
  "This check does not build, replay, repair, or perform a new semantic judgment.",
];

export async function checkSemanticClosure(
  options: CheckSemanticClosureOptions,
): Promise<SemanticClosureReport> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const manifestPath = resolve(options.manifestPath);
  const manifestRelative = workspaceRelativePath(
    workspaceRoot,
    manifestPath,
    "Semantic Closure manifest",
  );
  const manifest = parseSemanticClosureManifest(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  const normalizedNodes = normalizeAndValidateGraph(manifest, workspaceRoot);
  const explanations = await Promise.all(
    normalizedNodes.map(async (node) => ({
      manifestNode: node,
      explanation: await explainSemanticSource({
        sourcePath: resolve(workspaceRoot, node.source),
        workspaceRoot,
        ...(options.lockPath === undefined ? {} : { lockPath: options.lockPath }),
      }),
    })),
  );
  const nodes: SemanticClosureNode[] = explanations.map(
    ({ manifestNode, explanation }) => ({
      id: manifestNode.id,
      kind: explanation.kind,
      source: explanation.source,
      symbol: explanation.symbol,
      conceptId: explanation.concept.id,
      status: explanation.status,
      generated: explanation.generated,
      dependsOn: manifestNode.dependsOn,
    }),
  );
  const blockers = nodes.flatMap((node): SemanticClosureBlocker[] =>
    node.status === "current"
      ? []
      : [
          {
            nodeId: node.id,
            code: node.status,
            message: blockerMessage(node.status),
          },
        ],
  );

  return {
    version: 1,
    scope: "artifact",
    status: blockers.length === 0 ? "closed" : "open",
    approval: "unknown",
    manifest: manifestRelative,
    nodes,
    edges: normalizedNodes
      .flatMap((node) =>
        node.dependsOn.map(
          (dependency): SemanticClosureEdge => ({
            from: node.id,
            to: dependency,
            kind: "depends-on",
          }),
        ),
      )
      .sort(compareEdges),
    blockers,
    summary: {
      total: nodes.length,
      current: countStatus(nodes, "current"),
      stale: countStatus(nodes, "stale"),
      unlocked: countStatus(nodes, "unlocked"),
      integrityError: countStatus(nodes, "integrity-error"),
    },
    limitations: [...limitations],
  };
}

export function parseSemanticClosureManifest(
  input: unknown,
): SemanticClosureManifest {
  const value = objectValue(input, "Semantic Closure manifest");
  assertKnownKeys(value, ["version", "nodes"], "Semantic Closure manifest");
  if (value.version !== 1) {
    throw new Error("Semantic Closure manifest.version must be 1");
  }
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    throw new Error("Semantic Closure manifest.nodes must be a non-empty array");
  }
  return {
    version: 1,
    nodes: value.nodes.map((node, index) => parseManifestNode(node, index)),
  };
}

function parseManifestNode(
  input: unknown,
  index: number,
): SemanticClosureManifestNode {
  const path = `Semantic Closure manifest.nodes[${index}]`;
  const value = objectValue(input, path);
  assertKnownKeys(value, ["id", "source", "dependsOn"], path);
  const id = stringValue(value.id, `${path}.id`);
  if (!/^[a-z][a-z0-9._-]*$/.test(id)) {
    throw new Error(
      `${path}.id must start with a lowercase letter and contain only lowercase letters, numbers, dot, underscore, or hyphen`,
    );
  }
  const source = stringValue(value.source, `${path}.source`);
  if (isAbsolute(source)) {
    throw new Error(`${path}.source must be workspace-relative`);
  }
  const dependencies = value.dependsOn ?? [];
  if (!Array.isArray(dependencies)) {
    throw new Error(`${path}.dependsOn must be an array`);
  }
  return {
    id,
    source,
    dependsOn: dependencies.map((dependency, dependencyIndex) =>
      stringValue(dependency, `${path}.dependsOn[${dependencyIndex}]`),
    ),
  };
}

function normalizeAndValidateGraph(
  manifest: SemanticClosureManifest,
  workspaceRoot: string,
): SemanticClosureManifestNode[] {
  const ids = new Set<string>();
  const sources = new Set<string>();
  const nodes = manifest.nodes.map((node) => {
    if (ids.has(node.id)) {
      throw new Error(`Semantic Closure manifest has duplicate node id ${node.id}`);
    }
    ids.add(node.id);
    const source = workspaceRelativePath(
      workspaceRoot,
      resolve(workspaceRoot, node.source),
      `Semantic Closure node ${node.id} source`,
    );
    if (sources.has(source)) {
      throw new Error(`Semantic Closure manifest has duplicate source ${source}`);
    }
    sources.add(source);
    const dependsOn = [...node.dependsOn].sort();
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`Semantic Closure node ${node.id} has duplicate dependencies`);
    }
    return { ...node, source, dependsOn };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) {
        throw new Error(`Semantic Closure node ${node.id} cannot depend on itself`);
      }
      if (!nodeById.has(dependency)) {
        throw new Error(
          `Semantic Closure node ${node.id} depends on unknown node ${dependency}`,
        );
      }
    }
  }
  assertAcyclic(nodes, nodeById);
  return nodes.sort((left, right) => left.id.localeCompare(right.id));
}

function assertAcyclic(
  nodes: SemanticClosureManifestNode[],
  nodeById: Map<string, SemanticClosureManifestNode>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: SemanticClosureManifestNode, path: string[]): void => {
    if (visited.has(node.id)) return;
    if (visiting.has(node.id)) {
      const cycleStart = path.indexOf(node.id);
      const cycle = [...path.slice(cycleStart), node.id];
      throw new Error(`Semantic Closure graph contains a cycle: ${cycle.join(" -> ")}`);
    }
    visiting.add(node.id);
    path.push(node.id);
    for (const dependency of node.dependsOn) {
      visit(nodeById.get(dependency)!, path);
    }
    path.pop();
    visiting.delete(node.id);
    visited.add(node.id);
  };
  for (const node of nodes) visit(node, []);
}

function blockerMessage(
  status: Exclude<SemanticExplanationStatus, "current">,
): string {
  if (status === "stale") return "semantic inputs differ from the latest lock entry";
  if (status === "unlocked") return "no lock entry exists for this semantic source";
  return "the generated output is missing or does not match the lock hash";
}

function countStatus(
  nodes: SemanticClosureNode[],
  status: SemanticExplanationStatus,
): number {
  return nodes.filter((node) => node.status === status).length;
}

function compareEdges(left: SemanticClosureEdge, right: SemanticClosureEdge): number {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
}

function objectValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return input;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new Error(`${path} contains unknown field ${unknown}`);
  }
}
