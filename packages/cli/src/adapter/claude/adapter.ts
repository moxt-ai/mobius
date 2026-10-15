import type { AcpSessionEventStoreV2 } from "../../acp/session-event-store-v2.ts";
import { AcpHarnessAdapter } from "../acp-harness-adapter.ts";

export class ClaudeHarnessAdapter extends AcpHarnessAdapter {
    constructor(events: AcpSessionEventStoreV2) {
        super("claude", events);
    }
}
