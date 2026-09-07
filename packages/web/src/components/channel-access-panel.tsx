import {
  Check,
  Copy,
  Link2,
  LoaderCircle,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type {
  CreatedChannelAccessGrant,
  LinkedChannelDevice,
} from "@/domain/channel";
import { PairingApiError } from "@/domain/channel";
import {
  createChannelAccessGrant,
  readLinkedChannelDevices,
  revokeLinkedChannelDevice,
} from "@/services/pairing-api";

abstract class DeviceDirectoryState {}

class LoadingDeviceDirectoryState extends DeviceDirectoryState {}

class OwnerDeviceDirectoryState extends DeviceDirectoryState {
  readonly devices: readonly LinkedChannelDevice[];

  constructor(devices: readonly LinkedChannelDevice[]) {
    super();
    this.devices = devices;
  }
}

class LinkedDeviceDirectoryState extends DeviceDirectoryState {}

class FailedDeviceDirectoryState extends DeviceDirectoryState {
  readonly message: string;

  constructor(message: string) {
    super();
    this.message = message;
  }
}

abstract class AccessLinkState {}

class IdleAccessLinkState extends AccessLinkState {}

class CreatingAccessLinkState extends AccessLinkState {}

class ReadyAccessLinkState extends AccessLinkState {
  readonly expiresAt: Date;
  readonly url: string;

  constructor(url: string, expiresAt: Date) {
    super();
    this.expiresAt = expiresAt;
    this.url = url;
  }
}

class FailedAccessLinkState extends AccessLinkState {
  readonly message: string;

  constructor(message: string) {
    super();
    this.message = message;
  }
}

abstract class DeviceRevocationState {}

class IdleDeviceRevocationState extends DeviceRevocationState {}

class RevokingDeviceState extends DeviceRevocationState {
  readonly credentialId: string;

  constructor(credentialId: string) {
    super();
    this.credentialId = credentialId;
  }
}

class FailedDeviceRevocationState extends DeviceRevocationState {
  readonly message: string;

  constructor(message: string) {
    super();
    this.message = message;
  }
}

function failureMessage(error: unknown): string {
  return error instanceof PairingApiError
    ? `${error.code}: ${error.message}`
    : "The access request failed unexpectedly.";
}

function accessLink(
  channelId: string,
  grant: CreatedChannelAccessGrant,
): string {
  const url = new URL(
    `/channels/${encodeURIComponent(channelId)}`,
    window.location.origin,
  );
  const fragment = new URLSearchParams();
  fragment.set("access", `${grant.grantId}.${grant.grantSecret}`);
  url.hash = fragment.toString();
  return url.href;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function deviceLabel(device: LinkedChannelDevice): string {
  return `Linked device ${device.credentialId.slice(-6)}`;
}

export function ChannelAccessPanel({
  channelId,
}: {
  readonly channelId: string;
}) {
  const [controller] = useState(() => new AbortController());
  const [directory, setDirectory] = useState<DeviceDirectoryState>(
    new LoadingDeviceDirectoryState(),
  );
  const [link, setLink] = useState<AccessLinkState>(new IdleAccessLinkState());
  const [revocation, setRevocation] = useState<DeviceRevocationState>(
    new IdleDeviceRevocationState(),
  );
  const [copyConfirmation, setCopyConfirmation] = useState("");

  const loadDevices = useCallback(async (): Promise<void> => {
    setDirectory(new LoadingDeviceDirectoryState());
    try {
      setDirectory(
        new OwnerDeviceDirectoryState(
          await readLinkedChannelDevices(channelId, controller.signal),
        ),
      );
    } catch (error) {
      if (
        error instanceof PairingApiError &&
        error.code === "owner_access_required"
      ) {
        setDirectory(new LinkedDeviceDirectoryState());
        return;
      }
      if (controller.signal.aborted) {
        return;
      }
      setDirectory(new FailedDeviceDirectoryState(failureMessage(error)));
    }
  }, [channelId, controller]);

  useEffect(() => {
    void loadDevices();
    return () => controller.abort();
  }, [controller, loadDevices]);

  const createLink = async (): Promise<void> => {
    setCopyConfirmation("");
    setLink(new CreatingAccessLinkState());
    try {
      const grant = await createChannelAccessGrant(
        channelId,
        controller.signal,
      );
      setLink(
        new ReadyAccessLinkState(accessLink(channelId, grant), grant.expiresAt),
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        setLink(new FailedAccessLinkState(failureMessage(error)));
      }
    }
  };

  const copyLink = async (readyLink: ReadyAccessLinkState): Promise<void> => {
    try {
      await navigator.clipboard.writeText(readyLink.url);
      setCopyConfirmation("Access link copied.");
    } catch {
      setCopyConfirmation(
        "Copy was unavailable. Select the full link and copy it manually.",
      );
    }
  };

  const revokeDevice = async (credentialId: string): Promise<void> => {
    if (!(directory instanceof OwnerDeviceDirectoryState)) {
      return;
    }
    setRevocation(new RevokingDeviceState(credentialId));
    try {
      await revokeLinkedChannelDevice(
        channelId,
        credentialId,
        controller.signal,
      );
      setDirectory(
        new OwnerDeviceDirectoryState(
          directory.devices.filter(
            (device) => device.credentialId !== credentialId,
          ),
        ),
      );
      setRevocation(new IdleDeviceRevocationState());
    } catch (error) {
      if (!controller.signal.aborted) {
        setRevocation(new FailedDeviceRevocationState(failureMessage(error)));
      }
    }
  };

  return (
    <section aria-labelledby="channel-access-heading" className="mt-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold tracking-[0.08em] text-[#218854] uppercase">
            Channel capability
          </p>
          <h2
            className="mt-2 text-xl font-semibold tracking-[-0.025em]"
            id="channel-access-heading"
          >
            Access from other devices
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Create a link that works once for 10 minutes. The new browser gets
            its own revocable credential; your owner credential is never put in
            the link.
          </p>
        </div>
        {directory instanceof OwnerDeviceDirectoryState && (
          <Button
            aria-busy={link instanceof CreatingAccessLinkState}
            className="min-h-11 shrink-0 sm:self-end"
            disabled={link instanceof CreatingAccessLinkState}
            onClick={() => void createLink()}
          >
            {link instanceof CreatingAccessLinkState ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
            ) : (
              <Link2 aria-hidden="true" className="size-4" />
            )}
            Create one-time access link
          </Button>
        )}
      </div>

      {directory instanceof LinkedDeviceDirectoryState && (
        <div className="mt-5 rounded-xl border-[0.5px] border-black/10 bg-white px-5 py-4 text-sm leading-6 text-muted-foreground shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
          This browser has linked-device access. It can use the channel, but
          only the original browser can create links or revoke devices.
        </div>
      )}

      {directory instanceof FailedDeviceDirectoryState && (
        <div className="mt-5 flex flex-col gap-3 rounded-xl border border-[#f2c4c4] bg-[#fff7f7] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-6 text-[#9b2c32]">
            {directory.message}
          </p>
          <Button
            className="min-h-11 shrink-0"
            onClick={() => void loadDevices()}
            variant="outline"
          >
            <RefreshCw aria-hidden="true" className="size-4" /> Retry
          </Button>
        </div>
      )}

      {directory instanceof LoadingDeviceDirectoryState && (
        <div
          aria-busy="true"
          aria-live="polite"
          className="mt-5 flex min-h-20 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-5 py-4 text-sm text-muted-foreground"
        >
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Loading device access…
        </div>
      )}

      {link instanceof ReadyAccessLinkState && (
        <div className="mt-5 rounded-xl border-[0.5px] border-[#9bd8b7] bg-[#f4fcf7] p-4 sm:p-5">
          <label
            className="text-xs font-semibold text-foreground"
            htmlFor="one-time-access-link"
          >
            One-time access link
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              aria-describedby="one-time-access-link-help"
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-black/12 bg-white px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              id="one-time-access-link"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              type="text"
              value={link.url}
            />
            <Button
              className="min-h-11 shrink-0"
              onClick={() => void copyLink(link)}
              variant="outline"
            >
              {copyConfirmation === "Access link copied." ? (
                <Check aria-hidden="true" className="size-4" />
              ) : (
                <Copy aria-hidden="true" className="size-4" />
              )}
              Copy link
            </Button>
          </div>
          <p
            className="mt-2 text-xs leading-5 text-muted-foreground"
            id="one-time-access-link-help"
          >
            Expires {formatDate(link.expiresAt)} and becomes invalid immediately
            after one successful use.
          </p>
          <p
            aria-live="polite"
            className="mt-1 text-xs leading-5 text-[#218854]"
          >
            {copyConfirmation}
          </p>
        </div>
      )}

      {link instanceof FailedAccessLinkState && (
        <p
          aria-live="polite"
          className="mt-4 rounded-lg bg-[#fff0f0] px-4 py-3 text-sm text-[#9b2c32]"
        >
          {link.message}
        </p>
      )}

      {directory instanceof OwnerDeviceDirectoryState && (
        <div className="mt-6">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold tracking-[-0.015em]">
                Linked devices
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Revoking a device does not affect this browser or other linked
                devices.
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
              {directory.devices.length.toString()}
            </span>
          </div>

          {directory.devices.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-black/15 bg-white/60 px-5 py-6 text-sm text-muted-foreground">
              No other devices currently have access.
            </p>
          ) : (
            <ul aria-label="Linked devices" className="mt-4 grid gap-3">
              {directory.devices.map((device) => {
                const isRevoking =
                  revocation instanceof RevokingDeviceState &&
                  revocation.credentialId === device.credentialId;
                return (
                  <li
                    className="flex flex-col gap-4 rounded-xl border-[0.5px] border-black/10 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.03)] sm:flex-row sm:items-center"
                    key={device.credentialId}
                  >
                    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[#eefaf3] text-[#218854]">
                      <Smartphone aria-hidden="true" className="size-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block text-sm font-semibold">
                        {deviceLabel(device)}
                      </strong>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        Added {formatDate(device.createdAt)} · Last used{" "}
                        {formatDate(device.lastUsedAt)}
                      </span>
                    </span>
                    <Button
                      aria-busy={isRevoking}
                      aria-label={`Revoke linked device ${device.credentialId.slice(-6)}`}
                      className="min-h-11 shrink-0 text-[#a1282e] hover:text-[#821f24]"
                      disabled={revocation instanceof RevokingDeviceState}
                      onClick={() => void revokeDevice(device.credentialId)}
                      variant="outline"
                    >
                      {isRevoking ? (
                        <LoaderCircle
                          aria-hidden="true"
                          className="size-4 animate-spin"
                        />
                      ) : (
                        <Trash2 aria-hidden="true" className="size-4" />
                      )}
                      Revoke
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {revocation instanceof FailedDeviceRevocationState && (
        <p
          aria-live="polite"
          className="mt-4 rounded-lg bg-[#fff0f0] px-4 py-3 text-sm text-[#9b2c32]"
        >
          {revocation.message}
        </p>
      )}
    </section>
  );
}
