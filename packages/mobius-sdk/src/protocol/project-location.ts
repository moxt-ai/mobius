export const PROJECT_LOCATION_HINTS: readonly [
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
] = ["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"];

export type ProjectLocationHint = (typeof PROJECT_LOCATION_HINTS)[number];

const projectLocationHints: ReadonlySet<unknown> = new Set(PROJECT_LOCATION_HINTS);

export function isProjectLocationHint(value: unknown): value is ProjectLocationHint {
    return projectLocationHints.has(value);
}
