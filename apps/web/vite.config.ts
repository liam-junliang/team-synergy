import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  appType: 'spa',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // 页面使用正常路径；接口统一放在 /api，避免 /projects、/teams 冲突。
    proxy: {
      '^/api(?:/|$)': {
        target: process.env.ACP_CORE_API_URL ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api(?=\/|\?|$)/, '') || '/',
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
