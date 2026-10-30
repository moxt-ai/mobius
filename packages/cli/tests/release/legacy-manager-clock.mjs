import { readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";

// Only the released worker's clock is controlled. npm, the manager, the new
// daemon, IPC and filesystem operations retain their real implementations.
if (process.argv[2] === "__worker" && process.env.MOBIUS_TEST_LEGACY_CLOCK) {
    const metadata = JSON.parse(readFileSync(join(dirname(process.argv[1]), "../package.json"), "utf8"));
    if (metadata.version === "0.0.381") {
        const { mock } = await import("node:test");
        mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-30T00:00:00Z") });
        const watcher = watch(process.env.MOBIUS_TEST_LEGACY_CLOCK, () => {
            watcher.close();
            mock.timers.tick(3_600_000);
        });
        process.once("disconnect", () => watcher.close());
    }
}
