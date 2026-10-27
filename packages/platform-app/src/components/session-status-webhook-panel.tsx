import type { MobiusPlatformAppSessionStatusWebhook } from "@moxt-ai/mobius-sdk/platform";
import { KeyRound, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { platformDataTestId } from "../data-testid.ts";

export interface SessionStatusWebhookPanelProps {
    readonly busy: string;
    readonly onRotate: () => void;
    readonly onSave: (request: { readonly enabled: boolean; readonly endpoint: string }) => void;
    readonly webhook: MobiusPlatformAppSessionStatusWebhook;
}

function PanelNote({ children }: { readonly children: React.ReactNode }) {
    return <p className="mt-1.5 text-sm leading-6 text-[#69766f]">{children}</p>;
}

/** Configures the App-scoped terminal Session status webhook. */
export function SessionStatusWebhookPanel({ busy, onRotate, onSave, webhook }: SessionStatusWebhookPanelProps) {
    const [enabled, setEnabled] = useState(webhook.enabled);
    const [endpoint, setEndpoint] = useState(webhook.endpoint);
    const disabled = busy.length > 0;
    return (
        <section className="mt-6 grid gap-4">
            <div>
                <h3 className="m-0 text-xl font-bold">Session status webhook</h3>
                <PanelNote>
                    Mobius signs each terminal Session status notification with this App's dedicated secret and sends it
                    to this HTTPS endpoint. Notifications do not require Recording and never block live output.
                </PanelNote>
            </div>
            <form
                className="grid gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    onSave({ enabled, endpoint });
                }}
            >
                <label className="grid gap-1.5 text-xs font-bold text-[#5f6c65]" htmlFor="webhook-endpoint">
                    HTTPS endpoint
                    <input
                        id="webhook-endpoint"
                        className="min-h-[38px] rounded-lg border border-[#ccd5cf] px-3 text-sm font-normal text-[#17221d]"
                        type="url"
                        value={endpoint}
                        onChange={(event) => setEndpoint(event.target.value)}
                        placeholder="https://example.com/mobius/sessions/status"
                        required
                        disabled={disabled}
                    />
                </label>
                <label className="flex items-center gap-2 text-xs font-bold text-[#5f6c65]">
                    <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(event) => setEnabled(event.target.checked)}
                        disabled={disabled}
                    />
                    Enabled
                </label>
                <div className="flex flex-wrap gap-2">
                    <button
                        className="inline-flex min-h-[38px] items-center justify-center gap-2 rounded-lg border border-[#168247] bg-[#168247] px-3.5 text-sm font-bold text-white hover:bg-[#11683a] disabled:cursor-not-allowed disabled:opacity-50"
                        type="submit"
                        disabled={disabled}
                        data-testid={platformDataTestId.sessionStatusWebhookSave}
                    >
                        {busy === "webhook-save" ? (
                            <LoaderCircle className="motion-safe:animate-spin" size={15} aria-hidden="true" />
                        ) : null}
                        Save webhook
                    </button>
                    <button
                        className="inline-flex min-h-[38px] items-center justify-center gap-2 rounded-lg border border-[#ccd5cf] bg-white px-3.5 text-sm font-bold text-[#45534b] hover:bg-[#fafbfa] disabled:cursor-not-allowed disabled:opacity-50"
                        type="button"
                        onClick={onRotate}
                        disabled={disabled || !webhook.configured}
                    >
                        <KeyRound size={15} aria-hidden="true" /> Rotate secret
                    </button>
                </div>
            </form>
            <div className="grid gap-1 rounded-lg border border-[#e8ece9] bg-[#f8faf8] p-3 text-xs text-[#5f6c65]">
                <span>Secret ID: {webhook.secretId || "Not created"}</span>
                <span>The signing secret is shown only when created or rotated.</span>
            </div>
        </section>
    );
}
