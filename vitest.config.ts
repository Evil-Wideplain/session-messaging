import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 这些用例会开真实 socket / 命名管道，并断言「单属主」「30s 空闲超时」等
    // 与进程级资源相关的语义；并行跑不同文件会互相干扰时序，保持串行。
    fileParallelism: false,
  },
})
