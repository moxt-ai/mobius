import { type ChildProcess, fork } from "node:child_process";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import {
    createProbeOutput,
    ensureProbeDirectory,
    removeProbeState,
    writeProbeEvents,
    writeProbeReport,
} from "../../../storage/diagnostics/relay-probe-files.ts";
import type { CliContext } from "../../context.ts";
import {
    configuredProbeProxy,
    failureCode,
    RelayProbeError,
    type RelayProbeRole,
    readProbeConfiguration,
} from "./config.ts";
import { type RouteEvidence, routeEvidenceSchema } from "./routes.ts";
import { runRelayProbeWorker } from "./worker.ts";

const workerMessage = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("prepared"),
        role: z.enum(["direct", "proxy"]),
        channelId: z.string(),
        runtimeId: z.string(),
        routesBefore: z.array(routeEvidenceSchema),
    }),
    z.object({
        kind: z.literal("status"),
        role: z.enum(["direct", "proxy"]),
        status: z.string(),
        timestamp: z.string(),
    }),
    z.object({
        kind: z.literal("finished"),
        role: z.enum(["direct", "proxy"]),
        routesAfter: z.array(routeEvidenceSchema),
    }),
    z.object({
        kind: z.literal("failed"),
        role: z.enum(["direct", "proxy"]),
        code: z.string(),
        details: z.record(z.string(), z.string()),
        routesBefore: z.array(routeEvidenceSchema),
    }),
]);

interface LegReport {
    readonly role: RelayProbeRole;
    readonly channelId: string;
    readonly runtimeId: string;
    readonly onlineCount: number;
    readonly routesBefore: readonly RouteEvidence[];
    readonly routesAfter: readonly RouteEvidence[];
    readonly transportFailures: readonly Readonly<Record<string, string>>[];
    readonly preparationFailures: readonly Readonly<Record<string, string>>[];
    readonly disconnects: readonly Readonly<Record<string, string>>[];
    readonly exitCode: number | null;
    readonly omittedEvents: number;
}

class ProbeLeg {
    readonly role: RelayProbeRole;
    readonly #child: ChildProcess;
    readonly #directory: string;
    readonly #prepared = Promise.withResolvers<{ readonly channelId: string; readonly runtimeId: string }>();
    readonly closed: Promise<number | null>;
    #channelId = "";
    #runtimeId = "";
    #routesBefore: readonly RouteEvidence[] = [];
    #routesAfter: readonly RouteEvidence[] = [];
    #onlineCount = 0;
    #lastStatus = "starting";
    readonly #events: Readonly<Record<string, string>>[] = [];
    readonly #preparationFailures: Readonly<Record<string, string>>[] = [];
    #omittedEvents = 0;

