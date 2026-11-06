import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { i18n as I18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../i18n";
import en from "../locales/en.json";
import he from "../locales/he.json";
import { expectOnlyLocaleText, pseudoResources } from "../testing/pseudo";
import { AdminApp, targetPath } from "./AdminApp";
import { ERROR_KEYS, errorKey } from "./errors";
import { rememberPassword } from "./router";

type Routes = Record<string, unknown>;

const USER = {
  id: "user-1",
  name: "shlomi",
  username: "shlomi",
  email: "admin@example.test",
  emailVerified: false,
  image: null,
  twoFactorEnabled: false,
  createdAt: "2026-11-01T08:00:00.000Z",
  updatedAt: "2026-11-01T08:00:00.000Z",
};
const SESSION = {
  id: "session-1",
  token: "token",
  userId: USER.id,
  expiresAt: "2026-11-01T20:00:00.000Z",
  createdAt: "2026-11-01T08:00:00.000Z",
  updatedAt: "2026-11-01T08:00:00.000Z",
};

/** Better Auth's get-session answers: a session without TOTP, and one with TOTP. */
const ENROLLMENT = { session: SESSION, user: USER };
const FULL = { session: SESSION, user: { ...USER, twoFactorEnabled: true } };

const TOTP_URI =
  "otpauth://totp/Mashkif:shlomi?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Mashkif&algorithm=SHA1&digits=6&period=30";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers fetch calls by path with JSON; unknown paths are 404. */
function serve(routes: Routes) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({ path: url.pathname, method, body });
    const key = `${method} ${url.pathname}`;
    const answer = key in routes ? routes[key] : routes[url.pathname];
    if (answer === undefined) {
      return json({ error: "not_found" }, 404);
    }
    if (answer instanceof Response) {
      return answer;
    }
    return json(answer, 200);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** The answers the admin app needs to start; session is Better Auth's get-session answer. */
function boot(setupRequired: boolean, session: unknown, extra: Routes = {}): Routes {
  return {
    "/api/admin/status": { setupRequired },
    "/api/auth/get-session": session,
    "/api/auth/passkey/list-user-passkeys": [],
    ...extra,
  };
}

function renderAdmin(instance: I18n) {
  return render(
    <I18nextProvider i18n={instance}>
      <AdminApp />
    </I18nextProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/admin");
  rememberPassword(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pages = [
  ["setup", boot(true, null), "/admin", "/admin/setup", en.setup.heading],
  ["sign-in", boot(false, null), "/admin", "/admin/sign-in", en.signIn.heading],
  ["TOTP enrollment", boot(false, ENROLLMENT), "/admin", "/admin/totp", en.totp.heading],
  [
    "forgot password",
    boot(false, null),
    "/admin/forgot-password",
    "/admin/forgot-password",
    en.forgot.heading,
  ],
  [
    "reset password",
    boot(false, null),
    "/admin/reset-password?token=abc",
    "/admin/reset-password",
    en.reset.heading,
  ],
  [
    "admin home",
    boot(false, FULL),
    "/admin",
    "/admin",
    en.admin.homeHeading.replace("{{username}}", "shlomi"),
  ],
] as const;

describe("admin routes", () => {
  it.each(pages)("render the %s page at its path", async (_, routes, start, path, heading) => {
    window.history.replaceState(null, "", start);
    serve(routes);
    renderAdmin(createI18n("en"));
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe(path));
  });

  it.each(pages)("the %s page has only locale text", async (_, routes, start) => {
    window.history.replaceState(null, "", start);
    serve(routes);
    const { container } = renderAdmin(createI18n("he", pseudoResources()));
    await screen.findByRole("heading", { level: 1 });
    // Let the page finish loading its data.
    await act(async () => {});
    expectOnlyLocaleText(container);
  });

  it("renders in Hebrew by default", async () => {
    serve(boot(false, null));
    renderAdmin(createI18n("he"));
    expect(await screen.findByRole("heading", { level: 1, name: he.signIn.heading })).toBeTruthy();
  });

  it("sends an unknown admin path to the right page", async () => {
    window.history.replaceState(null, "", "/admin/nowhere");
    serve(boot(false, FULL));
    renderAdmin(createI18n("en"));
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(window.location.pathname).toBe("/admin"));
  });

  it("shows a retry when the server cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    renderAdmin(createI18n("en"));
    expect(await screen.findByText(en.errors.network)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.admin.retry })).toBeTruthy();
  });
});

