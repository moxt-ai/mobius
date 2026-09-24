import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle, X } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";

type NameDialogState = { readonly kind: "closed" } | { readonly kind: "editing"; readonly name: string };

interface CreateNameDialogProps {
    readonly title: string;
    readonly description: string;
    readonly label: string;
    readonly placeholder: string;
    readonly busy: boolean;
    readonly error: string;
    readonly onOpen: () => void;
    readonly onCreate: (name: string) => Promise<boolean>;
    readonly children: ReactNode;
}

export function CreateNameDialog({
    title,
    description,
    label,
    placeholder,
    busy,
    error,
    onOpen,
    onCreate,
    children,
}: CreateNameDialogProps) {
    const [state, setState] = useState<NameDialogState>({ kind: "closed" });
    const inputId = useId();
    const inputRef = useRef<HTMLInputElement>(null);

    return (
        <Dialog.Root
            open={state.kind === "editing"}
            onOpenChange={(open) => {
                if (busy) {
                    return;
                }
                if (open) {
                    onOpen();
                }
                setState(open ? { kind: "editing", name: "" } : { kind: "closed" });
            }}
        >
            <Dialog.Trigger asChild>{children}</Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[#121d17]/60 p-4 backdrop-blur-sm">
                    {state.kind === "closed" ? null : (
                        <Dialog.Content
                            onOpenAutoFocus={(event) => {
                                event.preventDefault();
                                inputRef.current?.focus();
                            }}
                            className="relative w-full max-w-[440px] rounded-2xl bg-white p-6 text-[#17221d] shadow-2xl md:p-8"
                        >
                            <Dialog.Title className="pr-8 text-2xl font-bold tracking-tight">{title}</Dialog.Title>
                            <Dialog.Description className="mt-2 text-sm leading-6 text-[#69766f]">
                                {description}
                            </Dialog.Description>
                            <Dialog.Close asChild>
                                <button
                                    type="button"
                                    aria-label="Close dialog"
                                    disabled={busy}
                                    className="absolute top-5 right-5 rounded-lg p-1 text-[#69766f] hover:bg-[#eff2f0] disabled:opacity-50"
                                >
                                    <X size={20} />
                                </button>
                            </Dialog.Close>
                            <form
                                className="mt-6"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    const name = state.name.trim();
                                    if (busy || name.length === 0) {
                                        return;
                                    }
                                    void onCreate(name).then((created) => {
                                        if (created) {
                                            setState({ kind: "closed" });
                                        }
                                    });
                                }}
                            >
                                <label htmlFor={inputId} className="mb-2 block text-sm font-bold text-[#45534b]">
                                    {label}
                                </label>
                                <input
                                    ref={inputRef}
                                    id={inputId}
                                    value={state.name}
                                    onChange={(event) => setState({ kind: "editing", name: event.target.value })}
                                    placeholder={placeholder}
                                    required
                                    maxLength={120}
                                    disabled={busy}
                                    className="w-full cursor-text rounded-lg border border-[#ccd5cf] bg-white px-3 py-2 text-[#17221d] caret-[#17221d] outline-none placeholder:text-[#819087] focus:border-[#168247] focus:ring-2 focus:ring-[#168247]/20 disabled:opacity-50"
                                />
                                {error.length > 0 ? (
                                    <p role="alert" className="mt-3 text-sm text-[#8c3636]">
                                        {error}
                                    </p>
                                ) : null}
                                <div className="mt-6 flex justify-end gap-2">
                                    <Dialog.Close asChild>
                                        <button
                                            type="button"
                                            disabled={busy}
                                            className="min-h-[39px] rounded-lg border border-[#ccd5cf] bg-white px-3.5 font-bold text-[#45534b] hover:bg-[#fafbfa] disabled:opacity-50"
                                        >
                                            Cancel
                                        </button>
                                    </Dialog.Close>
                                    <button
                                        type="submit"
                                        disabled={busy || state.name.trim().length === 0}
                                        className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#168247] bg-[#168247] px-3.5 font-bold text-white hover:bg-[#11683a] disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {busy ? <LoaderCircle className="animate-spin" size={16} /> : null}
                                        {busy ? "Creating…" : title}
                                    </button>
                                </div>
                            </form>
                        </Dialog.Content>
                    )}
                </Dialog.Overlay>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
