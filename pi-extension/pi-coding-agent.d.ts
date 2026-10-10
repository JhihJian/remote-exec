declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerTool(tool: {
      name: string;
      label: string;
      description: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters: unknown;
      execute: (id: string, params: any) => Promise<{
        content: Array<{ type: string; text: string }>;
        details?: unknown;
      }>;
    }): void;
    on(
      event: "before_agent_start",
      handler: (event: {
        systemPrompt: string;
        systemPromptOptions?: { selectedTools?: string[] };
      }) => Promise<{ systemPrompt: string } | void>,
    ): void;
  }
}