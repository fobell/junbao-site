import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { normalizeBasePath } from "./src/shared/base-path.mjs";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "APP_");
  const path = normalizeBasePath(
    process.env.APP_BASE_PATH ?? env.APP_BASE_PATH ?? "",
  );
  return {
    base: `${path}/`,
    plugins: [react()],
    build: { outDir: "dist/web" },
    server: {
      port: 5173,
      proxy: {
        [`${path}/api`]: {
          target: "http://127.0.0.1:3000",
          rewrite: (url: string) => url.slice(path.length),
        },
      },
    },
  };
});
