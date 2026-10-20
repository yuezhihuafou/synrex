/**
 * A Synrex node always owns its local execution runtime. These roles only
 * determine how it participates in the optional shared directory.
 *
 * gateway/worker are accepted indefinitely as wire/config aliases while old
 * installations and published MCP clients are migrated.
 */
export type ClusterRole = "standalone" | "coordinator" | "peer" | "gateway" | "worker";
export type TopologyRole = "standalone" | "coordinator" | "peer";

export function topologyRole(role: ClusterRole): TopologyRole {
  if (role === "gateway") return "coordinator";
  if (role === "worker") return "peer";
  return role;
}

export function hostsDirectory(role: ClusterRole): boolean {
  return topologyRole(role) === "coordinator";
}

export function joinsDirectory(role: ClusterRole): boolean {
  return topologyRole(role) === "peer";
}

export function topologyDescription(role: ClusterRole): string {
  switch (topologyRole(role)) {
    case "coordinator": return "directory + full local execution";
    case "peer": return "full local execution + optional directory registration";
    case "standalone": return "independent local execution";
  }
}
