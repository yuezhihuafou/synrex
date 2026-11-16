declare module "*.css";

interface Window {
  openai?: {
    toolOutput?: unknown;
    toolResponseMetadata?: unknown;
    sendFollowUpMessage?: (input: { prompt: string }) => Promise<unknown>;
  };
}
