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

const ENROLLMENT = {
  state: "enrollment",
  username: "shlomi",
  method: "password",
  maxAgeAt: "2026-11-01T22:00:00.000Z",
  idleAt: "2026-11-01T11:00:00.000Z",
};
const FULL = { ...ENROLLMENT, state: "full", method: "totp" };

const TOTP_URI =
  "otpauth://totp/Mashkif:shlomi%40admin.mashkif.invalid?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Mashkif&algorithm=SHA1&digits=6&period=30";

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
    const answer = routes[`${method} ${url.pathname}`] ?? routes[url.pathname];
    if (answer === undefined) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    if (answer instanceof Response) {
      return answer;
    }
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function boot(setupRequired: boolean, session: unknown, extra: Routes = {}): Routes {
  return {
    "/api/admin/status": { setupRequired },
    "/api/admin/session": session,
    "/api/admin/audit": { entries: [] },
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
  ["setup", boot(true, { state: "none" }), "/admin/setup", en.setup.heading],
  ["sign-in", boot(false, { state: "none" }), "/admin/sign-in", en.signIn.heading],
  ["TOTP enrollment", boot(false, ENROLLMENT), "/admin/totp", en.totp.heading],
  [
    "admin home",
    boot(false, FULL),
    "/admin",
    en.admin.homeHeading.replace("{{username}}", "shlomi"),
  ],
] as const;

describe("admin routes", () => {
  it.each(pages)("render the %s page at its path", async (_, routes, path, heading) => {
    serve(routes);
    renderAdmin(createI18n("en"));
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe(path));
  });

  it.each(pages)("the %s page has only locale text", async (_, routes) => {
    serve(routes);
    const { container } = renderAdmin(createI18n("he", pseudoResources()));
    await screen.findByRole("heading", { level: 1 });
    // Let the page finish loading its data.
    await act(async () => {});
    expectOnlyLocaleText(container);
  });

  it("renders in Hebrew by default", async () => {
    serve(boot(false, { state: "none" }));
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

  it("explains a session that ended for inactivity", async () => {
    serve(boot(false, { state: "none", ended: "idle" }));
    renderAdmin(createI18n("en"));
    expect(await screen.findByText(en.signIn.endedIdle)).toBeTruthy();
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
  it("asks for the TOTP code after the password", async () => {
    const calls = serve(
      boot(
        false,
        { state: "none" },
        { "POST /api/auth/sign-in/username": { twoFactorRedirect: true } },
      ),
    );
    renderAdmin(createI18n("en"));
    await screen.findByRole("heading", { level: 1, name: en.signIn.heading });
    fireEvent.change(screen.getByLabelText(en.signIn.username), { target: { value: "shlomi" } });
    fireEvent.change(screen.getByLabelText(en.signIn.password), {
      target: { value: "a long password" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.signIn.submit }));
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
      boot(
        false,
        { state: "none" },
        {
          "POST /api/auth/sign-in/username": new Response(
            JSON.stringify({
              code: "INVALID_USERNAME_OR_PASSWORD",
              message: "Invalid username or password",
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
        },
      ),
    );
    renderAdmin(createI18n("he"));
    await screen.findByRole("heading", { level: 1, name: he.signIn.heading });
    fireEvent.change(screen.getByLabelText(he.signIn.username), { target: { value: "shlomi" } });
    fireEvent.change(screen.getByLabelText(he.signIn.password), {
      target: { value: "wrong password" },
    });
    fireEvent.click(screen.getByRole("button", { name: he.signIn.submit }));
    expect((await screen.findByRole("alert")).textContent).toBe(he.errors.invalidCredentials);
  });
});

describe("TOTP enrollment", () => {
  it("shows a QR code drawn locally and the manual key", async () => {
    rememberPassword("a long password");
    const calls = serve(
      boot(false, ENROLLMENT, {
        "POST /api/auth/two-factor/enable": {
          totpURI: TOTP_URI,
          backupCodes: ["backup-code-one", "backup-code-two"],
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
    // Backup codes are never shown.
    expect(document.body.textContent).not.toContain("backup-code");
  });

  it("asks for the password when it was not just typed", async () => {
    serve(boot(false, ENROLLMENT));
    renderAdmin(createI18n("en"));
    expect(await screen.findByLabelText(en.totp.password)).toBeTruthy();
  });
});

describe("routing and errors", () => {
  it("chooses the page from setup and session state", () => {
    expect(targetPath({ setupRequired: true, session: { state: "none" } })).toBe("/admin/setup");
    expect(targetPath({ setupRequired: false, session: { state: "none" } })).toBe("/admin/sign-in");
    expect(targetPath({ setupRequired: false, session: ENROLLMENT as never })).toBe("/admin/totp");
    expect(targetPath({ setupRequired: false, session: FULL as never })).toBe("/admin");
  });

  it("maps server codes to locale keys that exist in both languages", () => {
    expect(errorKey("INVALID_USERNAME_OR_PASSWORD", 401)).toBe(ERROR_KEYS.invalidCredentials);
    expect(errorKey("setup_token_invalid", 403)).toBe(ERROR_KEYS.setupTokenInvalid);
    expect(errorKey("PASSKEY_USER_VERIFICATION_REQUIRED", 401)).toBe(
      ERROR_KEYS.passkeyUserVerification,
    );
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

describe("sign-in flow", () => {
  it("shows the home page after the TOTP step succeeds", async () => {
    let session: unknown = { state: "none" };
    serve({
      "/api/admin/status": { setupRequired: false },
      get "/api/admin/session"() {
        return session;
      },
      "/api/admin/audit": { entries: [] },
      "/api/auth/passkey/list-user-passkeys": [],
      "POST /api/auth/sign-in/username": { twoFactorRedirect: true },
      get "POST /api/auth/two-factor/verify-totp"() {
        session = FULL;
        return { token: "t", user: { username: "shlomi" } };
      },
    });
    renderAdmin(createI18n("en"));
    await screen.findByRole("heading", { level: 1, name: en.signIn.heading });
    fireEvent.change(screen.getByLabelText(en.signIn.username), { target: { value: "shlomi" } });
    fireEvent.change(screen.getByLabelText(en.signIn.password), {
      target: { value: "a long password" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.signIn.submit }));
    fireEvent.change(await screen.findByLabelText(en.signIn.code), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: en.signIn.verify }));
    await waitFor(() => expect(window.location.pathname).toBe("/admin"));
    expect(
      await screen.findByRole("heading", { level: 2, name: en.passkeys.heading }),
    ).toBeTruthy();
  });
});
