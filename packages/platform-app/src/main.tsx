import {
    ClerkProvider,
    OrganizationSwitcher,
    SignedIn,
    SignedOut,
    SignInButton,
    SignUpButton,
    UserButton,
    useAuth,
    useClerk,
    useOrganization,
} from "@clerk/clerk-react";
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { PlatformApp } from "./application.tsx";
import { OrganizationInviteDialog } from "./components/organization-invite-dialog.tsx";
import { JoinOrganizationView } from "./views/join-organization-view.tsx";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const platformEndpoint = import.meta.env.VITE_MOBIUS_PLATFORM_ENDPOINT ?? window.location.origin;
const joinPath = `${import.meta.env.BASE_URL}join`;
const joining = window.location.pathname === joinPath;
const inviteStorageKey = "mobius.organization-invite";
function pendingInvite(): string {
    if (!joining) {
        return "";
    }
    const fragment = window.location.hash.slice(1);
    if (fragment.length > 0) {
        if (/^[a-f0-9]{64}$/.test(fragment)) {
            sessionStorage.setItem(inviteStorageKey, fragment);
            window.history.replaceState(null, "", joinPath);
        } else {
            sessionStorage.removeItem(inviteStorageKey);
            return "";
        }
    }
    return sessionStorage.getItem(inviteStorageKey) ?? "";
}
const inviteToken = pendingInvite();
if (typeof publishableKey !== "string" || publishableKey.length === 0) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required");
}

function AuthenticatedPlatformApp() {
    const { getToken, orgRole } = useAuth();
    const { setActive } = useClerk();
    const { organization, isLoaded } = useOrganization();
    const onJoined = useCallback(
        async (id: string, signal: AbortSignal) => {
            signal.throwIfAborted();
            await setActive({ organization: id });
            signal.throwIfAborted();
            await getToken({ skipCache: true });
            signal.throwIfAborted();
            sessionStorage.removeItem(inviteStorageKey);
            window.location.replace(import.meta.env.BASE_URL);
        },
        [setActive, getToken],
    );
    const token = useCallback(async () => {
        const value = await getToken();
        if (value === null) {
            throw new Error("Your Clerk session is unavailable. Please sign in again.");
        }
        return value;
    }, [getToken]);
    if (joining) {
        return (
            <JoinOrganizationView
                endpoint={platformEndpoint}
                getToken={token}
                token={inviteToken}
                onJoined={onJoined}
            />
        );
    }
    if (!isLoaded) {
        return <main>Loading organization…</main>;
    }
    if (organization === null || organization === undefined) {
        return (
            <main className="grid min-h-screen place-content-center gap-6 text-center">
                <h1>Select or create an organization</h1>
                <OrganizationSwitcher hidePersonal />
                <UserButton />
            </main>
        );
    }
    return (
        <PlatformApp
            key={organization.id}
            endpoint={platformEndpoint}
            getToken={token}
            organization={{ id: organization.id, name: organization.name }}
            organizationControl={
                <div className="flex flex-wrap items-center gap-2">
                    <OrganizationSwitcher hidePersonal />
                    {orgRole === "org:admin" ? (
                        <OrganizationInviteDialog
                            endpoint={platformEndpoint}
                            getToken={token}
                            organization={{ id: organization.id, name: organization.name }}
                        />
                    ) : null}
                </div>
            }
            userControl={<UserButton />}
        />
    );
}

const root = document.getElementById("root");
if (root === null) {
    throw new Error("The Platform application root element is missing");
}

createRoot(root).render(
    <StrictMode>
        <ClerkProvider publishableKey={publishableKey}>
            <SignedOut>
                <main className="grid min-h-screen place-items-center bg-[#f4f6f4] p-6">
                    <div className="w-full max-w-[480px] rounded-2xl border border-[#dce2de] bg-white p-8 text-center shadow-xl md:p-12 [&>h1]:mb-3 [&>h1]:text-4xl [&>h1]:font-bold [&>h1]:tracking-[-.04em] [&>p:not(.eyebrow)]:text-[#65736b] [&>p:not(.eyebrow)]:leading-6">
                        <div className="mx-auto mb-7 grid size-[54px] place-items-center rounded-xl bg-[#168247] text-2xl font-extrabold text-white">
                            M
                        </div>
                        <p className="mb-2 text-[10px] font-extrabold uppercase tracking-[.13em] text-[#168247]">
                            Mobius Platform
                        </p>
                        <h1>{joining ? "Join your team." : "Build on Mobius."}</h1>
                        <p>
                            {joining
                                ? "Sign in or create an account to accept your organization invitation."
                                : "Manage your organization’s applications and server credentials from one secure workspace."}
                        </p>
                        <div className="mt-7 grid grid-cols-1 gap-2 sm:grid-cols-2 [&_button]:w-full">
                            <SignInButton
                                mode="modal"
                                forceRedirectUrl={joining ? joinPath : null}
                                signUpForceRedirectUrl={joining ? joinPath : null}
                            >
                                <button
                                    type="button"
                                    className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#168247] bg-[#168247] px-3.5 font-bold text-white hover:bg-[#11683a] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Sign in
                                </button>
                            </SignInButton>
                            <SignUpButton
                                mode="modal"
                                forceRedirectUrl={joining ? joinPath : null}
                                signInForceRedirectUrl={joining ? joinPath : null}
                            >
                                <button
                                    type="button"
                                    className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#ccd5cf] bg-white px-3.5 font-bold text-[#45534b] hover:bg-[#fafbfa]"
                                >
                                    Create account
                                </button>
                            </SignUpButton>
                        </div>
                    </div>
                </main>
            </SignedOut>
            <SignedIn>
                <AuthenticatedPlatformApp />
            </SignedIn>
        </ClerkProvider>
    </StrictMode>,
);
