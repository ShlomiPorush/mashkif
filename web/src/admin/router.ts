import { useSyncExternalStore } from "react";

export const ADMIN_PATHS = {
  home: "/admin",
  setup: "/admin/setup",
  signIn: "/admin/sign-in",
  totp: "/admin/totp",
} as const;

export type AdminPath = (typeof ADMIN_PATHS)[keyof typeof ADMIN_PATHS];

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

/** The current path, updated on navigation. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(path: AdminPath, replace = false): void {
  if (window.location.pathname === path) {
    return;
  }
  if (replace) {
    window.history.replaceState(null, "", path);
  } else {
    window.history.pushState(null, "", path);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * The password typed on this page view, kept in memory only, so TOTP
 * enrollment right after setup or sign-in does not ask for it again.
 */
let rememberedPassword: string | undefined;

export function rememberPassword(password: string | undefined): void {
  rememberedPassword = password;
}

export function takeRememberedPassword(): string | undefined {
  const password = rememberedPassword;
  rememberedPassword = undefined;
  return password;
}
