import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "../../src/engine/acp/harness/codex/app-server-client.ts";
import { CodexBorrowedAcpAgent } from "../../src/engine/acp/harness/codex/borrowed-agent.ts";

afterEach(() => {
    vi.useRealTimers();
});

it("Given another Codex client owns the thread, When its turn for this prompt is still running, Then the prompt ends only after the owner completes it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T00:00:00.000Z"));
    // Codex reports the owner's unfinished turn to a reader as "interrupted" without a completion time.
    let ownerTurn: { readonly status: string; readonly completedAt?: number } | null = null;
    let clientId = "";
    const client = {
        request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
            switch (method) {
                case "thread/queue/list":
                    return { data: [], nextCursor: null };
                case "thread/queue/add":
                    clientId = String(params["clientUserMessageId"]);
                    return { queuedSubmission: { id: "queued", clientUserMessageId: clientId } };
                case "thread/turns/list":
                    return {
                        data:
                            ownerTurn === null
                                ? []
                                : [
                                      {
                                          id: "owner-turn",
                                          ...ownerTurn,
                                          items: [
                                              {
                                                  type: "userMessage",
                                                  id: "user",
                                                  clientId,
                                                  content: [{ type: "text", text: "Plan it" }],
                                              },
                                          ],
                                      },
                                  ],
                        nextCursor: null,
                    };
                default:
                    throw new Error(`Unexpected Codex request ${method}`);
            }
        },
    } as unknown as CodexAppServerClient;
    const agent = new CodexBorrowedAcpAgent(client, "thread", async () => {});
    await agent.initialize(AbortSignal.timeout(60_000));

    let settled = false;
    const prompt = agent
        .prompt([{ type: "text", text: "Plan it" }], AbortSignal.timeout(60_000), [{ type: "text", text: "Plan it" }])
        .finally(() => {
            settled = true;
        });
    await vi.advanceTimersByTimeAsync(0);
    ownerTurn = { status: "interrupted" };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);

    ownerTurn = { status: "completed", completedAt: Date.now() };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await prompt).toMatchObject({ stopReason: "end_turn" });
    await agent.close();
});
