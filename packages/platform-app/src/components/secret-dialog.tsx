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
                                Created successfully
                            </p>
                            <Dialog.Title className="mb-2 text-3xl font-bold">Save your app secret</Dialog.Title>
                            <Dialog.Description className="mb-6 text-sm leading-6 text-[#69766f]">
                                This is the only time Mobius will show this secret. Store it in your server’s secret
                                manager.
                            </Dialog.Description>
                            <SecretField
                                label="App ID"
                                value={secret.appId}
                                onCopy={() => onCopy(secret.appId, "App ID")}
                            />
                            <SecretField
                                label="Key ID"
                                value={secret.publicCredentialId}
                                onCopy={() => onCopy(secret.publicCredentialId, "Key ID")}
                            />
                            <div className="mt-3 mb-1.5 text-[11px] font-bold text-[#6d7b73]">App secret</div>
                            <div className="flex min-h-[43px] items-center rounded-lg border border-[#d3dad5] bg-[#f8faf8] pl-3 [&>code]:min-w-0 [&>code]:flex-1 [&>code]:overflow-hidden [&>code]:text-ellipsis [&>code]:whitespace-nowrap [&>code]:text-[11px] [&>button]:grid [&>button]:w-[38px] [&>button]:self-stretch [&>button]:place-items-center [&>button]:border-0 [&>button]:border-l [&>button]:border-[#dce2de] [&>button]:bg-transparent">
                                <code>{visible ? secret.secret : "•".repeat(32)}</code>
                                <button
                                    type="button"
                                    onClick={() => onVisibleChange(!visible)}
                                    aria-label={visible ? "Hide secret" : "Show secret"}
                                >
                                    {visible ? <EyeOff size={15} /> : <Eye size={15} />}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onCopy(secret.secret, "App secret")}
                                    aria-label="Copy App secret"
                                >
                                    <Clipboard size={15} />
                                </button>
                            </div>
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
