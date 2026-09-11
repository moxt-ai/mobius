import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { ReactNode } from "react";

export interface ConfirmActionProps {
    readonly children: ReactNode;
    readonly description: string;
    readonly onConfirm: () => void;
    readonly title: string;
}

export function ConfirmAction({ children, description, onConfirm, title }: ConfirmActionProps) {
    return (
        <AlertDialog.Root>
            <AlertDialog.Trigger asChild>{children}</AlertDialog.Trigger>
            <AlertDialog.Portal>
                <AlertDialog.Overlay className="fixed inset-0 z-50 grid place-items-center bg-[#121d17]/60 p-5 backdrop-blur-sm">
                    <AlertDialog.Content className="w-full max-w-[440px] rounded-2xl bg-white p-7 shadow-2xl [&_h2]:m-0 [&_h2]:text-2xl [&_h2]:font-bold [&_p]:my-5 [&_p]:text-sm [&_p]:leading-6 [&_p]:text-[#69766f]">
                        <AlertDialog.Title>{title}</AlertDialog.Title>
                        <AlertDialog.Description>{description}</AlertDialog.Description>
                        <div className="flex flex-wrap gap-2">
                            <AlertDialog.Cancel asChild>
                                <button
                                    type="button"
                                    className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#ccd5cf] bg-white px-3.5 font-bold text-[#45534b] hover:bg-[#fafbfa]"
                                >
                                    Cancel
                                </button>
                            </AlertDialog.Cancel>
                            <AlertDialog.Action asChild>
                                <button
                                    type="button"
                                    className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#e2c9c9] bg-[#fffafa] px-3.5 font-bold text-[#b83e3e] hover:bg-[#fff1f1]"
                                    onClick={onConfirm}
                                >
                                    Delete
                                </button>
                            </AlertDialog.Action>
                        </div>
                    </AlertDialog.Content>
                </AlertDialog.Overlay>
            </AlertDialog.Portal>
        </AlertDialog.Root>
    );
}
