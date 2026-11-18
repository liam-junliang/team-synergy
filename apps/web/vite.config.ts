import { defineConfig, type Connect } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { webSecurityHeaders } from './security-headers.mjs';

const encodeAgentGuide: Connect.NextHandleFunction = (request, response, next) => {
  const pathname = request.url?.split('?', 1)[0] ?? '';
  if (/^\/agent\/guide\.(zh-CN|en-US)\.md$/.test(pathname)) {
    response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  }
  next();
};

export default defineConfig({
  appType: 'spa',
  plugins: [react(), tailwindcss(), {
    name: 'agent-guide-encoding',
    configureServer(server) { server.middlewares.use(encodeAgentGuide); },
    configurePreviewServer(server) { server.middlewares.use(encodeAgentGuide); },
  }],
  server: {
    port: 5173,
    headers: webSecurityHeaders({ development: true }),
    // 页面使用正常路径；接口统一放在 /api，避免 /projects、/teams 冲突。
    proxy: {
      '^/api(?:/|$)': {
        target: process.env.ACP_CORE_API_URL ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api(?=\/|\?|$)/, '') || '/',
      },
    },
  },
  preview: { headers: webSecurityHeaders() },
  build: {
    outDir: 'dist',
  },
});
