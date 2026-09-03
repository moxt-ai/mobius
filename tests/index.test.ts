import { describe, expect, test } from "vitest";

import { projectName } from "../src/index.ts";

describe("project initialization", () => {
  test("Given the package is installed, When its entrypoint is imported, Then the project identity is available", () => {
    expect(projectName).toBe("Mobius");
  });
});
