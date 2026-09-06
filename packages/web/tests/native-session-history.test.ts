import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeSessionHistoryView } from "@/components/chat-message-list";

describe("saved conversation display", () => {
  it("Given previously imported history contains an embedded image link, When the conversation is reopened, Then the image is displayed without exposing its encoded text", () => {
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const html = renderToStaticMarkup(
      createElement(NativeSessionHistoryView, {
        agentLabel: "Codex",
        history: {
          status: "available",
          coveredCommandIds: [],
          truncated: false,
          messages: [
            {
              role: "user",
              text: `Describe this[@image](data:image/png;base64,${data})`,
            },
          ],
        },
      }),
    );
    expect(html).toContain(`<img`);
    expect(html).toContain(`src="data:image/png;base64,${data}"`);
    expect(html).toContain("Describe this");
    expect(html).not.toContain("[@image]");
  });

  it("Given previously imported history contains more than ten messages and unsafe image links, When the conversation is reopened, Then only recent messages and attachment placeholders are displayed", () => {
    const html = renderToStaticMarkup(
      createElement(NativeSessionHistoryView, {
        agentLabel: "Codex",
        history: {
          status: "available",
          coveredCommandIds: [],
          truncated: false,
          messages: [
            { role: "user", text: "Older message outside the preview" },
            ...Array.from({ length: 9 }, (_, index) => ({
              role: "user" as const,
              text: `Recent question ${index.toString()}`,
            })),
            {
              role: "user",
              text: "[@image](https://example.com/private.png)[@image](data:image/svg+xml;base64,PHN2Zz4=)[@image](data:image/png;base64,broken",
            },
          ],
        },
      }),
    );
    expect(html).not.toContain("Older message outside the preview");
    expect(html).toContain("Showing the last 10 messages");
    expect(html).toContain("Image unavailable");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("base64");
    expect(html).not.toContain("private.png");
  });
});
