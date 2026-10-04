import { expect, it } from "vitest";
import { completeAcpControls, createControlledSession } from "./acp-controls-fixture.ts";

it("Given image and embedded context input, When ACP returns structured tool content and an inline image, Then prompt blocks and output types survive the boundary", async () => {
    await using session = await createControlledSession();
    const result = await completeAcpControls(session);
    expect(result.completed).toEqual({ stopReason: "end_turn" });
    expect(result.text).toContain("1 image, 1 resource");
    expect(session.observer.content.at(-1)?.content).toMatchObject({ mimeType: "image/png", type: "image" });
    expect(result.activityContent).toContain("diff");
    expect(result.activityContent).toContain("resource");
    expect(session.observer.information.at(-1)).toMatchObject({
        title: "ACP feature session",
        updatedAt: "2026-09-04T00:01:00.000Z",
    });
});
