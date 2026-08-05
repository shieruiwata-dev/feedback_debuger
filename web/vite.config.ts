import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Lovable は標準的な Vite プロジェクトとしてビルドするため、
// ここには Lovable 固有のプラグイン/設定を入れない。
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
  build: { outDir: "dist", sourcemap: false },
});
