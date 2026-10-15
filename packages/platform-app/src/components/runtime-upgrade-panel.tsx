import { type AppUpgradeTask, isRuntimeUpgradeNeeded, type RuntimeUpgradeSnapshot } from "@moxt-ai/mobius-sdk/platform";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPlatformClient } from "../services/platform-client.ts";

type LoadState =
    | { readonly kind: "loading" }
    | {
          readonly kind: "ready";
          readonly task: AppUpgradeTask | null;
          readonly rows: readonly RuntimeUpgradeSnapshot[];
          readonly complete: boolean;
          readonly queriedAt: number;
      }
    | { readonly kind: "failed"; readonly message: string };
const button = "rounded-lg border border-[#b9cfc0] px-3 py-2 text-sm font-semibold disabled:opacity-50";
function status(row: RuntimeUpgradeSnapshot, task: AppUpgradeTask | null): string {
    if (task === null) {
        return "No task";
    }
    if (!row.matched) {
        return "Not selected";
    }
    if (row.version === task.version) {
        return "Completed";
    }
    if (row.version !== null && isRuntimeUpgradeNeeded(task.version, row.version)) {
        return "Already newer";
    }
    if (row.attempt?.revision !== task.revision) {
        return "Pending";
    }
    const result = row.latest?.result;
    if (result?.requestId !== row.attempt.requestId) {
        return "Awaiting result";
    }
    switch (result.outcome.status) {
        case "accepted":
            return "In progress";
        case "succeeded":
            return "Awaiting version confirmation";
        case "failed":
            return "Failed";
        case "rejected":
            return `Rejected: ${result.outcome.code}`;
    }
}
export function RuntimeUpgradePanel({
    appId,
    endpoint,
    getToken,
}: {
    readonly appId: string;
    readonly endpoint: string;
    readonly getToken: () => Promise<string>;
}) {
    const [state, setState] = useState<LoadState>({ kind: "loading" });
    const [version, setVersion] = useState("");
    const [percentage, setPercentage] = useState("10");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [confirming, setConfirming] = useState(false);
    const running = useRef<AbortController | null>(null);
    const refresh = useCallback(
        async (signal: AbortSignal) => {
            const client = createPlatformClient(endpoint, getToken);
            const initial = await client.readUpgradeTask(appId, signal);
            const rows: RuntimeUpgradeSnapshot[] = [];
            let cursor = "";
            for (;;) {
                const page = await client.listUpgradeRuntimes(appId, cursor, signal);
                signal.throwIfAborted();
                if (page.task?.revision !== initial.task?.revision) {
                    throw new Error("Task changed during refresh. Refresh again.");
                }
                rows.push(...page.runtimes);
                setState({
                    kind: "ready",
                    task: page.task,
                    rows: [...rows],
                    complete: page.next === null,
                    queriedAt: page.queriedAt,
                });
                if (page.next === null) {
                    break;
                }
                cursor = page.next;
            }
            return initial.task;
        },
        [appId, endpoint, getToken],
    );
    useEffect(() => {
        const controller = new AbortController();
        running.current = controller;
        void refresh(controller.signal)
            .then((task) => {
                if (task) {
                    setVersion(task.version);
                    setPercentage(String(task.percentage));
                }
            })
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    setState({
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "Upgrade management unavailable",
                    });
                }
            });
        return () => controller.abort();
    }, [refresh]);
    const perform = async (action: "save" | "clear" | "refresh") => {
        running.current?.abort();
        const controller = new AbortController();
        running.current = controller;
        setBusy(true);
        setError("");
        setConfirming(false);
        try {
            const client = createPlatformClient(endpoint, getToken);
            if (action === "save") {
                await client.setUpgradeTask(
                    appId,
                    { version: version.trim(), percentage: Number(percentage) },
                    controller.signal,
                );
            }
            if (action === "clear") {
                await client.clearUpgradeTask(appId, controller.signal);
            }
            await refresh(controller.signal);
        } catch (cause) {
            if (!controller.signal.aborted) {
                setError(cause instanceof Error ? cause.message : "Operation failed");
            }
        } finally {
            if (!controller.signal.aborted) {
                setBusy(false);
            }
        }
    };
    const unmatched = state.kind === "ready" ? state.rows.filter((row) => !row.matched) : [];
    const versions = new Map<string, number>();
    for (const row of unmatched) {
        versions.set(row.version ?? "Unknown", (versions.get(row.version ?? "Unknown") ?? 0) + 1);
    }
    return (
        <div className="mt-6 grid gap-5">
            <div>
                <h3 className="text-xl font-bold">Runtime upgrades</h3>
                <p className="mt-2 text-sm text-[#69766f]">
                    One task for this app. Selection is stable by Runtime ID. Other apps are not listed.
                </p>
            </div>
            {state.kind === "failed" ? (
                <p role="alert">{state.message}</p>
            ) : (
                <>
                    <form
                        className="flex flex-wrap items-end gap-3"
                        onSubmit={(event) => {
                            event.preventDefault();
                            setConfirming(true);
                        }}
                    >
                        <label className="grid gap-2 text-sm">
                            Target version
                            <input
                                className="rounded border p-2"
                                aria-label="Target version"
                                placeholder="0.0.229"
                                required
                                pattern="[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?"
                                value={version}
                                onChange={(event) => setVersion(event.target.value)}
                            />
                        </label>
                        <label className="grid gap-2 text-sm">
                            Rollout percentage
                            <input
                                className="w-24 rounded border p-2"
                                aria-label="Rollout percentage"
                                type="number"
                                min="0"
                                max="100"
                                step="1"
                                required
                                value={percentage}
                                onChange={(event) => setPercentage(event.target.value)}
                            />
                        </label>
                        <button className={button} disabled={busy || state.kind === "loading"} type="submit">
                            Save task
                        </button>
                        <button
                            className={button}
                            disabled={busy || state.kind !== "ready" || state.task === null}
                            type="button"
                            onClick={() => void perform("clear")}
                        >
                            Clear task
                        </button>
                    </form>
                    {confirming && (
                        <div className="rounded border border-amber-300 bg-amber-50 p-4">
                            <p>
                                Replace the current task with {version} at {percentage}%? Upgrading restarts the worker
                                and can interrupt active sessions and other Runtime connections in that process.
                                Rollback can discard data created after upgrading.
                            </p>
                            <div className="mt-3 flex gap-3">
                                <button className={button} onClick={() => void perform("save")} type="button">
                                    Confirm upgrade task
                                </button>
                                <button className={button} onClick={() => setConfirming(false)} type="button">
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}
            {error && (
                <p role="alert" className="text-red-700">
                    {error}
                </p>
            )}
            <div className="flex items-center gap-3">
                <button className={button} type="button" disabled={busy} onClick={() => void perform("refresh")}>
                    Refresh status
                </button>
                {state.kind === "loading" && <span role="status">Loading Runtimes…</span>}
            </div>
            {state.kind === "ready" && (
                <>
                    <p role="status">
                        {state.task === null
                            ? "No current upgrade task"
                            : `Current task: ${state.task.version} · ${state.task.percentage}%`}{" "}
                        · {state.rows.length} Runtimes queried ·{" "}
                        {state.complete ? "Complete" : "Partial results, loading…"} ·{" "}
                        {new Date(state.queriedAt).toLocaleTimeString()}
                    </p>
                    <div className="rounded-lg bg-[#f4f6f4] p-4">
                        <h4 className="font-bold">{state.task === null ? "App overview" : "Outside rollout"}</h4>
                        <p className="mt-2 text-sm">
                            {unmatched.length} Runtimes ·{" "}
                            {unmatched.filter((row) => row.connection === "online").length} online ·{" "}
                            {unmatched.filter((row) => row.connection === "offline").length} offline ·{" "}
                            {unmatched.filter((row) => row.connection === "unknown").length} unknown
                        </p>
                        <p className="mt-2 text-sm">
                            Versions:{" "}
                            {[...versions].map(([version, count]) => `${version}: ${count}`).join(" · ") || "None"}
                        </p>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[900px] text-left text-sm">
                            <caption className="mb-3 text-left font-bold">
                                {state.task === null ? "Runtimes" : "Selected Runtimes"}
                            </caption>
                            <thead>
                                <tr>
                                    {[
                                        "Runtime / Project",
                                        "Connection",
                                        "Last online",
                                        "Version",
                                        "Upgrade",
                                        "Last failure",
                                    ].map((title) => (
                                        <th className="p-2" key={title}>
                                            {title}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {state.rows
                                    .filter((row) => state.task === null || row.matched)
                                    .map((row) => (
                                        <tr className="border-t" key={row.runtimeId}>
                                            <td className="p-2">
                                                <strong>{row.name || row.runtimeId}</strong>
                                                <div className="text-xs">
                                                    {row.runtimeId}
                                                    <br />
                                                    {row.projectId}
                                                </div>
                                            </td>
                                            <td className="p-2">{row.connection}</td>
                                            <td className="p-2">
                                                {row.lastSeen === null
                                                    ? "Unknown"
                                                    : new Date(row.lastSeen).toLocaleString()}
                                            </td>
                                            <td className="p-2">{row.version ?? "Unknown"}</td>
                                            <td className="p-2">{status(row, state.task)}</td>
                                            <td className="p-2">
                                                {row.lastFailure?.result.outcome.status === "failed" ? (
                                                    <details>
                                                        <summary>{row.lastFailure.result.outcome.code}</summary>
                                                        <p>{new Date(row.lastFailure.receivedAt).toLocaleString()}</p>
                                                        <pre className="max-w-sm whitespace-pre-wrap">
                                                            {row.lastFailure.result.outcome.message}
                                                            {"\n"}
                                                            {row.lastFailure.result.outcome.stdout}
                                                            {"\n"}
                                                            {row.lastFailure.result.outcome.stderr}
                                                        </pre>
                                                        {row.lastFailure.result.outcome.retryAfter >
                                                            state.queriedAt && (
                                                            <p>
                                                                Upgrade requests paused until{" "}
                                                                {new Date(
                                                                    row.lastFailure.result.outcome.retryAfter,
                                                                ).toLocaleString()}
                                                            </p>
                                                        )}
                                                    </details>
                                                ) : (
                                                    "None"
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}
