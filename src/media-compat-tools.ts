import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { isImagePath, readBoundedImagePreview } from "./image-preview.js";
import { isVideoPath, readVideoFrames } from "./media-read.js";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import { readFileTool } from "./pi-tools.js";
import { contentText, logToolCall, textBlock } from "./tool-surfaces/shared.js";
import {
  toolNames,
  type ToolContent,
} from "./tool-surfaces/types.js";
import type { WorkspaceRegistry } from "./workspaces.js";

interface MediaCompatibilityOptions {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
}

async function readImage(
  workspaces: WorkspaceRegistry,
  workspaceId: string,
  inputPath: string,
): Promise<{ content: ToolContent[]; structuredContent: Record<string, unknown> }> {
  if (!isImagePath(inputPath)) {
    throw new Error("read_image/read_images require a supported image path.");
  }
  const workspace = await workspaces.getWorkspace(workspaceId);
  const readPath = workspaces.resolveReadPath(workspace, inputPath);
  const preview = await readBoundedImagePreview(readPath.absolutePath);
  const result = preview ?? await readFileTool(
    { path: readPath.absolutePath, limit: 250 },
    { cwd: workspace.root, root: workspace.root, readRoots: readPath.readRoots },
  );
  if ("isError" in result && result.isError === true) {
    throw new Error(contentText(result.content) || `Could not read image: ${inputPath}`);
  }
  const originalStructured = "structuredContent" in result
    && result.structuredContent
    && typeof result.structuredContent === "object"
    ? result.structuredContent as Record<string, unknown>
    : {};
  return {
    content: result.content as ToolContent[],
    structuredContent: {
      ...originalStructured,
      result: typeof originalStructured.result === "string"
        ? originalStructured.result
        : contentText(result.content),
    },
  };
}

/**
 * Backward-compatible media aliases for connected hosts that still advertise
 * the pre-consolidation Synrex tool surface. New clients should use `read`,
 * whose image/video handling is the canonical implementation.
 */
export function registerMediaCompatibilityTools(
  server: McpRegistrationTarget,
  options: MediaCompatibilityOptions,
): void {
  const { config, workspaces } = options;

  server.registerTool(
    toolNames.readImage,
    {
      inputSchema: {
        workspaceId: z.string(),
        path: z.string(),
      },
    },
    async ({ workspaceId, path: inputPath }) => {
      const startedAt = performance.now();
      try {
        const result = await readImage(workspaces, workspaceId, inputPath);
        logToolCall(config, {
          tool: toolNames.readImage,
          workspaceId,
          path: inputPath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall(config, {
          tool: toolNames.readImage,
          workspaceId,
          path: inputPath,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return { content: [textBlock(message)], isError: true };
      }
    },
  );

  server.registerTool(
    toolNames.readImages,
    {
      inputSchema: {
        workspaceId: z.string(),
        paths: z.array(z.string()).min(1).max(8),
      },
    },
    async ({ workspaceId, paths }) => {
      const startedAt = performance.now();
      try {
        const items = await Promise.all(paths.map((path) => readImage(workspaces, workspaceId, path)));
        const content: ToolContent[] = [];
        items.forEach((item, index) => {
          content.push(textBlock(`Image ${index + 1}/${items.length}: ${paths[index]}`));
          content.push(...item.content);
        });
        const result = {
          content,
          structuredContent: {
            result: `${items.length} images read successfully.`,
            count: items.length,
            paths,
          },
        };
        logToolCall(config, {
          tool: toolNames.readImages,
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall(config, {
          tool: toolNames.readImages,
          workspaceId,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return { content: [textBlock(message)], isError: true };
      }
    },
  );

  server.registerTool(
    toolNames.readVideo,
    {
      inputSchema: {
        workspaceId: z.string(),
        path: z.string(),
        startSeconds: z.number().nonnegative().optional(),
        endSeconds: z.number().positive().optional(),
      },
    },
    async ({ workspaceId, path: inputPath, startSeconds, endSeconds }) => {
      const startedAt = performance.now();
      try {
        if (!isVideoPath(inputPath)) {
          throw new Error("read_video requires a supported video path.");
        }
        const workspace = await workspaces.getWorkspace(workspaceId);
        const readPath = workspaces.resolveReadPath(workspace, inputPath);
        const video = await readVideoFrames(readPath.absolutePath, { startSeconds, endSeconds });
        const result = {
          ...video,
          structuredContent: {
            ...video.structuredContent,
            path: inputPath,
          },
        };
        logToolCall(config, {
          tool: toolNames.readVideo,
          workspaceId,
          path: inputPath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall(config, {
          tool: toolNames.readVideo,
          workspaceId,
          path: inputPath,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return { content: [textBlock(message)], isError: true };
      }
    },
  );
}
