import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, "pages-reader"),
  base: "./",
  publicDir: path.join(root, "pages-reader", "public"),
  build: {
    outDir: path.join(root, "pages-reader", "dist"),
    emptyOutDir: true,
  },
  server: { fs: { allow: [root] } },
});
