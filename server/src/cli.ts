// Operator commands, run inside the app container:
//   docker compose exec app node server/dist/cli.js setup-token
//   docker compose exec app node server/dist/cli.js reset-admin
// They need only DATABASE_URL, and apply pending migrations first.
import postgres from "postgres";
import { resetAdmin } from "./admin/reset.js";
import { createSetupToken, SETUP_TOKEN_TTL_MS } from "./admin/setup.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";

const USAGE = `Usage: node server/dist/cli.js <command>

Commands:
  setup-token   Print a single-use token for creating the admin at /admin/setup.
                Valid for ${SETUP_TOKEN_TTL_MS / 60_000} minutes. Refused once an admin exists.
  reset-admin   Give the admin a new random password, printed once, and remove
                TOTP, passkeys, sessions, and pending sign-ins. After signing in
                with the new password, TOTP must be set up again.`;

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (argv.length !== 1 || (command !== "setup-token" && command !== "reset-admin")) {
    console.error(USAGE);
    return 2;
  }
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
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
    console.log(`Username: ${result.username}`);
    console.log(`New password: ${result.password}`);
    console.log("This password is shown only now. TOTP, passkeys, and every session were removed.");
    console.log("Sign in at /admin with the new password, then set up TOTP again.");
    return 0;
  } catch (error) {
    console.error(`command failed: ${describe(error)}`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

process.exitCode = await main(process.argv.slice(2));
