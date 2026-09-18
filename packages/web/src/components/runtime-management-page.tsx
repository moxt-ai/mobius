import {
    MobiusExpiredRuntimePairingStatus,
    MobiusPairedRuntimePairingStatus,
    MobiusPendingRuntimePairingStatus,
    MobiusRevokedRuntimePairingStatus,
    type MobiusRuntimeDescriptor,
    type MobiusRuntimePairing,
} from "@moxt-ai/mobius-sdk";
import {
    ArrowLeft,
    Check,
    CircleCheck,
    Copy,
    Laptop,
    LoaderCircle,
    Menu,
    MessageSquarePlus,
    PanelLeftClose,
    PanelLeftOpen,
    Plus,
    RefreshCw,
    Terminal,
    Trash2,
    Wifi,
    WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { PairingApiError } from "@/domain/channel";
import { projectRuntimeRoutePath } from "@/services/app-routes";
import {
    createProjectRuntimePairing,
    OwnerRuntimeManagementAccess,
    readProjectRuntimePairing,
    readProjectRuntimes,
    readRuntimeManagementAccess,
    revokeProjectRuntime,
} from "@/services/pairing-api";
import { useChatStore } from "@/store/chat-store";

abstract class RuntimeDirectoryState {}

class LoadingRuntimeDirectoryState extends RuntimeDirectoryState {}

abstract class ReadyRuntimeDirectoryState extends RuntimeDirectoryState {
    readonly runtimes: readonly MobiusRuntimeDescriptor[];

    constructor(runtimes: readonly MobiusRuntimeDescriptor[]) {
        super();
        this.runtimes = runtimes;
    }
}

class OwnerRuntimeDirectoryState extends ReadyRuntimeDirectoryState {}

class ReadOnlyRuntimeDirectoryState extends ReadyRuntimeDirectoryState {}

class FailedRuntimeDirectoryState extends RuntimeDirectoryState {
    readonly message: string;

    constructor(message: string) {
        super();
        this.message = message;
    }
}

abstract class RuntimePairingCreationState {}

class IdleRuntimePairingCreationState extends RuntimePairingCreationState {}

class CreatingRuntimePairingState extends RuntimePairingCreationState {
    readonly idempotencyKey: string;

    constructor(idempotencyKey: string) {
        super();
        this.idempotencyKey = idempotencyKey;
    }
}

class PendingRuntimePairingState extends RuntimePairingCreationState {
    readonly pairing: MobiusRuntimePairing;

    constructor(pairing: MobiusRuntimePairing) {
        super();
        this.pairing = pairing;
    }
}

class CheckingRuntimePairingState extends RuntimePairingCreationState {
    readonly pairing: MobiusRuntimePairing;

    constructor(pairing: MobiusRuntimePairing) {
        super();
        this.pairing = pairing;
    }
}

class ConnectedRuntimePairingState extends RuntimePairingCreationState {
    readonly machineName: string;

    constructor(machineName: string) {
        super();
        this.machineName = machineName;
    }
}

class ClaimedRuntimePairingState extends RuntimePairingCreationState {
    readonly machineName: string;
    readonly pairing: MobiusRuntimePairing;

    constructor(pairing: MobiusRuntimePairing, machineName: string) {
        super();
        this.machineName = machineName;
        this.pairing = pairing;
    }
}

class ExpiredRuntimePairingState extends RuntimePairingCreationState {}

class RevokedRuntimePairingState extends RuntimePairingCreationState {}

class FailedRuntimePairingCreationState extends RuntimePairingCreationState {
    readonly idempotencyKey: string;
    readonly message: string;

    constructor(idempotencyKey: string, message: string) {
        super();
        this.idempotencyKey = idempotencyKey;
        this.message = message;
    }
}

class FailedRuntimePairingCheckState extends RuntimePairingCreationState {
    readonly message: string;
    readonly pairing: MobiusRuntimePairing;

    constructor(pairing: MobiusRuntimePairing, message: string) {
        super();
        this.message = message;
        this.pairing = pairing;
    }
}

abstract class RuntimeRevocationState {}

class IdleRuntimeRevocationState extends RuntimeRevocationState {}

class ConfirmingRuntimeRevocationState extends RuntimeRevocationState {
    readonly runtimeId: string;

    constructor(runtimeId: string) {
        super();
        this.runtimeId = runtimeId;
    }
}

class RevokingRuntimeState extends RuntimeRevocationState {
    readonly runtimeId: string;

    constructor(runtimeId: string) {
        super();
        this.runtimeId = runtimeId;
    }
}

class FailedRuntimeRevocationState extends RuntimeRevocationState {
    readonly message: string;
    readonly runtimeId: string;

    constructor(runtimeId: string, message: string) {
        super();
        this.message = message;
        this.runtimeId = runtimeId;
    }
}

function failureMessage(error: unknown): string {
    return error instanceof PairingApiError
        ? `${error.code}: ${error.message}`
        : "The Runtime management request failed unexpectedly.";
}

function formatDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value));
}

