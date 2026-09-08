import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";

import { fetch, type Response } from "undici";

import { environmentProxyDispatcher } from "../network/environment-proxy.ts";

const MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class InstallerDownloadError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.name = "InstallerDownloadError";
  }
}

export class VerifiedDownload {
  readonly bytes: number;
  readonly sha256: string;
  readonly url: URL;

  constructor(url: URL, bytes: number, sha256: string) {
    this.bytes = bytes;
    this.sha256 = sha256;
    this.url = url;
  }
}

export interface VerifiedDownloadOptions {
  readonly allowedHosts: ReadonlySet<string>;
  readonly destination: string;
  readonly maximumBytes: number;
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds: number;
  readonly url: URL;
}

export interface InstallerDownloadTransport {
  readonly get: (url: URL, signal: AbortSignal) => Promise<Response>;
}

class UndiciInstallerDownloadTransport implements InstallerDownloadTransport {
  readonly get = async (url: URL, signal: AbortSignal): Promise<Response> =>
    await fetch(url, {
      dispatcher: environmentProxyDispatcher,
      headers: {
        accept: "text/plain, application/octet-stream;q=0.9",
        "user-agent": "Mobius-Agent-Installer/0.0.3",
      },
      method: "GET",
      redirect: "manual",
      signal,
    });
}

function validateUrl(url: URL, allowedHosts: ReadonlySet<string>): void {
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    !allowedHosts.has(url.hostname)
  ) {
    throw new InstallerDownloadError(
      "installer_host_not_allowed",
      "The installer download target is not allowed",
    );
  }
}

async function fetchInstaller(
  options: VerifiedDownloadOptions,
  signal: AbortSignal,
  transport: InstallerDownloadTransport,
): Promise<{
  readonly response: Awaited<ReturnType<typeof fetch>>;
  readonly url: URL;
}> {
  let url = new URL(options.url);
  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    validateUrl(url, options.allowedHosts);
    const response = await transport.get(url, signal);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, url };
    }
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (location === null || redirectCount === MAX_REDIRECTS) {
      throw new InstallerDownloadError(
        "installer_redirect_invalid",
        "The installer returned an invalid redirect",
      );
    }
    let redirected: URL;
    try {
      redirected = new URL(location, url);
    } catch (error) {
      throw new InstallerDownloadError(
        "installer_redirect_invalid",
        "The installer returned an invalid redirect",
        { cause: error },
      );
    }
    try {
      validateUrl(redirected, options.allowedHosts);
    } catch (error) {
      throw new InstallerDownloadError(
        "installer_redirect_not_allowed",
        "The installer redirect left the approved host allowlist",
        { cause: error },
      );
    }
    url = redirected;
  }
  throw new InstallerDownloadError(
    "installer_redirect_invalid",
    "The installer returned too many redirects",
  );
}

async function writeCompleteChunk(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    );
    if (written.bytesWritten < 1) {
      throw new InstallerDownloadError(
        "installer_write_failed",
        "The verified installer could not be stored",
      );
    }
    offset += written.bytesWritten;
  }
}

export async function downloadVerifiedFile(
  options: VerifiedDownloadOptions,
  transport: InstallerDownloadTransport = new UndiciInstallerDownloadTransport(),
): Promise<VerifiedDownload> {
  options.signal.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(options.timeoutMilliseconds);
  const signal = AbortSignal.any([options.signal, timeoutSignal]);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let responseBody: Response["body"] = null;
  try {
    const fetched = await fetchInstaller(options, signal, transport);
    responseBody = fetched.response.body;
    if (!fetched.response.ok || fetched.response.body === null) {
      throw new InstallerDownloadError(
        "installer_download_failed",
        "The approved installer could not be downloaded",
      );
    }
    const contentLength = fetched.response.headers.get("content-length");
    if (contentLength !== null) {
      const declaredLength = Number(contentLength);
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 1 ||
        declaredLength > options.maximumBytes
      ) {
        throw new InstallerDownloadError(
          "installer_size_invalid",
          "The installer size is outside the approved limit",
        );
      }
    }

    handle = await open(options.destination, "wx", 0o600);
    const digest = createHash("sha256");
    const reader = fetched.response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > options.maximumBytes) {
          throw new InstallerDownloadError(
            "installer_size_invalid",
            "The installer exceeded the approved size limit",
          );
        }
        digest.update(chunk.value);
        await writeCompleteChunk(handle, chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (bytes === 0) {
      throw new InstallerDownloadError(
        "installer_verification_failed",
        "The downloaded installer is empty",
      );
    }
    await handle.sync();
    await handle.close();
    handle = null;
    return new VerifiedDownload(fetched.url, bytes, digest.digest("hex"));
  } catch (error) {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    await unlink(options.destination).catch(() => undefined);
    if (options.signal.aborted) {
      options.signal.throwIfAborted();
    }
    if (timeoutSignal.aborted) {
      throw new InstallerDownloadError(
        "installer_download_timeout",
        "The installer download timed out",
        { cause: error },
      );
    }
    if (error instanceof InstallerDownloadError) {
      throw error;
    }
    throw new InstallerDownloadError(
      "installer_download_failed",
      "The approved installer could not be downloaded",
      { cause: error },
    );
  } finally {
    await responseBody?.cancel().catch(() => undefined);
  }
}
