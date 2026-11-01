// Operator commands, run inside the app container:
//   docker compose exec app node server/dist/cli.js setup-token
//   docker compose exec app node server/dist/cli.js reset-admin
// They need only DATABASE_URL, and apply pending migrations first. Neither
// ever prints a password.
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { RESET_TOKEN_TTL_MS, resetAdmin } from "./admin/reset.js";
import { createSetupToken, SETUP_TOKEN_TTL_MS } from "./admin/setup.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { describeSafely } from "./errors.js";

const USAGE = `Usage: node server/dist/cli.js <command>

Commands:
  setup-token   Print a single-use token for creating the admin at /admin/setup.
                Valid for ${SETUP_TOKEN_TTL_MS / 60_000} minutes. Refused once an admin exists.
  reset-admin   Lock the admin out and print a single-use token for setting a
                new password at /admin/reset, valid for ${RESET_TOKEN_TTL_MS / 60_000} minutes. The current
                password, TOTP, passkeys, sessions, and pending sign-ins stop
                working at once. After the new password, TOTP is set up again.`;

/** Runs one operator command and returns the exit code. */
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const command = argv[0];
  if (argv.length !== 1 || (command !== "setup-token" && command !== "reset-admin")) {
    console.error(USAGE);
    return 2;
  }
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    console.error("configuration error: DATABASE_URL must be set to a postgres:// URL");
    return 2;
  }
  const sql = postgres(databaseUrl, { max: 2, connect_timeout: 5, onnotice: () => {} });
  try {
    await runMigrations(sql);
    const db = createDb(sql);
    if (command === "setup-token") {
      const result = await createSetupToken(db);
      if (!result.ok) {
        console.error(
          "An admin already exists. To regain access, run: node server/dist/cli.js reset-admin",
        );
        return 1;
      }
      console.log(`Setup token: ${result.token}`);
      console.log(
        `Valid until ${result.expiresAt.toISOString()}, once. Open /admin/setup and enter it.`,
      );
      return 0;
    }
    const result = await resetAdmin(db);
    if (!result.ok) {
      console.error("No admin exists yet. Create one with: node server/dist/cli.js setup-token");
      return 1;
    }
    console.log(`Reset token: ${result.token}`);
    console.log(
      `Valid until ${result.expiresAt.toISOString()}, once. Open /admin/reset, enter it, and choose a new password.`,
    );
    console.log("The old password, TOTP, passkeys, and every session no longer work.");
    return 0;
  } catch (error) {
    console.error(`command failed: ${describeSafely(error)}`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
