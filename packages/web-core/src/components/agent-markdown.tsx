import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const STREAM_ANIMATION = Object.freeze({ duration: 180, stagger: 0 });

function isSafeLink(href: string): boolean {
  return (
    href.startsWith("https://") ||
    href.startsWith("http://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#")
  );
}

function AgentMarkdownLink({ children, href }: ComponentProps<"a">) {
  if (href === undefined || !isSafeLink(href)) {
    return <span>{children}</span>;
  }
  return (
    <a href={href} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  );
}

const MARKDOWN_COMPONENTS = Object.freeze({ a: AgentMarkdownLink });

export interface AgentMarkdownProps {
  readonly markdown: string;
  readonly streaming: boolean;
}

export function AgentMarkdown({ markdown, streaming }: AgentMarkdownProps) {
  return (
    <Streamdown
      animated={STREAM_ANIMATION}
      className={cn(
        "agent-markdown overflow-wrap-anywhere text-[15px] leading-6 text-foreground max-[420px]:text-sm max-[420px]:leading-[22px]",
        "[&_p]:my-2 [&_p]:whitespace-pre-line",
        "[&_h1]:mt-7 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:leading-8 [&_h1]:font-semibold",
        "[&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:leading-7 [&_h2]:font-semibold",
        "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:leading-6 [&_h3]:font-semibold",
        "[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:font-semibold",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
        "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5",
        "[&_li>p]:my-0",
        "[&_blockquote]:my-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-black/12 [&_blockquote]:pl-3 [&_blockquote]:text-[#454959]",
        "[&_a]:font-medium [&_a]:text-[#19764a] [&_a]:underline [&_a]:decoration-[#2fb872]/35 [&_a]:underline-offset-2 hover:[&_a]:decoration-[#2fb872]",
        "[&_code]:font-mono",
        "[&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border-black/8 [&_pre]:bg-[#f4f5f7]",
        "[&_table]:text-sm",
      )}
      components={MARKDOWN_COMPONENTS}
      isAnimating={streaming}
      mode={streaming ? "streaming" : "static"}
    >
      {markdown}
    </Streamdown>
  );
}
