# 前端（Vue 3 + TypeScript + Vite）

HPF-Reader 的前端：Vue 3 `<script setup>` SFC + TypeScript + Vite 8 + Tailwind 4 +
Pinia + vue-router + vue-i18n。阅读内核是 vendored 的 foliate-js（见
`src/vendor/foliate-js/VENDOR.md`）。

## 开发与测试管线

**完整管线（环境、测试、构建、性能门控、排障）见仓库根的
[`apps/client/STATUS.md` §3](../STATUS.md#3-开发测试与编译调试管线windows--powershell)**。
最常用的几条：

```powershell
corepack pnpm install
corepack pnpm run dev            # 热重载 → http://127.0.0.1:9245/#/reader/sample

corepack pnpm exec vue-tsc --noEmit   # 类型检查
corepack pnpm run test                 # vitest 单元测试
corepack pnpm run test:e2e             # Playwright E2E（真实 Chrome，自动起 preview :4173）

corepack pnpm run build                # 生产构建 → dist/
```

> 性能测量台（`e2e/perf-*.spec.ts`）默认跳过，需 `HPF_PERF=1` 才跑。
> 前端产物会被 `main.go` 的 `//go:embed all:frontend/dist` 嵌入桌面 exe，
> 改前端后要让桌面应用生效必须重编 exe——见 STATUS.md §3.3。

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)
  (and disable Vetur) + [TypeScript Vue Plugin (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.vscode-typescript-vue-plugin).

## Type Support For `.vue` Imports in TS

TypeScript cannot handle type information for `.vue` imports by default, so we replace the
`tsc` CLI with `vue-tsc` for type checking. In editors, we need
[TypeScript Vue Plugin (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.vscode-typescript-vue-plugin)
to make the TypeScript language service aware of `.vue` types.

If the standalone TypeScript plugin doesn't feel fast enough to you, Volar has also implemented
a [Take Over Mode](https://github.com/johnsoncodehk/volar/discussions/471#discussioncomment-1361669)
that is more performant. You can enable it by the following steps:

1. Disable the built-in TypeScript Extension
   1. Run `Extensions: Show Built-in Extensions` from VSCode's command palette
   2. Find `TypeScript and JavaScript Language Features`, right click and select `Disable (Workspace)`
2. Reload the VSCode window by running `Developer: Reload Window` from the command palette.
