import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminLockBusyError, withAdminLock } from "../src/admin/lock.js";
import { resetAdmin } from "../src/admin/reset.js";
import type { AuthOptions } from "../src/auth/auth.js";
import { createTestDatabase, type TestDatabase, truncateAll } from "./support/database.js";
import {
  Browser,
  createHarness,
  enrollTotp,
  type Harness,
  ORIGIN,
  PASSWORD,
  pauseOnce,
  setUpAdmin,
  USERNAME,
  untilLockWaiter,
} from "./support/harness.js";
import { SoftwareAuthenticator } from "./support/webauthn.js";

let database: TestDatabase;
let harness: Harness;
let hooks: NonNullable<AuthOptions["testHooks"]>;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await truncateAll(database.sql);
  hooks = {};
  harness = createHarness(database, {
    afterPasswordCheck: () => hooks.afterPasswordCheck?.() ?? Promise.resolve(),
    afterPasskeyCheck: () => hooks.afterPasskeyCheck?.() ?? Promise.resolve(),
  });
  await setUpAdmin(database, harness);
});

/** The owner signs in with the password reset-admin printed and enrolls TOTP again. */
async function ownerRecovers(password: string): Promise<void> {
  harness.rateLimits.clear();
  const owner = new Browser(harness);
  await enrollTotp(owner, password);
  expect(await owner.sessionState()).toBe("full");
}

describe("sign-ins racing reset-admin", () => {
  it("a password sign-in that verified the old password yields no usable session", async () => {
    const pause = pauseOnce();
    hooks.afterPasswordCheck = pause.hook;
    const attacker = new Browser(harness);
    const signIn = attacker.signIn(USERNAME, PASSWORD);
    await pause.atPause;

    const reset = resetAdmin(database.db);
    await untilLockWaiter(database.sql);
    pause.resume();
    await signIn;
    const result = await reset;
    if (!result.ok) {
      throw new Error("reset refused");
    }

    expect(await attacker.sessionState()).toBe("none");
    expect(
      (await attacker.post("/api/auth/two-factor/enable", { password: PASSWORD })).status,
    ).toBe(401);
    await ownerRecovers(result.password);
    expect(await attacker.sessionState()).toBe("none");
  });

  it("a passkey sign-in that read the old passkey yields no usable session", async () => {
    const owner = new Browser(harness);
    await enrollTotp(owner);
    const authenticator = new SoftwareAuthenticator();
    const register = await owner.get("/api/auth/passkey/generate-register-options");
    const added = await owner.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register({
        origin: ORIGIN,
        rpId: new URL(ORIGIN).hostname,
        challenge: String(register.body.challenge),
        userVerified: true,
      }),
    });
    expect(added.status).toBe(200);

    const pause = pauseOnce();
    hooks.afterPasskeyCheck = pause.hook;
    const attacker = new Browser(harness);
    const options = await attacker.get("/api/auth/passkey/generate-authenticate-options");
    const signIn = attacker.post("/api/auth/passkey/verify-authentication", {
      response: authenticator.authenticate({
        origin: ORIGIN,
        rpId: new URL(ORIGIN).hostname,
        challenge: String(options.body.challenge),
        userVerified: true,
      }),
    });
    await pause.atPause;

    const reset = resetAdmin(database.db);
    await untilLockWaiter(database.sql);
    pause.resume();
    await signIn;
    const result = await reset;
    if (!result.ok) {
      throw new Error("reset refused");
    }

    // Checked only after the owner enrolls TOTP again, when a surviving
    // passkey session would count as full.
    await ownerRecovers(result.password);
    expect(await attacker.sessionState()).toBe("none");
  });
});

describe("the admin lock", () => {
  it("more concurrent credential changes than pool connections all finish", async () => {
    // The test database pool has 10 connections.
    const browser = new Browser(harness);
    expect((await browser.signIn()).status).toBe(200);
    const requests = Array.from({ length: 15 }, () =>
      browser.post("/api/auth/two-factor/enable", { password: PASSWORD }),
    );
    const outcome = await Promise.race([
      Promise.all(requests),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 25_000)),
    ]);
    expect(outcome).not.toBe("stuck");
    // Every request finished. Better Auth limits /two-factor/* on its own, inside the lock.
    const statuses = (outcome as { status: number }[]).map((reply) => reply.status);
    expect(statuses.every((status) => status === 200 || status === 429)).toBe(true);
    expect(statuses).toContain(200);
    expect(statuses).toHaveLength(15);
  }, 30_000);

  it("gives up after a bounded wait and keeps the queue working", async () => {
    let finish = () => {};
    const holder = withAdminLock(
      database.db,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(withAdminLock(database.db, async () => "late", 200)).rejects.toBeInstanceOf(
      AdminLockBusyError,
    );
    finish();
    await holder;
    await expect(withAdminLock(database.db, async () => "next")).resolves.toBe("next");
  });

  it("a stuck holder in another process makes requests give up, not hang", async () => {
    const other = await database.sql.reserve();
    await other`select pg_advisory_lock(hashtext('mashkif:admin-credentials'))`;
    try {
      await expect(withAdminLock(database.db, async () => "late", 300)).rejects.toBeInstanceOf(
        AdminLockBusyError,
      );
    } finally {
      await other`select pg_advisory_unlock(hashtext('mashkif:admin-credentials'))`;
      other.release();
    }
    await expect(withAdminLock(database.db, async () => "next")).resolves.toBe("next");
  });
});
