import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    // 单测全部 mock fetch，不打真实网关、不消耗额度
    setupFiles: ['server/test/setup.ts'],
  },
});
