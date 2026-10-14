import * as Dialog from "@radix-ui/react-dialog";
import { Clipboard, Eye, EyeOff, ShieldCheck } from "lucide-react";
import type { RevealedSecret } from "../view-models/platform-app-view-model.ts";

export interface SecretDialogProps {
    readonly onClose: () => void;
    readonly onCopy: (value: string, label: string) => void;
    readonly onVisibleChange: (visible: boolean) => void;
    readonly secret: RevealedSecret | null;
    readonly visible: boolean;
}

function SecretField({
    label,
    value,
    onCopy,
}: {
    readonly label: string;
    readonly value: string;
    readonly onCopy: () => void;
}) {
    return (
        <>
            <div className="mt-3 mb-1.5 text-[11px] font-bold text-[#6d7b73]">{label}</div>
            <div className="flex min-h-[43px] items-center rounded-lg border border-[#d3dad5] bg-[#f8faf8] pl-3 [&>code]:min-w-0 [&>code]:flex-1 [&>code]:overflow-hidden [&>code]:text-ellipsis [&>code]:whitespace-nowrap [&>code]:text-[11px] [&>button]:grid [&>button]:w-[38px] [&>button]:self-stretch [&>button]:place-items-center [&>button]:border-0 [&>button]:border-l [&>button]:border-[#dce2de] [&>button]:bg-transparent">
                <code>{value}</code>
                <button type="button" onClick={onCopy} aria-label={`Copy ${label}`}>
                    <Clipboard size={15} />
                </button>
            </div>
        </>
    );
}

const copy: {
    readonly [K in RevealedSecret["kind"]]: {
        readonly eyebrow: string;
        readonly title: string;
        readonly description: string;
        readonly secretLabel: string;
        readonly secretNote: React.ReactNode;
        readonly copyLabel: string;
    };
} = {
    "app-credential": {
        eyebrow: "Created successfully",
        title: "Save your app secret",
        description:
            "Copy the full app secret below for server authentication. This is the only time Mobius will show it. Store it in your server’s secret manager.",
        secretLabel: "App secret",
        secretNote: (
            <>
                This is your full <code>mapp_…</code> AppCredential. Use it as <code>MOBIUS_APP_SECRET</code>, with the
                App ID above as <code>MOBIUS_APP_ID</code>.
            </>
        ),
        copyLabel: "App secret",
    },
    "webhook-created": {
        eyebrow: "Created successfully",
        title: "Save your webhook signing secret",
        description:
            "Copy the signing secret below to verify Session status webhook signatures. This is the only time Mobius will show it. Store it in your server’s secret manager.",
        secretLabel: "Webhook signing secret",
        secretNote: (
            <>
                This is your full <code>mweb_…</code> webhook signing secret, not the App secret. Use it to verify the{" "}
                <code>x-mobius-signature</code> header on each Session status notification.
            </>
        ),
        copyLabel: "Webhook secret",
    },
    "webhook-rotated": {
        eyebrow: "Rotated successfully",
        title: "Save your webhook signing secret",
        description:
            "The previous signing secret stopped working immediately. Copy the new signing secret below to verify Session status webhook signatures. This is the only time Mobius will show it.",
        secretLabel: "Webhook signing secret",
        secretNote: (
            <>
                This is your full <code>mweb_…</code> webhook signing secret, not the App secret. Use it to verify the{" "}
                <code>x-mobius-signature</code> header on each Session status notification.
            </>
        ),
        copyLabel: "Webhook secret",
    },
};

export function SecretDialog({ onClose, onCopy, onVisibleChange, secret, visible }: SecretDialogProps) {
    return (
        <Dialog.Root
            open={secret !== null}
            onOpenChange={(open) => {
                if (!open) {
                    onClose();
                }
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[#121d17]/60 p-5 backdrop-blur-sm">
                    {secret === null ? null : (
                        <Dialog.Content className="w-full max-w-[560px] rounded-2xl bg-white p-8 text-[#17221d] shadow-2xl">
                            <div className="mb-5 grid size-12 place-items-center rounded-xl bg-[#e7f3eb] text-[#168247]">
                                <ShieldCheck size={24} />
                            </div>
                            <p className="mb-2 text-[10px] font-extrabold uppercase tracking-[.13em] text-[#168247]">
                                {copy[secret.kind].eyebrow}
                            </p>
                            <Dialog.Title className="mb-2 text-3xl font-bold">{copy[secret.kind].title}</Dialog.Title>
                            <Dialog.Description className="mb-6 text-sm leading-6 text-[#69766f]">
                                {copy[secret.kind].description}
                            </Dialog.Description>
                            <SecretField
                                label="App ID"
                                value={secret.appId}
                                onCopy={() => onCopy(secret.appId, "App ID")}
                            />
                            <div className="mt-3 mb-1.5 text-[11px] font-bold text-[#6d7b73]">
                                {copy[secret.kind].secretLabel}
                            </div>
                            <p className="mb-2 text-xs leading-5 text-[#69766f]">{copy[secret.kind].secretNote}</p>
                            <div className="flex min-h-[43px] items-center rounded-lg border border-[#d3dad5] bg-[#f8faf8] pl-3 [&>code]:min-w-0 [&>code]:flex-1 [&>code]:overflow-hidden [&>code]:text-ellipsis [&>code]:whitespace-nowrap [&>code]:text-[11px] [&>button]:grid [&>button]:w-[38px] [&>button]:self-stretch [&>button]:place-items-center [&>button]:border-0 [&>button]:border-l [&>button]:border-[#dce2de] [&>button]:bg-transparent">
                                <code>{visible ? secret.secret : "•".repeat(32)}</code>
                                <button
                                    type="button"
                                    onClick={() => onVisibleChange(!visible)}
                                    aria-label={visible ? "Hide secret" : "Show secret"}
                                >
                                    {visible ? <EyeOff size={15} /> : <Eye size={15} />}
                                </button>
                            </div>
                            <button
                                type="button"
                                className="mt-3 inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#168247] bg-[#e7f3eb] px-3.5 text-sm font-bold text-[#168247] hover:bg-[#d8ebdf]"
                                onClick={() => onCopy(secret.secret, copy[secret.kind].copyLabel)}
                                aria-label={`Copy ${copy[secret.kind].copyLabel}`}
                            >
                                <Clipboard size={15} />
                                Copy {copy[secret.kind].copyLabel}
                            </button>
                            <Dialog.Close asChild>
                                <button
                                    type="button"
                                    className="mt-6 inline-flex min-h-[39px] w-full items-center justify-center rounded-lg border border-[#168247] bg-[#168247] px-3.5 font-bold text-white hover:bg-[#11683a]"
                                >
                                    I’ve saved the secret
                                </button>
                            </Dialog.Close>
                        </Dialog.Content>
                    )}
                </Dialog.Overlay>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
