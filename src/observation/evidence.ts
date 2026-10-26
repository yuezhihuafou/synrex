import { randomUUID } from "node:crypto";

/** Source-independent evidence envelope. Observation is not semantic verification:
 * the GPT host must interpret the image/data and verify the user's goal.
 */
export interface ObservationSource {
  kind: string;
  locator: string;
  workspaceId: string;
  nodeId?: string;
}

export interface ObservationEvidence {
  schemaVersion: 1;
  observationId: string;
  source: ObservationSource;
  capturedAt: string;
  status: "captured";
  imageCount: number;
  mimeTypes: string[];
  sourceTimestampNanoseconds?: string;
  sourceFrameId?: string;
  previewOnly: boolean;
}

type Content = { type: string; mimeType?: string; data?: string; text?: string };
type CapturedResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** Adapter boundary: the caller resolves credentials, workspace paths and
 * permissions before passing a read-only capture. Future desktop, document,
 * simulation and camera capture sources can share this contract.
 */
export interface ObservationAdapter<T extends CapturedResult> {
  capture(): Promise<T>;
}

export async function captureObservation<T extends CapturedResult>(
  adapter: ObservationAdapter<T>,
  source: ObservationSource,
  options: { previewOnly?: boolean } = {},
): Promise<T & { structuredContent: Record<string, unknown> & { observation: ObservationEvidence } }> {
  return withObservationEvidence(await adapter.capture(), source, options);
}

/** Preserve actual image blocks and existing structured metadata; never put
 * base64 image bytes into structuredContent, logs, or a second database.
 */
export function withObservationEvidence<T extends CapturedResult>(
  captured: T,
  source: ObservationSource,
  options: { previewOnly?: boolean } = {},
): T & { structuredContent: Record<string, unknown> & { observation: ObservationEvidence } } {
  if (captured.isError === true) {
    throw new Error("Failed capture cannot be recorded as a successful observation.");
  }
  const images = captured.content.filter(content => content.type === "image");
  const media = captured.structuredContent?.media;
  const provenance = media && typeof media === "object" && !Array.isArray(media)
    ? media as Record<string, unknown> : {};
  const stamp = provenance.stampNanoseconds;
  const frame = provenance.frameId;
  const observation: ObservationEvidence = {
    schemaVersion: 1,
    observationId: randomUUID(),
    source,
    capturedAt: new Date().toISOString(),
    status: "captured",
    imageCount: images.length,
    mimeTypes: [...new Set(images.map(image => image.mimeType).filter((mime): mime is string => typeof mime === "string"))],
    ...(typeof stamp === "string" ? { sourceTimestampNanoseconds: stamp } : {}),
    ...(typeof frame === "string" ? { sourceFrameId: frame } : {}),
    previewOnly: options.previewOnly === true,
  };
  return {
    ...captured,
    structuredContent: { ...captured.structuredContent, observation },
  };
}
