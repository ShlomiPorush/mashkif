import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { twoFactorClient, usernameClient } from "better-auth/client/plugins";

/** Better Auth on the same origin. */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [usernameClient(), twoFactorClient(), passkeyClient()],
  // Look fetch up on every request instead of once at load, like adminApi.
  fetchOptions: { customFetchImpl: (input, init) => globalThis.fetch(input, init) },
});

/** The error shape the Better Auth client returns. A missing status means no answer arrived. */
export interface AuthClientError {
  code?: string | undefined;
  status?: number | undefined;
  message?: string | undefined;
}
