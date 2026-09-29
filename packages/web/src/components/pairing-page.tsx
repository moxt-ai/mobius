import {
    Check,
    CheckCircle2,
    Clipboard,
    Code2,
    Laptop,
    LoaderCircle,
    RefreshCw,
    ShieldCheck,
    TerminalSquare,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { dataTestId } from "@/data-testid";
import {
    type ChannelConnection,
    ConnectedBrowserPairingStatus,
    type CreatedPairing,
    ExpiredBrowserPairingStatus,
    PairingApiError,
} from "@/domain/channel";
import { projectRuntimeRoutePath } from "@/services/app-routes";
import {
    configureStandaloneRecording,
    createBrowserPairing,
    pairingCommand,
    readBrowserPairingStatus,
    readStandaloneRecordingConfiguration,
} from "@/services/pairing-api";

const POLL_INTERVAL_MILLISECONDS = 1_200;
const CONNECTED_PAUSE_MILLISECONDS = 650;

abstract class PairingPageState {
    abstract readonly status: string;
}

class CreatingPairingPageState extends PairingPageState {
    readonly status = "creating";
}

class SelectingRecordingPageState extends PairingPageState {
    readonly providerAvailable: boolean;
    readonly status = "selecting-recording";

    constructor(providerAvailable: boolean) {
        super();
        this.providerAvailable = providerAvailable;
    }
}

class WaitingPairingPageState extends PairingPageState {
    readonly pairing: CreatedPairing;
    readonly status = "waiting";

    constructor(pairing: CreatedPairing) {
        super();
        this.pairing = pairing;
    }
}

class ConnectedPairingPageState extends PairingPageState {
    readonly machineName: string;
    readonly status = "connected";

    constructor(machineName: string) {
        super();
        this.machineName = machineName;
    }
}

class ExpiredPairingPageState extends PairingPageState {
    readonly status = "expired";
}

class FailedPairingPageState extends PairingPageState {
    readonly message: string;
    readonly status = "failed";

    constructor(message: string) {
        super();
        this.message = message;
    }
}

function waitForPoll(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timeout = window.setTimeout(finish, POLL_INTERVAL_MILLISECONDS);

        function finish(): void {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", finish);
            resolve();
        }

        signal.addEventListener("abort", finish, { once: true });
    });
}

function MobiusWordmark() {
    return (
        <Link
            aria-label="Mobius home"
            className="inline-flex min-h-11 items-center gap-2.5 text-base font-semibold tracking-[-0.02em] text-foreground no-underline"
            to="/"
        >
            <svg
                aria-hidden="true"
                className="size-[26px] fill-none stroke-[#279a60] stroke-[2.2] [stroke-linecap:round] [stroke-linejoin:round]"
                viewBox="0 0 32 32"
            >
                <path d="M7 9.5C7 6.46 9.46 4 12.5 4S18 6.46 18 9.5 15.54 15 12.5 15H11" />
                <path d="M25 22.5c0 3.04-2.46 5.5-5.5 5.5S14 25.54 14 22.5s2.46-5.5 5.5-5.5H21" />
                <path d="M11 15h10M21 17H11" />
            </svg>
            <span>Mobius</span>
        </Link>
    );
}

function PairingLoading({
    description = "Mobius is creating a short-lived code for this browser.",
    title = "Preparing secure pairing",
}: {
    readonly description?: string;
    readonly title?: string;
}) {
    return (
        <section
            aria-busy="true"
            aria-live="polite"
            className="pairing-card mx-auto flex min-h-[340px] w-full max-w-[680px] flex-col items-center justify-center rounded-2xl bg-white px-7 py-12 text-center"
        >
            <LoaderCircle className="size-6 animate-spin text-[#279a60]" />
            <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em]">{title}</h1>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
        </section>
    );
}