function runtimeName(runtime: MobiusRuntimeDescriptor): string {
    return runtime.machineName.trim().length > 0 ? runtime.machineName : `Runtime ${runtime.runtimeId.slice(-6)}`;
}

function pairingCommand(pairing: MobiusRuntimePairing): string {
    return `npx --yes @moxt-ai/mobius pair --url ${JSON.stringify(window.location.origin)} --pairing ${pairing.pairingId} --code ${pairing.pairingCode}`;
}

async function readRuntimeDirectory(
    channelId: string,
    projectId: string,
    signal: AbortSignal,
): Promise<ReadyRuntimeDirectoryState> {
    const [runtimes, access] = await Promise.all([
        readProjectRuntimes(channelId, projectId, signal),
        readRuntimeManagementAccess(channelId, projectId, signal),
    ]);
    return access instanceof OwnerRuntimeManagementAccess
        ? new OwnerRuntimeDirectoryState(runtimes)
        : new ReadOnlyRuntimeDirectoryState(runtimes);
}

function PairingDetails({
    checking,
    copyConfirmation,
    onCheck,
    onCopy,
    pairing,
}: {
    readonly checking: boolean;
    readonly copyConfirmation: string;
    readonly onCheck: () => void;
    readonly onCopy: (value: string, successMessage: string) => void;
    readonly pairing: MobiusRuntimePairing;
}) {
    const codeInputRef = useRef<HTMLInputElement>(null);
    const command = pairingCommand(pairing);

    useEffect(() => {
        codeInputRef.current?.focus({ preventScroll: true });
        codeInputRef.current?.select();
    }, []);

    return (
        <section
            aria-labelledby="runtime-pairing-heading"
            className="mt-6 rounded-2xl border border-success/35 bg-success-subtle p-4 sm:p-5"
        >
            <div className="flex items-start gap-3">
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-success shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.09)]">
                    <Terminal aria-hidden="true" className="size-[18px]" />
                </span>
                <div className="min-w-0">
                    <h2 className="text-base font-semibold tracking-[-0.015em]" id="runtime-pairing-heading">
                        Run this on the other machine
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        The one-time code expires {formatDate(pairing.expiresAt)}. It never contains your Project owner
                        credential.
                    </p>
                </div>
            </div>

            <label className="mt-5 block text-xs font-semibold" htmlFor="runtime-pairing-code">
                One-time pairing code
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-black/12 bg-white px-3 font-mono text-sm font-semibold tracking-[0.08em] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    id="runtime-pairing-code"
                    onFocus={(event) => event.currentTarget.select()}
                    readOnly
                    ref={codeInputRef}
                    type="text"
                    value={pairing.pairingCode}
                />
                <Button
                    className="min-h-11 shrink-0"
                    onClick={() => onCopy(pairing.pairingCode, "Pairing code copied.")}
                    variant="outline"
                >
                    <Copy aria-hidden="true" className="size-4" /> Copy code
                </Button>
            </div>

            <label className="mt-4 block text-xs font-semibold" htmlFor="runtime-pairing-command">
                Pairing command
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-black/12 bg-white px-3 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    id="runtime-pairing-command"
                    onFocus={(event) => event.currentTarget.select()}
                    readOnly
                    type="text"
                    value={command}
                />
                <Button
                    className="min-h-11 shrink-0"
                    onClick={() => onCopy(command, "Pairing command copied.")}
                    variant="outline"
                >
                    {copyConfirmation === "Pairing command copied." ? (
                        <Check aria-hidden="true" className="size-4" />
                    ) : (
                        <Copy aria-hidden="true" className="size-4" />
                    )}
                    Copy command
                </Button>
            </div>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p aria-live="polite" className="min-h-5 text-xs leading-5 text-success">
                    {copyConfirmation}
                </p>
                <Button aria-busy={checking} className="min-h-11" disabled={checking} onClick={onCheck}>
                    {checking ? (
                        <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                    ) : (
                        <RefreshCw aria-hidden="true" className="size-4" />
                    )}
                    Check connection
                </Button>
            </div>
        </section>
    );
}