    constructor(role: RelayProbeRole, config: string, directory: string, proxy: URL) {
        this.role = role;
        this.#directory = directory;
        const entrypoint = process.argv[1];
        if (entrypoint === undefined) {
            throw new RelayProbeError("probe_entrypoint_missing", "Cannot locate the Mobius CLI entrypoint");
        }
        const environment: NodeJS.ProcessEnv = {
            HOME: join(directory, "home"),
            PATH: process.env["PATH"] ?? "",
            MOBIUS_STATE_DIRECTORY: join(directory, "state"),
        };
        for (const name of [
            "SystemRoot",
            "WINDIR",
            "TMPDIR",
            "TMP",
            "TEMP",
            "NODE_EXTRA_CA_CERTS",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ]) {
            if (process.env[name] !== undefined) {
                environment[name] = process.env[name];
            }
        }
        environment["NO_PROXY"] = environment["no_proxy"] = role === "direct" ? "*" : "";
        if (role === "proxy") {
            environment["HTTPS_PROXY"] = environment["HTTP_PROXY"] = proxy.href;
        }
        this.#child = fork(
            resolve(entrypoint),
            ["_relay-probe-worker", "--config", config, "--role", role, "--directory", directory],
            { env: environment, silent: true, windowsHide: true },
        );
        this.#child.stdout?.resume();
        let pending = "";
        this.#child.stderr?.on("data", (data: Buffer) => {
            pending += data.toString();
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
                if (line.startsWith("Mobius relay diagnostic ")) {
                    process.stderr.write(`${role}: ${line}\n`);
                    try {
                        const event = z
                            .record(z.string(), z.string())
                            .safeParse(JSON.parse(line.slice("Mobius relay diagnostic ".length)));
                        if (event.success && event.data["channelId"] === this.#channelId) {
                            this.#events.push(event.data);
                            if (this.#events.length > 2_000) {
                                this.#events.shift();
                                this.#omittedEvents += 1;
                            }
                        }
                    } catch {
                        // Only complete diagnostic JSON lines enter the report.
                    }
                }
            }
            if (pending.length > 32_768) {
                pending = "";
            }
        });
        this.#child.on("message", (value: unknown) => {
            const message = workerMessage.safeParse(value);
            if (!message.success || message.data.role !== role) {
                return;
            }
            const event = message.data;
            switch (event.kind) {
                case "prepared":
                    this.#channelId = event.channelId;
                    this.#runtimeId = event.runtimeId;
                    this.#routesBefore = event.routesBefore;
                    this.#prepared.resolve(event);
                    break;
                case "status":
                    if (event.status === "online" && this.#lastStatus !== "online") {
                        this.#onlineCount += 1;
                    }
                    this.#lastStatus = event.status;
                    break;
                case "finished":
                    this.#routesAfter = event.routesAfter;
                    break;
                case "failed":
                    this.#routesBefore = event.routesBefore;
                    this.#preparationFailures.push(event.details);
                    this.#prepared.reject(new RelayProbeError(event.code, `The ${role} probe failed`));
                    break;
            }
        });
        this.closed = new Promise((done) => {
            this.#child.once("error", (error) => {
                this.#prepared.reject(error);
                done(1);
            });
            this.#child.once("close", (code) => {
                this.#prepared.reject(
                    new RelayProbeError("probe_worker_exited", `The ${role} probe exited before preparation`),
                );
                done(code);
            });
        });
        void this.#prepared.promise.catch(() => undefined);
    }

    readonly prepare = async () => await this.#prepared.promise;
    readonly start = (): void => {
        if (this.#child.connected) {
            this.#child.send({ action: "start" }, () => undefined);
        }
    };
    readonly stop = (): void => {
        if (this.#child.connected) {
            this.#child.send({ action: "stop" }, () => undefined);
        }
    };
    readonly kill = (): void => {
        this.#child.kill("SIGKILL");
    };
    readonly report = async (): Promise<LegReport> => {
        const events = this.#events;
        await writeProbeEvents(this.#directory, events);
        return {
            role: this.role,
            channelId: this.#channelId,
            runtimeId: this.#runtimeId,
            onlineCount: this.#onlineCount,
            routesBefore: this.#routesBefore,
            routesAfter: this.#routesAfter,
            transportFailures: events.filter((event) => event["event"] === "relay_transport_failed"),
            preparationFailures: this.#preparationFailures,
            disconnects: events.filter((event) => event["event"] === "relay_connection_closed"),
            exitCode: await this.closed,
            omittedEvents: this.#omittedEvents,
        };
    };
}