function RecordingChoice({
    onContinue,
    providerAvailable,
}: {
    readonly onContinue: (enabled: boolean) => void;
    readonly providerAvailable: boolean;
}) {
    const [enabled, setEnabled] = useState(false);
    return (
        <section className="pairing-card mx-auto w-full max-w-[680px] rounded-2xl bg-white px-7 py-10 sm:px-10">
            <div className="mx-auto max-w-[520px]">
                <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-[#eefaf3] text-[#218854]">
                    <ShieldCheck className="size-5" />
                </span>
                <p className="mt-5 text-xs font-semibold tracking-[0.06em] text-[#218854] uppercase">First pairing</p>
                <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">Keep durable conversation history?</h1>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    Recording stores Session events in the optional Recording Worker. When enabled, this Web app loads
                    conversation history from Recording instead of asking your local daemon.
                </p>

                <label className="mt-7 flex min-h-20 cursor-pointer items-start gap-3 rounded-xl border border-black/10 bg-[#f7f8f9] px-4 py-4 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#2fb872]">
                    <input
                        checked={enabled}
                        className="mt-0.5 size-4 accent-[#279a60]"
                        data-testid={dataTestId.recordingChoice}
                        disabled={!providerAvailable}
                        onChange={(event) => setEnabled(event.target.checked)}
                        type="checkbox"
                    />
                    <span>
                        <span className="block text-sm font-semibold">Enable Recording</span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            {providerAvailable
                                ? "This choice applies to this Standalone deployment and cannot be changed after pairing starts."
                                : "No Recording Worker is installed. Conversations will continue to load from the daemon."}
                        </span>
                    </span>
                </label>

                <Button
                    className="mt-6 w-full"
                    data-testid={dataTestId.recordingContinue}
                    onClick={() => onContinue(enabled)}
                >
                    Continue to pairing
                </Button>
                <p className="mt-3 text-center text-[11px] leading-4 text-muted-foreground">
                    Recording is off by default. Local execution permissions are unchanged.
                </p>
            </div>
        </section>
    );
}

function PairingError({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) {
    return (
        <section className="pairing-card mx-auto flex min-h-[340px] w-full max-w-[680px] flex-col items-center justify-center rounded-2xl bg-white px-7 py-12 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-[#fff3e8] text-[#a85d00]">
                <RefreshCw className="size-5" />
            </span>
            <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em]">Pairing could not start</h1>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{message}</p>
            <Button className="mt-6" onClick={onRetry}>
                Try again
            </Button>
        </section>
    );
}

function PairingConnected({ machineName }: { readonly machineName: string }) {
    return (
        <section
            aria-live="polite"
            className="pairing-card mx-auto flex min-h-[340px] w-full max-w-[680px] flex-col items-center justify-center rounded-2xl bg-white px-7 py-12 text-center"
        >
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-[#e9f8f0] text-[#218854]">
                <CheckCircle2 className="size-7" />
            </span>
            <p className="mt-5 text-xs font-semibold tracking-[0.06em] text-[#218854] uppercase">Machine paired</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">Opening your channel</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {machineName} is connected. Your chat workspace is ready.
            </p>
            <LoaderCircle className="mt-6 size-5 animate-spin text-[#279a60]" />
        </section>
    );
}

function PairingInstructions({ pairing }: { readonly pairing: CreatedPairing }) {
    const [copyLabel, setCopyLabel] = useState("Copy");
    const command = pairingCommand(pairing);
    const expiresAt = new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
    }).format(pairing.expiresAt);

    const copyCommand = async (): Promise<void> => {
        try {
            await navigator.clipboard.writeText(command);
            setCopyLabel("Copied");
            window.setTimeout(() => setCopyLabel("Copy"), 1_800);
        } catch {
            setCopyLabel("Select command");
        }
    };

    return (
        <section
            aria-busy="true"
            className="pairing-card grid w-full grid-cols-[minmax(0,1.04fr)_minmax(280px,0.96fr)] overflow-hidden rounded-2xl bg-white max-md:grid-cols-1"
        >
            <div className="px-[clamp(24px,5vw,54px)] py-[clamp(34px,6vw,60px)]">
                <div className="inline-flex min-h-7 items-center gap-1.5 rounded-full border-[0.5px] border-[#2fb872]/25 bg-[#eefaf3] px-2.5 text-[11px] font-semibold text-[#218854]">
                    <span className="size-1.5 rounded-full bg-[#2fb872]" />
                    Waiting for your machine
                </div>
                <h1 className="mt-5 max-w-md text-[clamp(28px,4vw,40px)] leading-[1.12] font-semibold tracking-[-0.045em]">
                    Pair your machine
                </h1>
                <p className="mt-4 max-w-[520px] text-sm leading-6 text-[#5f6673]">
                    Run one command to connect this browser to your machine. Mobius uses your local user account’s
                    permissions, and each conversation can have its own working directory.
                </p>

                <ol className="mt-8 space-y-6 p-0">
                    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                        <span className="inline-flex size-7 items-center justify-center rounded-full bg-black/6 text-xs font-semibold">
                            1
                        </span>
                        <div>
                            <h2 className="text-sm font-semibold">Open your terminal</h2>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                Run the command from any folder. New conversations start in ~/.mobius/workspace, and you
                                can choose another folder later.
                            </p>
                        </div>
                    </li>
                    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                        <span className="inline-flex size-7 items-center justify-center rounded-full bg-black/6 text-xs font-semibold">
                            2
                        </span>
                        <div className="min-w-0">
                            <h2 className="text-sm font-semibold">Run the pairing command</h2>
                            <div className="mt-3 overflow-hidden rounded-xl border-[0.5px] border-black/10 bg-[#111318] text-[#e8ebef] shadow-[0_5px_18px_rgba(0,0,0,0.08)]">
                                <div className="flex min-h-9 items-center justify-between border-b border-white/8 px-3 text-[10px] text-[#aeb4bf]">
                                    <span className="inline-flex items-center gap-1.5">
                                        <TerminalSquare className="size-3" /> Terminal
                                    </span>
                                    <button
                                        className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-[10px] text-[#dfe3e8] outline-none transition-colors hover:bg-white/8 focus-visible:ring-2 focus-visible:ring-[#2fb872]"
                                        onClick={() => void copyCommand()}
                                        type="button"
                                    >
                                        {copyLabel === "Copied" ? (
                                            <Check className="size-3" />
                                        ) : (
                                            <Clipboard className="size-3" />
                                        )}
                                        {copyLabel}
                                    </button>
                                </div>
                                <code className="conversation-scroll block max-h-28 overflow-auto px-3 py-3.5 font-mono text-[11px] leading-[19px] break-all whitespace-pre-wrap">
                                    {command}
                                </code>
                            </div>
                        </div>
                    </li>
                    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                        <span className="inline-flex size-7 items-center justify-center rounded-full bg-black/6 text-xs font-semibold">
                            3
                        </span>
                        <div>
                            <h2 className="text-sm font-semibold">Keep the daemon running</h2>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                This page opens the channel automatically after the terminal confirms pairing.
                            </p>
                        </div>
                    </li>
                </ol>
            </div>

            <aside className="flex flex-col border-l-[0.5px] border-black/7 bg-[#f5f6f8] px-[clamp(24px,4vw,38px)] py-[clamp(32px,5vw,48px)] max-md:border-t-[0.5px] max-md:border-l-0">
                <span className="inline-flex size-11 items-center justify-center rounded-[14px] bg-white text-[#279a60] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)]">
                    <Laptop className="size-5" />
                </span>
                <h2 className="mt-5 text-base font-semibold tracking-[-0.02em]">Local machine channel</h2>
                <p className="mt-2 text-xs leading-5 text-copy-tertiary">
                    Code <strong className="font-mono text-[#454959]">{pairing.pairingCode}</strong>
                    <br />
                    Expires at {expiresAt}
                </p>

                <div className="mt-7 space-y-3">
                    <div className="flex items-start gap-2.5 rounded-xl bg-white px-3 py-3 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.07)]">
                        <Code2 className="mt-0.5 size-4 shrink-0 text-[#655ec7]" />
                        <div>
                            <p className="text-xs font-semibold">Codex or Claude Code</p>
                            <p className="mt-0.5 text-[11px] leading-[17px] text-muted-foreground">
                                Choose an agent independently for every new conversation.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-2.5 rounded-xl bg-white px-3 py-3 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.07)]">
                        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[#218854]" />
                        <div>
                            <p className="text-xs font-semibold">Machine access</p>
                            <p className="mt-0.5 text-[11px] leading-[17px] text-muted-foreground">
                                Pairing lets this channel work with files available to your local user account.
                            </p>
                        </div>
                    </div>
                </div>

                <p className="mt-auto pt-8 text-[10px] leading-4 text-muted-foreground">
                    The one-time code expires after ten minutes and is invalidated when it is claimed.
                </p>
            </aside>
        </section>
    );
}

