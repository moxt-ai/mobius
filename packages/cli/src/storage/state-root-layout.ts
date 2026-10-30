/** The entries a Mobius state root owns at its top level. */
export const STATE_ROOT_LAYOUT = Object.freeze({
    /** Names the version whose data is current. */
    currentData: "current-data.txt",
    /** Applications' installations: `installations/<application>/<installation>`. */
    installations: "installations",
    /** Each CLI version's data: `versions/<version>`. */
    versions: "versions",
});
