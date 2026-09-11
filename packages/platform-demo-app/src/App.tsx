import {
    createMobiusConversationSession,
    MobiusArtifactUploadRequest,
    MobiusBrowserAccessToken,
    type MobiusBrowserClient,
    MobiusPageRequest,
} from "@moxt-ai/mobius-sdk/browser";
import {
    Activity,
    Bot,
    Boxes,
    Check,
    ChevronRight,
    CircleAlert,
    Clipboard,
    CloudCog,
    Database,
    KeyRound,
    LoaderCircle,
    MessageSquareText,
    Play,
    RefreshCw,
    Send,
    ServerCog,
    ShieldCheck,
    TerminalSquare,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

interface VerificationCheckView {
    readonly evidence: string;
    readonly id: string;
    readonly label: string;
    readonly status: string;
}

class EnvironmentView {
    readonly platformEndpoint: string;
    readonly status: string;

    constructor(platformEndpoint: string, status: string) {
        this.platformEndpoint = platformEndpoint;
        this.status = status;
    }
}

class ProvisionView {
    readonly activeApps: number;
    readonly activeProjects: number;
    readonly appId: string;
    readonly auditCount: number;
    readonly checks: readonly VerificationCheckView[];
    readonly health: string;
    readonly hostingProfile: string;
    readonly projectId: string;
    readonly tenantId: string;

    constructor(
        health: string,
        hostingProfile: string,
        tenantId: string,
        appId: string,
        projectId: string,
        activeApps: number,
        activeProjects: number,
        auditCount: number,
        checks: readonly VerificationCheckView[],
    ) {
        this.health = health;
        this.hostingProfile = hostingProfile;
        this.tenantId = tenantId;
        this.appId = appId;
        this.projectId = projectId;
        this.activeApps = activeApps;
        this.activeProjects = activeProjects;
        this.auditCount = auditCount;
        this.checks = Object.freeze([...checks]);
    }
}

class CredentialView {
    readonly issuedCredentialId: string;
    readonly overlapEndsAt: string;
    readonly revokedAccessDenied: boolean;
    readonly revokedCredentialId: string;
    readonly rotatedCredentialId: string;

    constructor(
        issuedCredentialId: string,
        rotatedCredentialId: string,
        revokedCredentialId: string,
        overlapEndsAt: string,
        revokedAccessDenied: boolean,
    ) {
        this.issuedCredentialId = issuedCredentialId;
        this.rotatedCredentialId = rotatedCredentialId;
        this.revokedCredentialId = revokedCredentialId;
        this.overlapEndsAt = overlapEndsAt;
        this.revokedAccessDenied = revokedAccessDenied;
    }
}

class PairingView {
    readonly command: string;
    readonly expiresAt: string;
    readonly pairingCode: string;
    readonly pairingId: string;
    readonly runtimeId: string;

    constructor(pairingId: string, pairingCode: string, runtimeId: string, expiresAt: string, command: string) {
        this.pairingId = pairingId;
        this.pairingCode = pairingCode;
        this.runtimeId = runtimeId;
        this.expiresAt = expiresAt;
        this.command = command;
    }
}

class RuntimeView {
    readonly agentLabels: readonly string[];
    readonly machineName: string;
    readonly online: boolean;
    readonly runtimeId: string;
    readonly status: string;
    readonly workspaceName: string;

    constructor(
        status: string,
        runtimeId: string,
        machineName: string,
        workspaceName: string,
        agentLabels: readonly string[],
        online: boolean,
    ) {
        this.status = status;
        this.runtimeId = runtimeId;
        this.machineName = machineName;
        this.workspaceName = workspaceName;
        this.agentLabels = Object.freeze([...agentLabels]);
        this.online = online;
    }
}

class BotView {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingStatus: string;
    readonly botId: string;
    readonly displayName: string;

    constructor(
        botId: string,
        displayName: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingStatus: string,
    ) {
        this.botId = botId;
        this.displayName = displayName;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingStatus = bindingStatus;
    }
}

class ConversationView {
    readonly actorRef: string;
    readonly conversationId: string;
    readonly credential: string;
    readonly credentialId: string;
    readonly expiresAt: string;
    readonly permissions: readonly string[];
    readonly platformEndpoint: string;
    readonly sessionId: string;

    constructor(
        conversationId: string,
        sessionId: string,
        actorRef: string,
        credentialId: string,
        credential: string,
        expiresAt: string,
        permissions: readonly string[],
        platformEndpoint: string,
    ) {
        this.conversationId = conversationId;
        this.sessionId = sessionId;
        this.actorRef = actorRef;
        this.credentialId = credentialId;
        this.credential = credential;
        this.expiresAt = expiresAt;
        this.permissions = Object.freeze([...permissions]);
        this.platformEndpoint = platformEndpoint;
    }
}

class BrowserEvidenceView {
    readonly artifactId: string;
    readonly configurationRevision: number;
    readonly eventCount: number;
    readonly historyCount: number;
    readonly latestResponse: string;
    readonly latestTurnState: string;
    readonly pendingInteractionCount: number;
    readonly sessionId: string;

    constructor(
        sessionId: string,
        configurationRevision: number,
        artifactId: string,
        historyCount: number,
        eventCount: number,
        pendingInteractionCount: number,
        latestTurnState: string,
        latestResponse: string,
    ) {
        this.sessionId = sessionId;
        this.configurationRevision = configurationRevision;
        this.artifactId = artifactId;
        this.historyCount = historyCount;
        this.eventCount = eventCount;
        this.pendingInteractionCount = pendingInteractionCount;
        this.latestTurnState = latestTurnState;
        this.latestResponse = latestResponse;
    }
}

class StageView {
    readonly complete: boolean;
    readonly href: string;
    readonly label: string;
    readonly number: string;

    constructor(number: string, label: string, complete: boolean, href: string) {
        this.number = number;
        this.label = label;
        this.complete = complete;
        this.href = href;
    }
}

abstract class ResourceState {}
class EmptyResourceState extends ResourceState {}
class ReadyResourceState<T> extends ResourceState {
    readonly value: T;
    constructor(value: T) {
        super();
        this.value = value;
    }
}

abstract class BrowserState {}
class EmptyBrowserState extends BrowserState {}
class ReadyBrowserState extends BrowserState {
    readonly client: MobiusBrowserClient;
    readonly evidence: BrowserEvidenceView;
    readonly lastMessageId: string;
    readonly lastTurnId: string;

    constructor(client: MobiusBrowserClient, evidence: BrowserEvidenceView, lastTurnId = "", lastMessageId = "") {
        super();
        this.client = client;
        this.evidence = evidence;
        this.lastTurnId = lastTurnId;
        this.lastMessageId = lastMessageId;
    }
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`The ${name} response is invalid`);
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function text(value: Readonly<Record<string, unknown>>, field: string, name: string): string {
    const candidate = value[field];
    if (typeof candidate !== "string") {
        throw new Error(`The ${name} response has an invalid ${field}`);
    }
    return candidate;
}

function integer(value: Readonly<Record<string, unknown>>, field: string, name: string): number {
    const candidate = value[field];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
        throw new Error(`The ${name} response has an invalid ${field}`);
    }
    return candidate;
}