describe("sign-in", () => {
  async function password(language: typeof en | typeof he) {
    await screen.findByRole("heading", { level: 1, name: language.signIn.heading });
    fireEvent.change(screen.getByLabelText(language.signIn.username), {
      target: { value: "shlomi" },
    });
    fireEvent.change(screen.getByLabelText(language.signIn.password), {
      target: { value: "a long password" },
    });
    fireEvent.click(screen.getByRole("button", { name: language.signIn.submit }));
  }

  it("asks for the TOTP code after the password", async () => {
    const calls = serve(
      boot(false, null, { "POST /api/auth/sign-in/username": { twoFactorRedirect: true } }),
    );
    renderAdmin(createI18n("en"));
    await password(en);
    expect(
      await screen.findByRole("heading", { level: 1, name: en.signIn.totpHeading }),
    ).toBeTruthy();
    expect(calls.find((call) => call.path === "/api/auth/sign-in/username")?.body).toEqual({
      username: "shlomi",
      password: "a long password",
    });
  });

  it("maps a wrong password to a localized message", async () => {
    serve(
      boot(false, null, {
        "POST /api/auth/sign-in/username": json(
          { code: "INVALID_USERNAME_OR_PASSWORD", message: "Invalid username or password" },
          401,
        ),
      }),
    );
    renderAdmin(createI18n("he"));
    await password(he);
    expect((await screen.findByRole("alert")).textContent).toBe(he.errors.invalidCredentials);
  });

  it("completes with the TOTP code and shows the account page", async () => {
    let session: unknown = null;
    serve({
      "/api/admin/status": { setupRequired: false },
      get "/api/auth/get-session"() {
        return session;
      },
      "/api/auth/passkey/list-user-passkeys": [],
      "POST /api/auth/sign-in/username": { twoFactorRedirect: true },
      get "POST /api/auth/two-factor/verify-totp"() {
        session = FULL;
        return { token: "t", user: FULL.user };
      },
    });
    renderAdmin(createI18n("en"));
    await password(en);
    fireEvent.change(await screen.findByLabelText(en.signIn.code), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: en.signIn.verify }));
    await waitFor(() => expect(window.location.pathname).toBe("/admin"));
    expect(
      await screen.findByRole("heading", { level: 2, name: en.passkeys.heading }),
    ).toBeTruthy();
  });

  it("completes with a backup code instead", async () => {
    let session: unknown = null;
    const calls = serve({
      "/api/admin/status": { setupRequired: false },
      get "/api/auth/get-session"() {
        return session;
      },
      "/api/auth/passkey/list-user-passkeys": [],
      "POST /api/auth/sign-in/username": { twoFactorRedirect: true },
      get "POST /api/auth/two-factor/verify-backup-code"() {
        session = FULL;
        return { token: "t", user: FULL.user };
      },
    });
    renderAdmin(createI18n("en"));
    await password(en);
    fireEvent.click(await screen.findByRole("button", { name: en.signIn.useBackup }));
    fireEvent.change(await screen.findByLabelText(en.signIn.backupCode), {
      target: { value: "abcde-12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.signIn.verify }));
    await waitFor(() => expect(window.location.pathname).toBe("/admin"));
    expect(
      calls.find((call) => call.path === "/api/auth/two-factor/verify-backup-code")?.body,
    ).toMatchObject({ code: "abcde-12345" });
  });

  it("maps a used backup code to its message in Hebrew", async () => {
    serve(
      boot(false, null, {
        "POST /api/auth/sign-in/username": { twoFactorRedirect: true },
        "POST /api/auth/two-factor/verify-backup-code": json(
          { code: "INVALID_BACKUP_CODE", message: "Invalid backup code" },
          401,
        ),
      }),
    );
    renderAdmin(createI18n("he"));
    await password(he);
    fireEvent.click(await screen.findByRole("button", { name: he.signIn.useBackup }));
    fireEvent.change(await screen.findByLabelText(he.signIn.backupCode), {
      target: { value: "abcde-12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: he.signIn.verify }));
    expect((await screen.findByRole("alert")).textContent).toBe(he.errors.invalidBackupCode);
  });

  it("signs in with a passkey", async () => {
    let session: unknown = null;
    const calls = serve({
      "/api/admin/status": { setupRequired: false },
      get "/api/auth/get-session"() {
        return session;
      },
      "/api/auth/passkey/list-user-passkeys": [],
      "/api/auth/passkey/generate-authenticate-options": {
        challenge: "Y2hhbGxlbmdl",
        rpId: "localhost",
        allowCredentials: [],
        userVerification: "preferred",
      },
      get "POST /api/auth/passkey/verify-authentication"() {
        session = FULL;
        return { session: SESSION, user: FULL.user };
      },
    });
    const credential = {
      id: "Y3JlZA",
      rawId: new Uint8Array([1, 2, 3]).buffer,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
        userHandle: null,
      },
      getClientExtensionResults: () => ({}),
    };
    vi.stubGlobal("PublicKeyCredential", class {});
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get: vi.fn(async () => credential) },
    });
    renderAdmin(createI18n("en"));
    fireEvent.click(await screen.findByRole("button", { name: en.signIn.passkey }));
    await waitFor(() => expect(window.location.pathname).toBe("/admin"));
    expect(calls.some((call) => call.path === "/api/auth/passkey/verify-authentication")).toBe(
      true,
    );
  });

  it("links to the forgot-password page", async () => {
    serve(boot(false, null));
    renderAdmin(createI18n("en"));
    fireEvent.click(await screen.findByRole("link", { name: en.signIn.forgotLink }));
    expect(await screen.findByRole("heading", { level: 1, name: en.forgot.heading })).toBeTruthy();
    expect(window.location.pathname).toBe("/admin/forgot-password");
  });

  it("keeps a click on the forgot link that lands before the redirect to /admin/sign-in", async () => {
    serve(boot(false, null));
    // Click the link as soon as React puts it in the page: the mutation
    // callback runs before React's pending effects, like a very fast user.
    const observer = new MutationObserver(() => {
      const link = screen.queryByRole("link", { name: en.signIn.forgotLink });
      if (link !== null) {
        observer.disconnect();
        link.click();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    renderAdmin(createI18n("en"));
    expect(await screen.findByRole("heading", { level: 1, name: en.forgot.heading })).toBeTruthy();
    expect(window.location.pathname).toBe("/admin/forgot-password");
    observer.disconnect();
  });
});

describe("setup", () => {
  async function fill(language: typeof en) {
    await screen.findByRole("heading", { level: 1, name: language.setup.heading });
    fireEvent.change(screen.getByLabelText(language.setup.username), {
      target: { value: "shlomi" },
    });
    fireEvent.change(screen.getByLabelText(language.setup.email), {
      target: { value: "admin@example.test" },
    });
    fireEvent.change(screen.getByLabelText(language.setup.password), {
      target: { value: "a long password" },
    });
    fireEvent.change(screen.getByLabelText(language.setup.confirm), {
      target: { value: "a long password" },
    });
    fireEvent.click(screen.getByRole("button", { name: language.setup.submit }));
  }

  it("creates the admin with Better Auth sign-up and goes on to TOTP enrollment", async () => {
    let setupRequired = true;
    let session: unknown = null;
    const calls = serve({
      get "/api/admin/status"() {
        return { setupRequired };
      },
      get "/api/auth/get-session"() {
        return session;
      },
      get "POST /api/auth/sign-up/email"() {
        setupRequired = false;
        session = ENROLLMENT;
        return { token: "t", user: USER };
      },
      "POST /api/auth/two-factor/enable": { totpURI: TOTP_URI, backupCodes: ["one-1", "two-2"] },
    });
    renderAdmin(createI18n("en"));
    await fill(en);
    await waitFor(() => expect(window.location.pathname).toBe("/admin/totp"));
    expect(calls.find((call) => call.path === "/api/auth/sign-up/email")?.body).toEqual({
      name: "shlomi",
      username: "shlomi",
      email: "admin@example.test",
      password: "a long password",
    });
    // The password typed at setup starts the enrollment without asking again.
    expect(await screen.findByRole("img", { name: en.totp.qrAlt })).toBeTruthy();
  });

  it("moves on to sign-in when the admin exists already, for example after a lost answer", async () => {
    let setupRequired = true;
    serve({
      get "/api/admin/status"() {
        return { setupRequired };
      },
      "/api/auth/get-session": null,
      get "POST /api/auth/sign-up/email"() {
        // The first attempt created the admin, but its answer never arrived.
        setupRequired = false;
        return json({ code: "FAILED_TO_CREATE_USER", message: "Failed to create user" }, 400);
      },
    });
    renderAdmin(createI18n("en"));
    await fill(en);
    expect(await screen.findByRole("heading", { level: 1, name: en.signIn.heading })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe("/admin/sign-in"));
  });
});

describe("TOTP enrollment", () => {
  it("shows a QR code drawn locally, the manual key, and the backup codes once", async () => {
    rememberPassword("a long password");
    const calls = serve(
      boot(false, ENROLLMENT, {
        "POST /api/auth/two-factor/enable": {
          totpURI: TOTP_URI,
          backupCodes: ["backup-one", "backup-two"],
        },
      }),
    );
    renderAdmin(createI18n("en"));
    const qr = (await screen.findByRole("img", { name: en.totp.qrAlt })) as HTMLImageElement;
    expect(qr.src).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP")).toBeTruthy();
    expect(calls.find((call) => call.path === "/api/auth/two-factor/enable")?.body).toMatchObject({
      password: "a long password",
    });
    expect(screen.getByRole("heading", { level: 2, name: en.backupCodes.heading })).toBeTruthy();
    expect(screen.getByText("backup-one")).toBeTruthy();
    expect(screen.getByText("backup-two")).toBeTruthy();
  });

  it("has only locale text besides the codes", async () => {
    rememberPassword("a long password");
    serve(
      boot(false, ENROLLMENT, {
        "POST /api/auth/two-factor/enable": { totpURI: TOTP_URI, backupCodes: ["backup-one"] },
      }),
    );
    const { container } = renderAdmin(createI18n("he", pseudoResources()));
    await screen.findByRole("img");
    // The manual key is user data too.
    container.querySelector(".totp-key")?.setAttribute("data-value", "");
    expectOnlyLocaleText(container);
  });

  it("asks for the password when it was not just typed", async () => {
    serve(boot(false, ENROLLMENT));
    renderAdmin(createI18n("en"));
    expect(await screen.findByLabelText(en.totp.password)).toBeTruthy();
  });
});

describe("forgot and reset password", () => {
  it("asks Better Auth to email a link back to the reset page, without saying whether it was sent", async () => {
    window.history.replaceState(null, "", "/admin/forgot-password");
    const calls = serve(
      boot(false, null, { "POST /api/auth/request-password-reset": { status: true } }),
    );
    renderAdmin(createI18n("en"));
    fireEvent.change(await screen.findByLabelText(en.forgot.email), {
      target: { value: "admin@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.forgot.submit }));
    expect(await screen.findByText(en.forgot.sent)).toBeTruthy();
    expect(calls.find((call) => call.path === "/api/auth/request-password-reset")?.body).toEqual({
      email: "admin@example.test",
      redirectTo: `${window.location.origin}/admin/reset-password`,
    });
  });

  it("is not offered to a signed-in admin", async () => {
    window.history.replaceState(null, "", "/admin/forgot-password");
    serve(boot(false, FULL));
    renderAdmin(createI18n("en"));
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(window.location.pathname).toBe("/admin"));
  });

  async function fillReset(language: typeof en | typeof he) {
    await screen.findByRole("heading", { level: 1, name: language.reset.heading });
    for (const label of [language.reset.password, language.reset.confirm]) {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "a brand new passphrase" },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: language.reset.submit }));
  }

  it.each([
    ["without a session", null],
    ["with a session", FULL],
  ] as const)("sets the new password from the link %s and goes to sign-in", async (_, start) => {
    window.history.replaceState(null, "", "/admin/reset-password?token=link-token");
    let session: unknown = start;
    const calls = serve({
      "/api/admin/status": { setupRequired: false },
      get "/api/auth/get-session"() {
        return session;
      },
      "/api/auth/passkey/list-user-passkeys": [],
      get "POST /api/auth/reset-password"() {
        // Better Auth ends every session.
        session = null;
        return { status: true };
      },
    });
    renderAdmin(createI18n("en"));
    await fillReset(en);
    expect(await screen.findByRole("heading", { level: 1, name: en.signIn.heading })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe("/admin/sign-in"));
    expect(calls.find((call) => call.path === "/api/auth/reset-password")?.body).toEqual({
      token: "link-token",
      newPassword: "a brand new passphrase",
    });
  });

  it("says when Better Auth reported the link invalid", async () => {
    window.history.replaceState(null, "", "/admin/reset-password?error=INVALID_TOKEN");
    serve(boot(false, null));
    renderAdmin(createI18n("en"));
    expect(await screen.findByText(en.errors.resetLinkInvalid)).toBeTruthy();
    expect(screen.getByRole("link", { name: en.reset.again })).toBeTruthy();
  });

  it("maps a used or expired token to its message in Hebrew", async () => {
    window.history.replaceState(null, "", "/admin/reset-password?token=old");
    serve(
      boot(false, null, {
        "POST /api/auth/reset-password": json(
          { code: "INVALID_TOKEN", message: "Invalid token" },
          400,
        ),
      }),
    );
    renderAdmin(createI18n("he"));
    await fillReset(he);
    expect((await screen.findByRole("alert")).textContent).toBe(he.errors.resetLinkInvalid);
  });
});

describe("account page", () => {
  it("asks for an email change, which completes from the link sent to the new address", async () => {
    const calls = serve(boot(false, FULL, { "POST /api/auth/change-email": { status: true } }));
    renderAdmin(createI18n("en"));
    expect(await screen.findByText("admin@example.test")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(en.account.newEmail), {
      target: { value: "new@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.account.changeEmail }));
    expect(await screen.findByText(en.account.emailSent)).toBeTruthy();
    expect(calls.find((call) => call.path === "/api/auth/change-email")?.body).toEqual({
      newEmail: "new@example.test",
      callbackURL: "/admin",
    });
  });

  it("shows new backup codes once", async () => {
    serve(
      boot(false, FULL, {
        "POST /api/auth/two-factor/generate-backup-codes": {
          status: true,
          backupCodes: ["fresh-one", "fresh-two"],
        },
      }),
    );
    renderAdmin(createI18n("en"));
    fireEvent.change(await screen.findByLabelText(en.account.password), {
      target: { value: "a long password" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.account.generateBackup }));
    expect(await screen.findByText("fresh-one")).toBeTruthy();
  });
});

describe("routing and errors", () => {
  it("chooses the page from setup and session state", () => {
    const enrollment = { state: "enrollment", username: "shlomi", email: "a@b.test" } as const;
    const full = { ...enrollment, state: "full" } as const;
    expect(targetPath({ setupRequired: true, session: { state: "none" } })).toBe("/admin/setup");
    expect(targetPath({ setupRequired: false, session: { state: "none" } })).toBe("/admin/sign-in");
    expect(targetPath({ setupRequired: false, session: enrollment })).toBe("/admin/totp");
    expect(targetPath({ setupRequired: false, session: full })).toBe("/admin");
    for (const session of [{ state: "none" } as const, enrollment, full]) {
      expect(targetPath({ setupRequired: false, session }, "/admin/reset-password")).toBe(
        "/admin/reset-password",
      );
    }
    expect(targetPath({ setupRequired: false, session: full }, "/admin/forgot-password")).toBe(
      "/admin",
    );
  });

  it("maps server codes to locale keys that exist in both languages", () => {
    expect(errorKey("INVALID_USERNAME_OR_PASSWORD", 401)).toBe(ERROR_KEYS.invalidCredentials);
    expect(errorKey("FAILED_TO_CREATE_USER", 400)).toBe(ERROR_KEYS.alreadySetUp);
    expect(errorKey("INVALID_TOKEN", 400)).toBe(ERROR_KEYS.resetLinkInvalid);
    expect(errorKey("INVALID_ORIGIN", 403)).toBe(ERROR_KEYS.originRejected);
    expect(errorKey("setting_locked", 400)).toBe(ERROR_KEYS.settingLocked);
    expect(errorKey(undefined, 429)).toBe(ERROR_KEYS.tooManyAttempts);
    expect(errorKey("SOMETHING_NEW", 500)).toBe(ERROR_KEYS.unexpected);
    expect(errorKey(undefined, undefined)).toBe(ERROR_KEYS.network);
    for (const key of Object.values(ERROR_KEYS)) {
      const name = key.slice("errors.".length) as keyof typeof en.errors;
      expect(en.errors[name], key).toBeTruthy();
      expect(he.errors[name], key).toBeTruthy();
    }
  });
});

const AGENT = {
  id: "11111111-2222-4333-8444-555555555555",
  label: "Office PC",
  trustTier: "normal",
  activeDays: 12,
  agentVersion: "0.1.0",
  osVersion: "10.0.26100",
  registeredAt: "2026-11-01T08:00:00.000Z",
  revokedAt: null,
  lastSeenAt: "2026-11-01T09:00:00.000Z",
  address: "203.0.113.5",
  siteKey: "203.0.113.5",
  asn: 64500,
  asOrganization: "Example Net",
  providerName: "Example",
  reportedCell: "872d0a3c9ffffff",
  assignedCell: null,
  infrastructure: "partner_fiber",
  silenceIntervalSeconds: 60,
  lastEventKind: "connectivity_lost",
  lastEventAt: "2026-11-01T08:30:00.000Z",
  droppedEvents: "2",
};

/** A new agent in its trial. */
const LOW_AGENT = {
  ...AGENT,
  id: "66666666-7777-4888-8999-000000000000",
  label: "Kitchen PC",
  trustTier: "low",
  activeDays: 2,
  address: "198.51.100.7",
  siteKey: "198.51.100.7",
  asn: null,
  asOrganization: null,
  providerName: null,
  reportedCell: null,
  infrastructure: "unknown",
  lastEventKind: null,
  lastEventAt: null,
  droppedEvents: "0",
};

const SETTINGS = {
  heartbeatIntervalSeconds: 60,
  retentionDays: 30,
  registrationOpen: true,
  newAgentTier: "low",
  promotionDays: 7,
  registerPerSitePer10Min: 10,
  registerGlobalPerHour: 200,
  eventsPerAgentHour: 2000,
  eventsPerLowAgentHour: 200,
  agentCleanupDays: 30,
  publicUrl: "",
  trustedOrigins: [],
  trustedProxies: [],
  sessionHours: 12,
  smtpHost: "",
  smtpPort: 465,
  smtpUser: "",
  smtpPasswordSet: false,
  smtpFrom: "",
  locked: [],
  apply: {
    heartbeatIntervalSeconds: "now",
    retentionDays: "now",
    registrationOpen: "now",
    newAgentTier: "now",
    promotionDays: "now",
    registerPerSitePer10Min: "now",
    registerGlobalPerHour: "now",
    eventsPerAgentHour: "now",
    eventsPerLowAgentHour: "now",
    agentCleanupDays: "now",
    publicUrl: "restart",
    trustedOrigins: "now",
    trustedProxies: "restart",
    sessionHours: "restart",
    smtpHost: "next_email",
    smtpPort: "next_email",
    smtpUser: "next_email",
    smtpPassword: "next_email",
    smtpFrom: "next_email",
  },
  env: {
    publicUrl: "BETTER_AUTH_URL",
    trustedOrigins: "BETTER_AUTH_TRUSTED_ORIGINS",
    trustedProxies: "MASHKIF_TRUSTED_PROXIES",
    sessionHours: "MASHKIF_SESSION_HOURS",
    smtpHost: "MASHKIF_SMTP_HOST",
    smtpPort: "MASHKIF_SMTP_PORT",
    smtpUser: "MASHKIF_SMTP_USER",
    smtpPassword: "MASHKIF_SMTP_PASSWORD",
    smtpFrom: "MASHKIF_SMTP_FROM",
  },
  geoip: { state: "ok", buildDate: "2026-10-28T00:00:00.000Z", stale: false },
};

/** Every management resource, with data. */
function managed(extra: Routes = {}): Routes {
  return boot(false, FULL, {
    "/api/admin/agents": { agents: [AGENT, LOW_AGENT], promotionDays: 7 },
    "/api/admin/blocked-ranges": {
      ranges: [
        {
          id: 1,
          range: "192.0.2.0/24",
          note: "test range",
          createdAt: "2026-11-01T08:00:00.000Z",
          createdBy: "shlomi",
        },
      ],
    },
    "/api/admin/providers": { providers: [{ id: 3, name: "Example", asns: [64500, 64501] }] },
    "/api/admin/settings": SETTINGS,
    ...extra,
  });
}

const managementPages = [
  ["agents", "/admin/agents", en.agents.heading],
  ["blocked addresses", "/admin/blocked", en.blocked.heading],
  ["providers", "/admin/providers", en.providers.heading],
  ["settings", "/admin/settings", en.settings.heading],
] as const;

describe("management pages", () => {
  it.each(managementPages)("render the %s page with its data", async (_, path, heading) => {
    window.history.replaceState(null, "", path);
    serve(managed());
    renderAdmin(createI18n("en"));
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
    expect(window.location.pathname).toBe(path);
    expect(screen.getByRole("navigation", { name: en.nav.label })).toBeTruthy();
  });

  it.each(managementPages)("the %s page has only locale text besides data", async (_, path) => {
    window.history.replaceState(null, "", path);
    serve(managed());
    const { container } = renderAdmin(createI18n("he", pseudoResources()));
    await screen.findByRole("heading", { level: 1 });
    await act(async () => {});
    expectOnlyLocaleText(container);
  });

  it.each(managementPages)("the %s page has only locale text when empty", async (_, path) => {
    window.history.replaceState(null, "", path);
    serve(
      managed({
        "/api/admin/agents": { agents: [], promotionDays: 7 },
        "/api/admin/blocked-ranges": { ranges: [] },
        "/api/admin/providers": { providers: [] },
      }),
    );
    const { container } = renderAdmin(createI18n("he", pseudoResources()));
    await screen.findByRole("heading", { level: 1 });
    await act(async () => {});
    expectOnlyLocaleText(container);
  });

  it("are not shown without a full session", async () => {
    window.history.replaceState(null, "", "/admin/agents");
    serve(boot(false, ENROLLMENT));
    renderAdmin(createI18n("en"));
    await waitFor(() => expect(window.location.pathname).toBe("/admin/totp"));
  });

  it("show the site address, network, provider, area, and infrastructure of an agent", async () => {
    window.history.replaceState(null, "", "/admin/agents");
    serve(managed());
    renderAdmin(createI18n("en"));
    expect(await screen.findByText("203.0.113.5")).toBeTruthy();
    expect(screen.getByText("AS64500 · Example Net")).toBeTruthy();
    expect(screen.getByText("872d0a3c9ffffff")).toBeTruthy();
    expect(screen.getByText(en.agents.areaReported)).toBeTruthy();
    expect(screen.getByText(en.infra.partnerFiber)).toBeTruthy();
    expect(screen.getByText(en.eventKind.connectivityLost)).toBeTruthy();
  });

  it("edit the label, tier, and area of an agent", async () => {
    window.history.replaceState(null, "", "/admin/agents");
    const calls = serve(managed({ [`POST /api/admin/agents/${AGENT.id}`]: { ok: true } }));
    renderAdmin(createI18n("en"));
    fireEvent.click(
      (await screen.findAllByRole("button", { name: en.common.edit }))[0] as HTMLElement,
    );
    fireEvent.change(screen.getByLabelText(en.agents.labelField), { target: { value: "Den" } });
    fireEvent.change(screen.getByLabelText(en.agents.tierField), { target: { value: "trusted" } });
    fireEvent.change(screen.getByLabelText(en.agents.areaField), {
      target: { value: " 872D0A3C9FFFFFF " },
    });
    fireEvent.click(screen.getByRole("button", { name: en.common.save }));
    await waitFor(() =>
      expect(calls.find((call) => call.path === `/api/admin/agents/${AGENT.id}`)?.body).toEqual({
        label: "Den",
        trustTier: "trusted",
        assignedCell: "872d0a3c9ffffff",
      }),
    );
  });

  it("send the tier only when the admin changed it, so a label edit never demotes or restarts a trial", async () => {
    window.history.replaceState(null, "", "/admin/agents");
    const calls = serve(managed({ [`POST /api/admin/agents/${LOW_AGENT.id}`]: { ok: true } }));
    renderAdmin(createI18n("en"));
    fireEvent.click(
      (await screen.findAllByRole("button", { name: en.common.edit }))[1] as HTMLElement,
    );
    fireEvent.change(screen.getByLabelText(en.agents.labelField), { target: { value: "Den" } });
    fireEvent.click(screen.getByRole("button", { name: en.common.save }));
    await waitFor(() =>
      expect(calls.find((call) => call.path === `/api/admin/agents/${LOW_AGENT.id}`)?.body).toEqual(
        {
          label: "Den",
          assignedCell: null,
        },
      ),
    );
  });

  it("never send a stale tier when the agent was promoted while its form was open", async () => {
    window.history.replaceState(null, "", "/admin/agents");
    const routes = managed({
      [`POST /api/admin/agents/${AGENT.id}/revoke`]: { ok: true },
      [`POST /api/admin/agents/${LOW_AGENT.id}`]: { ok: true },
    });
    const calls = serve(routes);
    renderAdmin(createI18n("en"));
    // The admin opens the low agent's form.
    fireEvent.click(
      (await screen.findAllByRole("button", { name: en.common.edit }))[1] as HTMLElement,
    );
    expect((screen.getByLabelText(en.agents.tierField) as HTMLSelectElement).value).toBe("low");
    // Meanwhile the agent is promoted; another change reloads the list.
    routes["/api/admin/agents"] = {
      agents: [AGENT, { ...LOW_AGENT, trustTier: "normal" }],
      promotionDays: 7,
    };
    fireEvent.click(screen.getByRole("button", { name: en.agents.revoke }));
    fireEvent.click(screen.getByRole("button", { name: en.agents.revokeConfirm }));
    await waitFor(() =>
      expect(calls.filter((call) => call.path === "/api/admin/agents").length).toBe(2),
    );
    // The label is saved; the untouched tier select is not sent.
    fireEvent.change(screen.getByLabelText(en.agents.labelField), { target: { value: "Den" } });
    fireEvent.click(screen.getByRole("button", { name: en.common.save }));
    await waitFor(() =>
      expect(calls.find((call) => call.path === `/api/admin/agents/${LOW_AGENT.id}`)?.body).toEqual(
        { label: "Den", assignedCell: null },
      ),
    );
  });

  it("show a low agent's trial as active days of the trial length", async () => {
    window.history.replaceState(null, "", "/admin/agents");
    serve(managed());
    renderAdmin(createI18n("en"));
    expect(await screen.findByText(en.tier.low)).toBeTruthy();
    expect(
      screen.getByText(en.agents.trialDays.replace("{{days}}", "2").replace("{{needed}}", "7")),
    ).toBeTruthy();
    // A normal agent has no trial line.
    expect(screen.getAllByText(en.agents.trial)).toHaveLength(1);
  });

  it("revoke an agent only after a second click", async () => {
    window.history.replaceState(null, "", "/admin/agents");
    const calls = serve(managed({ [`POST /api/admin/agents/${AGENT.id}/revoke`]: { ok: true } }));
    renderAdmin(createI18n("en"));
    fireEvent.click(
      (await screen.findAllByRole("button", { name: en.agents.revoke }))[0] as HTMLElement,
    );
    expect(calls.some((call) => call.path.endsWith("/revoke"))).toBe(false);
    expect(screen.getByText(en.agents.revokeHelp)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.agents.revokeConfirm }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith("/revoke"))).toBe(true));
  });

  it("refuse ASNs that are not numbers before sending", async () => {
    window.history.replaceState(null, "", "/admin/providers");
    const calls = serve(managed());
    renderAdmin(createI18n("en"));
    const [nameField] = await screen.findAllByLabelText(en.providers.name);
    const [asnField] = screen.getAllByLabelText(en.providers.asns);
    fireEvent.change(nameField as HTMLElement, { target: { value: "New" } });
    fireEvent.change(asnField as HTMLElement, { target: { value: "64500, AS1" } });
    fireEvent.click(screen.getByRole("button", { name: en.providers.add }));
    expect((await screen.findByRole("alert")).textContent).toBe(en.errors.asnsInvalid);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("map a server refusal on a block to its message in Hebrew", async () => {
    window.history.replaceState(null, "", "/admin/blocked");
    serve(
      managed({
        "POST /api/admin/blocked-ranges": new Response(
          JSON.stringify({ error: "range_invalid", field: "range" }),
          { status: 400 },
        ),
      }),
    );
    renderAdmin(createI18n("he"));
    fireEvent.change(await screen.findByLabelText(he.blocked.range), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: he.blocked.add }));
    expect((await screen.findByRole("alert")).textContent).toBe(he.errors.rangeInvalid);
  });

  it("close registration and choose the tier of new PCs", async () => {
    window.history.replaceState(null, "", "/admin/settings");
    const calls = serve(managed({ "POST /api/admin/settings": SETTINGS }));
    renderAdmin(createI18n("en"));
    fireEvent.change(await screen.findByLabelText(en.settings.registrationOpen), {
      target: { value: "false" },
    });
    fireEvent.change(screen.getByLabelText(en.settings.newAgentTier), {
      target: { value: "normal" },
    });
    fireEvent.change(screen.getByLabelText(en.settings.registerGlobalPerHour), {
      target: { value: "1000" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.settings.save }));
    expect(await screen.findByText(en.settings.saved)).toBeTruthy();
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      registrationOpen: false,
      newAgentTier: "normal",
      registerGlobalPerHour: 1000,
    });
  });

  it("save the settings and confirm", async () => {
    window.history.replaceState(null, "", "/admin/settings");
    const calls = serve(managed({ "POST /api/admin/settings": SETTINGS }));
    renderAdmin(createI18n("en"));
    fireEvent.change(await screen.findByLabelText(en.settings.heartbeatIntervalSeconds), {
      target: { value: "120" },
    });
    fireEvent.change(screen.getByLabelText(en.settings.trustedProxies), {
      target: { value: "172.18.0.0/16, 10.0.0.1" },
    });
    fireEvent.change(screen.getByLabelText(en.settings.smtpHost), {
      target: { value: "smtp.example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.settings.save }));
    expect(await screen.findByText(en.settings.saved)).toBeTruthy();
    // The empty password field keeps the stored password, so it is not sent.
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      heartbeatIntervalSeconds: 120,
      retentionDays: 30,
      registrationOpen: true,
      newAgentTier: "low",
      promotionDays: 7,
      registerPerSitePer10Min: 10,
      registerGlobalPerHour: 200,
      eventsPerAgentHour: 2000,
      eventsPerLowAgentHour: 200,
      agentCleanupDays: 30,
      publicUrl: "",
      trustedOrigins: [],
      trustedProxies: ["172.18.0.0/16", "10.0.0.1"],
      sessionHours: 12,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpUser: "",
      smtpFrom: "",
    });
  });

  it("show a field set by the environment locked, name the variable, and never send it", async () => {
    window.history.replaceState(null, "", "/admin/settings");
    const locked = {
      ...SETTINGS,
      publicUrl: "https://mashkif.example",
      smtpPasswordSet: true,
      locked: ["publicUrl", "smtpPassword"],
    };
    const calls = serve(
      managed({ "/api/admin/settings": locked, "POST /api/admin/settings": locked }),
    );
    renderAdmin(createI18n("en"));
    const field = (await screen.findByLabelText(en.settings.publicUrl)) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe("https://mashkif.example");
    expect(
      screen.getByText(en.settings.locked.replace("{{variable}}", "BETTER_AUTH_URL")),
    ).toBeTruthy();
    expect(screen.getByText(en.settings.passwordSet)).toBeTruthy();
    expect((screen.getByLabelText(en.settings.smtpPassword) as HTMLInputElement).readOnly).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: en.settings.save }));
    expect(await screen.findByText(en.settings.saved)).toBeTruthy();
    const body = calls.find((call) => call.method === "POST")?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("publicUrl");
    expect(body).not.toHaveProperty("smtpPassword");
  });

  it("send a typed SMTP password once and say when the server refuses a value", async () => {
    window.history.replaceState(null, "", "/admin/settings");
    const calls = serve(
      managed({
        "POST /api/admin/settings": json({ error: "setting_invalid", field: "smtpPort" }, 400),
      }),
    );
    renderAdmin(createI18n("he"));
    fireEvent.change(await screen.findByLabelText(he.settings.smtpPassword), {
      target: { value: "mail secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: he.settings.save }));
    expect((await screen.findByRole("alert")).textContent).toBe(he.errors.settingInvalid);
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      smtpPassword: "mail secret",
    });
  });

  it("warn when the GeoLite2-ASN database is missing", async () => {
    window.history.replaceState(null, "", "/admin/settings");
    serve(
      managed({
        "/api/admin/settings": {
          ...SETTINGS,
          geoip: { state: "unavailable", buildDate: null, stale: false },
        },
      }),
    );
    renderAdmin(createI18n("en"));
    expect(await screen.findByText(en.settings.geoipUnavailable)).toBeTruthy();
  });

  it("go back to sign-in when the session ends", async () => {
    window.history.replaceState(null, "", "/admin/agents");
    let session: unknown = FULL;
    // Getters defined after the spread in managed(), so they run on each request.
    const routes = managed();
    Object.defineProperty(routes, "/api/auth/get-session", { get: () => session });
    Object.defineProperty(routes, "/api/admin/agents", {
      get: () => {
        session = null;
        return json({ error: "session_required" }, 401);
      },
    });
    serve(routes);
    renderAdmin(createI18n("en"));
    await waitFor(() => expect(window.location.pathname).toBe("/admin/sign-in"));
  });
});
