import type {
    SessionElicitationField,
    SessionElicitationRequestedEvent,
    SessionPermissionRequestedEvent,
} from "@moxt-ai/mobius-sdk";
import type { ElicitationResponseRequest } from "@moxt-ai/mobius-sdk/channel";
import { ExternalLink, HelpCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { encodeElicitationForm, readMultiselectDefaults } from "@/services/elicitation-form";
import { respondToElicitation, respondToPermission } from "@/services/mobius-transport";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

function safeExternalUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol === "https:" || url.protocol === "http:") {
            return url.toString();
        }
    } catch {}
    return "";
}

function FieldControl({ field }: { readonly field: SessionElicitationField }) {
    if (field.type === "boolean") {
        return (
            <label className="flex min-h-11 items-center gap-2 rounded-md border-[0.5px] border-black/9 px-3 text-xs text-[#454959] md:min-h-10">
                <input
                    defaultChecked={field.hasDefaultValue && field.defaultBooleanValue}
                    name={field.name}
                    type="checkbox"
                />
                {field.title}
            </label>
        );
    }
    if (field.type === "select" || field.type === "multiselect") {
        return (
            <label className="grid gap-1.5 text-[11px] font-medium text-[#555c68]">
                {field.title}
                <select
                    className="min-h-11 rounded-md border-[0.5px] border-black/12 bg-white px-2.5 text-base font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70 md:min-h-10 md:text-xs"
                    defaultValue={
                        field.type === "multiselect"
                            ? readMultiselectDefaults(field)
                            : field.hasDefaultValue
                              ? field.defaultStringValue
                              : undefined
                    }
                    multiple={field.type === "multiselect"}
                    name={field.name}
                    required={field.required}
                >
                    {!field.required && field.type === "select" && <option value="">Not selected</option>}
                    {field.options.map((option) => (
                        <option key={option.value} title={option.description} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
                {field.description.length > 0 && (
                    <span className="font-normal text-muted-foreground">{field.description}</span>
                )}
            </label>
        );
    }
    const numeric = field.type === "integer" || field.type === "number";
    return (
        <label className="grid gap-1.5 text-[11px] font-medium text-[#555c68]">
            {field.title}
            <input
                className="min-h-11 rounded-md border-[0.5px] border-black/12 bg-white px-3 text-base font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70 md:min-h-10 md:text-xs"
                defaultValue={
                    field.hasDefaultValue ? (numeric ? field.defaultNumberValue : field.defaultStringValue) : undefined
                }
                max={field.maximum.length > 0 ? field.maximum : undefined}
                maxLength={!numeric && field.maximumLength.length > 0 ? Number(field.maximumLength) : undefined}
                min={field.minimum.length > 0 ? field.minimum : undefined}
                minLength={!numeric && field.minimumLength.length > 0 ? Number(field.minimumLength) : undefined}
                name={field.name}
                pattern={field.pattern.length > 0 ? field.pattern : undefined}
                placeholder={field.description}
                required={field.required}
                step={field.type === "integer" ? 1 : "any"}
                type={
                    numeric
                        ? "number"
                        : field.format === "email"
                          ? "email"
                          : field.format === "uri"
                            ? "url"
                            : field.format === "date"
                              ? "date"
                              : field.format === "date-time"
                                ? "datetime-local"
                                : "text"
                }
            />
            {field.description.length > 0 && (
                <span className="font-normal text-muted-foreground">{field.description}</span>
            )}
        </label>
    );
}

function PermissionCard({
    busy,
    permission,
    setBusy,
}: {
    readonly busy: boolean;
    readonly permission: SessionPermissionRequestedEvent;
    readonly setBusy: (interactionId: string) => void;
}) {
    return (
        <section
            className="max-w-[444px] rounded-lg border-[0.5px] border-input bg-white px-4 pt-5 pb-4 text-sm"
            role="alertdialog"
            aria-label="Agent permission request"
        >
            <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#fff3c4] text-[#8a5a00]">
                    <ShieldCheck className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-base leading-6 font-semibold text-foreground">{permission.title}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {permission.toolKind.length > 0 ? permission.toolKind : "tool"} · {permission.toolCallId}
                    </p>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                        {permission.options.map((option) => (
                            <Button
                                className="min-h-11 md:min-h-10"
                                disabled={busy}
                                key={option.optionId}
                                onClick={() => {
                                    setBusy(permission.interactionId);
                                    void respondToPermission({
                                        interactionId: permission.interactionId,
                                        optionId: option.optionId,
                                        outcome: "selected",
                                        sessionId: permission.sessionId,
                                    }).finally(() => setBusy(""));
                                }}
                                size="sm"
                                variant={option.kind.startsWith("allow") ? "default" : "outline"}
                            >
                                {option.name}
                            </Button>
                        ))}
                        <Button
                            className="min-h-11 md:min-h-10"
                            disabled={busy}
                            onClick={() => {
                                setBusy(permission.interactionId);
                                void respondToPermission({
                                    interactionId: permission.interactionId,
                                    optionId: "",
                                    outcome: "cancelled",
                                    sessionId: permission.sessionId,
                                }).finally(() => setBusy(""));
                            }}
                            size="sm"
                            variant="ghost"
                        >
                            Cancel
                        </Button>
                    </div>
                </div>
            </div>
        </section>
    );
}

function ElicitationCard({
    busy,
    elicitation,
    setBusy,
}: {
    readonly busy: boolean;
    readonly elicitation: SessionElicitationRequestedEvent;
    readonly setBusy: (interactionId: string) => void;
}) {
    const externalUrl = safeExternalUrl(elicitation.url);
    const cancel = (action: ElicitationResponseRequest["action"]): void => {
        setBusy(elicitation.interactionId);
        void respondToElicitation({
            action,
            content: "",
            interactionId: elicitation.interactionId,
            sessionId: elicitation.sessionId,
        }).finally(() => setBusy(""));
    };

    return (
        <section
            className="max-w-[444px] rounded-lg border-[0.5px] border-input bg-white px-4 pt-5 pb-4 text-sm"
            role="dialog"
            aria-label="Agent information request"
        >
            <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#e5edff] text-[#3159a6]">
                    <HelpCircle className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-base leading-6 font-semibold text-foreground">Agent needs input</p>
                    <p className="mt-1 text-sm leading-6 text-foreground">{elicitation.message}</p>
                    {elicitation.mode === "url" ? (
                        <div className="mt-2.5">
                            <code className="block break-all rounded-lg border-[0.5px] border-[#2f6feb]/15 bg-white/70 px-2.5 py-2 text-[10px] leading-4 text-[#435f8c]">
                                {externalUrl.length > 0 ? externalUrl : elicitation.url}
                            </code>
                            {elicitation.accepted ? (
                                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                    <span className="text-[11px] font-medium text-[#435f8c]">
                                        Waiting for the agent to confirm completion…
                                    </span>
                                    {externalUrl.length > 0 && (
                                        <a
                                            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-[#3159a6] outline-none hover:bg-[#e5edff] focus-visible:ring-2 focus-visible:ring-ring/70 md:min-h-10"
                                            href={externalUrl}
                                            rel="noreferrer"
                                            target="_blank"
                                        >
                                            Open again <ExternalLink className="size-3.5" />
                                        </a>
                                    )}
                                </div>
                            ) : (
                                <div className="mt-2.5 flex flex-wrap gap-2">
                                    {externalUrl.length > 0 && (
                                        <Button
                                            className="min-h-11 md:min-h-10"
                                            disabled={busy}
                                            onClick={() => {
                                                window.open(externalUrl, "_blank", "noopener,noreferrer");
                                                setBusy(elicitation.interactionId);
                                                void respondToElicitation({
                                                    action: "accept",
                                                    content: "",
                                                    interactionId: elicitation.interactionId,
                                                    sessionId: elicitation.sessionId,
                                                }).finally(() => setBusy(""));
                                            }}
                                            size="sm"
                                        >
                                            Open page <ExternalLink className="size-3.5" />
                                        </Button>
                                    )}
                                    <Button
                                        className="min-h-11 md:min-h-10"
                                        disabled={busy}
                                        onClick={() => cancel("decline")}
                                        size="sm"
                                        variant="outline"
                                    >
                                        Decline
                                    </Button>
                                    <Button
                                        className="min-h-11 md:min-h-10"
                                        disabled={busy}
                                        onClick={() => cancel("cancel")}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            )}
                        </div>
                    ) : (
                        <form
                            className="mt-3 grid gap-3"
                            onSubmit={(event) => {
                                event.preventDefault();
                                setBusy(elicitation.interactionId);
                                void respondToElicitation({
                                    action: "accept",
                                    content: encodeElicitationForm(
                                        new FormData(event.currentTarget),
                                        elicitation.fields,
                                    ),
                                    interactionId: elicitation.interactionId,
                                    sessionId: elicitation.sessionId,
                                }).finally(() => setBusy(""));
                            }}
                        >
                            {elicitation.fields.map((field) => (
                                <FieldControl field={field} key={field.name} />
                            ))}
                            <div className="flex flex-wrap gap-2">
                                <Button className="min-h-11 md:min-h-10" disabled={busy} size="sm" type="submit">
                                    Continue
                                </Button>
                                <Button
                                    className="min-h-11 md:min-h-10"
                                    disabled={busy}
                                    onClick={() => cancel("decline")}
                                    size="sm"
                                    variant="outline"
                                >
                                    Decline
                                </Button>
                                <Button
                                    className="min-h-11 md:min-h-10"
                                    disabled={busy}
                                    onClick={() => cancel("cancel")}
                                    size="sm"
                                    variant="ghost"
                                >
                                    Cancel
                                </Button>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </section>
    );
}

export function SessionInteractions() {
    const conversation = useChatStore(selectActiveConversation);
    const [busyId, setBusyId] = useState("");
    if (conversation.session.permissions.length === 0 && conversation.session.elicitations.length === 0) {
        return null;
    }
    return (
        <div className="mt-4 mb-12 grid w-full max-w-[444px] gap-3">
            {conversation.session.permissions.map((permission) => (
                <PermissionCard
                    busy={busyId === permission.interactionId}
                    key={permission.interactionId}
                    permission={permission}
                    setBusy={setBusyId}
                />
            ))}
            {conversation.session.elicitations.map((elicitation) => (
                <ElicitationCard
                    busy={busyId === elicitation.interactionId}
                    elicitation={elicitation}
                    key={elicitation.interactionId}
                    setBusy={setBusyId}
                />
            ))}
        </div>
    );
}