function boolean(value: Readonly<Record<string, unknown>>, field: string, name: string): boolean {
    const candidate = value[field];
    if (typeof candidate !== "boolean") {
        throw new Error(`The ${name} response has an invalid ${field}`);
    }
    return candidate;
}

function records(
    value: Readonly<Record<string, unknown>>,
    field: string,
    name: string,
): readonly Readonly<Record<string, unknown>>[] {
    const candidate = value[field];
    if (!Array.isArray(candidate)) {
        throw new Error(`The ${name} response has an invalid ${field}`);
    }
    return Object.freeze(candidate.map((entry) => record(entry, name)));
}

function texts(value: Readonly<Record<string, unknown>>, field: string, name: string): readonly string[] {
    const candidate = value[field];
    if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== "string")) {
        throw new Error(`The ${name} response has an invalid ${field}`);
    }
    return Object.freeze(candidate.filter((entry) => typeof entry === "string"));
}

async function api(path: string, method: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const signal = AbortSignal.timeout(20_000);
    const response =
        method === "GET"
            ? await fetch(path, { method, signal })
            : await fetch(path, {
                  body: JSON.stringify(body),
                  headers: { "content-type": "application/json" },
                  method,
                  signal,
              });
    const payload: unknown = await response.json();
    if (!response.ok) {
        const envelope = record(payload, "error");
        const error = record(envelope["error"], "error");
        throw new Error(text(error, "message", "error"));
    }
    return payload;
}

function decodeEnvironment(value: unknown): EnvironmentView {
    const data = record(value, "environment");
    return new EnvironmentView(text(data, "platformEndpoint", "environment"), text(data, "status", "environment"));
}

function decodeProvision(value: unknown): ProvisionView {
    const data = record(value, "provision");
    const configuration = record(data["configuration"], "configuration");
    const tenant = record(data["tenant"], "tenant");
    const app = record(data["app"], "app");
    const project = record(data["project"], "project");
    const usage = record(data["usage"], "usage");
    const checks = records(data, "checks", "checks").map((check) => ({
        evidence: text(check, "evidence", "check"),
        id: text(check, "id", "check"),
        label: text(check, "label", "check"),
        status: text(check, "status", "check"),
    }));
    return new ProvisionView(
        text(data, "health", "provision"),
        text(configuration, "hostingProfile", "configuration"),
        text(tenant, "tenantId", "tenant"),
        text(app, "appId", "app"),
        text(project, "projectId", "project"),
        integer(usage, "activeApps", "usage"),
        integer(usage, "activeProjects", "usage"),
        records(data, "auditEvents", "audit events").length,
        checks,
    );
}

