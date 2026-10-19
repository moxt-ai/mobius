import { describe, expect, expectTypeOf, it } from "vitest";
import { isProjectLocationHint, PROJECT_LOCATION_HINTS, type ProjectLocationHint } from "../../src/protocol/index.ts";

describe("Project location protocol contract", () => {
    it("Given Project location values, When they are checked, Then only the published location hints are accepted", () => {
        expect(PROJECT_LOCATION_HINTS).toEqual([
            "wnam",
            "enam",
            "sam",
            "weur",
            "eeur",
            "apac",
            "apac-ne",
            "apac-se",
            "oc",
            "afr",
            "me",
        ]);
        expect(PROJECT_LOCATION_HINTS.every(isProjectLocationHint)).toBe(true);
        expect(isProjectLocationHint("moon")).toBe(false);
        expect(isProjectLocationHint(null)).toBe(false);
        expectTypeOf<(typeof PROJECT_LOCATION_HINTS)[number]>().toEqualTypeOf<ProjectLocationHint>();
    });
});
