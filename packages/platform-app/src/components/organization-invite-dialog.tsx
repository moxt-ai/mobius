import * as Dialog from "@radix-ui/react-dialog";
import { Link, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
    createOrganizationInvite,
    listOrganizationInvites,
    type OrganizationInvite,
    revokeOrganizationInvite,
} from "../services/organization-invite-client.ts";

interface InviteProps {
    readonly endpoint: string;
    readonly getToken: () => Promise<string>;
    readonly organization: { readonly id: string; readonly name: string };
}
type LinksState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "ready"; readonly links: readonly OrganizationInvite[] };
type ActionState =
    | { readonly kind: "idle" }
    | { readonly kind: "busy" }
    | { readonly kind: "failed"; readonly message: string };
type IssuedState = { readonly kind: "none" } | { readonly kind: "issued"; readonly id: string; readonly url: string };
const button =
    "inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#ccd5cf] px-3.5 text-sm font-bold text-[#45534b] hover:bg-[#fafbfa] disabled:opacity-50";

function InviteContent({ endpoint, getToken, organization }: InviteProps) {
    const [state, setState] = useState<LinksState>({ kind: "loading" });
    const [action, setAction] = useState<ActionState>({ kind: "idle" });
    const [issued, setIssued] = useState<IssuedState>({ kind: "none" });
    const [notice, setNotice] = useState("");
    const lifetime = useRef(new AbortController());
    useEffect(() => {
        const controller = new AbortController();
        void listOrganizationInvites(
            endpoint,
            getToken,
            organization.id,
            AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        )
            .then((links) => {
                if (!controller.signal.aborted) {
                    setState({ kind: "ready", links });
                }
            })
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    setState({
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "Could not load invite links",
                    });
                }
            });
        return () => controller.abort();
    }, [endpoint, getToken, organization.id]);
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        return () => controller.abort();
    }, []);

    const perform = async (operation: (signal: AbortSignal) => Promise<void>) => {
        if (action.kind === "busy") {
            return;
        }
        setAction({ kind: "busy" });
        setNotice("");
        const controller = lifetime.current;
        try {
            await operation(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
            if (!controller.signal.aborted) {
                setAction({ kind: "idle" });
            }
        } catch (cause) {
            if (!controller.signal.aborted) {
                setAction({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "The invitation request failed",
                });
            }
        }
    };
    const busy = action.kind === "busy";
    return (
        <>
            <Dialog.Title className="pr-8 text-2xl font-bold tracking-tight">
                Invite members to {organization.name}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-[#69766f]">
                Share a link so people can join this organization. Anyone with the link can sign in and join as a
                member.
            </Dialog.Description>
            <Dialog.Close asChild>
                <button
                    type="button"
                    aria-label="Close dialog"
                    className="absolute top-5 right-5 rounded-lg p-1 text-[#69766f]"
                >
                    <X size={20} />
                </button>
            </Dialog.Close>
            <div className="my-5 flex gap-8 rounded-lg bg-[#f4f6f4] p-4 text-sm">
                <div>
                    Role<strong className="block">Member</strong>
                </div>
                <div>
                    Expires<strong className="block">In 7 days</strong>
                </div>
            </div>
            {state.kind === "loading" ? <p role="status">Loading invite links…</p> : null}
            {state.kind === "failed" ? (
                <p role="alert" className="text-sm text-[#8c3636]">
                    {state.message}
                </p>
            ) : null}
            {state.kind === "ready" ? (
                <>
                    <button
                        type="button"
                        disabled={busy}
                        className={`${button} border-[#168247] bg-[#168247] text-white hover:bg-[#11683a]`}
                        onClick={() =>
                            void perform(async (signal) => {
                                const link = await createOrganizationInvite(
                                    endpoint,
                                    getToken,
                                    organization.id,
                                    signal,
                                );
                                if (signal.aborted) {
                                    return;
                                }
                                const url = new URL(`${import.meta.env.BASE_URL}join`, window.location.origin);
                                url.hash = link.token;
                                setIssued({ kind: "issued", id: link.id, url: url.href });
                                setState({ kind: "ready", links: [link, ...state.links] });
                            })
                        }
                    >
                        <Link size={16} />
                        {busy ? "Working…" : "Create invite link"}
                    </button>
                    {issued.kind === "issued" ? (
                        <div className="mt-4 rounded-lg border border-[#cfe5d6] bg-[#f0faf3] p-4">
                            <label htmlFor="organization-invite-link" className="mb-2 block text-sm font-bold">
                                Your invite link
                            </label>
                            <div className="flex gap-2">
                                <input
                                    id="organization-invite-link"
                                    readOnly
                                    value={issued.url}
                                    onFocus={(event) => event.target.select()}
                                    className="min-w-0 flex-1 rounded-lg border border-[#ccd5cf] bg-white px-3 text-sm"
                                />
                                <button
                                    type="button"
                                    className={button}
                                    onClick={() => {
                                        void navigator.clipboard.writeText(issued.url).then(
                                            () => setNotice("Invite link copied"),
                                            () => setNotice("Select and copy the link above"),
                                        );
                                    }}
                                >
                                    Copy link
                                </button>
                            </div>
                            <p className="mt-2 text-xs text-[#69766f]">
                                Copy this link now. You can create another if you lose it.
                            </p>
                        </div>
                    ) : null}
                    <h3 className="mt-6 text-sm font-bold">Active invite links</h3>
                    {state.links.length === 0 ? (
                        <p className="mt-2 text-sm text-[#69766f]">No active invite links.</p>
                    ) : (
                        <ul className="mt-2 divide-y divide-[#dce2de]">
                            {state.links.map((link) => (
                                <li key={link.id} className="flex items-center justify-between gap-3 py-3">
                                    <div className="text-sm">
                                        Member invite
                                        <span className="block text-xs text-[#69766f]">
                                            Created {new Date(link.createdAt).toLocaleDateString()} · Expires{" "}
                                            {new Date(link.expiresAt).toLocaleDateString()}
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        className={button}
                                        aria-label={`Revoke invite created ${new Date(link.createdAt).toISOString()}`}
                                        onClick={() =>
                                            void perform(async (signal) => {
                                                await revokeOrganizationInvite(
                                                    endpoint,
                                                    getToken,
                                                    organization.id,
                                                    link.id,
                                                    signal,
                                                );
                                                if (signal.aborted) {
                                                    return;
                                                }
                                                setState({
                                                    kind: "ready",
                                                    links: state.links.filter((entry) => entry.id !== link.id),
                                                });
                                                if (issued.kind === "issued" && issued.id === link.id) {
                                                    setIssued({ kind: "none" });
                                                }
                                                setNotice("Invite link revoked");
                                            })
                                        }
                                    >
                                        Revoke
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            ) : null}
            {action.kind === "failed" ? (
                <p role="alert" className="mt-3 text-sm text-[#8c3636]">
                    {action.message}
                </p>
            ) : null}
            <p role="status" className="mt-3 text-sm text-[#168247]">
                {notice}
            </p>
        </>
    );
}

export function OrganizationInviteDialog(props: InviteProps) {
    return (
        <Dialog.Root>
            <Dialog.Trigger asChild>
                <button type="button" className={button}>
                    <Link size={16} />
                    Invite members
                </button>
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[#121d17]/60 p-4 backdrop-blur-sm">
                    <Dialog.Content className="relative max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl bg-white p-6 text-[#17221d] shadow-2xl md:p-8">
                        <InviteContent {...props} />
                    </Dialog.Content>
                </Dialog.Overlay>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
