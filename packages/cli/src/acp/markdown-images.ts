import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { visit } from "unist-util-visit";
import { type LocalRasterImage, readAuthorizedRaster } from "../authorization/local-raster.ts";

interface MarkdownImage {
    readonly end: number;
    readonly start: number;
    readonly uri: string;
}

function parseMarkdownImages(markdown: string): readonly MarkdownImage[] {
    const images: MarkdownImage[] = [];
    visit(fromMarkdown(markdown), (node: Nodes) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) {
            return;
        }
        if (node.type === "image") {
            images.push({ end, start, uri: node.url });
            return;
        }
        if (
            node.type === "link" &&
            node.children.length === 1 &&
            node.children[0]?.type === "text" &&
            node.children[0].value === "@image"
        ) {
            images.push({ end, start, uri: node.url });
        }
    });
    return images.sort((left, right) => left.start - right.start);
}

export async function emitMarkdownWithLocalImages(options: {
    readonly markdown: string;
    readonly onImage: (image: LocalRasterImage) => Promise<void>;
    readonly onText: (text: string) => Promise<void>;
    readonly roots: readonly string[];
    readonly signal: AbortSignal;
}): Promise<void> {
    let cursor = 0;
    for (const image of parseMarkdownImages(options.markdown)) {
        if (image.start < cursor) {
            continue;
        }
        if (image.start > cursor) {
            await options.onText(options.markdown.slice(cursor, image.start));
        }
        const raster = await readAuthorizedRaster(image.uri, options.roots, options.signal);
        if (raster === null) {
            await options.onText("[Image unavailable]");
        } else {
            await options.onImage(raster);
        }
        cursor = image.end;
    }
    if (cursor < options.markdown.length) {
        await options.onText(options.markdown.slice(cursor));
    }
}
