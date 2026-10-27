/**
 * The entries a Mobius state root owns at its top level. Installation data never uses these names, so finding one
 * inside an installation means an earlier Mobius ran with that installation as its root.
 */
export const STATE_ROOT_LAYOUT = Object.freeze({
    /** Names the version whose data is current. */
    currentData: "current-data.txt",
    /** Applications' installations: `installations/<application>/<installation>`. */
    installations: "installations",
    /** Managed CLI releases: `npm/<version>`. */
    releases: "npm",
    /** Each CLI version's data: `versions/<version>`. */
    versions: "versions",
});

export const STATE_ROOT_ENTRY_NAMES: ReadonlySet<string> = new Set(Object.values(STATE_ROOT_LAYOUT));
