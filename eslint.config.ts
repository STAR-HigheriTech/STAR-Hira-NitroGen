/**
 * 只保留**能真正执行**的规则。
 *
 * 这里曾经挂着两条自定义规则（`no-string-ipc` / `no-hardcoded-color-or-spacing`），
 * 但它们一直是 `off`，而且按"任意字符串字面量"匹配：真源 `ipc-channels.mjs` 自己、
 * 测试夹具、`hira://shared/*` 资源 URL 全部会命中 —— 一旦打开就是几百条噪音，
 * 所以从来没人敢开。与其留个假承诺，不如删掉：IPC 通道的唯一真源由
 * `packages/shared-types/src/ipc-channels.mjs` 约束，z-index / 页面模块 / 分层
 * 各自有 `scripts/check-*.cjs` 在做真检查。
 */
import type { Linter } from 'eslint'

const config: Linter.Config[] = [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/out/**", "**/build/plugins/**", "**/external/**", "**/.tmp/**"]
  },
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      "no-var": "error",
      "prefer-const": "error"
    }
  }
]

export default config
