import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const defaultAllowedHosts = [".ngrok-free.dev"];

function parseAllowedHosts(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const allowedHosts = Array.from(new Set([...defaultAllowedHosts, ...parseAllowedHosts(env.VITE_DEV_ALLOWED_HOSTS)]));

  return {
    plugins: [react()],
    server: {
      port: 5173,
      allowedHosts,
      proxy: {
        "/api": "http://localhost:8787",
        "/media": "http://localhost:8787"
      }
    }
  };
});
