/** Stable Synrex-side capability contract; not MemHub's internal data model. */
export interface ProjectMemoryItem {
  id: string;
  content: string;
  evidenceRef?: string;
  source: "project" | "global" | "skill" | "architecture_context";
  revision?: string;
  truncated?: boolean;
}

export type ProjectMemoryRecall =
  | { status: "ok"; project: string; items: ProjectMemoryItem[]; bytes: number }
  | { status: "disabled" | "unavailable" | "ambiguous"; reason: string };

export type ProjectMemoryHydration =
  | { status: "ok"; evidenceRef: string; content: string; truncated: boolean }
  | { status: "disabled" | "unavailable"; reason: string };

export interface ProjectMemoryPort {
  recall(input: { project: string; query: string; maxBytes?: number }): Promise<ProjectMemoryRecall>;
  hydrate(evidenceRef: string, maxBytes?: number): Promise<ProjectMemoryHydration>;
}

export class DisabledProjectMemoryPort implements ProjectMemoryPort {
  async recall(): Promise<ProjectMemoryRecall> {
    return { status: "disabled", reason: "No optional memory adapter is configured." };
  }
  async hydrate(): Promise<ProjectMemoryHydration> {
    return { status: "disabled", reason: "No optional memory adapter is configured." };
  }
}
