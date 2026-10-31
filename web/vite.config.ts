import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    // Keep every asset a separate file so the server's Content Security
    // Policy does not need to allow data: URLs for fonts or scripts.
    assetsInlineLimit: 0,
  },
  test: {
    environment: "jsdom",
    restoreMocks: true,
  },
});
