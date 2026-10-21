/** Bounded read fan-out. The model selects all requested files and ranges. */
export interface BatchReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface BatchReadResult {
  path: string;
  offset?: number;
  limit: number;
  result: string;
  isError: boolean;
}

export interface ReadResponseLike {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: { result?: unknown };
  isError?: boolean;
}

export function validateBatchFiles(files: unknown): BatchReadInput[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > 8) {
    throw new Error("read.files requires 1 to 8 file ranges.");
  }
  return files.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid file entry at index ${index}.`);
    }
    const { path, offset, limit } = entry as Record<string, unknown>;
    if (typeof path !== "string" || path.trim().length === 0) throw new Error(`Missing file path at index ${index}.`);
    if (offset !== undefined && (!Number.isSafeInteger(offset) || (offset as number) < 1)) throw new Error(`Invalid offset at index ${index}.`);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 500)) throw new Error(`Invalid limit at index ${index}.`);
    return { path, ...(offset === undefined ? {} : { offset: offset as number }), limit: (limit as number | undefined) ?? 250 };
  });
}

export async function readBatch(
  files: readonly BatchReadInput[],
  readOne: (entry: BatchReadInput) => Promise<ReadResponseLike>,
  concurrency = 4,
) {
  if (files.length < 1 || files.length > 8) throw new Error("Expected 1 to 8 ranges.");
  const results = new Array<BatchReadResult>(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(files.length, Math.max(1, Math.min(4, Math.floor(concurrency)))) }, async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index]!;
      try {
        const response = await readOne(file);
        const structuredText = response.structuredContent?.result;
        const result = typeof structuredText === "string" ? structuredText
          : response.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
        results[index] = { path: file.path, offset: file.offset, limit: file.limit ?? 250, result, isError: response.isError === true };
      } catch (error) {
        results[index] = { path: file.path, offset: file.offset, limit: file.limit ?? 250,
          result: error instanceof Error ? error.message : String(error), isError: true };
      }
    }
  }));
  const errorCount = results.filter((entry) => entry.isError).length;
  return {
    content: [{ type: "text" as const, text: results.map((entry, index) =>
      `[${index + 1}/${results.length}] ${JSON.stringify(entry.path)}${entry.offset ? ` line ${entry.offset}` : ""}\n${entry.isError ? "ERROR: " : ""}${entry.result}`,
    ).join("\n\n") }],
    structuredContent: { files: results, fileCount: results.length, errorCount },
    isError: errorCount > 0,
  };
}
