import { StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk";

import { MobiusExampleOptions, runMobiusExample } from "./workflow.ts";

function requiredEnvironment(name: string): string {
    const value = Reflect.get(process.env, name);
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`The ${name} environment variable is required`);
    }
    return value;
}

const endpoint = requiredEnvironment("MOBIUS_ENDPOINT");
const credential = requiredEnvironment("MOBIUS_CREDENTIAL");
const projectId = requiredEnvironment("MOBIUS_PROJECT_ID");
const runtimeId = requiredEnvironment("MOBIUS_RUNTIME_ID");
const agentId = requiredEnvironment("MOBIUS_AGENT_ID");
const workspaceRef = requiredEnvironment("MOBIUS_WORKSPACE_REF");
const signal = AbortSignal.timeout(120_000);
const result = await runMobiusExample(
    new MobiusExampleOptions(
        endpoint,
        projectId,
        runtimeId,
        agentId,
        workspaceRef,
        new StaticMobiusCredentialProvider(credential),
        (text) => process.stdout.write(text),
    ),
    signal,
);

console.log(`\nTurn ${result.turnId}: ${result.turnState}`);
console.log(`Persisted messages: ${result.messageCount}`);
