import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentMarkdown } from "@/components/agent-markdown";

describe("Agent Markdown", () => {
  it("Given an agent reply with Markdown, When it is rendered, Then structured content remains readable", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        markdown:
          "## Result\n\n- one\n- two\n\n> note\n\n`inline`\n\n```ts\nconst answer = 42;\n```\n\n[Docs](https://example.com/docs)",
        streaming: false,
      }),
    );

    expect(html).toContain("<h2");
    expect(html).toContain("<ul");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<code");
    expect(html).toContain('href="https://example.com/docs"');
  });

  it("Given untrusted HTML and a dangerous link, When Markdown is rendered, Then executable content is not exposed", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        markdown:
          '<script>alert("unsafe")</script>\n\n[unsafe](javascript:alert("unsafe"))',
        streaming: false,
      }),
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });
});
