import { useSyncExternalStore } from "react";

export const ADMIN_PATHS = {
  home: "/admin",
  setup: "/admin/setup",
  signIn: "/admin/sign-in",
  totp: "/admin/totp",
  forgotPassword: "/admin/forgot-password",
  resetPassword: "/admin/reset-password",
  agents: "/admin/agents",
  blocked: "/admin/blocked",
  providers: "/admin/providers",
  settings: "/admin/settings",
} as const;

export type AdminPath = (typeof ADMIN_PATHS)[keyof typeof ADMIN_PATHS];

/** Pages of a full admin session, in navigation order; the account page is home. */
export const MANAGEMENT_PATHS = [
  ADMIN_PATHS.agents,
  ADMIN_PATHS.blocked,
  ADMIN_PATHS.providers,
  ADMIN_PATHS.settings,
  ADMIN_PATHS.home,
] as const;

export function isManagementPath(path: string): path is (typeof MANAGEMENT_PATHS)[number] {
  return (MANAGEMENT_PATHS as readonly string[]).includes(path);
}

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
