import type { ExecutionNode } from "./protocol.js";
import type { ControlPlaneStore } from "./store.js";

export interface WorkspacePlacement {
  node: ExecutionNode;
  reason: "explicit" | "project-binding" | "required-rule" | "preferred-rule" | "unique-root" | "single-node";
}

export interface WorkspacePlacementRule {
  id: string;
  pathPrefix: string;
  mode: "require" | "prefer";
  node?: string;
  labels: Record<string, string>;
}

export function selectWorkspaceNode(
  store: ControlPlaneStore,
  input: {
    selector?: string;
    project?: string;
    path: string;
    localNodeId: string;
    rules?: readonly WorkspacePlacementRule[];
    projectBindings?: readonly { project: string; node: string; pathPrefix: string }[];
  },
): WorkspacePlacement {
  const bindings = input.projectBindings ?? [];
  const matching = bindings.filter((item) => pathPrefixMatches(input.path, item.pathPrefix))
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  const binding = input.project
    ? bindings.find((item) => item.project === input.project)
    : matching[0];
  if (input.project && !binding) throw new Error(`Unknown Synrex project binding: ${input.project}.`);
  if (binding && !pathPrefixMatches(input.path, binding.pathPrefix)) {
    throw new Error(`Workspace path ${JSON.stringify(input.path)} is outside project ${binding.project} prefix ${binding.pathPrefix}.`);
  }
  if (!input.project && matching.length > 1 && matching[0]!.pathPrefix.length === matching[1]!.pathPrefix.length
    && matching[0]!.node !== matching[1]!.node) {
    throw new Error(`Ambiguous project bindings for path ${JSON.stringify(input.path)}; specify project.`);
  }
  const pinned = binding ? store.findNode(binding.node) : undefined;
  if (binding && !pinned) throw new Error(`Project ${binding.project} references unknown node ${binding.node}.`);
  if (pinned && input.selector && store.findNode(input.selector)?.id !== pinned.id) {
    throw new Error(`Project ${binding!.project} is bound to ${binding!.node}; node override denied.`);
  }
  if (pinned) {
    assertAcceptsNewWorkspace(pinned);
    assertPathAllowedOnNode(input.path, pinned);
    assertRequiredRules(pinned, matchingRules(input.path, input.rules ?? []), store);
    return { node: pinned, reason: "project-binding" };
  }
  const rules = matchingRules(input.path, input.rules ?? []);
  if (input.selector) {
    const selected = store.findNode(input.selector);
    if (!selected) throw new Error(`Unknown execution node: ${input.selector}. ${nodeHint(store)}`);
    assertAcceptsNewWorkspace(selected);
    assertPathAllowedOnNode(input.path, selected);
    assertRequiredRules(selected, rules, store);
    return { node: selected, reason: "explicit" };
  }

  const nodes = store.listNodes().filter((node) => node.health === "online");
  if (nodes.length === 0) throw new Error("No online Synrex execution nodes are available.");
  const rootMatched = nodes.filter((node) => pathMatchesAnyRoot(input.path, node));
  const required = rules.filter((rule) => rule.mode === "require");
  const eligible = required.length > 0
    ? rootMatched.filter((node) => required.every((rule) => nodeMatchesRule(node, rule, store)))
    : rootMatched;

  if (required.length > 0) {
    if (eligible.length === 1) return { node: eligible[0]!, reason: "required-rule" };
    if (eligible.length === 0) {
      throw new Error(
        `Workspace path ${JSON.stringify(input.path)} matches required placement rule(s) `
        + `${required.map((rule) => rule.id).join(", ")}, but no online node satisfies them. ${nodeHint(store)}`,
      );
    }
  }

  const preferred = rules.filter((rule) => rule.mode === "prefer");
  if (eligible.length > 1 && preferred.length > 0) {
    const preferredNodes = eligible.filter((node) => preferred.some((rule) => nodeMatchesRule(node, rule, store)));
    if (preferredNodes.length === 1) return { node: preferredNodes[0]!, reason: "preferred-rule" };
  }

  if (eligible.length === 1) return { node: eligible[0]!, reason: "unique-root" };
  if (nodes.length === 1 && rootMatched.length === 1) return { node: nodes[0]!, reason: "single-node" };

  if (eligible.length > 1) {
    throw new Error(
      `Workspace path ${JSON.stringify(input.path)} matches multiple execution nodes (${formatNodes(eligible)}). `
      + "Synrex will not guess. Retry open_workspace with node=<id-or-alias> only when the user intent or an explicit placement rule identifies the host.",
    );
  }

  throw new Error(
    `Workspace path ${JSON.stringify(input.path)} does not uniquely identify an execution node. `
    + `${nodeHint(store)} Synrex will not default to the local machine in multi-node mode; retry open_workspace with node=<id-or-alias>.`,
  );
}

