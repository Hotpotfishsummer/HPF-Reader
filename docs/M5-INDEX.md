# M5 规划与交付总览（索引）

> 状态：**已全量交付并通过端到端实测验证** ｜ 接口契约：`api/openapi.yaml`
> 本文件是 M5 相关文档的**索引与最终交付状态**。

## 文档地图

| 文档 | 内容 | 状态 |
|---|---|---|
| [`M5-PLAN.md`](M5-PLAN.md) | 主规划：现状盘点、LLM 接入、翻译流水线、人名归一化、书源、任务分解、成本分析 | ✅ 核心已落地 |
| [`M5-PLAN-APPENDIX.md`](M5-PLAN-APPENDIX.md) | 术语表与同步通道接法、聚类算法、LLM 歧义裁决成本对比 | ✅ 已落地 |
| [`M5-PLAN-LEGAL-CORRECTION.md`](M5-PLAN-LEGAL-CORRECTION.md) | **书源方案法律修正**（全面废弃通用抓取规则引擎，只做 OPDS 开放协议） | ✅ 已生效 |
| [`M5-PLAN-RESEARCH-INTEGRATION.md`](M5-PLAN-RESEARCH-INTEGRATION.md) | 整合 80 号调研：修正日志、译后扫描、库选型核实 | ✅ 已落地 |
| [`research/80-entity-normalization.md`](research/80-entity-normalization.md) | 人名归一化调研（769 行，断言带来源） | 📚 参考基线 |
| [`research/85-zlib-legal-and-plugin.md`](research/85-zlib-legal-and-plugin.md) | Z-Library 法律现状 + 书源合规设计（503 行） | 📚 参考基线 |

## 核心架构决策落地总结

1. **LLM 网关与提供商**：兼容 OpenAI API 规范，支持 DeepSeek flash、原生 OpenAI 及本地 Ollama。真模型 `liveai` 标签实测验证通过。
2. **双维度成本与配额闸门（M5-1）**：`calls`（防刷）+ `tokens`（防烧钱）双维度原子预扣与结算，超额报 429 `quota_exceeded` 并明确指出超限维度与重置时间。
3. **后台翻译真执行与断点续跑（M5-2）**：按章分块（~6000 token），Postgres `SKIP LOCKED` 抢占队列，块级幂等与上下文贯通；配额耗尽置为 `paused`（保留已翻块）而非 `failed`。
4. **术语表服务端权威与同步（M5-3）**：术语表落库至 `glossaries` / `glossary_terms` 表，写入同时分发至 `change_log` 的 `book_config` 通道漫游到多设备，版本号自增以保证译文缓存有效。
5. **确定性人名归一化与修正日志重放（M5-4）**：基于 OpenCC 繁简转换、变音符号消除、尊称剥离、拼音与 Jaro-Winkler 聚类；用户手动 merge/split/rename/alias/lock 存为 append-only 事件日志，重跑流水线不冲掉用户确认。
6. **OPDS 合规书源（M5-5）**：仅抓取带有 `http://opds-spec.org/acquisition/open-access` 关系的开放资源；严苛的 SSRF 与 DNS 重绑定防护（全候选 IP 校验 + 预检拨号绑定）。
7. **客户端翻译交互与双语对照（M5-7）**：划词流式气泡（可取消）、整书翻译状态轮询与进度抽屉、配额 429 精确提示、分章节对照/仅看译文/导出 Markdown。
8. **术语表客户端对齐与归一化 UI（M5-8）**：客户端串行 commit 队列防并发乱序，离线 stale 保护，前端术语表管理支持用户手动修正操作及服务端同步。

## 任务交付清单

| 任务 | 内容 | 状态 | 对应提交与证据 |
|---|---|---|---|
| task-19 | M5-1 成本与配额闸门（双维度原子预扣） | ✅ 已完成 | `399d219` / `apps/server/STATUS.md` §7 |
| task-20 | M5-2 后台任务真执行（整书翻译+断点续跑+译后扫描） | ✅ 已完成 | `cb5986c` / `apps/server/STATUS.md` §1 |
| task-21 | M5-5 OPDS 书源（标准协议 + open-access 判据 + SSRF加固） | ✅ 已完成 | `6587526` / `apps/server/STATUS.md` §8 |
| task-22 | M5-3 术语表服务端化（双写权威表+同步日志） | ✅ 已完成 | `6587526` / `apps/server/STATUS.md` §9 |
| task-23 | M5-4 人名归一化一期（确定性聚类+事件日志重放） | ✅ 已完成 | `6587526` / `apps/server/STATUS.md` §9 |
| task-24 | M5-7 翻译 UI（划词流式/整书进度/配额429/双语对照） | ✅ 已完成 | `50af761` / `tests/evidence/client/task-23-*` |
| task-25 | M5-8 术语表客户端（串行 commit 队列/归一化 UI/离线保护） | ✅ 已完成 | `3dd36ab` / `tests/evidence/client/task-24-*` |
| task-26 | 真模型端到端实测验证（`liveai` 标签实测） | ✅ 已完成 | `888a7c8`, `b42b89e`, `2916e60` / `STATUS.md` §10 |
