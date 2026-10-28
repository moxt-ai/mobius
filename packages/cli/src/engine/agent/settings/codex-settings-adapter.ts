import { AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE } from "@moxt-ai/mobius-sdk/protocol";
import { AgentSettingsAdapter } from "./agent-settings-base.ts";

export class CodexSettingsAdapter extends AgentSettingsAdapter {
    override readonly modelEffortResolution = AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE;
}
