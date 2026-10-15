import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { AcpSessionEventStoreV2 } from "../../acp/session-event-store-v2.ts";
import { nativeHistoryEventsV2 } from "../../native-sessions/native-history-events-v2.ts";
import { AcpHarnessAdapter } from "../acp-harness-adapter.ts";
import type {
    HarnessHistoryPreviewRequest,
    HarnessHistoryRequest,
    HarnessNativeHistoryReader,
} from "../harness-adapter.ts";
import { readCodexFullHistory } from "./history.ts";

export class CodexHarnessAdapter extends AcpHarnessAdapter {
    readonly #nativeHistory: HarnessNativeHistoryReader;

    constructor(
        events: AcpSessionEventStoreV2,
        nativeHistory: HarnessNativeHistoryReader = {
            access: (options) => ({
                kind: "direct",
                read: async (nativeSessionId, nativeTurn) =>
                    (
                        await readCodexFullHistory(
                            options.agent,
                            options.cwd,
                            nativeSessionId,
                            options.signal,
                            nativeTurn,
                        )
                    ).history,
            }),
        },
    ) {
        super("codex", events);
        this.#nativeHistory = nativeHistory;
    }

    override readonly readHistory = async (request: HarnessHistoryRequest) => {
        const access = this.#nativeHistory.access(request.options);
        return access.kind === "direct"
            ? await access.read(request.nativeSessionId, request.nativeTurn)
            : await request.readFromHarness();
    };

    override readonly previewPageHistoryEvents = async (request: HarnessHistoryPreviewRequest) => {
        const access = this.#nativeHistory.access(request.options);
        if (access.kind === "acp") {
            return await request.readFromHarness();
        }
        const history = await access.read(request.nativeSessionId, () => null);
        if (history.status === "unavailable") {
            throw new AcpExecutionError(history.cause.message, {}, history.cause.code);
        }
        return nativeHistoryEventsV2(
            request.options.sessionId,
            request.nativeSessionId,
            history,
            request.eventLimit,
            request.cursor,
            this.events,
        );
    };
}
