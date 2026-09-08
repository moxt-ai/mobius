import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runAcpPrompt } from "../src/acp/run-prompt.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

describe("ACP prompt boundary", () => {
    it("Given an ACP agent emits reasoning and tool updates, When a prompt runs, Then the client observes details and final text", async () => {
        const chunks: string[] = [];
        const activities: Array<{
            readonly activityType: string;
            readonly input: string;
            readonly locations: readonly string[];
            readonly output: string;
            readonly status: string;
            readonly title: string;
        }> = [];
        const cancellation = new AbortController();

        const result = await runAcpPrompt({
            agentArguments: [fakeAgentPath],
            agentCommand: process.execPath,
            cwd: process.cwd(),
            onActivity: (activity) => {
                activities.push(activity);
                return Promise.resolve();
            },
            onText: (text) => {
                chunks.push(text);
                return Promise.resolve();
            },
            prompt: "hello from browser",
            signal: cancellation.signal,
        });

        expect(chunks).toEqual(["Echo from ACP: ", "hello from browser"]);
        expect(activities).toMatchObject([
            {
                activityType: "progress",
                output: "Gathering context",
                status: "running",
                title: "Progress update",
            },
            {
                activityType: "progress",
                output: "Gathering context",
                status: "completed",
                title: "Progress update",
            },
            {
                activityType: "reasoning",
                output: "Inspecting ",
                status: "running",
                title: "Reasoning",
            },
            {
                activityType: "reasoning",
                output: "Inspecting the workspace",
                status: "running",
                title: "Reasoning",
            },
            {
                activityType: "reasoning",
                output: "Inspecting the workspace",
                status: "completed",
                title: "Reasoning",
            },
            {
                activityType: "tool",
                input: '{\n  "path": "package.json"\n}',
                locations: [`${process.cwd()}/package.json`],
                output: "",
                status: "running",
                title: "Read package metadata",
            },
            {
                activityType: "tool",
                input: '{\n  "path": "package.json"\n}',
                locations: [`${process.cwd()}/package.json`],
                output: '{\n  "name": "mobius-workspace"\n}',
                status: "completed",
                title: "Read package metadata",
            },
        ]);
        expect(result.stopReason).toBe("end_turn");
    });
});
