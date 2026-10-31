/** The entries a Mobius state root owns at its top level. */
export const STATE_ROOT_LAYOUT = Object.freeze({
    /** Names the shared data container in the format understood by installed CLIs. */
    currentData: "current-data.txt",
    /** Applications' installations: `installations/<application>/<installation>`. */
    installations: "installations",
    /** Existing data containers; executable upgrades reuse the current one. */
    versions: "versions",
});
