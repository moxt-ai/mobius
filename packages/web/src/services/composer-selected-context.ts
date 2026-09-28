export interface ComposerSelectedContextCounts {
    readonly additionalDirectoryCount: number;
    readonly imageCount: number;
    readonly resourceCount: number;
}

export function hasSelectedComposerContext({
    additionalDirectoryCount,
    imageCount,
    resourceCount,
}: ComposerSelectedContextCounts): boolean {
    return additionalDirectoryCount + imageCount + resourceCount > 0;
}
