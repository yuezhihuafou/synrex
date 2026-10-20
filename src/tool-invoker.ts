import type { McpRegistrationTarget } from "./mcp-modern-server.js";

type ToolHandler = (input: unknown, extra: Record<string, unknown>) => unknown;

export class ToolInvoker {
  private readonly handlers = new Map<string, ToolHandler>();

  readonly registrationTarget: McpRegistrationTarget = {
    registerTool: ((
      name: string,
      _definition: unknown,
      handler: ToolHandler,
    ) => {
      if (this.handlers.has(name)) throw new Error(`Tool already registered: ${name}`);
      this.handlers.set(name, handler);
      return {};
    }) as McpRegistrationTarget["registerTool"],
    registerResource: (() => ({})) as unknown as McpRegistrationTarget["registerResource"],
  };

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** Advertise the exact local tool surface, never inferred remote features. */
  registeredToolNames(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async call(
    name: string,
    input: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Unknown node-runtime tool: ${name}`);
    const result = await handler(input, {
      _meta: meta,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(`Tool ${name} returned a non-object result.`);
    }
    return result as Record<string, unknown>;
  }
}
