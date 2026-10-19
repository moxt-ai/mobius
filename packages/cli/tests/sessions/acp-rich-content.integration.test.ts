import { expect, it } from "vitest";
import { completeAcpControls, createControlledSession } from "./acp-controls-fixture.ts";

it("Given image and embedded context input, When ACP returns structured tool content and an inline image, Then prompt blocks and output types survive the boundary", async () => {
    await using session = await createControlledSession();
    const result = await completeAcpControls(session);
    expect(result.completed).toEqual({ stopReason: "end_turn" });
    expect(result.text).toContain("1 image, 1 resource");
    expect(
        session.observer
            .acpUpdates()
            .findLast(
                (update) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "external_image",
            ),
    ).toMatchObject({
        content: { byteLength: 68, type: "external_image" },
        sessionUpdate: "agent_message_chunk",
    });
    expect(
        session.observer.acpUpdates().findLast((update) => {
            if (update.sessionUpdate !== "tool_call_update") {
                return false;
            }
            return (update.content ?? []).some(
                (item) =>
                    item.type === "content" &&
                    item.content.type === "external_resource" &&
                    item.content.uri === "resource:///tool-result.txt",
            );
        }),
    ).toBeDefined();
    expect(
        session.observer
            .acpUpdates()
            .some(
                (update) =>
                    update.sessionUpdate === "tool_call_update" &&
                    (update.content ?? []).some((item) => item.type === "diff"),
            ),
    ).toBe(true);
    expect(session.observer.information.at(-1)).toMatchObject({
        title: "ACP feature session",
        updatedAt: "2026-09-04T00:01:00.000Z",
    });
});
