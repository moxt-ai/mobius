import {
    ClerkProvider,
    SignedIn,
    SignedOut,
    SignInButton,
    SignUpButton,
    UserButton,
    useAuth,
} from "@clerk/clerk-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { PlatformApp } from "./views/platform-app-view.tsx";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const platformEndpoint = import.meta.env.VITE_MOBIUS_PLATFORM_ENDPOINT ?? window.location.origin;
if (typeof publishableKey !== "string" || publishableKey.length === 0) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required");
}

function AuthenticatedPlatformApp() {
    const { getToken } = useAuth();
    return (
        <PlatformApp
            endpoint={platformEndpoint}
            getToken={async () => {
                const token = await getToken();
                if (token === null) {
                    throw new Error("Your Clerk session is unavailable. Please sign in again.");
                }
                return token;
            }}
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
                <main className="grid min-h-screen place-items-center bg-[#f3f5f3] p-6">
                    <div className="w-full max-w-[480px] rounded-2xl border border-[#dce2de] bg-white p-8 text-center shadow-xl md:p-12 [&>h1]:mb-3 [&>h1]:text-4xl [&>h1]:font-bold [&>h1]:tracking-[-.04em] [&>p:not(.eyebrow)]:text-[#65736b] [&>p:not(.eyebrow)]:leading-6">
                        <div className="mx-auto mb-7 grid size-[54px] place-items-center rounded-xl bg-[#168247] text-2xl font-extrabold text-white">
                            M
                        </div>
                        <p className="mb-2 text-[10px] font-extrabold uppercase tracking-[.13em] text-[#168247]">
                            Mobius Platform
                        </p>
                        <h1>Build on Mobius.</h1>
                        <p>Create tenants, applications, and server credentials from one secure workspace.</p>
                        <div className="mt-7 grid grid-cols-1 gap-2 sm:grid-cols-2 [&_button]:w-full">
                            <SignInButton mode="modal">
                                <button
                                    type="button"
                                    className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#168247] bg-[#168247] px-3.5 font-bold text-white hover:bg-[#11683a] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Sign in
                                </button>
                            </SignInButton>
                            <SignUpButton mode="modal">
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
