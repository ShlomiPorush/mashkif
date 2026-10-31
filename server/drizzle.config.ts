import { defineConfig } from "drizzle-kit";

// MASHKIF_DRIZZLE_OUT lets the verify script generate into a scratch copy to
// detect schema changes that have no migration yet.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: process.env.MASHKIF_DRIZZLE_OUT ?? "./drizzle",
  migrations: {
    schema: "drizzle",
    table: "__drizzle_migrations",
  },
});
