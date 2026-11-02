
---

## 11. 术语表与同步通道的接法（技术细节，已核实）

**结论：术语表可以直接复用现有同步通道，不需要新造。** 依据是 `book_config` 这个先例。

### 11.1 关键代码事实

`internal/sync/engine.go:18` 定义了实体枚举，`:220` 注释写明：

    book_config 只写 change_log（不进 uuid 列，键名可以是任意配置键），
    其余实体的 entityId 都是 uuid 主键。

`ValidateOp`（`:222-249`）对 `book_config` **豁免了 UUID 校验**（`:237` 的 `op.Entity != EntityBookConfig`）。

### 11.2 这给我们什么

术语条目天然是「字符串键 → 字符串值」，**不是 UUID 实体**。所以术语表应该走 `book_config` 的路子：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A（推荐）** | 复用 `book_config`，entityId 用 `glossary:<bookId>:<normalizedKey>` | **零新增同步代码**；HLC 合并、remove-wins 墓碑全部白拿 |
| B | 新增 `EntityGlossary` 枚举 | 要改 `ValidateOp`、merge 分派、RLS、客户端 apply 逻辑，**四五个地方都要动** |

**选 A**。理由：术语表的冲突语义和 `book_config` 完全一致（字段级 LWW + remove-wins），没有理由造新实体。

### 11.3 但表还是要建

同步只负责**下发变更**，服务端仍需要本地表来支撑：
- 按 book 查全量术语（翻译时要一次性取全，不能翻 change_log）；
- 按 key 查单个（人工确认时）；
- 记录来源（auto 抽取 / confirmed 人工确认）；
- `glossaryVersion` 用于译文缓存键。

所以：**新表 `glossaries` + `glossary_terms` 存权威值，任何写入同时 `AppendServerChange` 写 change_log**（和现有 REST 写标注的做法一致，`STATUS.md:111` 有记录）。

### 11.4 表设计草案

    CREATE TABLE glossaries (
        id         UUID PRIMARY KEY,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        book_id    UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        target_lang TEXT NOT NULL,
        version    BIGINT NOT NULL DEFAULT 0,  -- 每次术语变更 +1，用于译文缓存键
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX glossaries_user_book_lang_idx ON glossaries(user_id, book_id, target_lang);

    CREATE TABLE glossary_terms (
        glossary_id  UUID NOT NULL REFERENCES glossaries(id) ON DELETE CASCADE,
        key          TEXT NOT NULL,       -- 归一化后的原文键，如 'darcy'
        display      TEXT NOT NULL,       -- 展示用原文，如 'Mr. Darcy'
        target       TEXT NOT NULL,       -- 标准译名，如 '达西先生'
        aliases      TEXT[] NOT NULL DEFAULT '{}',  -- 别名集合
        source       TEXT NOT NULL DEFAULT 'auto',  -- auto|confirmed
        hlc          TEXT NOT NULL,
        PRIMARY KEY (glossary_id, key)
    );

**为什么 `aliases` 用数组而不是子表**：别名数量很少（通常 <5），读的时候总是整组读，数组更省一次 join。**这是取舍不是教条**——如果以后要做「按别名反查」，再加 GIN 索引。

### 11.5 归一化键怎么算（确定性，纯函数，可单测）

    key = lowercase(
        strip_punctuation(
            strip_honorific(      // Mr./Mrs./Dr./Miss/Sir/Lady/...
                strip_diacritics(nfc(form))
            )
        )
    )

**必须写成纯函数并单测**，因为它是聚类的地基：同一人物在不同上下文被算成不同 key，整个归一化就废了。

### 11.6 聚类算法（确定性部分，零 LLM 成本）

输入：一批 (form, count) 候选。输出：分组。

1. **完全相同 key** → 同组（必然）；
2. **全名包含短名**：`fitzwilliam darcy` 的 token 集合 ⊇ `darcy` 的 → 同组（姓氏匹配）；
3. **编辑距离 ≤ 阈值**（按长度自适应：长度 5-8 允许 1，9+ 允许 2）→ 候选同组，**标记为「需确认」**；
4. **首字母 + 后缀**（`lizzy`/`eliza` 这类昵称）→ **不做自动合并**，只标为「疑似」，交 LLM 或人工。

**为什么昵称不自动合并**：`Lizzy`/`Eliza`/`Beth` 都是 Elizabeth 的昵称，但 `Beth` 也可能是独立人名。自动合并会产生**无法回退的错误**（用户看到两个人被合成一个会失去信任）。标为「疑似」让用户确认是正确做法。

### 11.7 LLM 只做「歧义裁决」

输入：一个「疑似组」的全部形式 + 各形式的一个原文例句。
输出：`{"same": true/false, "canonical": "...", "target": "..."}`。

**成本对比**（同样 30 万字书）：

| 做法 | 输入 token | 说明 |
|---|---|---|
| 全文抽取（每章都问） | ~40 万 | 贵，且跨块不一致 |
| **只裁决歧义组** | **~2 万** | 便宜 20 倍，且判断质量更高（有例句上下文） |

**这就是为什么先做确定性聚类**：把 90% 的合并用零成本做完，只把真正需要语义判断的 10% 交给模型。
