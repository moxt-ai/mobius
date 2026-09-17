import { code } from "@streamdown/code";
import type { MermaidConfig } from "@streamdown/mermaid";
import { type DiagramPlugin, type MermaidErrorComponentProps, Streamdown } from "streamdown";
import "streamdown/styles.css";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const STREAM_ANIMATION = Object.freeze({ duration: 180, stagger: 0 });
const MERMAID_CONFIG = Object.freeze({
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "neutral",
});
const MERMAID_PLUGIN: DiagramPlugin = Object.freeze({
    getMermaid: (config: MermaidConfig = MERMAID_CONFIG) =>
        Object.freeze({
            initialize: () => undefined,
            render: async (id: string, source: string) => {
                const { createMermaidPlugin } = await import("@streamdown/mermaid");
                const renderer = createMermaidPlugin({ config: MERMAID_CONFIG }).getMermaid(config);
                return await renderer.render(id, source);
            },
        }),
    language: "mermaid",
    name: "mermaid",
    type: "diagram",
});
const STREAMDOWN_CONTROLS = Object.freeze({
    code: Object.freeze({ copy: true, download: false }),
    mermaid: Object.freeze({ copy: true, download: true, fullscreen: true, panZoom: true }),
});
const STREAMDOWN_PLUGINS = Object.freeze({ code, mermaid: MERMAID_PLUGIN });
const STREAMDOWN_TRANSLATIONS = Object.freeze({ copyCode: "Copy code" });

function MermaidError({ chart, error, retry }: MermaidErrorComponentProps) {
    return (
        <section aria-label="Mermaid diagram error" className="mermaid-error grid gap-3 p-1">
            <div className="grid gap-1" role="alert">
                <p className="m-0 text-sm font-semibold text-destructive">Diagram could not be rendered.</p>
                <p className="m-0 break-words font-mono text-xs leading-5 text-copy-secondary">{error}</p>
            </div>
            <div className="flex flex-wrap items-start gap-2">
                <button
                    className="inline-flex min-h-11 items-center rounded-lg border border-border bg-white px-3 text-xs font-medium text-foreground hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none"
                    onClick={retry}
                    type="button"
                >
                    Retry diagram
                </button>
                <details className="min-w-0 flex-1 text-xs text-copy-secondary">
                    <summary className="flex min-h-11 cursor-pointer items-center rounded-lg px-2 font-medium focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none">
                        Show Mermaid source
                    </summary>
                    <pre className="m-0 max-h-64 overflow-auto rounded-lg bg-surface-subtle p-3 font-mono text-xs leading-5 whitespace-pre">
                        <code>{chart}</code>
                    </pre>
                </details>
            </div>
        </section>
    );
}

const STREAMDOWN_MERMAID = Object.freeze({
    config: MERMAID_CONFIG,
    errorComponent: MermaidError,
});

function isSafeLink(href: string): boolean {
    return (
        href.startsWith("https://") || href.startsWith("http://") || href.startsWith("mailto:") || href.startsWith("#")
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
                "agent-markdown min-w-0 text-[15px] leading-6 text-foreground [overflow-wrap:anywhere]",
                "[&_p]:my-2 [&_p]:whitespace-pre-line",
                "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-[21px] [&_h1]:leading-7 [&_h1]:font-semibold md:[&_h1]:mt-7 md:[&_h1]:text-2xl md:[&_h1]:leading-8",
                "[&_h2]:mt-5 [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:leading-7 [&_h2]:font-semibold md:[&_h2]:mt-6 md:[&_h2]:text-xl",
                "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:leading-6 [&_h3]:font-semibold",
                "[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:font-semibold",
                "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
                "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5",
                "[&_li>p]:my-0",
                "[&_blockquote]:my-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-black/12 [&_blockquote]:pl-3 [&_blockquote]:text-[#454959]",
                "[&_a]:font-medium [&_a]:text-[#19764a] [&_a]:underline [&_a]:decoration-[#2fb872]/35 [&_a]:underline-offset-2 hover:[&_a]:decoration-[#2fb872]",
                "[&_code]:font-mono",
                "[&_table]:text-sm",
            )}
            components={MARKDOWN_COMPONENTS}
            controls={STREAMDOWN_CONTROLS}
            isAnimating={streaming}
            lineNumbers={false}
            mermaid={STREAMDOWN_MERMAID}
            mode={streaming ? "streaming" : "static"}
            plugins={STREAMDOWN_PLUGINS}
            translations={STREAMDOWN_TRANSLATIONS}
        >
            {markdown}
        </Streamdown>
    );
}
