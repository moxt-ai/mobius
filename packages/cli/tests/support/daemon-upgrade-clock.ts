// Test-only Node preload: drive the real daemon's hourly timer without sleeping.
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { mock } from "node:test";

if (process.argv.includes("__worker") || process.argv.includes("__manager")) {
    mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2030-01-01T00:00:00Z") });
    const server = createServer((request, response) => {
        mock.timers.tick(Number(request.url?.slice(1)));
        response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Clock server did not listen");
    }
    const directory = process.env["MOBIUS_TEST_CLOCK_DIRECTORY"];
    if (directory === undefined) {
        throw new Error("Missing test clock directory");
    }
    await writeFile(join(directory, `${process.pid}.clock`), String(address.port));
    server.unref();
}