function decodeCredential(value: unknown): CredentialView {
    const data = record(value, "AppCredential verification");
    return new CredentialView(
        text(data, "issuedCredentialId", "AppCredential verification"),
        text(data, "rotatedCredentialId", "AppCredential verification"),
        text(data, "revokedCredentialId", "AppCredential verification"),
        text(data, "overlapEndsAt", "AppCredential verification"),
        boolean(data, "revokedAccessDenied", "AppCredential verification"),
    );
}

function decodePairing(value: unknown): PairingView {
    const data = record(value, "Runtime pairing");
    return new PairingView(
        text(data, "pairingId", "Runtime pairing"),
        text(data, "pairingCode", "Runtime pairing"),
        text(data, "runtimeId", "Runtime pairing"),
        text(data, "expiresAt", "Runtime pairing"),
        text(data, "command", "Runtime pairing"),
    );
}

function decodeRuntime(value: unknown): RuntimeView {
    const data = record(value, "Runtime status");
    return new RuntimeView(
        text(data, "status", "Runtime status"),
        text(data, "runtimeId", "Runtime status"),
        text(data, "machineName", "Runtime status"),
        text(data, "workspaceName", "Runtime status"),
        texts(data, "agentLabels", "Runtime status"),
        boolean(data, "online", "Runtime status"),
    );
}

function decodeBot(value: unknown): BotView {
    const data = record(value, "Bot");
    return new BotView(
        text(data, "botId", "Bot"),
        text(data, "displayName", "Bot"),
        text(data, "behaviorRevisionId", "Bot"),
        text(data, "bindingId", "Bot"),
        text(data, "bindingStatus", "Bot"),
    );
}

function decodeConversation(value: unknown): ConversationView {
    const data = record(value, "Conversation access");
    const credential = text(data, "credential", "Conversation access");
    if (!/^mconv_[a-zA-Z0-9_-]{22}_[a-zA-Z0-9_-]{43}$/.test(credential)) {
        throw new Error("The Conversation access response has an invalid credential");
    }
    return new ConversationView(
        text(data, "conversationId", "Conversation access"),
        text(data, "sessionId", "Conversation access"),
        text(data, "actorRef", "Conversation access"),
        text(data, "credentialId", "Conversation access"),
        credential,
        text(data, "expiresAt", "Conversation access"),
        texts(data, "permissions", "Conversation access"),
        text(data, "platformEndpoint", "Conversation access"),
    );
}

function short(value: string): string {
    return value.length <= 28 ? value : `${value.slice(0, 14)}…${value.slice(-9)}`;
}

function StatusPill({ label, ready }: { readonly label: string; readonly ready: boolean }) {
    return (
        <span className={ready ? "status-pill status-pill--ready" : "status-pill"}>
            <span className="status-dot" aria-hidden="true" />
            {label}
        </span>
    );
}

function ActionButton({
    busy,
    children,
    disabled,
    icon,
    onClick,
}: {
    readonly busy: boolean;
    readonly children: string;
    readonly disabled: boolean;
    readonly icon: ReactNode;
    readonly onClick: () => void;
}) {
    return (
        <button className="action-button" type="button" disabled={disabled || busy} onClick={onClick}>
            {busy ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : icon}
            {children}
        </button>
    );
}

function IdRow({ label, value }: { readonly label: string; readonly value: string }) {
    return (
        <div className="id-row">
            <span>{label}</span>
            <code title={value}>{short(value)}</code>
        </div>
    );
}