async function compare(configPath: string, output: string, duration: number, context: CliContext): Promise<void> {
    const config = await readProbeConfiguration(configPath, context.shutdownSignal);
    const proxy = configuredProbeProxy();
    const directory = resolve(output);
    await createProbeOutput(directory);
    const legs: ProbeLeg[] = [];
    let startedAt: string | null = null;
    let endedAt: string | null = null;
    let completed = false;
    let failure: string | null = null;
    const deadline = AbortSignal.timeout(60_000);
    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    let abortPreparation = (): void => undefined;
    try {
        for (const role of ["direct", "proxy"] as const) {
            context.shutdownSignal.throwIfAborted();
            const legDirectory = join(directory, role);
            await ensureProbeDirectory(join(legDirectory, "home"));
            legs.push(new ProbeLeg(role, resolve(configPath), legDirectory, proxy));
        }
        const cancelled = Promise.withResolvers<never>();
        context.shutdownSignal.throwIfAborted();
        abortPreparation = (): void =>
            cancelled.reject(new RelayProbeError("probe_cancelled", "Relay comparison preparation was cancelled"));
        context.shutdownSignal.addEventListener("abort", abortPreparation, { once: true });
        deadline.addEventListener("abort", abortPreparation, { once: true });
        const prepared = await Promise.race([Promise.all(legs.map((leg) => leg.prepare())), cancelled.promise]);
        context.shutdownSignal.throwIfAborted();
        if (prepared[0]?.channelId === prepared[1]?.channelId || prepared[0]?.runtimeId === prepared[1]?.runtimeId) {
            throw new RelayProbeError(
                "probe_runtime_reused",
                "The Relay returned the same Runtime for distinct pairings",
            );
        }
        context.shutdownSignal.removeEventListener("abort", abortPreparation);
        deadline.removeEventListener("abort", abortPreparation);
        startedAt = new Date().toISOString();
        const finish = Promise.withResolvers<void>();
        const stop = (): void => finish.resolve();
        context.shutdownSignal.addEventListener("abort", stop, { once: true });
        durationTimer = setTimeout(() => {
            completed = true;
            finish.resolve();
        }, duration * 1_000);
        for (const leg of legs) {
            leg.start();
        }
        try {
            await Promise.race([
                finish.promise,
                ...legs.map((leg) =>
                    leg.closed.then(() => {
                        throw new RelayProbeError(
                            "probe_worker_exited",
                            `The ${leg.role} probe exited during comparison`,
                        );
                    }),
                ),
            ]);
        } finally {
            context.shutdownSignal.removeEventListener("abort", stop);
        }
    } catch (error) {
        if (!context.shutdownSignal.aborted) {
            failure = failureCode(error);
            process.exitCode = 1;
        }
    } finally {
        endedAt = new Date().toISOString();
        if (durationTimer !== undefined) {
            clearTimeout(durationTimer);
        }
        context.shutdownSignal.removeEventListener("abort", abortPreparation);
        deadline.removeEventListener("abort", abortPreparation);
        for (const leg of legs) {
            leg.stop();
        }
        const force = setTimeout(() => {
            for (const leg of legs) {
                leg.kill();
            }
        }, 10_000);
        try {
            await Promise.all(legs.map((leg) => leg.closed));
            const reports = await Promise.all(legs.map((leg) => leg.report()));
            if (reports.some((leg) => leg.exitCode !== 0 || leg.onlineCount === 0)) {
                process.exitCode = 1;
                failure ??= "probe_not_ready";
            }
            const report = {
                version: context.version,
                targetOrigin: new URL(config.relayOrigin).origin,
                proxyOrigin: proxy.origin,
                requestedDurationSeconds: duration,
                startedAt,
                endedAt,
                completed,
                failure,
                directMeans: "No explicit HTTP proxy; operating-system TUN/VPN routing still applies",
                legs: reports,
            };
            await writeProbeReport(directory, report);
            process.stdout.write(`${join(directory, "report.json")}\n`);
        } finally {
            clearTimeout(force);
            await Promise.all(legs.map((leg) => removeProbeState(join(directory, leg.role))));
        }
    }
}

export function registerDiagnoseCommand(program: Command, context: CliContext): void {
    program
        .command("diagnose")
        .description("collect isolated network diagnostics")
        .command("relay")
        .description("compare fresh direct and proxied Runtime channels over the same observation window")
        .requiredOption(
            "--config <path>",
            "private JSON with relayOrigin and distinct direct/proxy pairingId and pairingCode",
        )
        .requiredOption("--output <directory>", "new directory for sanitized report.json and transport logs")
        .option("--duration <seconds>", "observation duration after both pairings are prepared", "600")
        .action(async (options: { readonly config: string; readonly output: string; readonly duration: string }) => {
            const duration = Number(options.duration);
            if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86_400) {
                throw new RelayProbeError(
                    "probe_duration_invalid",
                    "--duration must be a whole number from 1 to 86400 seconds",
                );
            }
            await compare(options.config, options.output, duration, context);
        });
    program
        .command("_relay-probe-worker", { hidden: true })
        .requiredOption("--config <path>")
        .requiredOption("--role <role>")
        .requiredOption("--directory <path>")
        .action(async (options: { readonly config: string; readonly role: string; readonly directory: string }) => {
            const role = z.enum(["direct", "proxy"]).parse(options.role);
            await runRelayProbeWorker(options.config, role, options.directory, context.shutdownSignal);
        });
}
