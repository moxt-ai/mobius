import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Response } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    downloadVerifiedFile,
    type InstallerDownloadTransport,
} from "../../../packages/cli/src/agent-installation/verified-download.ts";

type DownloadScenario = "allowed-redirect" | "leaving-allowlist";

// Real installer endpoints are mutable third-party services. This stateful fake
// implements the production transport port while the filesystem boundary and
// streamed Response body remain real.
class StatefulInstallerProvider implements InstallerDownloadTransport {
    readonly #scenario: DownloadScenario;
    #requestCount = 0;

    constructor(scenario: DownloadScenario) {
        this.#scenario = scenario;
    }

    readonly get = (url: URL, signal: AbortSignal): Promise<Response> => {
        signal.throwIfAborted();
        this.#requestCount += 1;
        if (
            this.#scenario === "leaving-allowlist" &&
            this.#requestCount === 1 &&
            url.toString() === "https://vendor.example/install.sh"
        ) {
            return Promise.resolve(
                new Response(null, {
                    headers: { location: "https://outside.example/install.sh" },
                    status: 302,
                }),
            );
        }
        if (
            this.#scenario === "allowed-redirect" &&
            this.#requestCount === 1 &&
            url.toString() === "https://vendor.example/install.sh"
        ) {
            return Promise.resolve(
                new Response(null, {
                    headers: { location: "https://downloads.vendor.example/install.sh" },
                    status: 302,
                }),
            );
        }
        if (
            this.#scenario === "allowed-redirect" &&
            this.#requestCount === 2 &&
            url.toString() === "https://downloads.vendor.example/install.sh"
        ) {
            return Promise.resolve(new Response("verified installer\n", { status: 200 }));
        }
        return Promise.resolve(new Response(null, { status: 500 }));
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("verified installer downloads", () => {
    it("Given an installer redirects outside its recipe allowlist, When Mobius follows it, Then download fails before a file is published", async () => {
        vi.useFakeTimers({ now: new Date("2026-09-04T00:00:00.000Z") });
        const directory = await mkdtemp(join(tmpdir(), "mobius-download-denied-"));
        const destination = join(directory, "install.sh");
        const transport = new StatefulInstallerProvider("leaving-allowlist");
        try {
            await expect(
                downloadVerifiedFile(
                    {
                        allowedHosts: new Set(["vendor.example"]),
                        destination,
                        maximumBytes: 1_024,
                        signal: new AbortController().signal,
                        timeoutMilliseconds: 5_000,
                        url: new URL("https://vendor.example/install.sh"),
                    },
                    transport,
                ),
            ).rejects.toMatchObject({ code: "installer_redirect_not_allowed" });
            await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it.skipIf(process.platform === "win32")(
        "Given every redirect remains allowlisted, When the bounded download completes, Then Mobius publishes a private file and records its digest",
        async () => {
            vi.useFakeTimers({ now: new Date("2026-09-04T00:00:00.000Z") });
            const directory = await mkdtemp(join(tmpdir(), "mobius-download-allowed-"));
            const destination = join(directory, "install.sh");
            const transport = new StatefulInstallerProvider("allowed-redirect");
            try {
                const result = await downloadVerifiedFile(
                    {
                        allowedHosts: new Set(["vendor.example", "downloads.vendor.example"]),
                        destination,
                        maximumBytes: 1_024,
                        signal: new AbortController().signal,
                        timeoutMilliseconds: 5_000,
                        url: new URL("https://vendor.example/install.sh"),
                    },
                    transport,
                );

                expect(await readFile(destination, "utf8")).toBe("verified installer\n");
                expect((await stat(destination)).mode & 0o777).toBe(0o600);
                expect(result).toMatchObject({
                    bytes: 19,
                    sha256: "e6573f9c7196248c7cf243928d24835d292469b7e5c1ed1f0b426074d6012953",
                });
                expect(result.url.toString()).toBe("https://downloads.vendor.example/install.sh");
            } finally {
                await rm(directory, { force: true, recursive: true });
            }
        },
    );
});
