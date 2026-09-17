import type { PromptImage, PromptResource } from "@moxt-ai/mobius-sdk";

import { cn } from "@/lib/utils";

const SAFE_IMAGE_MIME = /^image\/(?:gif|jpeg|png|webp)$/;

interface UserPromptMessageProps {
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];
    readonly text: string;
}

export function UserPromptMessage({ images, resources, text }: UserPromptMessageProps) {
    return (
        <article
            aria-label="Message from you"
            className="mb-5 flex justify-end motion-safe:animate-[message-enter_200ms_ease-out_both]"
        >
            <div className="min-w-0 max-w-[85%] max-md:max-w-[94%]">
                <div className="grid min-w-0 gap-2 rounded-[18px] rounded-br-[6px] border-[0.5px] border-primary/12 bg-success-subtle px-3.5 py-2.5 text-[15px] leading-6 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] md:px-4 md:py-3">
                    {images.length > 0 && (
                        <div className={cn("grid min-w-0 gap-1.5", images.length > 1 && "grid-cols-2")}>
                            {images.map((image, index) =>
                                SAFE_IMAGE_MIME.test(image.mimeType) ? (
                                    <img
                                        alt={image.name}
                                        className="h-auto max-h-56 max-w-full rounded-lg object-contain object-left"
                                        key={`${index.toString()}:${image.name}`}
                                        loading="lazy"
                                        src={`data:${image.mimeType};base64,${image.data}`}
                                    />
                                ) : (
                                    <span
                                        className="rounded-lg border-[0.5px] border-black/9 bg-white/70 p-2 text-[10px] text-muted-foreground"
                                        key={`${index.toString()}:${image.name}`}
                                    >
                                        {image.name}
                                    </span>
                                ),
                            )}
                        </div>
                    )}
                    {resources.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {resources.map((resource) => (
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