function matchingRules(path: string, rules: readonly WorkspacePlacementRule[]): WorkspacePlacementRule[] {
  const matched = rules.filter((rule) => pathPrefixMatches(path, rule.pathPrefix));
  if (matched.length === 0) return [];
  const maxSpecificity = Math.max(...matched.map((rule) => normalizePath(rule.pathPrefix, false).length));
  return matched.filter((rule) => normalizePath(rule.pathPrefix, false).length === maxSpecificity);
}

function pathPrefixMatches(workspacePath: string, prefix: string): boolean {
  const path = normalizePath(workspacePath, false);
  const normalizedPrefix = normalizePath(prefix, false).replace(/\/$/, "");
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}

function assertPathAllowedOnNode(workspacePath: string, node: ExecutionNode): void {
  const roots = node.capabilities.workspaceRoots ?? [];
  if (roots.length === 0) return;
  if (!pathMatchesAnyRoot(workspacePath, node)) {
    throw new Error(
      `Workspace path ${JSON.stringify(workspacePath)} is outside the advertised roots of ${displayNode(node)}. `
      + "Synrex refuses the explicit node selection rather than risking work on the wrong host.",
    );
  }
}

function assertRequiredRules(
  node: ExecutionNode,
  rules: readonly WorkspacePlacementRule[],
  store: ControlPlaneStore,
): void {
  const required = rules.filter((rule) => rule.mode === "require");
  const failed = required.filter((rule) => !nodeMatchesRule(node, rule, store));
  if (failed.length === 0) return;
  throw new Error(
    `Execution node ${displayNode(node)} violates required placement rule(s) ${failed.map((rule) => rule.id).join(", ")}. `
    + "Synrex refuses this override to prevent work on the wrong host.",
  );
}

function nodeMatchesRule(
  node: ExecutionNode,
  rule: WorkspacePlacementRule,
  store: ControlPlaneStore,
): boolean {
  if (rule.node) {
    const pinned = store.findNode(rule.node);
    if (!pinned || pinned.id !== node.id) return false;
  }
  return Object.entries(rule.labels).every(([key, value]) => node.capabilities.labels[key] === value);
}

function assertAcceptsNewWorkspace(node: ExecutionNode): void {
  if (node.health === "offline" || node.health === "draining") {
    throw new Error(`Execution node ${displayNode(node)} is ${node.health} and cannot accept a new workspace.`);
  }
  if (node.health === "suspect") {
    throw new Error(`Execution node ${displayNode(node)} is suspect; wait for it to become online before opening a new workspace.`);
  }
}

function pathMatchesAnyRoot(workspacePath: string, node: ExecutionNode): boolean {
  const roots = node.capabilities.workspaceRoots ?? [];
  const path = expandNodeHome(workspacePath, node);
  return roots.some((root) => pathWithinRoot(path, root, node.platform.os));
}

function expandNodeHome(workspacePath: string, node: ExecutionNode): string {
  if (workspacePath === "~") return node.capabilities.homeDir ?? workspacePath;
  if (!workspacePath.startsWith("~/")) return workspacePath;
  const home = node.capabilities.homeDir?.replace(/[\\/]+$/, "");
  return home ? `${home}/${workspacePath.slice(2)}` : workspacePath;
}

export function pathWithinRoot(workspacePath: string, root: string, os: string): boolean {
  if (workspacePath.startsWith("~/") || workspacePath === "~") return false;
  const caseInsensitive = os === "win32" || os === "windows";
  const path = normalizePath(workspacePath, caseInsensitive);
  const normalizedRoot = normalizePath(root, caseInsensitive).replace(/\/$/, "");
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

function normalizePath(value: string, lower: boolean): string {
  let normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (lower) normalized = normalized.toLowerCase();
  return normalized;
}

function nodeHint(store: ControlPlaneStore): string {
  const nodes = store.listNodes();
  return `Known nodes: ${formatNodes(nodes)}.`;
}

function formatNodes(nodes: ExecutionNode[]): string {
  return nodes.slice(0, 12).map((node) => {
    const roots = node.capabilities.workspaceRoots ?? [];
    const rootHint = roots.length > 0 ? ` roots=${roots.slice(0, 3).join("|")}` : "";
    const labels = Object.entries(node.capabilities.labels);
    const labelHint = labels.length > 0
      ? ` labels=${labels.slice(0, 4).map(([key, value]) => `${key}:${value}`).join("|")}`
      : "";
    return `${displayNode(node)}[${node.health}${rootHint}${labelHint}]`;
  }).join(", ");
}

function displayNode(node: ExecutionNode): string {
  return node.alias ? `${node.alias} (${node.id})` : node.id;
}
