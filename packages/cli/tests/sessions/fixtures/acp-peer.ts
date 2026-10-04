import * as acp from "@agentclientprotocol/sdk";
import { registerInitialization } from "../../runtime/fixtures/acp-initialize.ts";
import { readableWebStream, writableWebStream } from "../../support/acp-process.ts";
import { registerHistory } from "./acp-native-history.ts";
import { registerNativeSessions } from "./acp-native-sessions.ts";
import { registerSettings } from "./acp-session-settings.ts";
import { registerTurns } from "./acp-turns.ts";

// Private subprocess fixture: real daemon + controlled ACP peer, never an Agent compatibility test.
const agent = acp.agent({ name: "controlled-acp-peer" });
registerInitialization(agent);
registerNativeSessions(agent);
registerHistory(agent);
registerSettings(agent);
registerTurns(agent);
agent.connect(acp.ndJsonStream(writableWebStream(process.stdout), readableWebStream(process.stdin)));