export function App() {
    const [environment, setEnvironment] = useState<ResourceState>(new EmptyResourceState());
    const [provision, setProvision] = useState<ResourceState>(new EmptyResourceState());
    const [credential, setCredential] = useState<ResourceState>(new EmptyResourceState());
    const [pairing, setPairing] = useState<ResourceState>(new EmptyResourceState());
    const [runtime, setRuntime] = useState<ResourceState>(new EmptyResourceState());
    const [bot, setBot] = useState<ResourceState>(new EmptyResourceState());
    const [conversation, setConversation] = useState<ResourceState>(new EmptyResourceState());
    const [browser, setBrowser] = useState<BrowserState>(new EmptyBrowserState());
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState(
        "Start with Platform provisioning; each result is evidence from a real boundary.",
    );
    const [message, setMessage] = useState("Say hello through the Mobius Platform demo.");
    const browserRef = useRef<BrowserState>(new EmptyBrowserState());

    useEffect(() => {
        const controller = new AbortController();
        void fetch("/demo-api/health", { signal: controller.signal })
            .then(async (response) => decodeEnvironment(await response.json()))
            .then((value) => setEnvironment(new ReadyResourceState(value)))
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    setError(cause instanceof Error ? cause.message : "The demo API is unavailable");
                }
            });
        return () => controller.abort();
    }, []);

    useEffect(
        () => () => {
            if (browserRef.current instanceof ReadyBrowserState) {
                browserRef.current.client.close();
            }
        },
        [],
    );

    const perform = async (name: string, operation: () => Promise<void>): Promise<void> => {
        setBusy(name);
        setError("");
        try {
            await operation();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The operation failed");
        } finally {
            setBusy("");
        }
    };

    const provisionPlatform = (): void => {
        void perform("provision", async () => {
            const value = decodeProvision(await api("/demo-api/provision", "POST", { label: "Integration Lab" }));
            setProvision(new ReadyResourceState(value));
            setNotice("Platform control plane verified. The AppCredential stayed inside the demo API process.");
        });
    };

    const verifyCredential = (): void => {
        void perform("credential", async () => {
            const value = decodeCredential(await api("/demo-api/app-credentials/verify", "POST", {}));
            setCredential(new ReadyResourceState(value));
            setNotice("Scoped AppCredential issued, rotated, exercised, revoked, and rejected after revocation.");
        });
    };

    const createPairing = (): void => {
        void perform("pairing", async () => {
            const value = decodePairing(await api("/demo-api/runtime-pairings", "POST", {}));
            setPairing(new ReadyResourceState(value));
            setRuntime(new ReadyResourceState(new RuntimeView("pending", value.runtimeId, "", "", [], false)));
            setNotice("Run the generated command in a second terminal, then refresh Runtime status.");
        });
    };

    const refreshRuntime = (): void => {
        void perform("runtime", async () => {
            const value = decodeRuntime(await api("/demo-api/runtime-pairing", "GET", {}));
            setRuntime(new ReadyResourceState(value));
            setNotice(
                value.online
                    ? "Runtime paired and its authenticated WebSocket is online."
                    : `Runtime is ${value.status}.`,
            );
        });
    };

    const copyPairing = (): void => {
        if (!(pairing instanceof ReadyResourceState) || !(pairing.value instanceof PairingView)) {
            return;
        }
        void navigator.clipboard
            .writeText(pairing.value.command)
            .then(() => setNotice("Pairing command copied."))
            .catch(() => setError("The browser could not copy the pairing command."));
    };

    const createBot = (): void => {
        void perform("bot", async () => {
            const value = decodeBot(await api("/demo-api/bots", "POST", {}));
            setBot(new ReadyResourceState(value));
            setNotice("Bot profile, behavior revision, and Runtime execution binding request were created.");
        });
    };

    const createConversation = (): void => {
        void perform("conversation", async () => {
            const value = decodeConversation(await api("/demo-api/conversation-access", "POST", {}));
            setConversation(new ReadyResourceState(value));
            if (bot instanceof ReadyResourceState && bot.value instanceof BotView) {
                const current = bot.value;
                setBot(
                    new ReadyResourceState(
                        new BotView(
                            current.botId,
                            current.displayName,
                            current.behaviorRevisionId,
                            current.bindingId,
                            "approved",
                        ),
                    ),
                );
            }
            setNotice(
                "Runtime binding approval verified and Conversation created. Only its short-lived fixed-session credential crossed into the browser.",
            );
        });
    };

    const verifyBrowser = (): void => {
        void perform("browser", async () => {
            if (!(conversation instanceof ReadyResourceState) || !(conversation.value instanceof ConversationView)) {
                throw new Error("Create a Conversation before running browser verification");
            }
            const access = conversation.value;
            const client = createMobiusConversationSession({
                accessTokenProvider: {
                    accessToken: async () => new MobiusBrowserAccessToken(access.credential, access.expiresAt),
                },
                endpoint: access.platformEndpoint,
            });
            const signal = AbortSignal.timeout(20_000);
            const session = await client.session.read(signal);
            const configuration = await client.configuration.read(signal);
            const pending = await client.interactions.listPending(signal);
            const bytes = new TextEncoder().encode("Browser SDK verified by the Mobius Platform Integration Lab.");
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
                byte.toString(16).padStart(2, "0"),
            ).join("");
            const upload = await client.artifacts.createUpload(
                new MobiusArtifactUploadRequest("browser-evidence.txt", "text/plain", bytes.byteLength, digest),
                signal,
            );
            const artifact = await client.artifacts.uploadContent(upload, bytes, signal);
            const download = await client.artifacts.download(artifact.artifactId, signal);
            if (new TextDecoder().decode(download.bytes) !== new TextDecoder().decode(bytes)) {
                throw new Error("The browser Artifact round trip changed its content");
            }
            const history = await client.history.read(new MobiusPageRequest(50, ""), signal);
            const events = await client.readEvents(new MobiusPageRequest(50, ""), signal);
            const evidence = new BrowserEvidenceView(
                session.session.sessionId,
                configuration.revision,
                artifact.artifactId,
                history.acceptedMessages.length + history.turns.length,
                events.events.length,
                pending.length,
                "",
                "",
            );
            const state = new ReadyBrowserState(client, evidence);
            if (browserRef.current instanceof ReadyBrowserState) {
                browserRef.current.client.close();
            }
            browserRef.current = state;
            setBrowser(state);
            setNotice(
                "Browser SDK verified snapshot, configuration, Artifact, history, events, and Interaction routes.",
            );
        });
    };

    const sendMessage = (): void => {
        void perform("message", async () => {
            if (!(browserRef.current instanceof ReadyBrowserState)) {
                throw new Error("Run browser verification before sending a message");
            }
            const current = browserRef.current;
            const accepted = await current.client.messages.create(
                {
                    artifactIds: [current.evidence.artifactId],
                    content: message,
                    idempotencyKey: `browser-${crypto.randomUUID()}`,
                    images: [],
                    resources: [],
                },
                AbortSignal.timeout(20_000),
            );
            const turn = await current.client.messages.run(accepted.messageId, AbortSignal.timeout(20_000));
            const evidence = new BrowserEvidenceView(
                current.evidence.sessionId,
                current.evidence.configurationRevision,
                current.evidence.artifactId,
                current.evidence.historyCount,
                current.evidence.eventCount,
                current.evidence.pendingInteractionCount,
                turn.state.kind,
                "",
            );
            const state = new ReadyBrowserState(current.client, evidence, turn.turnId, accepted.messageId);
            browserRef.current = state;
            setBrowser(state);
            setNotice("Message persisted and Turn dispatched to the paired local Runtime.");
        });
    };

    const refreshBrowser = (): void => {
        void perform("browser-refresh", async () => {
            if (!(browserRef.current instanceof ReadyBrowserState)) {
                throw new Error("Run browser verification first");
            }
            const current = browserRef.current;
            const signal = AbortSignal.timeout(20_000);
            const history = await current.client.history.read(new MobiusPageRequest(50, ""), signal);
            const events = await current.client.readEvents(new MobiusPageRequest(50, ""), signal);
            let latestTurnState = current.evidence.latestTurnState;
            let latestResponse = current.evidence.latestResponse;
            if (current.lastTurnId.length > 0) {
                const turn = await current.client.turns.read(current.lastTurnId, signal);
                const messages = await current.client.session.readMessages(new MobiusPageRequest(50, ""), signal);
                latestTurnState = turn.state.kind;
                latestResponse =
                    messages.messages.find((messageEntry) => messageEntry.commandId === current.lastMessageId)
                        ?.response ?? "";
            }
            const evidence = new BrowserEvidenceView(
                current.evidence.sessionId,
                current.evidence.configurationRevision,
                current.evidence.artifactId,
                history.acceptedMessages.length + history.turns.length,
                events.events.length,
                current.evidence.pendingInteractionCount,
                latestTurnState,
                latestResponse,
            );
            const state = new ReadyBrowserState(current.client, evidence, current.lastTurnId, current.lastMessageId);
            browserRef.current = state;
            setBrowser(state);
            setNotice(`Browser history, events, and latest Turn were refreshed from Platform: ${latestTurnState}.`);
        });
    };

    const provisioned = provision instanceof ReadyResourceState && provision.value instanceof ProvisionView;
    const credentialVerified = credential instanceof ReadyResourceState && credential.value instanceof CredentialView;
    const paired = pairing instanceof ReadyResourceState && pairing.value instanceof PairingView;
    const runtimeOnline =
        runtime instanceof ReadyResourceState && runtime.value instanceof RuntimeView && runtime.value.online;
    const botProvisioned = bot instanceof ReadyResourceState && bot.value instanceof BotView;
    const botBindingApproved = botProvisioned && bot.value.bindingStatus === "approved";
    const conversationCreated =
        conversation instanceof ReadyResourceState && conversation.value instanceof ConversationView;
    const browserVerified = browser instanceof ReadyBrowserState;
    const stages = Object.freeze([
        new StageView("01", "Control plane", provisioned, "#control-plane"),
        new StageView("02", "Credentials", credentialVerified, "#credentials"),
        new StageView("03", "Runtime", runtimeOnline, "#runtime"),
        new StageView("04", "Bot binding", botBindingApproved, "#bot"),
        new StageView("05", "Conversation", conversationCreated, "#conversation"),
        new StageView("06", "Browser SDK", browserVerified, "#browser-sdk"),
    ]);
    const completedStageCount = stages.filter((stage) => stage.complete).length;

    return (
        <div className="app-shell">
            <header className="topbar">
                <a className="brand" href="#overview" aria-label="Mobius Platform Integration Lab home">
                    <span className="brand-mark">
                        <Boxes size={20} aria-hidden="true" />
                    </span>
                    <span>Mobius Platform</span>
                    <span className="brand-subtitle">Integration Lab</span>
                </a>
                <div className="topbar-status">
                    <StatusPill label="local only" ready />
                    <StatusPill
                        label={environment instanceof ReadyResourceState ? "API ready" : "API connecting"}
                        ready={environment instanceof ReadyResourceState}
                    />
                </div>
            </header>

            <div className="workspace">
                <aside className="rail" aria-label="Platform verification stages">
                    <p className="eyebrow">Phases 1—6</p>
                    <nav>
                        {stages.map((stage) => (
                            <a
                                className={stage.complete ? "rail-step rail-step--complete" : "rail-step"}
                                href={stage.href}
                                key={stage.number}
                            >
                                <span>{stage.number}</span>
                                <strong>{stage.label}</strong>
                                {stage.complete ? (
                                    <Check size={16} aria-label="complete" />
                                ) : (
                                    <ChevronRight size={16} aria-hidden="true" />
                                )}
                            </a>
                        ))}
                    </nav>
                    <div className="trust-card">
                        <ShieldCheck size={20} aria-hidden="true" />
                        <strong>Trust boundary</strong>
                        <p>AppCredential stays server-side. The browser receives one scoped Conversation credential.</p>
                    </div>
                </aside>

                <main id="overview">
                    <section className="hero">
                        <div>
                            <p className="eyebrow">Executable platform proof</p>
                            <h1>From tenant to local Agent, with evidence at every hop.</h1>
                            <p className="hero-copy">
                                Provision the multi-tenant control plane, pair the production Runtime SDK, and exercise
                                the fixed-session browser SDK against real local D1 and Durable Objects.
                            </p>
                        </div>
                        <div
                            className="hero-metric"
                            role="progressbar"
                            aria-label="Verification progress"
                            aria-valuemin={0}
                            aria-valuemax={stages.length}
                            aria-valuenow={completedStageCount}
                        >
                            <strong>
                                {completedStageCount}
                                <span>/6</span>
                            </strong>
                            <small>boundaries verified</small>
                        </div>
                    </section>

                    <div
                        className={error.length > 0 ? "notice notice--error" : "notice"}
                        role="status"
                        aria-live="polite"
                    >
                        {error.length > 0 ? (
                            <CircleAlert size={18} aria-hidden="true" />
                        ) : (
                            <Activity size={18} aria-hidden="true" />
                        )}
                        <span>{error.length > 0 ? error : notice}</span>
                    </div>

                    <section className="panel" id="control-plane">
                        <div className="panel-heading">
                            <div className="section-icon">
                                <CloudCog size={22} aria-hidden="true" />
                            </div>
                            <div>
                                <p className="eyebrow">Phase 01</p>
                                <h2>Platform control plane</h2>
                                <p>Health, hosting boundary, Tenant, App, Project, quotas, and audit.</p>
                            </div>
                            <ActionButton
                                busy={busy === "provision"}
                                disabled={provisioned}
                                icon={<Play size={18} aria-hidden="true" />}
                                onClick={provisionPlatform}
                            >
                                Provision & verify
                            </ActionButton>
                        </div>
                        {provisioned &&
                        provision instanceof ReadyResourceState &&
                        provision.value instanceof ProvisionView ? (
                            <div className="panel-grid">
                                <div className="resource-card">
                                    <div className="resource-title">
                                        <Database size={18} aria-hidden="true" />
                                        <strong>Created resources</strong>
                                        <StatusPill label={provision.value.health} ready />
                                    </div>
                                    <IdRow label="Tenant" value={provision.value.tenantId} />
                                    <IdRow label="App" value={provision.value.appId} />
                                    <IdRow label="Project" value={provision.value.projectId} />
                                </div>
                                <div className="resource-card">
                                    <div className="resource-title">
                                        <Activity size={18} aria-hidden="true" />
                                        <strong>Observed evidence</strong>
                                    </div>
                                    <IdRow label="Hosting" value={provision.value.hostingProfile} />
                                    <IdRow
                                        label="Usage"
                                        value={`${provision.value.activeApps} app · ${provision.value.activeProjects} project`}
                                    />
                                    <IdRow label="Audit" value={`${provision.value.auditCount} events`} />
                                </div>
                                <div className="check-list">
                                    {provision.value.checks.map((check) => (
                                        <div className="check-row" key={check.id}>
                                            <Check size={16} aria-hidden="true" />
                                            <span>
                                                <strong>{check.label}</strong>
                                                <small>{check.evidence}</small>
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div className="empty-state">No Platform resources have been created in this run.</div>
                        )}
                    </section>

                    <section className="panel" id="credentials">
                        <div className="panel-heading">
                            <div className="section-icon">
                                <KeyRound size={22} aria-hidden="true" />
                            </div>
                            <div>
                                <p className="eyebrow">Phase 02</p>
                                <h2>Credential lifecycle</h2>
                                <p>Scoped issue, authenticated use, rotation overlap, revocation, and denial.</p>
                            </div>
                            <ActionButton
                                busy={busy === "credential"}
                                disabled={!provisioned || credentialVerified}
                                icon={<ShieldCheck size={18} aria-hidden="true" />}
                                onClick={verifyCredential}
                            >
                                Verify lifecycle
                            </ActionButton>
                        </div>
                        {credentialVerified &&
                        credential instanceof ReadyResourceState &&
                        credential.value instanceof CredentialView ? (
                            <div className="credential-flow">
                                <div>
                                    <span className="credential-flow-label">Issued</span>
                                    <code className="credential-flow-code">
                                        {short(credential.value.issuedCredentialId)}
                                    </code>
                                </div>
                                <ChevronRight size={18} aria-hidden="true" />
                                <div>
                                    <span className="credential-flow-label">Rotated</span>
                                    <code className="credential-flow-code">
                                        {short(credential.value.rotatedCredentialId)}
                                    </code>
                                </div>
                                <ChevronRight size={18} aria-hidden="true" />
                                <div>
                                    <span className="credential-flow-label">Revoked</span>
                                    <code className="credential-flow-code">
                                        {short(credential.value.revokedCredentialId)}
                                    </code>
                                </div>
                                <StatusPill
                                    label="access denied after revoke"
                                    ready={credential.value.revokedAccessDenied}
                                />
                            </div>
                        ) : (
                            <div className="empty-state">
                                The primary secret remains sealed in the backend; a disposable credential will exercise
                                lifecycle checks.
                            </div>
                        )}
                    </section>

                    <section className="panel" id="runtime">
                        <div className="panel-heading">
                            <div className="section-icon">
                                <ServerCog size={22} aria-hidden="true" />
                            </div>
                            <div>
                                <p className="eyebrow">Phase 03</p>
                                <h2>Runtime pairing</h2>
                                <p>Create a pollable pairing, then connect the real local Runtime SDK.</p>
                            </div>
                            <div className="button-group">
                                <ActionButton
                                    busy={busy === "pairing"}
                                    disabled={!provisioned || paired}
                                    icon={<TerminalSquare size={18} aria-hidden="true" />}
                                    onClick={createPairing}
                                >
                                    Create pairing
                                </ActionButton>
                                <ActionButton
                                    busy={busy === "runtime"}
                                    disabled={!paired}
                                    icon={<RefreshCw size={18} aria-hidden="true" />}
                                    onClick={refreshRuntime}
                                >
                                    Refresh status
                                </ActionButton>
                            </div>
                        </div>
                        {paired && pairing instanceof ReadyResourceState && pairing.value instanceof PairingView ? (
                            <div className="terminal-card">
                                <div className="terminal-bar">
                                    <span>
                                        <span className="terminal-dot" />
                                        Runtime command
                                    </span>
                                    <button type="button" onClick={copyPairing}>
                                        <Clipboard size={16} aria-hidden="true" />
                                        Copy
                                    </button>
                                </div>
                                <code>{pairing.value.command}</code>
                                <div className="pairing-meta">
                                    <span>
                                        Code <strong>{pairing.value.pairingCode}</strong>
                                    </span>
                                    <span>Expires {new Date(pairing.value.expiresAt).toLocaleTimeString()}</span>
                                </div>
                            </div>
                        ) : (
                            <div className="empty-state">
                                Create a one-time pairing after the control plane is ready.
                            </div>
                        )}
                        {runtime instanceof ReadyResourceState && runtime.value instanceof RuntimeView ? (
                            <div className="runtime-line">
                                <StatusPill
                                    label={runtime.value.online ? "online" : runtime.value.status}
                                    ready={runtime.value.online}
                                />
                                <IdRow label="Runtime" value={runtime.value.runtimeId} />
                                <IdRow label="Machine" value={runtime.value.machineName || "waiting for pairing"} />
                                <IdRow label="Agents" value={runtime.value.agentLabels.join(", ") || "not reported"} />
                            </div>
                        ) : null}
                    </section>

                    <section className="panel" id="bot">
                        <div className="panel-heading">
                            <div className="section-icon">
                                <Bot size={22} aria-hidden="true" />
                            </div>
                            <div>
                                <p className="eyebrow">Phase 04</p>
                                <h2>Bot execution binding</h2>
                                <p>Profile, behavior, local approval, and pinned Runtime execution.</p>
                            </div>
                            <ActionButton
                                busy={busy === "bot"}
                                disabled={!runtimeOnline || botProvisioned}
                                icon={<Bot size={18} aria-hidden="true" />}
                                onClick={createBot}
                            >
                                Create Bot
                            </ActionButton>
                        </div>
                        {botProvisioned && bot instanceof ReadyResourceState && bot.value instanceof BotView ? (
                            <div className="resource-card resource-card--wide">
                                <div className="resource-title">
                                    <Bot size={18} aria-hidden="true" />
                                    <strong>{bot.value.displayName}</strong>
                                    <StatusPill
                                        label={bot.value.bindingStatus}
                                        ready={bot.value.bindingStatus === "approved"}
                                    />
                                </div>
                                <div className="three-columns">
                                    <IdRow label="Bot" value={bot.value.botId} />
                                    <IdRow label="Behavior" value={bot.value.behaviorRevisionId} />
                                    <IdRow label="Binding" value={bot.value.bindingId} />
                                </div>
                            </div>
                        ) : (
                            <div className="empty-state">
                                An online Runtime is required before its execution boundary can approve a binding.
                            </div>
                        )}
                    </section>

                    <section className="panel" id="conversation">
                        <div className="panel-heading">
                            <div className="section-icon">
                                <MessageSquareText size={22} aria-hidden="true" />
                            </div>
                            <div>
                                <p className="eyebrow">Phase 05</p>
                                <h2>Conversation access</h2>
                                <p>Server creates the Conversation and issues one short-lived browser credential.</p>
                            </div>
                            <ActionButton
                                busy={busy === "conversation"}
                                disabled={!botProvisioned || conversationCreated}
                                icon={<KeyRound size={18} aria-hidden="true" />}
                                onClick={createConversation}
                            >
                                Issue browser access
                            </ActionButton>
                        </div>
                        {conversationCreated &&
                        conversation instanceof ReadyResourceState &&
                        conversation.value instanceof ConversationView ? (
                            <div className="conversation-access">
                                <IdRow label="Conversation" value={conversation.value.conversationId} />
                                <IdRow label="Session" value={conversation.value.sessionId} />
                                <IdRow label="Actor" value={conversation.value.actorRef} />
                                <IdRow
                                    label="Credential"
                                    value={`${conversation.value.credential.slice(0, 12)}… redacted`}
                                />
                                <span className="permission-count">
                                    {conversation.value.permissions.length} exact permissions
                                </span>
                            </div>
                        ) : (
                            <div className="empty-state">
                                The browser receives no Project selector and cannot construct Platform administration
                                clients.
                            </div>
                        )}
                    </section>

                    <section className="panel panel--accent" id="browser-sdk">
                        <div className="panel-heading">
                            <div className="section-icon">
                                <ShieldCheck size={22} aria-hidden="true" />
                            </div>
                            <div>
                                <p className="eyebrow">Phase 06</p>
                                <h2>Browser SDK data plane</h2>
                                <p>
                                    Snapshot, configuration, Artifact, history, events, messages, Turns, and
                                    Interactions.
                                </p>
                            </div>
                            <ActionButton
                                busy={busy === "browser"}
                                disabled={!conversationCreated}
                                icon={<Play size={18} aria-hidden="true" />}
                                onClick={verifyBrowser}
                            >
                                Run browser checks
                            </ActionButton>
                        </div>
                        {browserVerified && browser instanceof ReadyBrowserState ? (
                            <div className="browser-lab">
                                <div className="evidence-strip">
                                    <div>
                                        <strong className="evidence-value">
                                            {browser.evidence.configurationRevision}
                                        </strong>
                                        <span className="evidence-label">config revision</span>
                                    </div>
                                    <div>
                                        <strong className="evidence-value">{browser.evidence.historyCount}</strong>
                                        <span className="evidence-label">history records</span>
                                    </div>
                                    <div>
                                        <strong className="evidence-value">{browser.evidence.eventCount}</strong>
                                        <span className="evidence-label">events</span>
                                    </div>
                                    <div>
                                        <strong className="evidence-value">
                                            {browser.evidence.pendingInteractionCount}
                                        </strong>
                                        <span className="evidence-label">pending interactions</span>
                                    </div>
                                </div>
                                <IdRow label="Artifact round trip" value={browser.evidence.artifactId} />
                                <div className="composer">
                                    <label htmlFor="demo-message">Send a real Turn to the local Agent</label>
                                    <div>
                                        <textarea
                                            id="demo-message"
                                            value={message}
                                            onChange={(event) => setMessage(event.target.value)}
                                            rows={3}
                                        />
                                        <button
                                            className="send-button"
                                            type="button"
                                            disabled={busy.length > 0 || message.trim().length === 0}
                                            onClick={sendMessage}
                                        >
                                            {busy === "message" ? (
                                                <LoaderCircle className="spin" size={18} aria-hidden="true" />
                                            ) : (
                                                <Send size={18} aria-hidden="true" />
                                            )}
                                            Send
                                        </button>
                                    </div>
                                    <button
                                        className="text-button"
                                        type="button"
                                        disabled={busy.length > 0}
                                        onClick={refreshBrowser}
                                    >
                                        <RefreshCw size={16} aria-hidden="true" />
                                        Refresh Turn evidence
                                    </button>
                                </div>
                                {browser.lastTurnId.length > 0 ? (
                                    <div className="turn-result">
                                        <div>
                                            <IdRow label="Latest Turn" value={browser.lastTurnId} />
                                            <StatusPill
                                                label={browser.evidence.latestTurnState || "queued"}
                                                ready={browser.evidence.latestTurnState === "succeeded"}
                                            />
                                        </div>
                                        <p>
                                            {browser.evidence.latestResponse ||
                                                "Waiting for the local Agent response. Refresh Turn evidence to update."}
                                        </p>
                                    </div>
                                ) : null}
                            </div>
                        ) : (
                            <div className="empty-state">
                                Run this step in the browser to prove direct CORS and fixed-session authorization—not a
                                server-side proxy.
                            </div>
                        )}
                    </section>
                </main>
            </div>
        </div>
    );
}
