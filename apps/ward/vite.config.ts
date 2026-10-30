import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Port 3003 is in the local Auth redirect allow-list (supabase/config.toml).
export default defineConfig({
  plugins: [react()],
  // connector.tsx shares the CSV format with the partner-api function.
  server: { host: "127.0.0.1", port: 3003, strictPort: true, fs: { allow: [".", "../../supabase/functions/_shared"] } },
});