function RuntimeList({
    channelId,
    directory,
    onCancelRevocation,
    onConfirmRevocation,
    onOpenRuntime,
    onRequestRevocation,
    revocation,
}: {
    readonly channelId: string;
    readonly directory: ReadyRuntimeDirectoryState;
    readonly onCancelRevocation: (runtimeId: string) => void;
    readonly onConfirmRevocation: (runtime: MobiusRuntimeDescriptor) => void;
    readonly onOpenRuntime: (runtime: MobiusRuntimeDescriptor) => void;
    readonly onRequestRevocation: (runtimeId: string) => void;
    readonly revocation: RuntimeRevocationState;
}) {
    const canManage = directory instanceof OwnerRuntimeDirectoryState;

    return (
        <section aria-labelledby="project-runtimes-heading" className="mt-8">
            <div className="flex items-end justify-between gap-4">
                <div>
                    <h2 className="text-base font-semibold tracking-[-0.015em]" id="project-runtimes-heading">
                        Project Runtimes
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Each machine keeps an independent credential, connection, Agent catalog, and execution boundary.
                    </p>
                </div>
                <span className="shrink-0 rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
                    {directory.runtimes.length.toString()} / 8
                </span>
            </div>

            <ul aria-label="Project runtimes" className="mt-4 grid gap-3">
                {directory.runtimes.map((runtime) => {
                    const name = runtimeName(runtime);
                    const confirming =
                        revocation instanceof ConfirmingRuntimeRevocationState &&
                        revocation.runtimeId === runtime.runtimeId;
                    const revoking =
                        revocation instanceof RevokingRuntimeState && revocation.runtimeId === runtime.runtimeId;
                    const failed =
                        revocation instanceof FailedRuntimeRevocationState &&
                        revocation.runtimeId === runtime.runtimeId;
                    return (
                        <li
                            className="rounded-2xl border-[0.5px] border-black/10 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.03)] sm:p-5"
                            key={runtime.runtimeId}
                        >
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                                <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#eefaf3] text-[#218854]">
                                    <Laptop aria-hidden="true" className="size-5" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <strong className="text-sm font-semibold">{name}</strong>
                                        {runtime.channelId === channelId && (
                                            <span className="rounded-full bg-black/5 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                                                Current channel
                                            </span>
                                        )}
                                        <span
                                            className={
                                                runtime.online
                                                    ? "inline-flex items-center gap-1 rounded-full bg-success-subtle px-2 py-0.5 text-[10px] font-semibold text-success"
                                                    : "inline-flex items-center gap-1 rounded-full bg-destructive/8 px-2 py-0.5 text-[10px] font-semibold text-destructive"
                                            }
                                        >
                                            {runtime.online ? (
                                                <Wifi aria-hidden="true" className="size-3" />
                                            ) : (
                                                <WifiOff aria-hidden="true" className="size-3" />
                                            )}
                                            {runtime.online ? "Online" : "Offline"}
                                        </span>
                                    </div>
                                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                        {runtime.workspaceName}
                                    </p>
                                    <p className="mt-2 break-all font-mono text-[10px] leading-4 text-muted-foreground">
                                        {runtime.runtimeId}
                                    </p>
                                    <div className="mt-3 flex flex-wrap gap-1.5">
                                        {runtime.agents.length === 0 ? (
                                            <span className="rounded-md bg-black/5 px-2 py-1 text-[11px] text-muted-foreground">
                                                No ready Agents
                                            </span>
                                        ) : (
                                            runtime.agents.map((agent) => (
                                                <span
                                                    className="rounded-md bg-black/5 px-2 py-1 text-[11px] font-medium text-foreground"
                                                    key={agent.id}
                                                >
                                                    {agent.label}
                                                </span>
                                            ))
                                        )}
                                    </div>
                                </div>
                                {canManage && !confirming && (
                                    <div className="flex shrink-0 flex-col gap-2 sm:items-stretch">
                                        {runtime.online && (
                                            <Button
                                                aria-label={
                                                    runtime.agents.length > 0
                                                        ? `Open chat on ${name}`
                                                        : `Set up an Agent on ${name}`
                                                }
                                                className="min-h-11 shrink-0"
                                                onClick={() => onOpenRuntime(runtime)}
                                            >
                                                {runtime.agents.length > 0 ? (
                                                    <MessageSquarePlus aria-hidden="true" className="size-4" />
                                                ) : (
                                                    <Terminal aria-hidden="true" className="size-4" />
                                                )}
                                                {runtime.agents.length > 0 ? "Open chat" : "Set up Agent"}
                                            </Button>
                                        )}
                                        <Button
                                            aria-busy={revoking}
                                            aria-label={`Revoke ${name}`}
                                            className="min-h-11 shrink-0 text-destructive hover:text-destructive"
                                            disabled={revocation instanceof RevokingRuntimeState}
                                            id={`revoke-runtime-${runtime.runtimeId}`}
                                            onClick={() => onRequestRevocation(runtime.runtimeId)}
                                            variant="outline"
                                        >
                                            {revoking ? (
                                                <LoaderCircle
                                                    aria-hidden="true"
                                                    className="size-4 animate-spin motion-reduce:animate-none"
                                                />
                                            ) : (
                                                <Trash2 aria-hidden="true" className="size-4" />
                                            )}
                                            Revoke
                                        </Button>
                                    </div>
                                )}
                            </div>

                            {confirming && (
                                <div
                                    className="mt-4 rounded-xl border border-destructive/25 bg-destructive/5 p-4"
                                    role="alert"
                                >
                                    <p className="text-sm font-semibold text-destructive">Revoke {name}?</p>
                                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                        Its daemon will disconnect immediately and work pinned to it will not move to
                                        another Runtime. Pairing it again creates a new Runtime identity.
                                    </p>
                                    <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                                        <Button
                                            className="min-h-11"
                                            onClick={() => onCancelRevocation(runtime.runtimeId)}
                                            variant="outline"
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            aria-label={`Confirm revoke ${name}`}
                                            autoFocus
                                            className="min-h-11 bg-destructive text-white hover:bg-destructive/90"
                                            onClick={() => onConfirmRevocation(runtime)}
                                        >
                                            <Trash2 aria-hidden="true" className="size-4" /> Confirm revoke
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {failed && (
                                <p
                                    aria-live="polite"
                                    className="mt-3 rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive"
                                >
                                    {revocation.message}
                                </p>
                            )}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

function RuntimeManagementPanel({ channelId, projectId }: { readonly channelId: string; readonly projectId: string }) {
    const navigate = useNavigate();
    const [controller] = useState(() => new AbortController());
    const [directory, setDirectory] = useState<RuntimeDirectoryState>(new LoadingRuntimeDirectoryState());
    const [pairing, setPairing] = useState<RuntimePairingCreationState>(new IdleRuntimePairingCreationState());
    const [revocation, setRevocation] = useState<RuntimeRevocationState>(new IdleRuntimeRevocationState());
    const [copyConfirmation, setCopyConfirmation] = useState("");
    const [announcement, setAnnouncement] = useState("");

    const loadDirectory = useCallback(async (): Promise<void> => {
        setDirectory(new LoadingRuntimeDirectoryState());
        try {
            const loaded = await readRuntimeDirectory(channelId, projectId, controller.signal);
            if (controller.signal.aborted) {
                return;
            }
            setDirectory(loaded);
        } catch (error) {
            if (!controller.signal.aborted) {
                setDirectory(new FailedRuntimeDirectoryState(failureMessage(error)));
            }
        }
    }, [channelId, controller, projectId]);

    useEffect(() => {
        void loadDirectory();
        return () => controller.abort();
    }, [controller, loadDirectory]);

    const requestPairing = async (idempotencyKey: string): Promise<void> => {
        setAnnouncement("");
        setCopyConfirmation("");
        setPairing(new CreatingRuntimePairingState(idempotencyKey));
        try {
            const created = await createProjectRuntimePairing(channelId, projectId, idempotencyKey, controller.signal);
            if (!controller.signal.aborted) {
                setPairing(new PendingRuntimePairingState(created));
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                setPairing(new FailedRuntimePairingCreationState(idempotencyKey, failureMessage(error)));
            }
        }
    };

    const startPairing = (): void => {
        void requestPairing(`web-${crypto.randomUUID()}`);
    };

    const checkPairing = async (created: MobiusRuntimePairing): Promise<void> => {
        setAnnouncement("");
        setPairing(new CheckingRuntimePairingState(created));
        try {
            const status = await readProjectRuntimePairing(channelId, projectId, created.pairingId, controller.signal);
            if (controller.signal.aborted) {
                return;
            }
            if (status instanceof MobiusPendingRuntimePairingStatus) {
                setPairing(new PendingRuntimePairingState(created));
                setAnnouncement("The other machine has not claimed this code yet.");
                return;
            }
            if (status instanceof MobiusPairedRuntimePairingStatus) {
                const loaded = await readRuntimeDirectory(channelId, projectId, controller.signal);
                if (controller.signal.aborted) {
                    return;
                }
                setDirectory(loaded);
                const connected = loaded.runtimes.find((runtime) => runtime.runtimeId === status.runtimeId);
                if (connected === undefined) {
                    setPairing(
                        new FailedRuntimePairingCheckState(
                            created,
                            "The paired Runtime is missing from the Project directory.",
                        ),
                    );
                    return;
                }
                setPairing(
                    connected.online
                        ? new ConnectedRuntimePairingState(status.machineName)
                        : new ClaimedRuntimePairingState(created, status.machineName),
                );
                return;
            }
            if (status instanceof MobiusExpiredRuntimePairingStatus) {
                setPairing(new ExpiredRuntimePairingState());
                return;
            }
            if (status instanceof MobiusRevokedRuntimePairingStatus) {
                setPairing(new RevokedRuntimePairingState());
                return;
            }
            setPairing(
                new FailedRuntimePairingCheckState(created, "The Relay returned an unsupported Runtime pairing state."),
            );
        } catch (error) {
            if (!controller.signal.aborted) {
                setPairing(new FailedRuntimePairingCheckState(created, failureMessage(error)));
            }
        }
    };

    const copyValue = (value: string, successMessage: string): void => {
        void navigator.clipboard.writeText(value).then(
            () => setCopyConfirmation(successMessage),
            () => setCopyConfirmation("Copy was unavailable. Select the value and copy it manually."),
        );
    };

    const cancelRevocation = (runtimeId: string): void => {
        setRevocation(new IdleRuntimeRevocationState());
        window.requestAnimationFrame(() => document.getElementById(`revoke-runtime-${runtimeId}`)?.focus());
    };

    const revokeRuntime = async (runtime: MobiusRuntimeDescriptor): Promise<void> => {
        setAnnouncement("");
        setRevocation(new RevokingRuntimeState(runtime.runtimeId));
        try {
            await revokeProjectRuntime(channelId, projectId, runtime.runtimeId, controller.signal);
            if (controller.signal.aborted) {
                return;
            }
            if (directory instanceof OwnerRuntimeDirectoryState) {
                setDirectory(
                    new OwnerRuntimeDirectoryState(
                        directory.runtimes.filter((candidate) => candidate.runtimeId !== runtime.runtimeId),
                    ),
                );
            }
            setRevocation(new IdleRuntimeRevocationState());
            setAnnouncement(`${runtimeName(runtime)} was revoked.`);
        } catch (error) {
            if (!controller.signal.aborted) {
                setRevocation(new FailedRuntimeRevocationState(runtime.runtimeId, failureMessage(error)));
            }
        }
    };

    const readyDirectory = directory instanceof ReadyRuntimeDirectoryState ? directory : null;
    const ownerDirectory = directory instanceof OwnerRuntimeDirectoryState;
    const activePairing =
        pairing instanceof PendingRuntimePairingState || pairing instanceof CheckingRuntimePairingState
            ? pairing.pairing
            : null;

    return (
        <section aria-labelledby="runtime-management-heading">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="max-w-2xl">
                    <p className="text-[11px] font-semibold tracking-[0.08em] text-[#218854] uppercase">
                        Project execution
                    </p>
                    <h2
                        className="mt-2 text-[28px] leading-9 font-semibold tracking-[-0.035em]"
                        id="runtime-management-heading"
                    >
                        Manage local machines
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        Pair another computer into this Project without sharing your owner credential. Each computer
                        becomes a separate Runtime with its own local permissions and workspace.
                    </p>
                </div>
                {ownerDirectory &&
                    !(pairing instanceof CreatingRuntimePairingState) &&
                    !(pairing instanceof PendingRuntimePairingState) &&
                    !(pairing instanceof CheckingRuntimePairingState) &&
                    !(pairing instanceof ClaimedRuntimePairingState) && (
                        <Button className="min-h-11 shrink-0 sm:self-end" onClick={startPairing}>
                            <Plus aria-hidden="true" className="size-4" /> Pair another machine
                        </Button>
                    )}
            </div>

            {directory instanceof LoadingRuntimeDirectoryState && (
                <div
                    aria-busy="true"
                    aria-live="polite"
                    className="mt-5 flex min-h-20 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-5 py-4 text-sm text-muted-foreground"
                >
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                    Loading Project Runtimes…
                </div>
            )}

            {directory instanceof FailedRuntimeDirectoryState && (
                <div className="mt-5 flex flex-col gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm leading-6 text-destructive">{directory.message}</p>
                    <Button className="min-h-11 shrink-0" onClick={() => void loadDirectory()} variant="outline">
                        <RefreshCw aria-hidden="true" className="size-4" /> Retry
                    </Button>
                </div>
            )}

            {directory instanceof ReadOnlyRuntimeDirectoryState && (
                <div className="mt-5 rounded-xl border-[0.5px] border-black/10 bg-white px-5 py-4 text-sm leading-6 text-muted-foreground shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
                    This browser has linked-device access. It can see Project Runtimes, but only the original owner
                    browser can pair or revoke local machines.
                </div>
            )}

            {pairing instanceof CreatingRuntimePairingState && (
                <div
                    aria-busy="true"
                    aria-live="polite"
                    className="mt-6 flex min-h-20 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-5 py-4 text-sm text-muted-foreground"
                >
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                    Creating a one-time Runtime pairing…
                </div>
            )}

            {activePairing !== null && (
                <PairingDetails
                    checking={pairing instanceof CheckingRuntimePairingState}
                    copyConfirmation={copyConfirmation}
                    onCheck={() => void checkPairing(activePairing)}
                    onCopy={copyValue}
                    pairing={activePairing}
                />
            )}

            {pairing instanceof ConnectedRuntimePairingState && (
                <div
                    aria-live="polite"
                    className="mt-6 flex items-center gap-3 rounded-xl border border-success/30 bg-success-subtle px-4 py-3 text-sm text-success"
                >
                    <CircleCheck aria-hidden="true" className="size-5 shrink-0" />
                    {pairing.machineName} is connected.
                </div>
            )}

            {pairing instanceof ClaimedRuntimePairingState && (
                <div className="mt-6 rounded-xl border border-warning/30 bg-warning-subtle px-4 py-4">
                    <p className="text-sm font-semibold text-warning">{pairing.machineName} is paired but offline.</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Keep the Mobius command running on that machine, then check its connection again.
                    </p>
                    <Button
                        className="mt-3 min-h-11"
                        onClick={() => void checkPairing(pairing.pairing)}
                        variant="outline"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" /> Check connection
                    </Button>
                </div>
            )}

            {pairing instanceof ExpiredRuntimePairingState && (
                <div className="mt-6 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-4">
                    <p className="text-sm text-destructive">The one-time pairing code expired before it was claimed.</p>
                    <Button className="mt-3 min-h-11" onClick={startPairing} variant="outline">
                        <RefreshCw aria-hidden="true" className="size-4" /> Create a new pairing
                    </Button>
                </div>
            )}

            {pairing instanceof RevokedRuntimePairingState && (
                <p aria-live="polite" className="mt-6 rounded-xl bg-destructive/8 px-4 py-3 text-sm text-destructive">
                    This pending Runtime pairing was revoked. Create a new pairing to continue.
                </p>
            )}

            {pairing instanceof FailedRuntimePairingCreationState && (
                <div className="mt-6 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-4">
                    <p aria-live="polite" className="text-sm text-destructive">
                        {pairing.message}
                    </p>
                    <Button
                        className="mt-3 min-h-11"
                        onClick={() => void requestPairing(pairing.idempotencyKey)}
                        variant="outline"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" /> Retry safely
                    </Button>
                </div>
            )}

            {pairing instanceof FailedRuntimePairingCheckState && (
                <div className="mt-6 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-4">
                    <p aria-live="polite" className="text-sm text-destructive">
                        {pairing.message}
                    </p>
                    <Button
                        className="mt-3 min-h-11"
                        onClick={() => void checkPairing(pairing.pairing)}
                        variant="outline"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" /> Retry status check
                    </Button>
                </div>
            )}

            <p aria-live="polite" className="mt-4 min-h-5 text-sm text-success">
                {announcement}
            </p>

            {readyDirectory !== null && (
                <RuntimeList
                    channelId={channelId}
                    directory={readyDirectory}
                    onCancelRevocation={cancelRevocation}
                    onConfirmRevocation={(runtime) => void revokeRuntime(runtime)}
                    onOpenRuntime={(runtime) => void navigate(projectRuntimeRoutePath(projectId, runtime.runtimeId))}
                    onRequestRevocation={(runtimeId) => setRevocation(new ConfirmingRuntimeRevocationState(runtimeId))}
                    revocation={revocation}
                />
            )}
        </section>
    );
}

export function RuntimeManagementPage({
    channelId,
    desktopSidebarCollapsed,
    onToggleDesktopSidebar,
    projectId,
}: {
    readonly channelId: string;
    readonly desktopSidebarCollapsed: boolean;
    readonly onToggleDesktopSidebar: () => void;
    readonly projectId: string;
}) {
    const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
    const sidebarOpen = useChatStore((state) => state.sidebarOpen);

    return (
        <>
            <header className="chat-header z-10 flex shrink-0 items-center border-b-[0.5px] border-black/6 bg-background/92 px-2.5 supports-[backdrop-filter]:backdrop-blur-xl md:px-[18px]">
                <Button
                    aria-controls="conversation-sidebar"
                    aria-expanded={sidebarOpen}
                    aria-label="Open conversation sidebar"
                    className="mr-[7px] size-11 lg:hidden"
                    id="conversation-sidebar-trigger"
                    onClick={() => setSidebarOpen(true)}
                    size="icon"
                    variant="ghost"
                >
                    <Menu aria-hidden="true" className="size-[18px]" />
                </Button>
                <Button
                    aria-label={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                    className="mr-2 hidden lg:inline-flex"
                    onClick={onToggleDesktopSidebar}
                    size="icon"
                    title={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                    variant="ghost"
                >
                    {desktopSidebarCollapsed ? (
                        <PanelLeftOpen aria-hidden="true" className="size-4" />
                    ) : (
                        <PanelLeftClose aria-hidden="true" className="size-4" />
                    )}
                </Button>
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-[#eefaf3] text-[#218854]">
                    <Laptop aria-hidden="true" className="size-4" />
                </span>
                <h1 className="ml-2 min-w-0 truncate text-sm font-semibold tracking-[-0.01em]">Local machines</h1>
                <Link
                    aria-label="Back to chat"
                    className="ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-xs font-medium text-muted-foreground no-underline transition-colors duration-150 hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-11 sm:w-auto sm:gap-1.5 sm:px-3"
                    relative="path"
                    to=".."
                >
                    <ArrowLeft aria-hidden="true" className="size-3.5" />
                    <span className="hidden sm:inline">Back to chat</span>
                </Link>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-[980px] px-5 py-8 sm:px-8 sm:py-10">
                    <RuntimeManagementPanel channelId={channelId} key={channelId} projectId={projectId} />
                </div>
            </div>
        </>
    );
}
