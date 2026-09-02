import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    environment: 'node',
    // .tsx 是 renderer 组件行为测试（F5/D3，M34）：全局仍 node，组件文件按文件切 happy-dom
    // （文件顶部 `// @vitest-environment happy-dom` 注释声明），其余测试零环境开销。
    include: ['tests/**/*.test.{ts,tsx}'],
    // PR #29 CI：vitest 跑在 Electron-as-node 运行时里，文件级并行时多个 worker 竞争
    // vite-node 的 /tmp ssr 模块缓存（Electron 补丁过的 fs 加剧竞态），偶发整片 ENOENT
    // 把 run 拱红（零断言失败也 exit 1）。串行化文件消除跨 worker 缓存竞争，CI 时长可接受。
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/main/brain/**/*.ts'],
      thresholds: {
        lines: 80,
      },
      reporter: ['text', 'text-summary'],
    },
  },
});
