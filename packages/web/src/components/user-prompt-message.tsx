import type { PromptImage, PromptResource } from "@moxt-ai/mobius-sdk";

import { SAFE_IMAGE_MIME, useArtifactImageSource } from "@/components/artifact-image";
import type { ChannelConnection } from "@/domain/channel";
import { cn } from "@/lib/utils";
import { artifactIdFromUri } from "@/services/pairing-api";

/**
 * How a prompt was delivered to the conversation. An ordinary prompt is the default bubble; a steered
 * prompt was injected into a Turn that was already running, so it is labelled and outlined to stand apart
 * from one that started its own Turn. The label is words as well as colour, so the distinction does not
 * depend on colour perception.
 */
export type PromptDelivery = { readonly kind: "sent" } | { readonly kind: "steered" };

const DELIVERY_LABELS: Readonly<Record<PromptDelivery["kind"], string>> = Object.freeze({
    sent: "",
    steered: "Steered into the running turn",
});

const DELIVERY_BUBBLE_CLASSES: Readonly<Record<PromptDelivery["kind"], string>> = Object.freeze({
    sent: "border-primary/12 bg-success-subtle text-foreground",
    steered: "border-primary/35 bg-success-subtle text-foreground",
});

interface UserPromptMessageProps {
    readonly connection?: ChannelConnection | undefined;
    readonly delivery?: PromptDelivery;
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];
    readonly sessionId?: string | undefined;
    readonly text: string;
}

const IMAGE_CLASS_NAME = "h-auto max-h-56 max-w-full rounded-lg object-contain object-left";

function InlineImage({ image }: { readonly image: PromptImage }) {
    if (!SAFE_IMAGE_MIME.test(image.mimeType)) {
        return <AttachmentChip name={image.name} />;
    }
    return (
        <img
            alt={image.name}
            className={IMAGE_CLASS_NAME}
            loading="lazy"
            src={`data:${image.mimeType};base64,${image.data}`}
        />
    );
}

/**
 * Images sent through the public artifact API do not come back inline: the Relay records the Turn with
 * an empty `images` list and an image-typed `link` resource pointing at the uploaded artifact. Resolving
 * that link is what keeps the picture visible after a reload instead of degrading to a filename.
 */
function ArtifactImage({
    connection,
    resource,
    sessionId,
}: {
    readonly connection: ChannelConnection | undefined;
    readonly resource: PromptResource;
    readonly sessionId: string | undefined;
}) {
    const source = useArtifactImageSource(connection, sessionId, artifactIdFromUri(resource.uri));
    if (source.length === 0) {
        return <AttachmentChip name={resource.name} />;
    }
    return <img alt={resource.name} className={IMAGE_CLASS_NAME} loading="lazy" src={source} />;
}

function AttachmentChip({ name }: { readonly name: string }) {
    return (
        <span className="rounded-lg border-[0.5px] border-black/9 bg-white/70 p-2 text-[10px] text-muted-foreground">
            {name}
        </span>
    );
}

export function UserPromptMessage({
    connection,
    delivery = { kind: "sent" },
    images,
    resources,
    sessionId,
    text,
}: UserPromptMessageProps) {
    // Inline images cover the optimistic send and native history; image resources cover a reload.
    const shownInline = new Set(images.map((image) => image.name));
    const isRestoredImage = (resource: PromptResource): boolean =>
        SAFE_IMAGE_MIME.test(resource.mimeType) && !shownInline.has(resource.name);
    const imageResources = resources.filter(isRestoredImage);
    const otherResources = resources.filter((resource) => !isRestoredImage(resource));
    const attachmentCount = images.length + imageResources.length;
    const deliveryLabel = DELIVERY_LABELS[delivery.kind];
    return (
        <article
            aria-label="Message from you"
            className="mb-5 flex justify-end motion-safe:animate-[message-enter_200ms_ease-out_both]"
            data-delivery={delivery.kind}
        >
            <div className="min-w-0 max-w-[85%] max-md:max-w-[94%]">
                <div
                    className={cn(
                        "grid min-w-0 gap-2 rounded-[18px] border-[0.5px] px-3.5 py-2.5 text-[15px] leading-6 whitespace-pre-wrap [overflow-wrap:anywhere] md:px-4 md:py-3",
                        DELIVERY_BUBBLE_CLASSES[delivery.kind],
                    )}
                >
                    {deliveryLabel.length > 0 && (
                        <span className="text-[10px] leading-4 font-semibold tracking-[0.04em] text-copy-tertiary uppercase">
                            {deliveryLabel}
                        </span>
                    )}
                    {attachmentCount > 0 && (
                        <div className={cn("grid min-w-0 gap-1.5", attachmentCount > 1 && "grid-cols-2")}>
                            {images.map((image, index) => (
                                <InlineImage image={image} key={`${index.toString()}:${image.name}`} />
                            ))}
                            {imageResources.map((resource, index) => (
                                <ArtifactImage
                                    connection={connection}
                                    key={`${index.toString()}:${resource.name}`}
                                    resource={resource}
                                    sessionId={sessionId}
                                />
                            ))}
                        </div>
                    )}
                    {otherResources.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {otherResources.map((resource) => (
                                <span
                                    className="rounded-md border-[0.5px] border-black/10 bg-white/70 px-2 py-1 font-mono text-[10px]"
                                    key={`${resource.uri}:${resource.name}`}
                                >
                                    {resource.name}
                                </span>
                            ))}
                        </div>
                    )}
                    {text.length > 0 && <span>{text}</span>}
                </div>
            </div>
        </article>
    );
}
