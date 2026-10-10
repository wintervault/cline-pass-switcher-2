import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5173,
    // 开发期把 API 请求代理到后端；生产环境同源，无此需求
    proxy: {
      '/api': 'http://127.0.0.1:3123',
      '/v1': 'http://127.0.0.1:3123',
    },
  },
});