function PairingWorkflow({
    onConnected,
    onRetry,
}: {
    readonly onConnected: (connection: ChannelConnection) => void;
    readonly onRetry: () => void;
}) {
    const [state, setState] = useState<PairingPageState>(new CreatingPairingPageState());
    const [configurationSaved, setConfigurationSaved] = useState(false);

    useEffect(() => {
        const controller = new AbortController();

        const run = async (): Promise<void> => {
            try {
                const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
                const recording = await readStandaloneRecordingConfiguration(signal);
                if (recording.state === "unconfigured" && !configurationSaved) {
                    setState(new SelectingRecordingPageState(recording.providerAvailable));
                    return;
                }
                const pairing = await createBrowserPairing(signal);
                if (controller.signal.aborted) {
                    return;
                }
                setState(new WaitingPairingPageState(pairing));

                while (!controller.signal.aborted) {
                    await waitForPoll(controller.signal);
                    if (controller.signal.aborted) {
                        return;
                    }
                    const status = await readBrowserPairingStatus(pairing, controller.signal);
                    if (status instanceof ExpiredBrowserPairingStatus) {
                        setState(new ExpiredPairingPageState());
                        return;
                    }
                    if (status instanceof ConnectedBrowserPairingStatus) {
                        setState(new ConnectedPairingPageState(status.connection.machineName));
                        await new Promise<void>((resolve) => {
                            window.setTimeout(resolve, CONNECTED_PAUSE_MILLISECONDS);
                        });
                        if (!controller.signal.aborted) {
                            onConnected(status.connection);
                        }
                        return;
                    }
                }
            } catch (error) {
                if (controller.signal.aborted) {
                    return;
                }
                const message =
                    error instanceof PairingApiError
                        ? `${error.code}: ${error.message}`
                        : "The pairing flow failed unexpectedly.";
                setState(new FailedPairingPageState(message));
            }
        };

        void run();
        return () => controller.abort();
    }, [configurationSaved, onConnected]);

    let content = <PairingLoading />;
    if (state instanceof SelectingRecordingPageState) {
        content = (
            <RecordingChoice
                onContinue={(enabled) => {
                    setState(new CreatingPairingPageState());
                    const signal = AbortSignal.timeout(15_000);
                    void configureStandaloneRecording(enabled, signal).then(
                        () => setConfigurationSaved(true),
                        (error: unknown) => {
                            const message =
                                error instanceof PairingApiError
                                    ? `${error.code}: ${error.message}`
                                    : "The Recording choice could not be saved.";
                            setState(new FailedPairingPageState(message));
                        },
                    );
                }}
                providerAvailable={state.providerAvailable}
            />
        );
    } else if (state instanceof WaitingPairingPageState) {
        content = <PairingInstructions pairing={state.pairing} />;
    } else if (state instanceof ConnectedPairingPageState) {
        content = <PairingConnected machineName={state.machineName} />;
    } else if (state instanceof ExpiredPairingPageState) {
        content = <PairingError message="The one-time code expired before a daemon claimed it." onRetry={onRetry} />;
    } else if (state instanceof FailedPairingPageState) {
        content = <PairingError message={state.message} onRetry={onRetry} />;
    }

    return content;
}

