import { describe, expect, it } from "vitest";

import { validateInstallableAgents } from "../src/pairing-directory.ts";

describe("installable Agent directory", () => {
  it("Given a local capability grant, When the catalog crosses the Relay boundary, Then the sanitized no-prompt status is preserved", () => {
    expect(
      validateInstallableAgents([
        {
          id: "codex",
          label: "Codex",
          requiresLocalApproval: false,
        },
      ]),
    ).toEqual([
      {
        id: "codex",
        label: "Codex",
        requiresLocalApproval: false,
      },
    ]);
  });
});
