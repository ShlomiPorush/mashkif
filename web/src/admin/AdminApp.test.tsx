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

describe("setup", () => {
  it("moves on to sign-in when the admin exists already, for example after a lost answer", async () => {
    let setupRequired = true;
    serve({
      get "/api/admin/status"() {
        return { setupRequired };
      },
      "/api/admin/session": { state: "none" },
      get "POST /api/admin/setup"() {
        // The first attempt created the admin, but its answer never arrived.
        setupRequired = false;
        return new Response(JSON.stringify({ error: "already_set_up" }), { status: 409 });
      },
    });
    renderAdmin(createI18n("en"));
    await screen.findByRole("heading", { level: 1, name: en.setup.heading });
    fireEvent.change(screen.getByLabelText(en.setup.token), { target: { value: "token" } });
    fireEvent.change(screen.getByLabelText(en.setup.username), { target: { value: "shlomi" } });
    fireEvent.change(screen.getByLabelText(en.setup.password), {
      target: { value: "a long password" },
    });
    fireEvent.change(screen.getByLabelText(en.setup.confirm), {
      target: { value: "a long password" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.setup.submit }));
    expect(await screen.findByRole("heading", { level: 1, name: en.signIn.heading })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe("/admin/sign-in"));
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

describe("reset page", () => {
  const atReset = () => window.history.replaceState(null, "", "/admin/reset");

  async function fillReset(language: typeof en | typeof he, password = "a brand new passphrase") {
    await screen.findByRole("heading", { level: 1, name: language.reset.heading });
    fireEvent.change(screen.getByLabelText(language.reset.token), { target: { value: "token" } });
    fireEvent.change(screen.getByLabelText(language.reset.password), {
      target: { value: password },
    });
    fireEvent.change(screen.getByLabelText(language.reset.confirm), {
      target: { value: password },
    });
    fireEvent.click(screen.getByRole("button", { name: language.reset.submit }));
  }

  it("is reachable without a session and has only locale text", async () => {
    atReset();
    serve(boot(false, { state: "none" }));
    const { container } = renderAdmin(createI18n("he", pseudoResources()));
    await screen.findByRole("heading", { level: 1 });
    expect(window.location.pathname).toBe("/admin/reset");
    expectOnlyLocaleText(container);
  });

  it("sets the new password and goes to sign-in", async () => {
    atReset();
    const calls = serve(boot(false, { state: "none" }, { "POST /api/admin/reset": { ok: true } }));
    renderAdmin(createI18n("en"));
    await fillReset(en);
    expect(await screen.findByRole("heading", { level: 1, name: en.signIn.heading })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe("/admin/sign-in"));
    expect(calls.find((call) => call.path === "/api/admin/reset")?.body).toEqual({
      token: "token",
      password: "a brand new passphrase",
    });
  });

  it.each([
    ["reset_token_expired", "resetTokenExpired"],
    ["reset_token_used", "resetTokenUsed"],
    ["reset_token_invalid", "resetTokenInvalid"],
    ["password_too_short", "passwordTooShort"],
  ] as const)("shows %s in Hebrew", async (code, key) => {
    atReset();
    serve(
      boot(
        false,
        { state: "none" },
        {
          "POST /api/admin/reset": new Response(JSON.stringify({ error: code }), { status: 403 }),
        },
      ),
    );
    renderAdmin(createI18n("he"));
    await fillReset(he);
    expect((await screen.findByRole("alert")).textContent).toBe(he.errors[key]);
  });

  it("is not shown to a signed-in admin", async () => {
    atReset();
    serve(boot(false, FULL));
    renderAdmin(createI18n("en"));
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(window.location.pathname).toBe("/admin"));
  });

  it("is linked from the sign-in page", async () => {
    serve(boot(false, { state: "none" }));
    renderAdmin(createI18n("en"));
    fireEvent.click(await screen.findByRole("link", { name: en.signIn.resetLink }));
    expect(await screen.findByRole("heading", { level: 1, name: en.reset.heading })).toBeTruthy();
  });
});

const AGENT = {
  id: "11111111-2222-4333-8444-555555555555",
  label: "Office PC",
  trustTier: "normal",
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

const KEY = {
  id: 7,
  label: "Kitchen PC",
  createdAt: "2026-11-01T08:00:00.000Z",
  expiresAt: "2026-11-02T08:00:00.000Z",
  usedAt: null,
  revokedAt: null,
  agentId: null,
  status: "active",
};

/** Every management resource, with data. */
function managed(extra: Routes = {}): Routes {
  return boot(false, FULL, {
    "/api/admin/agents": { agents: [AGENT] },
    "/api/admin/enrollment-keys": {
      keys: [KEY, { ...KEY, id: 8, status: "used", usedAt: "2026-11-01T09:00:00.000Z" }],
    },
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
    "/api/admin/settings": {
      heartbeatIntervalSeconds: 60,
      retentionDays: 30,
      geoip: { state: "ok", buildDate: "2026-10-28T00:00:00.000Z", stale: false },
    },
    ...extra,
  });
}

const managementPages = [
  ["agents", "/admin/agents", en.agents.heading],
  ["enrollment keys", "/admin/keys", en.keys.heading],
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
        "/api/admin/agents": { agents: [] },
        "/api/admin/enrollment-keys": { keys: [] },
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
    fireEvent.click(await screen.findByRole("button", { name: en.common.edit }));
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

  it("revoke an agent only after a second click", async () => {
    window.history.replaceState(null, "", "/admin/agents");
    const calls = serve(managed({ [`POST /api/admin/agents/${AGENT.id}/revoke`]: { ok: true } }));
    renderAdmin(createI18n("en"));
    fireEvent.click(await screen.findByRole("button", { name: en.agents.revoke }));
    expect(calls.some((call) => call.path.endsWith("/revoke"))).toBe(false);
    expect(screen.getByText(en.agents.revokeHelp)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.agents.revokeConfirm }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith("/revoke"))).toBe(true));
  });

  it("show a new enrollment key once", async () => {
    window.history.replaceState(null, "", "/admin/keys");
    const secret = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    const calls = serve(
      managed({ "POST /api/admin/enrollment-keys": { secret, key: { ...KEY, label: "Den PC" } } }),
    );
    renderAdmin(createI18n("en"));
    fireEvent.change(await screen.findByLabelText(en.keys.label), { target: { value: "Den PC" } });
    fireEvent.change(screen.getByLabelText(en.keys.validity), { target: { value: "72" } });
    fireEvent.click(screen.getByRole("button", { name: en.keys.create }));
    expect(await screen.findByText(secret)).toBeTruthy();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      label: "Den PC",
      validHours: 72,
    });
    fireEvent.click(screen.getByRole("button", { name: en.keys.done }));
    expect(screen.queryByText(secret)).toBeNull();
  });

  it("offer revoke only for active keys", async () => {
    window.history.replaceState(null, "", "/admin/keys");
    serve(managed());
    renderAdmin(createI18n("en"));
    await screen.findAllByText("Kitchen PC");
    expect(screen.getAllByRole("button", { name: en.keys.revoke })).toHaveLength(1);
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

  it("save the settings and confirm", async () => {
    window.history.replaceState(null, "", "/admin/settings");
    const calls = serve(
      managed({ "POST /api/admin/settings": { heartbeatIntervalSeconds: 120, retentionDays: 14 } }),
    );
    renderAdmin(createI18n("en"));
    fireEvent.change(await screen.findByLabelText(en.settings.interval), {
      target: { value: "120" },
    });
    fireEvent.change(screen.getByLabelText(en.settings.retention), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: en.settings.save }));
    expect(await screen.findByText(en.settings.saved)).toBeTruthy();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      heartbeatIntervalSeconds: 120,
      retentionDays: 14,
    });
  });

  it("warn when the GeoLite2-ASN database is missing", async () => {
    window.history.replaceState(null, "", "/admin/settings");
    serve(
      managed({
        "/api/admin/settings": {
          heartbeatIntervalSeconds: 60,
          retentionDays: 30,
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
    Object.defineProperty(routes, "/api/admin/session", { get: () => session });
    Object.defineProperty(routes, "/api/admin/agents", {
      get: () => {
        session = { state: "none", ended: "idle" };
        return new Response(JSON.stringify({ error: "session_ended" }), { status: 401 });
      },
    });
    serve(routes);
    renderAdmin(createI18n("en"));
    await waitFor(() => expect(window.location.pathname).toBe("/admin/sign-in"));
  });
});
