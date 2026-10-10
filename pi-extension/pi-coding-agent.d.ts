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
      /** TUI 中工具调用行的自定义渲染（缺省时只显示工具名） */
      renderCall?: (args: any, theme: any, context: any) => { render(width: number): string[] };
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

declare module "@earendil-works/pi-tui" {
  export class Text {
    constructor(text: string, paddingLeft?: number, paddingRight?: number, bgFn?: (s: string) => string);
    setText(text: string): void;
    render(width: number): string[];
  }
  export interface Component {
    render(width: number): string[];
    invalidate?(): void;
  }
}
