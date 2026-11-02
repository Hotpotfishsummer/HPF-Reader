# 依赖库可行性实测（libprobe）

> 2026-11-03 · Lead 亲自跑，不是查文档
> 目的：在派发 M5-4 之前确认「纯 Go 确定性层」真的成立，避免 teammate 卡在依赖问题上。

## 结论：三个库都能用，但**有一个必须改导入路径**

| 库 | 文档写的导入路径 | **实际可用的路径** | 状态 |
|---|---|---|---|
| OpenCC | `github.com/longbridge/opencc` | **`github.com/longbridgeapp/opencc`** | ⚠️ 必须改 |
| go-pinyin | `github.com/mozillazg/go-pinyin` | 同左 | ✅ |
| smetrics | `github.com/xrash/smetrics` | 同左 | ✅ |

### 那个坑：README 写错了

README 的 Installation 段写 `go get github.com/longbridge/opencc`，但**实际会失败**：

```
go: github.com/longbridge/opencc@latest (v0.3.13) requires github.com/longbridge/opencc@v0.3.13:
    parsing go.mod: module declares its path as: github.com/longbridgeapp/opencc
            but was required as: github.com/longbridge/opencc
```

仓库 2024-12 改名为 `longbridge/opencc`，但 `go.mod` 里的 module path 还是旧的 `longbridgeapp`。
**Go 要求导入路径与 module 声明一致**，所以只能用旧路径。这是仓库自身的不一致，不是我们配错。

## 实测输出（原始，未加工）

```
opencc t2s: 伊丽莎白与达西
pinyin 伊丽莎白: [[yi] [li] [sha] [bai]]
pinyin 伊莉莎白: [[yi] [li] [sha] [bai]]
jaro(郝思嘉,斯嘉丽): 0.6296296296296297
jaro(伊丽莎白,伊莉莎白): 0.8333333333333334
```

## 这些数字证明了什么（重要）

### 1. 繁简归一生效
`伊麗莎白` → `伊丽莎白`。跨繁体/简体版本的书可以归一到同一实体。

### 2. **拼音 key 才是抓「同音异形」的真正机制，不是编辑距离**

这条推翻了我原先对阈值设定的直觉：

| 对 | Jaro-Winkler | 拼音 key | 结论 |
|---|---|---|---|
| 伊丽莎白 vs 伊莉莎白 | **0.8333** | `yilishabai` **完全相同** | 该合并，靠拼音 |
| 郝思嘉 vs 斯嘉丽 | 0.6296 | `haosijia` vs `sijiali` 不同 | 不该合并 |

**关键**：0.8333 **低于**常见阈值 0.85。如果只用编辑距离 + 0.85 阈值，`伊丽莎白` 和 `伊莉莎白` **会被漏掉**——
而它们恰恰是必须合并的同一人。反过来，0.6296 也确实低于阈值（`郝思嘉`/`斯嘉丽` 不合并是正确的，字符串法本来就做不到归化译名）。

**所以正确顺序是**：拼音 key 精确匹配（强信号，必合）→ 编辑距离只在拼音不同时作为**弱信号**兜底，且阈值要谨慎（0.85 会漏掉 0.8333 这种真阳性）。

### 3. 归化译名确认做不到
`郝思嘉` vs `斯嘉丽` 是《飘》的两个中译名，字符串层面无任何关系（拼音、字形、编辑距离都不同）。
**这类只能靠 LLM 或人工**，规划里已经如实写明，不假装能自动。

## 对 M5-4 的具体要求

1. 导入路径用 `github.com/longbridgeapp/opencc`，**不要**用 README 写的那个
2. 聚类顺序：**拼音 key 精确匹配优先**，编辑距离作为弱信号兜底
3. 编辑距离阈值不要硬编码 0.85——实测 0.8333 是真阳性，会被漏掉
4. 郝思嘉/斯嘉丽这类**断言「不合并」**，不要写成「合并失败」

## 复现方式

```powershell
cd spikes/libprobe
go run main.go
```

## 未验证

- 只在 Go 1.26 + Windows 上跑过；Linux/Android 交叉编译未测（纯 Go 库理论上没问题，但**没测**）
- OpenCC 词典是 embed 进二进制的，**会增大体积**——未测具体增量
- `go-pinyin` 对多音字的处理未测（人名常有多音字，如「单」「解」「查」）
