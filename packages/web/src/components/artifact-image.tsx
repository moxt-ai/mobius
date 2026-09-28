import { useEffect, useState } from "react";

import type { ChannelConnection } from "@/domain/channel";
import { readSessionArtifactBytes } from "@/services/pairing-api";

export const SAFE_IMAGE_MIME = /^image\/(?:gif|jpeg|png|webp)$/;

/**
 * Resolves an uploaded artifact into an object URL, revoking it when the artifact changes or the
 * component unmounts. Returns an empty string while loading, or when the artifact cannot be shown.
 */
export function useArtifactImageSource(
    connection: ChannelConnection | undefined,
    sessionId: string | undefined,
    artifactId: string,
): string {
    const [source, setSource] = useState("");
    useEffect(() => {
        setSource("");
        if (connection === undefined || sessionId === undefined || artifactId.length === 0) {
            return;
        }
        const controller = new AbortController();
        let objectUrl = "";
        void readSessionArtifactBytes(connection, sessionId, artifactId, controller.signal)
            .then((artifact) => {
                if (controller.signal.aborted || !SAFE_IMAGE_MIME.test(artifact.mimeType)) {
                    return;
                }
                objectUrl = URL.createObjectURL(
                    new Blob([Uint8Array.from(artifact.bytes)], { type: artifact.mimeType }),
                );
                setSource(objectUrl);
            })
            .catch(() => {
                if (!controller.signal.aborted) {
                    setSource("");
                }
            });
        return () => {
            controller.abort();
            if (objectUrl.length > 0) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [connection, sessionId, artifactId]);
    return source;
}
