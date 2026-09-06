import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // categoryStore 依赖 localStorage（zustand persist），用 jsdom 提供
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