export function Pair({ onConnected }: { readonly onConnected: (connection: ChannelConnection) => void }) {
    const [generation, setGeneration] = useState(0);
    const retry = (): void => setGeneration((value) => value + 1);

    return <PairingWorkflow key={generation} onConnected={onConnected} onRetry={retry} />;
}

export function PairingPage() {
    const navigate = useNavigate();

    return (
        <div className="pairing-page h-dvh overflow-y-auto bg-background">
            <header className="mx-auto flex min-h-[72px] w-[min(1180px,calc(100%-40px))] items-center justify-between max-sm:w-[calc(100%-28px)]">
                <MobiusWordmark />
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <ShieldCheck className="size-3.5 text-[#279a60]" /> End-to-end local execution
                </span>
            </header>
            <main className="mx-auto flex min-h-[calc(100dvh-112px)] w-[min(1120px,calc(100%-40px))] items-center py-8 max-sm:w-[calc(100%-24px)] max-sm:py-4">
                <Pair
                    onConnected={(connection) => {
                        void navigate(projectRuntimeRoutePath(connection.projectId, connection.runtimeId));
                    }}
                />
            </main>
            <footer className="mx-auto flex min-h-10 w-[min(1120px,calc(100%-40px))] items-center justify-center pb-5 text-[10px] text-muted-foreground">
                ACP adapters run beside your tools. Relay traffic contains protocol messages, never local credentials.
            </footer>
        </div>
    );
}
