import type { AgentDisplayContent } from "@moxt-ai/mobius-sdk";
import { ExternalLink, FileText, Image as ImageIcon, Terminal } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentMarkdown } from "@/components/agent-markdown";
import type { ChannelConnection } from "@/domain/channel";
import { readFile } from "@/services/mobius-transport";
import { readSessionArtifactBytes } from "@/services/pairing-api";

const SAFE_IMAGE_MIME = /^image\/(?:gif|jpeg|png|webp)$/;

function safeLink(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol === "https:" || url.protocol === "http:") {
            return url.toString();
        }
    } catch {}
    return "";
}

function ContentHeader({ content }: { readonly content: AgentDisplayContent }) {
    const label = content.name || content.path || content.uri || content.type;
    return (
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.04em] text-[#7d8590] uppercase">
            {content.type === "image" ? (
                <ImageIcon className="size-3" />
            ) : content.type === "terminal" ? (
                <Terminal className="size-3" />
            ) : (
                <FileText className="size-3" />
            )}
            <span className="truncate normal-case tracking-normal" title={label}>
                {label}
            </span>
        </div>
    );
}

function RemoteImage({
    connection,
    content,
    sessionId,
}: {
    readonly connection: ChannelConnection;
    readonly content: AgentDisplayContent;
    readonly sessionId: string;
}) {
    const [source, setSource] = useState("");
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        let objectUrl = "";
        const load = async () => {
            try {
                let bytes: Uint8Array;
                let mimeType: string;

                if (content.uri.length > 0) {
                    const file = await readFile(sessionId, content.uri, controller.signal);
                    bytes = file.bytes;
                    mimeType = file.mediaType;
                } else {
                    const artifact = await readSessionArtifactBytes(
                        connection,
                        sessionId,
                        content.artifactId,
                        controller.signal,
                    );
                    bytes = artifact.bytes;
                    mimeType = artifact.mimeType;
                }

                if (controller.signal.aborted || !SAFE_IMAGE_MIME.test(mimeType)) {
                    return;
                }
                objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mimeType }));
                setSource(objectUrl);
            } catch {
                if (!controller.signal.aborted) {
                    setSource("");
                    setFailed(true);
                }
            }
        };
        void load();
        return () => {
            controller.abort();
            if (objectUrl.length > 0) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [connection, content.artifactId, content.uri, sessionId]);
    if (source.length === 0) {
        return (
            <div className="min-h-24 rounded-lg border-[0.5px] border-black/8 bg-black/[0.02] p-3 text-xs text-muted-foreground">
                {failed ? "Image is unavailable on the local runtime." : "Loading image…"}
            </div>
        );
    }
    return (
        <figure className="m-0 overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white p-2">
            <ContentHeader content={content} />
            <img
                alt={content.name.length > 0 ? content.name : "Agent-provided image"}
                className="max-h-[480px] w-auto max-w-full rounded-lg object-contain"
                loading="lazy"
                src={source}
            />
        </figure>
    );
}

function AgentRichContentItem({
    connection,
    content,
    sessionId,
}: {
    readonly connection?: ChannelConnection | undefined;
    readonly content: AgentDisplayContent;
    readonly sessionId?: string | undefined;
}) {
    if (content.type === "image") {
        if (
            (content.uri.length > 0 || content.artifactId.length > 0) &&
            connection !== undefined &&
            sessionId !== undefined
        ) {
            return <RemoteImage connection={connection} content={content} sessionId={sessionId} />;
        }
        if (!SAFE_IMAGE_MIME.test(content.mimeType) || content.data.length === 0) {
            return (
                <div className="rounded-lg border-[0.5px] border-black/8 bg-black/[0.02] p-3 text-xs text-muted-foreground">
                    Image content could not be displayed safely.
                </div>
            );
        }
        return (
            <figure className="m-0 overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white p-2">
                <ContentHeader content={content} />
                <img
                    alt={content.name.length > 0 ? content.name : "Agent-provided image"}
                    className="max-h-[480px] w-auto max-w-full rounded-lg object-contain"
                    loading="lazy"
                    src={`data:${content.mimeType};base64,${content.data}`}
                />
            </figure>
        );
    }
    if (content.type === "diff") {
        return (
            <section className="overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white">
                <div className="border-b-[0.5px] border-black/7 px-3 pt-2">
                    <ContentHeader content={content} />
                </div>
                <div className="grid max-h-96 overflow-auto font-mono text-[11px] leading-[18px] md:grid-cols-2">
                    <pre className="m-0 whitespace-pre-wrap bg-[#fff4f2] p-3 text-[#8f2f35] [overflow-wrap:anywhere]">
                        {content.oldText}
                    </pre>
                    <pre className="m-0 whitespace-pre-wrap bg-[#effaf4] p-3 text-[#17663f] [overflow-wrap:anywhere]">
                        {content.newText}
                    </pre>
                </div>
            </section>
        );
    }
    if (content.type === "resource_link") {
        const href = safeLink(content.uri);
        return (
            <div className="rounded-lg border-[0.5px] border-black/9 bg-white p-3">
                <ContentHeader content={content} />
                {href.length > 0 ? (
                    <a
                        className="inline-flex min-h-11 items-center gap-1.5 break-all text-xs font-medium text-success underline decoration-primary/40 underline-offset-2 hover:decoration-success focus-visible:ring-2 focus-visible:ring-ring/70 md:min-h-9"
                        href={href}
                        rel="noreferrer"
                        target="_blank"
                    >
                        {content.text.length > 0 ? content.text : href}
                        <ExternalLink className="size-3 shrink-0" />
                    </a>
                ) : (
                    <code className="break-all text-[11px] text-muted-foreground">{content.uri}</code>
                )}
            </div>
        );
    }
    if (content.type === "terminal") {
        return (
            <section className="overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-[#17191d] text-[#e6e8eb]">
                <div className="px-3 pt-2 text-[#aeb5bc]">
                    <ContentHeader content={content} />
                </div>
                <pre className="m-0 max-h-80 overflow-auto px-3 pb-3 font-mono text-[11px] leading-[18px] whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {content.text}
                </pre>
            </section>
        );
    }
    if (content.type === "text") {
        return (
            <div className="rounded-lg border-[0.5px] border-black/8 bg-white px-3 py-2">
                <AgentMarkdown markdown={content.text} streaming={false} />
            </div>
        );
    }
    return (
        <section className="rounded-xl border-[0.5px] border-black/9 bg-white p-3">
            <ContentHeader content={content} />
            {content.text.length > 0 && (
                <pre className="m-0 max-h-80 overflow-auto font-mono text-[11px] leading-[18px] whitespace-pre-wrap text-[#555c68] [overflow-wrap:anywhere]">
                    {content.text}
                </pre>
            )}
            {content.uri.length > 0 && (
                <code className="mt-2 block break-all text-[10px] text-muted-foreground">{content.uri}</code>
            )}
        </section>
    );
}

export function AgentRichContent({
    connection,
    contents,
    sessionId,
}: {
    readonly connection?: ChannelConnection | undefined;
    readonly contents: readonly AgentDisplayContent[];
    readonly sessionId?: string | undefined;
}) {
    if (contents.length === 0) {
        return null;
    }
    return (
        <div className="mt-2 grid gap-2">
            {contents.map((content, index) => (
                <AgentRichContentItem
                    connection={connection}
                    content={content}
                    key={`${content.type}:${content.name}:${content.uri}:${content.artifactId}:${index.toString()}`}
                    sessionId={sessionId}
                />
            ))}
        </div>
    );
}
