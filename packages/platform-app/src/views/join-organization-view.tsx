import { useEffect, useState } from "react";
import {
    acceptOrganizationInvite,
    type OrganizationInvitePreview,
    previewOrganizationInvite,
} from "../services/organization-invite-client.ts";

type JoinState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "ready"; readonly invite: OrganizationInvitePreview }
    | { readonly kind: "joining"; readonly invite: OrganizationInvitePreview };

export function JoinOrganizationView({
    endpoint,
    getToken,
    token,
    onJoined,
}: {
    readonly endpoint: string;
    readonly getToken: () => Promise<string>;
    readonly token: string;
    readonly onJoined: (id: string, signal: AbortSignal) => Promise<void>;
}) {
    const [state, setState] = useState<JoinState>({ kind: "loading" });
    const [attempt, setAttempt] = useState(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: A user-requested retry must reload the same invitation.
    useEffect(() => {
        const controller = new AbortController();
        setState({ kind: "loading" });
        void previewOrganizationInvite(
            endpoint,
            getToken,
            token,
            AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        )
            .then((invite) => {
                if (!controller.signal.aborted) {
                    setState({ kind: "ready", invite });
                }
            })
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    setState({
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "Could not open this invitation",
                    });
                }
            });
        return () => controller.abort();
    }, [endpoint, getToken, token, attempt]);
    useEffect(() => {
        if (state.kind !== "joining") {
            return;
        }
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
        void (async () => {
            const joined = await acceptOrganizationInvite(endpoint, getToken, token, signal);
            signal.throwIfAborted();
            await onJoined(joined.organizationId, signal);
        })().catch((cause: unknown) => {
            if (!controller.signal.aborted) {
                setState({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "Could not join the organization",
                });
            }
        });
        return () => controller.abort();
    }, [state, endpoint, getToken, token, onJoined]);
    return (
        <main className="grid min-h-screen place-items-center bg-[#f4f6f4] p-6">
            <section className="w-full max-w-[480px] rounded-2xl border border-[#dce2de] bg-white p-8 text-center shadow-xl">
                <p className="mb-3 text-xs font-bold uppercase tracking-widest text-[#168247]">Mobius Platform</p>
                <h1 className="text-2xl font-bold">
                    {state.kind === "ready" || state.kind === "joining"
                        ? `Join ${state.invite.organizationName}`
                        : "Organization invitation"}
                </h1>
                {state.kind === "loading" ? (
                    <p role="status" className="mt-4">
                        Loading invitation…
                    </p>
                ) : null}
                {state.kind === "failed" ? (
                    <>
                        <p role="alert" className="mt-4 text-[#8c3636]">
                            {state.message}
                        </p>
                        <button
                            type="button"
                            className="mt-5 rounded-lg border px-4 py-2"
                            onClick={() => setAttempt((value) => value + 1)}
                        >
                            Try again
                        </button>
                    </>
                ) : null}
                {state.kind === "ready" || state.kind === "joining" ? (
                    <>
                        <p className="mt-3 text-sm text-[#69766f]">
                            {state.invite.member
                                ? "You’re already a member of this organization."
                                : "You’ve been invited to join this organization as a member."}
                        </p>
                        <button
                            type="button"
                            disabled={state.kind === "joining"}
                            className="mt-6 w-full rounded-lg bg-[#168247] px-4 py-3 font-bold text-white disabled:opacity-50"
                            onClick={() => setState({ kind: "joining", invite: state.invite })}
                        >
                            {state.kind === "joining"
                                ? "Opening organization…"
                                : state.invite.member
                                  ? "Open organization"
                                  : "Join organization"}
                        </button>
                    </>
                ) : null}
            </section>
        </main>
    );
}
