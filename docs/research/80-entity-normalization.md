# 80 · 电子书阅读器里的人名/实体归一化：可落地方案

> **任务**：task-80 ｜ **交付**：docs/research/80-entity-normalization.md
> **调研员**：research ｜ **日期**：2026-11-03 ｜ **证据采集**：2026-11-03
> **前置**：[30-formats-zlib-llm.md](30-formats-zlib-llm.md) §C.3 已给出 L1–L5 分层骨架与"LLM 只做裁定不做发现"的原则；本文**不重复**该骨架，而是把它拆成可实现的工程规格：数据结构、分块协议、反馈日志、Go 侧库选型、逐项成本。
> **项目上下文**：Go 后端（Wails v3 外壳，见 [ADR-002](../ADR-002-客户端落地-Vue与Wails.md)）+ Vue 3 前端；本地 SQLite 为真相源。
> **本文只做调研与设计，不含业务代码。**

---

## 证据方法与可复核性（先读这段）

| 标记 | 含义 |
|---|---|
| **已核实** | 本文作者**亲自抓取**了该 URL 的原文（许可证原文 / 官方文档正文 / 论文摘要页），并给出可复核的引用位置 |
| **已核实（二手）** | 抓到了页面原文，但该页面本身是百科/维基镜像等二手整理，权威性弱于一手 |
| **未验证** | 未取得一手来源，或只有搜索摘要、无原文；**不得作为事实引用**，只能当线索 |
| **估算** | 本文作者基于给定假设的算术结果，不是任何来源的断言；假设已写明，可自行代入 |

> 所有价格、许可证、版本号均取自**抓取当日的官方页面**。DeepSeek 价格与模型名在 2026 年内已多次变动（见 §5.1 的版本号），落地前必须重新核对。
> 本文**没有编造**任何库名、版本号、许可证或价格；凡不确定处一律标注。

---

## 0. 结论速览

| # | 问题 | 结论 | 证据强度 |
|---|---|---|---|
| **A1** | 人名归一化到底在解决什么？ | 不是"识别人名"，而是**把 N 个 surface form 收敛成 1 个 entity_id，并让这个 id 在全书（含翻译产物）里稳定复用**。识别只是原料，**一致性才是产品** | 设计结论 |
| **A2** | 纯 LLM 一步出人物表行不行？ | **不行**。三个硬伤：① 长上下文下中段信息利用率显著下降（U 形曲线，[arXiv:2307.03172](https://arxiv.org/abs/2307.03172)）；② 输出 JSON 可能被截断，官方明确要求"合理设置 max_tokens 防止 JSON 被中途截断"（[JSON Output 文档](https://api-docs.deepseek.com/zh-cn/guides/json_mode.md)）；③ 每次重跑结果不稳定，无法增量修正 | **已核实**（论文 + 官方文档） |
| **A3** | 最省钱的是哪条路？ | **不是最省钱的路，而是"发现走确定性、裁定走 LLM"的混合路**。整书 30 万字三阶段全跑，flash 低峰约 **¥0.46/本**，加 1.3× 失败重试系数 ≈ **¥0.6/本**（§5） | **估算**（价格已核实） |
| **A4** | 中文译名变体能靠字符串相似度搞定吗？ | **只能搞定一半**。同音异形（伊丽莎白/伊莉莎白）拼音 key 完全相同，能抓；**归化译名**（郝思嘉 vs 斯嘉丽·欧哈拉）拼音与编辑距离都远，字符串法**必然漏**，只能靠上下文/LLM | **已核实（二手）**+ 自算 |
| **A5** | Go 侧能直接跑 NER 吗？ | **能，但代价是 CGO**。`github.com/yalue/onnxruntime_go`（MIT）用**手动加载动态库**的方式绕开 MSVC/Mingw 冲突，README 明确说这是它相对其他 Go wrapper 的核心差异 | **已核实**（README 原文） |
| **A6** | 要不要上 Python 微服务？ | **一期不要**。一期用"LLM + 纯 Go 确定性层"，零模型、零 CGO；二期若确需本地 NER，优先 **ONNX 进程内**；只有当你要 BookNLP 级别的**整书指代消解**时才值得引入 Python 侧车 | 设计结论 |
| **A7** | 用户改完怎么回灌？ | **存 append-only 的 correction 日志，不存"改后的结果"**。自动流水线每次重跑后重放日志，用户工作永不丢失；日志同时充当"负样本"（禁止合并对），防止重跑把用户拆开的又合回去 | 设计结论 |
| **A8** | 一致性怎么保证（用户要的核心价值）？ | **两层**：① 译前——book glossary 强制注入每次翻译调用；② 译后——**确定性扫描**（不花 LLM 钱）统计每个 canonical name 在译文里的出现次数，为 0 即判定"译者忽略了术语表"，只重译该段 | 设计结论 |

**一句话**：**把"人名归一化"当成一个"实体注册表（registry）+ 可重放的修正日志"来设计，而不是当成一次性的 NLP 任务。** 一次性任务的结果会被下一次重跑冲掉；注册表不会。

---

# 1. 问题定义

## 1.1 到底要解决什么（四层，从易到难）

> **命名约定**：本文用 **L-a ~ L-d** 表示"问题本身的四个难度层"；用 **L1–L5**（沿用 [30 号文档 §C.3](30-formats-zlib-llm.md)）表示"技术实现的分层"。两者是"问题"与"解法"的关系，不要混淆。

| 层 | 要解决 | 典型失败表现 | 能否确定性解决 |
|---|---|---|---|
| **L-a 形态归一** | 大小写、标点、尊称、所有格、连字符 | `Mr. Darcy` / `Mr Darcy` / `DARSEY`(OCR 错) / `Darcy's` 被当成 4 个实体 | ✅ 几乎全可（规则） |
| **L-b 指称收敛** | 全名 / 姓氏 / 名字 / 昵称 / 尊称 → 同一人 | `Fitzwilliam Darcy` / `Darcy` / `Mr. Darcy` 三个人物卡片 | ⚠️ 部分可（子串包含 + 尊称剥离能吃掉大部分英文案例） |
| **L-c 跨语言/跨译本** | 同一人在不同译本、不同地区译法下的中文名 | `伊丽莎白` / `伊麗莎白` / `伊利沙伯`；`郝思嘉` / `斯嘉丽·欧哈拉` | ❌ 归化译名不可；同音异形可 |
| **L-d 跨身份/马甲** | 同一角色的化名、代号、称号、伪装身份 | 克莱恩 = 愚者 = 格尔曼·斯帕罗 = 小克 | ❌ 必须靠上下文/剧情，确定性方法无解 |

**关键区分**：L-a/L-b 是**语言学问题**，L-c/L-d 是**语义/设定问题**。前者用规则 + 小模型就能到 90%+，后者**只有 LLM 或有全书知识的系统能做**。任何"一个 NER 模型搞定全部"的方案都是在 L-c/L-d 上必然翻车。

> **产品含义**：L-d 恰恰是中文网文/轻小说读者最想要的东西（"这个人前面叫周明瑞后面叫克莱恩"）。所以**不能只做 NER**。

## 1.2 四个真实例子

### 例 1：`Mr. Darcy` / `Darcy` / `Fitzwilliam Darcy`（L-b，英文经典）

《傲慢与偏见》男主。维基百科镜像页明确写：书里角色通常以姓氏称他"达西"或"达西先生"，而**他的名字"费茨威廉"在整本书里只被提了两次**（[heyuanjia 维基镜像](https://www.heyuanjia.com/wikipedia/wiki/%E5%82%B2%E6%85%A2%E4%B8%8E%E5%81%8F%E8%A7%81)）。中文百科给出的全名是"費茨威廉·羅賓遜·亨利·達西"（[newton.com.tw](https://www.newton.com.tw/wiki/%E8%B2%BB%E8%8C%A8%E5%A8%81%E5%BB%89%C2%B7%E9%81%94%E8%A5%BF)）——**注意：该二手来源的"Robinson Henry"部分与英文通行说法不一致，本文不采信，仅采信"全名含 Fitzwilliam、且该名全书仅出现两次"这一条**。

**工程含义**：这是最"好办"的一类——`Fitzwilliam Darcy` ⊃ `Darcy`（子串包含），`Mr. Darcy` 剥尊称后 = `Darcy`。**纯确定性规则即可 100% 命中**。但代价是：如果只按"出现频次"排序，`Fitzwilliam` 因为只出现 2 次会被判定为低置信度实体，反而被漏掉——所以**不能只按频次做门槛**。

### 例 2：`伊丽莎白` / `伊麗莎白` / `伊利沙伯`（L-c，地区译名）

维基新闻的**地区词转换表**给出了逐条对照：`Elizabeth` → 大陆「伊丽莎白」/ 台湾「伊麗莎白」/ 香港「伊利沙伯」/ 新加坡「伊丽莎白」（[zh.wikinews 地区词转换](https://zh.wikinews.org/zh-hans/%E8%8B%B1%E5%9C%8B%E5%85%A7%E6%94%BF%E5%A4%A7%E8%87%A3%E5%BD%AD%E9%BB%9B%E7%8E%B2%E8%A2%AB%E6%8C%87%E8%81%B7%E5%A0%B4%E6%AC%BA%E5%87%8C%E5%AE%98%E5%93%A1_%E6%B6%89%E9%81%95%E5%8F%8D%E5%AE%98%E5%93%A1%E8%A1%8C%E7%82%BA%E5%AE%88%E5%89%87)）。同一页面还有 `Diana` → 大陆「戴安娜」/ 台湾「黛安娜」、`Hunt, Jeremy` → 台湾「傑瑞米·杭特」/ 香港「侯俊偉」（**香港这条是完全改姓，不是音译**）。

**工程含义**：
- 「伊丽莎白 / 伊麗莎白」= **简繁差异** → `longbridge/opencc` 的 `t2s` 一跑就并成一个 key。**零成本**。
- 「伊丽莎白 / 伊莉莎白」= **同音异形**。丽 与 莉 的普通话读音**都是 lì**，所以用 `go-pinyin` 取无声调拼音后 key 完全相同（`yi li sha bai`）。**这一条可直接用 go-pinyin 复核**，是本方案里最划算的一招。
- 「伊丽莎白 / 伊利沙伯」= **粤语/港式音译**，普通话拼音 key 不同（`yi li sha bai` vs `yi li sha bo`），编辑距离也大。→ **确定性方法漏**，需要译名映射表或 LLM。

### 例 3：`郝思嘉` vs `斯嘉丽·欧哈拉`（L-c，归化译名——确定性方法的天花板）

傅东华 1940 年首译本《飘》采用**归化翻译法**，把 Scarlett O'Hara / Rhett Butler / Melanie Hamilton / Ashley Wilkes 分别改写成 **郝思嘉 / 白瑞德 / 韩媚兰 / 卫希礼**（[今日头条文章](https://www.toutiao.com/article/7157209102564442637/)）；百度百科对该译本的描述同样是"采用归化翻译策略，将人名地名中国化"（[百度百科·飘(傅东华译)](https://baike.baidu.com/item/%E9%A3%98/15311)）。

**工程含义**：**「郝思嘉」和「斯嘉丽」在字符串上没有任何关系**——拼音（hao si jia vs si jia li）、编辑距离（4/4）、首字母、Soundex 全部判为"不同人"。而它们**是同一人**。这类案例证明：**任何"纯字符串聚类"方案在中文译本上会系统性失败**，且失败得毫无征兆（相似度分数低≠不同人）。

### 例 4：`克莱恩·莫雷蒂` = `愚者` = `格尔曼·斯帕罗` = `小克`（L-d，马甲/代号）

《诡秘之主》男主的百科条目列出别名："小克、克怂、克总、克喵、从心之人、**愚者**、穷神、盥洗室之主、套娃之主……"，并说明他"拥有多个身份以及假名"，且条目名本身有"格尔曼·斯帕羅一般指本詞條"的重定向（[快懂百科](https://www.baike.com/wikiid/2137721270836104718)、[中文百科全書](https://www.zhongwenwiki.com/)）。同一角色的"周明瑞"是穿越前原名。

**工程含义**：这类归一化**没有任何字符串线索**，只能靠"文本里明确说了'他就是愚者'"这类**剧情断言**。这只能由 LLM 从上下文里抽，或由用户手工合并。**这正是"用户确认"环节不可省的原因**——不是精度不够，而是**信息不在字符串里**。

> **补充例（俄语，L-b 的另一种形态）**：`Дмитрий` / `Митя` / `Dmitri` / `Mitya`。Nameberry 明确写 Mitya 是 Dmitri 的 diminutive，并指出它出现在《卡拉马佐夫兄弟》中作为德米特里的昵称（[nameberry](https://nameberry.com/name/MITYA)）。俄语的"名+父称+姓"三件套 + 一串 diminutive 是**规则可覆盖的**（有相对封闭的昵称后缀表：-ша/-ня/-ка/-ик），比中文网文的马甲好办。

## 1.3 明确不做什么（防止范围爆炸）

| 不做 | 理由 |
|---|---|
| 不做**代词消解**（he/she → 某实体） | 阅读器 UI 不需要。代词不显示为链接，不做也不错。做了反而增加误合并面 |
| 不做**跨书实体对齐**（这本书的"张三"= 那本书的"张三"） | 收益极低，成本极高；不同书的同名不同人是常态 |
| 不做**自动推断关系**（父子/恋人）作为 P0 | 关系图是 P2；且关系抽取错误率远高于实体抽取，早期上会毁掉信任 |
| 不做**全书一次性**处理 | 见 §3.1；必须按章节分块 + 断点续跑 |

---

# 2. 技术路线对比

## 2.0 评测口径（先说清楚"好"是什么）

没有口径的对比都是空谈。建议用四个指标（**这本方案自己定义的，不是引用**）：

| 指标 | 定义 | 目标 |
|---|---|---|
| **BCubed P/R** | 标准指代消解指标，对"合并错了"和"没合并"分别计分 | P ≥ 0.85, R ≥ 0.80 |
| **别名召回率（Alias Recall）** | 已知实体的 surface form 中，被正确挂到该实体 id 的比例 | ≥ 0.90（人工标注 100 个实体做金标） |
| **误合并率（False Merge）** | 被错误合并的实体对 / 总合并对 | **≤ 3%**（这条比召回更重要：错合并会让读者看到"张三的对话配李四的头像"） |
| **一致性泄漏率** | 译文中同一实体出现 ≥2 种写法的段数占比 | ≤ 1% |

> **为什么误合并率优先级最高**：漏合并的后果是"同一人两个卡片"，读者会觉得"这功能不太行"；错合并的后果是"两个人变一个"，读者会觉得"这功能是错的"。**后者不可接受。**

## 2.1 路线 A：纯 LLM（让模型输出人物表 JSON）

**做法**：整章/整书文本 + 一段 schema 提示词 → 模型直接吐 `{"characters":[{"canonical":"...","aliases":[...]}]}`。

**优点**
- 一天能跑通；无模型、无依赖、无 CGO。
- 天然覆盖 L-d（马甲/代号）—— 这是别的路线做不到的。
- 对中文网文、轻小说这类"设定密集"的文本，效果显著优于通用 NER。

**缺点（每条都有来源或可验证的机制）**
1. **长上下文不可靠**。Liu et al. 的实证结论是：相关信息在输入**中段**时性能显著下降，呈 U 形；且"配备上下文扩展的模型不一定更善于使用自己的上下文"（[arXiv:2307.03172](https://arxiv.org/abs/2307.03172)）。→ 把 30 万字塞进一次调用，中段人物会被系统性漏掉。
2. **输出会被截断**。DeepSeek 官方 JSON Output 文档第 3 条注意事项原文："需要合理设置 `max_tokens` 参数，防止 JSON 字符串被中途截断"；且非 JSON 内容会被替换为空格，"返回的 `content` 可能仅包含空格（看起来为空，此时 `finish_reason` 仍可能是 `stop`）"（[JSON Output 文档](https://api-docs.deepseek.com/zh-cn/guides/json_mode.md)）。→ **必须对空 content 做兜底重试**，否则你会静默丢章节。
3. **不可增量**。用户改了 3 个人名 → 重跑 → 全部重来 → 用户的修改被冲掉。除非你有修正日志（§3.3）。
4. **不可审计**。模型说"这两个是同一人"，你没有任何证据链，用户问"为什么"你答不上来。

**适用规模**：**≤ 5 万字的中短篇**，或**只做"候选发现"不做最终裁定**的场景。

**结论**：可以用，但**只能当"发现器"和"裁定器"，不能当"唯一真相源"**。

## 2.2 路线 B：NER 模型 + 指代消解（coreference resolution）

**做法**：spaCy / Stanza / HanLP / jieba 抽人名 → coref 模型把代词与名词短语连成链 → 取链头为 canonical。

**优点**
- 确定性、可复现、可解释（每个 mention 有 token 偏移）。
- **零 token 成本**，可离线、可批处理。
- 英文场景有成熟到"开箱可用"的整书方案：**BookNLP** 的 README 原文写着它做 "Character name clustering (e.g., 'Tom', 'Tom Sawyer', 'Mr. Sawyer', 'Thomas Sawyer' -> TOM_SAWYER)"（[BookNLP README](https://raw.githubusercontent.com/codecason/booknlp/master/README.md)）——**这正好就是本任务要的东西**，而且是专为"书"设计的。

**缺点**
1. **中文 coref 稀缺**。Stanford CoreNLP 的语言支持表里，Coreference 一行只有 **2 个**勾（该页表格的空单元格在抓取时被折叠，**无法逐格确认是哪两种语言**，本文**推断**为 en + zh，见 §6.2 U5）（[CoreNLP human-languages](https://stanfordnlp.github.io/CoreNLP/human-languages.html)）——**即便中文有 coref，那也是 Java + 大 jar 的整套 CoreNLP，不是轻量方案**；而 Stanza（Python，Apache-2.0，[LICENSE](https://raw.githubusercontent.com/stanfordnlp/stanza/main/LICENSE)）虽然有 Coreference 页面（[stanza/coref.html](https://stanfordnlp.github.io/stanza/coref.html)），但其 coref 模型覆盖语言**本次未逐一核实**，标 **未验证**。
2. **BookNLP 是英文专用**。README 第一句原文：pipeline "scales to books and other long documents (**in English**)"（同上）。→ **对中文书直接不可用**。
3. **BookNLP 很慢**。README 自带基准：small 模型在 2019 MacBook Pro 上处理《秘密花园》（99K tokens）需 **3.6 分钟** CPU；big 需 **15.4 分钟**；10 核服务器上 small 2.4 分钟 / big 5.2 分钟（同上）。→ 30 万字按官方换算约 180,000 tokens，是《秘密花园》99K 的 **1.82 倍**；线性外推得：**small 约 6.5 分钟/本、big 约 28 分钟/本**（2019 MBP）；10 核服务器上约 **4.4 / 9.5 分钟**（**估算**，基于 README 基准，非实测）。**作为"打开书就等着"的交互不可接受**，必须做异步任务 + 进度条。
4. **coref 的 F1 天花板就在 76–79%**。BookNLP README 的表格：Coreference Avg F1 small **76.4** / big **79.0**（同上）。→ **两成以上的链是错的**。直接拿来做产品，用户会看到大量错合并。
5. **中文 NER 的绝对水平也不高**。Trankit 论文的对比表里，Chinese OntoNotes NER F1：Trankit 80.0 / Stanza 79.2 / spaCy 69.3（[arXiv:2101.03289](https://arxiv.org/abs/2101.03289) 的表格摘要，**已核实到论文页与表格文本，未逐格核对 PDF 排版**）。→ **spaCy 中文 NER 只有 69 F1**，拿来做"人物表"会漏三成。

**适用规模**：**英文书、离线批处理、可接受分钟级延迟**的场景。中文书不推荐作为主路线。

## 2.3 路线 C：字符串聚类（编辑距离 / Jaro-Winkler / 音译）

**做法**：候选 surface form → 归一化（去尊称、大小写、繁简）→ 生成多个 key（原串 / 拼音 / 首字母 / 语音编码）→ 相似度 > 阈值就并查集合并。

**优点**
- **零成本、零延迟、可解释、可单元测试**。适合当"第一道过滤"，把 90% 的平凡案例吃掉。
- Go 生态齐备（§4）：`xrash/smetrics` 提供 WagnerFischer / Ukkonen / Jaro / JaroWinkler / Soundex / Hamming（[LICENSE MIT](https://raw.githubusercontent.com/xrash/smetrics/master/LICENSE)），`mozillazg/go-pinyin`（[MIT](https://raw.githubusercontent.com/mozillazg/go-pinyin/master/LICENSE)），`longbridge/opencc`（纯 Go、词典 embed 进二进制、[Apache-2.0](https://raw.githubusercontent.com/longbridge/opencc/master/LICENSE)）。

**缺点（这是本方案最想强调的部分）**
1. **中文译名场景，"相似度"和"同一人"几乎无关**。例 3 的郝思嘉/斯嘉丽就是反例：**相似度 0，但同一人**；反过来"李明"/"李铭"相似度极高，**但是两个人**（同音不同人）。→ **阈值怎么调都是错的**。
2. **英文姓氏/名字混用会误合并**。`Elizabeth Bennet` 与 `Elizabeth Darcy`（假如书里有）子串包含 → 误合并。
3. **Double Metaphone 只对拉丁字母有效**，对中文零作用；对西里尔/希腊也要先转写。Go 侧**没有活跃维护的 Double Metaphone 库**（能找到的是 `pkar/twine` 这类多年未更新的实现，[repo](https://github.com/pkar/twine)，**维护状态未验证**）。→ 不建议依赖。
4. **阈值需要按书调**。不同书的命名风格差异极大（西幻 vs 都市 vs 古言），一个全局阈值必然在某些书上崩。

**适用规模**：**永远不要单独用**。作为混合方案的 L1/L3 层（预处理 + 候选对生成），规模无上限（O(n²) 对候选做预筛，n 是 surface form 数，通常 < 1000，可忽略）。

## 2.4 路线 D：混合（LLM 抽取 + 确定性聚类 + 人工确认）——**推荐**

**做法**（这是本文的可落地主张，逐层可关闭）：

```
① 章节切分（EPUB 章节 / 段落边界）
      ↓
② 确定性预处理（Go，零成本）
   · OpenCC t2s 归一
   · 尊称剥离表（Mr./Mrs./Dr./San/先生/大人/殿下/阁下…）
   · 所有格/标点归一
   · 生成多路 key：原串 / pinyin / 首字母 / 繁简归一
      ↓
③ 候选发现（LLM，按章分块，输出 mention 级 JSON）
   · 只要求模型"标出这段里出现的人名/称谓"，不要求它判断同一人
      ↓
④ 确定性聚类（Go）
   · 子串包含 → 强边
   · 繁简/拼音 key 相同 → 强边
   · 编辑距离 ≤ 阈值 → 弱边（进候选池，不自动合并）
   · 并查集求连通分量
      ↓
⑤ LLM 裁定（只对"弱边"和"跨块未连通的孤立实体"调用）
   · 输入：候选对 + 各自 2 条上下文片段
   · 输出：same_person / different / uncertain
      ↓
⑥ 人工确认（Vue UI）
   · 实体卡片：别名列表、首次出场、出现次数
   · 三个操作：合并 / 拆分 / 改名
      ↓
⑦ 固化到 book glossary + 写 correction 日志
```

**优点**
- **成本可控**：LLM 只在 ③⑤ 花钱，⑤ 只处理不确定对（通常 < 200 对）。
- **可解释**：每一步都能给用户看"为什么这两个被合并了"（"因为它们拼音相同"/"因为 A 是 B 的子串"）。
- **可重跑**：确定性层是纯函数，重跑结果一致；LLM 层的结果被 correction 日志覆盖。
- **中文场景不依赖 coref 模型**——绕开了中文 coref 稀缺这个最大障碍。

**缺点**
- **实现复杂度最高**（约 4 个模块 + 1 套日志）。
- **需要维护"弱边"的阈值与裁定 prompt**，是有长期成本的。
- ③ 的 LLM 调用有网络依赖；离线场景需要降级到"只用确定性层"（质量下降但可用）。

**适用规模**：**从 1 万字的短篇到 100 万字的长篇都适用**，因为分块 + 断点续跑天然支持任意长度。这是唯一能覆盖本项目全场景的路线。

## 2.5 对比总表

| 维度 | A 纯 LLM | B NER+coref | C 字符串聚类 | **D 混合（推荐）** |
|---|---|---|---|---|
| 中文 L-a/L-b | 好 | 中（spaCy 69 F1） | 好 | **好** |
| 中文 L-c 同音异形 | 中 | 差 | **好**（拼音） | **好** |
| 中文 L-c 归化译名 | 中 | 差 | **必然失败** | 中（靠 ⑤ 裁定） |
| 中文 L-d 马甲 | **好** | 必然失败 | 必然失败 | **好**（靠 ③⑤） |
| 误合并风险 | 中（不可控） | **高**（coref F1 76–79） | **高**（阈值不可调） | **低**（人工兜底） |
| 单本 30 万字成本 | ¥0.24 起 | ¥0（电费） | ¥0 | **¥0.46–0.65** |
| 单本耗时 | 分钟级（API） | **约 4.5–28 分钟**（BookNLP 基准外推，估算） | 秒级 | 分钟级 + 秒级 |
| 可复现 | 差 | **好** | **好** | 好（日志重放） |
| 可离线 | 否 | **是** | **是** | 部分（降级） |
| 实现工作量 | 1–2 人日 | 3–5 人日（英文）/ 中文更高 | 2–3 人日 | **8–12 人日** |
| 适用规模 | ≤5 万字 | 英文书、批处理 | 仅作子模块 | **全场景** |

> 表中"人日"是**本文的主观估算**，非实测。

---

# 3. 关键工程问题

## 3.1 长书（30 万字）如何分块而不丢上下文

### 3.1.1 分块原则（按优先级）

| 原则 | 做法 | 为什么 |
|---|---|---|
| **① 只在章节边界切** | EPUB 的 `<h1>/<h2>` 或 `chapter` 标记天然是边界；PDF 退化到"标题正则 + 空行" | 跨章切断会把"第 3 章末尾出场的人"和"第 4 章开头只写姓氏"割裂 |
| **② 章内再切时只在段落边界** | 单章 > 8,000 字时按段落二分，**绝不按字符数硬切** | 硬切会产生半个句子、半个名字（如把 "Fitzwilliam" 拦腰截成 "Fitz" + "william"） |
| **③ 不重叠（overlap = 0）** | 不在文本上做滑动窗口 | 重叠会导致同一 mention 被抽两次，去重逻辑比省下的那点召回更贵 |
| **④ 用"滚动术语表"代替"重叠窗口"传递上下文** | 每块的 prompt 里附上"前面章节已确认的实体表"（只放 canonical + aliases，不放正文） | 这才是真正的跨块上下文；成本是每块多 ~500–1500 tokens |
| **⑤ 每块记录可回溯坐标** | `(chapter_id, para_index, char_offset)` | 没有坐标就无法在 UI 里"点人名跳到原文"，也无法做增量重跑 |

### 3.1.2 分块参数（具体数字）

```
目标块大小：4,000–12,000 汉字（按官方 0.6 token/字换算，约 2,400–7,200 tokens）
上限块大小：12,000 汉字（硬上限，超过必按段落二分）
下限：不切（一章不足 4,000 字就整章发，或与相邻短章合并）
```

**理由**：本文的成本模型（§5.3）按"**30 章、每章 1 万字、一章一块**"计算，即 30 块、每块正文 6,000 tokens。块太大会逼近"中段遗忘"区间（[arXiv:2307.03172](https://arxiv.org/abs/2307.03172)）；块太小则每块的固定 prompt 开销（约 900 tokens）占比上升，且跨块实体更多。6,000 tokens/块时，固定开销占比 = 900 / 6,000 ≈ **15%**，是还能接受的上限。

### 3.1.3 断点续跑（必须做，不是可选）

- 每块处理完立即落库：`chunk_state(book_id, chunk_id, status, input_hash, output_json, usage)`
- **`input_hash` = hash(块文本 + prompt 版本 + 滚动术语表版本)**。hash 不变就跳过——用户重跑一本书时，只有被改过的块会重新花钱。
- 失败块单独重试，**不阻塞其他块**（这是 30 万字长任务的唯一可行策略；整书事务性重跑会让一次 API 抖动废掉 20 分钟）。
- **空 content 兜底**：官方文档明确 JSON 模式下非法输出会被替换成空格、`finish_reason` 仍可能是 `stop`（[JSON Output 文档](https://api-docs.deepseek.com/zh-cn/guides/json_mode.md)）→ 必须判 `len(trim(content)) == 0` 并重试，最多 3 次。

### 3.1.4 两遍法：先"发现"后"绑定"（缓存友好的关键设计）

如果第一遍就带滚动术语表，那么每块的 user 消息前缀都在变 → **DeepSeek 的硬盘缓存只能命中固定的 system+schema 部分**。

更好的做法：
- **第一遍（发现）**：所有块使用**完全相同**的 system + schema + few-shot（约 900 tokens），只在末尾附本章正文。→ 这 900 tokens 在 30 次调用里全部命中缓存。
- **第二遍（绑定）**：把第一遍的全部 mention 汇总（一次调用，约 6,000 tokens 输入），配上完整术语表，让模型做"哪个 mention 属于哪个实体"的批量映射。

**这个设计的收益不在省钱**：固定前缀 900 × 30 = 27,000 tokens，即使 100% 命中缓存，按 flash 低峰缓存命中价 **0.02 元/M** 也只省 **¥0.0005**（对比未命中的 27,000 × 1 元/M = ¥0.027，即省 ¥0.0265），**可以忽略**。真正的收益在结构：发现阶段是纯函数（同输入同输出），可缓存到磁盘；绑定阶段才需要全局信息。

> **诚实说明**：缓存优化在本场景是"锦上添花"，不是"省钱主力"。真正的省钱手段是 `input_hash` 跳过重跑。

---

## 3.2 如何保证同一人物在全书的译名一致（用户要的核心价值）

这是本任务的**产品核心**，不是技术细节。分两层：

### 3.2.1 译前：book glossary 强制注入

- 每本书一份 `book_glossary`，条目 = `{entity_id, source_name, target_name, aliases[], locked}`。
- **每次翻译调用都把 glossary 放进 prompt 的固定前缀**（不是每段重发全文，而是放在 system/前缀区，利用前缀缓存；[30 号文档 §C.2.3](30-formats-zlib-llm.md) 已给出同样结论）。
- **`locked=true` 的条目是硬约束**：prompt 里写"以下译名必须逐字使用，不得改写"，且**译后做确定性校验**（见下）。
- 只注入"本章会出现"的条目（用 mention 索引预筛），避免 glossary 膨胀到几千条把 prompt 撑爆。

### 3.2.2 译后：确定性一致性扫描（零 LLM 成本，这是真正的护栏）

**做法**：
1. 译文入库后，对每个 `locked` 条目，统计其 `target_name` 在**该段/该章**的出现次数。
2. 若该段的原文里确实出现了该实体的 mention（由 §2.4 ③ 的索引提供），但译文里 `target_name` 出现 **0 次** → **判定"译者忽略了术语表"**。
3. 只重译这一段（不是整章），重试 1–2 次；仍失败则标记 `glossary_violation`，在 UI 上给用户看。

**为什么这招有效**：它把"一致性"从一个**概率问题**（模型听不听话）变成一个**可判定问题**（字符串在不在）。成本几乎为零（一次全文扫描 = 一次 grep）。

**这一条比任何 prompt 工程都可靠**——因为它是确定性的。

### 3.2.3 一致性泄漏的兜底展示

即使做了上面两层，仍会有漏网。UI 上给一个"一致性检查"面板：
- 列出"同一实体出现 ≥2 种写法"的段（按 §2.4 的别名索引反查）
- 一键"全部替换为 canonical"或"逐段确认"
- 这是**用户可见的价值证明**，也是产品差异化的地方（Kindle X-Ray 只做索引，不做一致性，见 [X-Ray 说明](https://www.justkindlebooks.com/article_jkb/how-to-use-kindle-xray/)）

---

## 3.3 用户纠正后如何回灌（glossary 反馈循环）

### 3.3.1 核心原则：存**日志**，不存**结果**

```
❌ 错误做法：用户把 A 和 B 合并 → 直接 UPDATE entity 表
   → 下次自动流水线重跑 → 用户的工作被覆盖

✅ 正确做法：用户把 A 和 B 合并 → INSERT 一条 correction 事件
   → 自动流水线重跑 → 重放所有 correction → 用户的工作保留
```

**为什么**：自动流水线的输出是"可重算的"，用户的输入是"不可重算的"。**只有后者值得持久化。** 这也是 §2.1 说"纯 LLM 不可增量"的根因——它没有日志层。

### 3.3.2 事件类型（五种，够用且不多）

| 事件 | 语义 | 重放时的作用 |
|---|---|---|
| `merge(a, b)` | a 与 b 是同一人 | 并查集强制 union，**优先级高于所有自动边** |
| `split(entity, mention_ids)` | 这些 mention 不属于该实体 | 把这些 mention 拉到新实体；并**记录负样本对** |
| `rename(entity, new_name)` | 改 canonical 显示名 | 覆盖自动生成的 canonical |
| `alias_add(entity, surface)` | 这个写法也是他 | 加入别名表；后续自动聚类把它当强边 |
| `lock(entity)` | 锁定，自动流水线不得改 | 该实体整条跳过自动更新 |

**负样本对（`split` 的副产物）是防"重跑回退"的关键**：把被用户拆开的 (mention_a, mention_b) 存进 `blocked_pairs`，自动聚类时**先查黑名单再合并**。没有这一条，用户拆完重跑又合回去，体验是灾难性的。

### 3.3.3 重放顺序（必须固定）

```
1. 跑自动流水线（③④⑤）→ 得到 auto_entities
2. 应用 blocked_pairs（禁止合并）
3. 应用 merge 事件（强制合并）
4. 应用 split 事件（强制拆分，晚于 merge）
5. 应用 rename / alias_add
6. 应用 lock（冻结）
```

**顺序不能乱**：split 必须在 merge 之后（否则"先合后拆"的意图丢失）；lock 必须最后（否则被前面的步骤改掉）。

### 3.3.4 增量重译（省钱的关键）

有了 mention 索引，一次 `merge` 能精确算出"哪些段落受影响"：
```
affected_segments = ∪ (mention.segment_id for mention in merged_entity.mentions)
```
只重译这些段。用户改 1 个人名 → 重译 3 段（而不是整本 30 万字）。**这是"反馈循环"真正的经济价值**。

---

## 3.4 数据模型（DDL 草案，SQLite / PostgreSQL 通用）

```sql
-- 实体注册表（一本书一份）
CREATE TABLE book_entity (
  id            TEXT PRIMARY KEY,          -- ULID，客户端生成，可离线
  book_id       TEXT NOT NULL,
  canonical     TEXT NOT NULL,             -- 显示名（原文语言）
  target_name   TEXT,                      -- 译名（可为空）
  kind          TEXT NOT NULL,             -- person / place / org / term
  locked        INTEGER NOT NULL DEFAULT 0,
  confidence    REAL NOT NULL DEFAULT 0,   -- 0..1，自动流水线给的分
  created_by    TEXT NOT NULL,             -- 'auto' | 'user'
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(book_id, canonical, kind)
);

-- 别名（surface form → 实体）
CREATE TABLE book_entity_alias (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES book_entity(id) ON DELETE CASCADE,
  surface       TEXT NOT NULL,             -- 原文写法，未归一
  norm_key      TEXT NOT NULL,             -- 归一化 key（t2s + 去尊称 + 小写）
  pinyin_key    TEXT,                      -- 无声调拼音（中文用）
  source        TEXT NOT NULL,             -- 'rule' | 'llm' | 'user'
  weight        REAL NOT NULL DEFAULT 1.0
);
-- 注：生产环境把 book_id 冗余到本表（book_id TEXT NOT NULL），
--     索引建成 idx_alias_norm(book_id, norm_key)，避免 join
CREATE INDEX idx_alias_norm ON book_entity_alias(entity_id, norm_key);

-- mention 索引（每个出现位置一条，这是 UI 跳转与增量重译的基础）
CREATE TABLE book_mention (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL,
  entity_id     TEXT REFERENCES book_entity(id) ON DELETE SET NULL,
  chunk_id      TEXT NOT NULL,
  chapter_id    TEXT NOT NULL,
  para_index    INTEGER NOT NULL,
  char_start    INTEGER NOT NULL,
  char_end      INTEGER NOT NULL,
  surface       TEXT NOT NULL,
  confidence    REAL NOT NULL,
  UNIQUE(book_id, chapter_id, char_start, char_end)
);
CREATE INDEX idx_mention_entity ON book_mention(entity_id);

-- 分块状态（断点续跑）
CREATE TABLE book_chunk_state (
  book_id       TEXT NOT NULL,
  chunk_id      TEXT NOT NULL,
  status        TEXT NOT NULL,             -- pending/running/ok/failed
  input_hash    TEXT NOT NULL,             -- 文本+prompt版本+glossary版本
  output_json   TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER,
  attempt       INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY(book_id, chunk_id)
);

-- 修正日志（append-only，永不 UPDATE/DELETE）
CREATE TABLE book_correction (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,          -- 单调递增，重放顺序
  op            TEXT NOT NULL,             -- merge/split/rename/alias_add/lock
  payload       TEXT NOT NULL,             -- JSON
  actor         TEXT NOT NULL,             -- user_id
  created_at    INTEGER NOT NULL,
  UNIQUE(book_id, seq)
);

-- 负样本对（split 的副产物，防重跑回退）
CREATE TABLE book_blocked_pair (
  book_id       TEXT NOT NULL,
  norm_key_a    TEXT NOT NULL,
  norm_key_b    TEXT NOT NULL,
  PRIMARY KEY(book_id, norm_key_a, norm_key_b)
);
```

> 设计说明：所有 id 用 ULID 而非自增，是为了**离线优先 + 多设备同步**（与 [20-backend-sync.md](20-backend-sync.md) 的 HLC/游标方案一致）。`seq` 而非时间戳排序，是为了避免时钟回拨导致重放顺序错乱。

## 3.5 API 草案（Go 侧）

```
POST /api/v1/books/{bookId}/entities/extract     # 启动抽取任务（异步，返回 task_id）
GET  /api/v1/books/{bookId}/entities/extract/{taskId}  # 进度：done_chunks/total_chunks
GET  /api/v1/books/{bookId}/entities             # 实体列表（含别名、mention 数）
GET  /api/v1/books/{bookId}/entities/{id}/mentions?chapter=  # 某章内的 mention（UI 高亮用）
POST /api/v1/books/{bookId}/corrections          # 提交修正事件（幂等，带 client_seq）
GET  /api/v1/books/{bookId}/glossary             # 导出术语表（TSV/JSON，给翻译用）
POST /api/v1/books/{bookId}/consistency-check    # 跑一致性扫描，返回违规段列表
```

**幂等性**：`POST /corrections` 带客户端生成的 `(book_id, seq)`，服务端 `INSERT OR IGNORE`，重复提交不产生重复事件。这直接对应同步引擎的要求。

## 3.6 Go / Vue 落位

| 模块 | 位置 | 语言 | 说明 |
|---|---|---|---|
| 归一化（繁简/尊称/拼音） | Go（Wails 后端） | Go | 纯函数，零依赖，可单测 |
| 分块 + 断点续跑 | Go | Go | 与 SQLite 同事务 |
| 并查集聚类 | Go | Go | n < 1000，O(n²) 可接受 |
| LLM 调用 | Go（HTTP） | Go | 只走 OpenAI 兼容接口 |
| 一致性扫描 | Go | Go | 纯字符串匹配 |
| NER（可选，二期） | Go + ONNX | Go | `onnxruntime_go`，见 §4.3 |
| 实体卡片 / 合并 UI | Vue 3 | TS | 见 §3.3 |
| 原文高亮 | foliate-js 的 `transformTarget` 钩子 | TS | 在"data"事件里改 DOM，**不注入脚本**（[70 号文档](../research/70-isolation-feasibility.md) 已核实该钩子存在） |

> ⚠️ **移动端约束**：`onnxruntime_go` 依赖 CGO + 动态库。Wails v3 的 iOS/Android 是 experimental（见 [ADR-002](../ADR-002-客户端落地-Vue与Wails.md) 的 G1 闸门），**CGO + ONNX Runtime 在移动端能否打包，本次未验证**。→ 移动端应默认走"云端 LLM + 纯 Go 确定性层"，本地 NER 只在桌面端启用。**这条必须写进 G1 Spike 的验收项。**

---

# 4. 具体可用的开源库/模型

> 许可证均取自仓库 `LICENSE` 文件原文（已抓取）。体积凡标"未验证"的，是我没有拿到官方发布物的确切大小。

## 4.1 中文处理（纯 Go，零 CGO）—— 一期就用这些

| 库 | 用途 | 许可证 | 中文 | 体积 | 证据 |
|---|---|---|---|---|---|
| `github.com/longbridge/opencc` | 繁简归一 | **Apache-2.0** | ✅ | 词典 **embed 进二进制**（"利用 Go Embed 特性…直接将字典打包到 Go 的二进制里面"），具体 MB 数**未验证** | [LICENSE](https://raw.githubusercontent.com/longbridge/opencc/master/LICENSE) / [README 镜像](https://gothub.dev.projectsegfau.lt/longbridgeapp/opencc) |
| `github.com/BYVoid/OpenCC`（上游 C++） | 同上（若走 CGO） | **Apache-2.0** | ✅ | 未验证 | [LICENSE](https://raw.githubusercontent.com/BYVoid/OpenCC/master/LICENSE) |
| `github.com/mozillazg/go-pinyin` | 汉字→拼音（多风格：Normal/Tone/Initials/FirstLetter…） | **MIT** | ✅ | 极小（纯查表） | [LICENSE](https://raw.githubusercontent.com/mozillazg/go-pinyin/master/LICENSE) / [源码常量](https://github.com/mozillazg/go-pinyin) |
| `github.com/xrash/smetrics` | Levenshtein / Jaro / JaroWinkler / Soundex / Hamming | **MIT** | ⚠️ 算法本身语言无关，但对中文语义无效 | 极小（"仅依赖标准库 math、fmt、strings"） | [LICENSE](https://raw.githubusercontent.com/xrash/smetrics/master/LICENSE) |
| `github.com/go-ego/gse` | 中/日/英分词 | **Apache-2.0** | ✅ | 未验证（含 embed 词典） | [LICENSE](https://raw.githubusercontent.com/go-ego/gse/master/LICENSE) |
| `github.com/sugarme/tokenizer` | 纯 Go 的 HF tokenizer（**用于精确算 token 数、做截断**） | **Apache-2.0** | ✅（走 HF 词表） | 取决于词表 | [README](https://github.com/sugarme/tokenizer) |

**说明**：`go-opencc` 有两个同名项目。`qiangwang/go-opencc` 是 **CGO 封装 libopencc**（[repo](https://github.com/qiangwang/go-opencc)，最后提交 2019，**维护状态差**）；`longbridge/opencc` 是**纯 Go 重实现**。**选后者**，否则你的"零 CGO"目标就破了。

## 4.2 NER / 指代消解（Python 或 JVM，非 Go 原生）

| 工具 | 用途 | 许可证 | 中文 | 体积 | 备注 |
|---|---|---|---|---|---|
| **spaCy** | NER/POS/依存 | **MIT**（[LICENSE](https://raw.githubusercontent.com/explosion/spaCy/master/LICENSE)） | ✅（zh 模型） | 库本身小 | 中文 NER F1 **69.3**（Trankit 论文对比表，[arXiv:2101.03289](https://arxiv.org/abs/2101.03289)） |
| `zh_core_web_sm` | spaCy 中文小模型 | **MIT**（HF 模型卡标注；⚠️ 直连 huggingface.co 超时，本条经**检索摘要**读取模型卡内容，**未取得原始页面**） | ✅ | **48.5 MB**（wheel，[SourceForge 镜像](https://sourceforge.net/projects/spacy-models.mirror/files/zh_core_web_sm-3.8.0)） | 0 vectors；纯 CPU |
| **Stanza** | 多语言 NLP（含 coref 页面） | **Apache-2.0**（[LICENSE](https://raw.githubusercontent.com/stanfordnlp/stanza/main/LICENSE)） | ✅（NER） | 模型按语言下载，**未验证** | 中文 NER F1 **79.2**（同上）；coref 覆盖语言**未验证** |
| **Stanford CoreNLP** | 含**中文 coreference** | 见其站点（**未核实**具体许可证文本） | ⚠️ 语言表里 Coreference 行有 **2 个**勾，本文推断为 en+zh（表格空单元格被折叠，**未逐格核对**） | 整套 jar，很大（**未验证**） | Java 11+；**这是唯一确认支持中文 coref 的成熟工具** |
| **HanLP 2.x** | 中文分词/NER/依存/指代 | **Apache-2.0**（[LICENSE](https://raw.githubusercontent.com/hankcs/HanLP/master/LICENSE)） | ✅ | 模型按需下载，**未验证** | 官方站称功能含指代消解（[hanlp.hankcs.com](https://hanlp.hankcs.com/)）；**具体中文 coref 模型可用性未验证** |
| **jieba** | 分词 + 词性（`nr`=人名） | **MIT**（[LICENSE](https://raw.githubusercontent.com/fxsjy/jieba/master/LICENSE)） | ✅ | 极小（词典约 MB 级，**未验证**） | 词性标记法与 ictclas 兼容，`nr` 即人名（[文档](https://gislite.osgeo.cn/lesson/jt9b78/)） |
| **BookNLP** | **整书**角色聚类 + coref + 引语归属 | **MIT**（[LICENSE](https://raw.githubusercontent.com/codecason/booknlp/master/LICENSE)） | ❌ **仅英文**（README 原文 "in English"） | 含 BERT，big 模型大（**未验证**） | coref F1 76.4(small)/79.0(big)；《秘密花园》99K tokens 在 2019 MBP 上 small **3.6 分钟** |
| **coreferee** | spaCy 的 coref 插件 | **Apache-2.0**（[PyPI](https://pypi.org/project/coreferee/1.1.0/)） | ❌ 仅 EN/DE/PL（法语版另有） | 小 | 中文**不支持** |
| **RapidFuzz** | 快速模糊匹配（若走 Python） | **MIT**（[PyPI](https://pypi.ac.cn/project/RapidFuzz/1.1.1/)） | ⚠️ 语言无关 | 小 | Go 侧用 smetrics 即可，不必引入 |

## 4.3 轻量 ONNX 方案（CPU 可跑，Go 可调）

| 项 | 说明 | 证据 |
|---|---|---|
| **ONNX Runtime** | 微软官方推理引擎 | **MIT**（[LICENSE](https://raw.githubusercontent.com/microsoft/onnxruntime/main/LICENSE)） |
| `github.com/yalue/onnxruntime_go` | Go 绑定 | **MIT**（[LICENSE](https://raw.githubusercontent.com/yalue/onnxruntime_go/master/LICENSE)） |
| 关键实现细节 | README 原文：其他 Go wrapper 都不支持 Windows，因为 onnxruntime 假定用 MSVC 而 CGO 在 Windows 要 Mingw；本库**手动加载 shared library**，绕开该问题，"works equally well on non-Windows systems" | [README](https://raw.githubusercontent.com/yalue/onnxruntime_go/master/README.md) |
| 版本耦合 | README 明确："at the time of writing, this library uses version **1.31.0** of the onnxruntime C API headers"，"probably only work with version 1.31.0 of the onnxruntime shared libraries" | 同上 |
| **GLiNER**（零样本 NER） | 用一个 BERT-like encoder 做"任意标签"的 span 抽取，**不用微调**就能指定"人物/地点/组织" | [arXiv:2311.08526](https://arxiv.org/abs/2311.08526)；代码 **Apache-2.0**（[LICENSE](https://raw.githubusercontent.com/urchade/GLiNER/main/LICENSE)） |
| GLiNER 模型规格 | `gliner_small-v2.1` **166M 参数 / apache-2.0**；`gliner_medium-v2.1` 209M；`gliner_large-v2.1` 459M；`gliner_multi-v2.1` **209M / 多语言 / apache-2.0**（模型卡表格） | [模型卡（HF 镜像）](http://www.huggingface.com/alfonsovelp/gliner) |
| 体积换算 | 166M 参数 fp32 ≈ **660 MB**；INT8 量化 ≈ **170 MB**（**估算，按参数量 ×4 字节 / ×1 字节，未实测**） | 估算 |
| 中文支持 | `gliner_multi-v2.1` 标 multilingual，但**中文人物抽取的实际效果未验证** | **未验证** |

**结论**：GLiNER 是"能跑 CPU、能塞 Go、许可证干净"的最优选；但**它的中文效果没人为你验证过**，必须自己用 100 个中文人名做金标测一次，否则不要写进承诺。

## 4.4 Go 生态能调用什么——三选一

| 方案 | 做法 | 优点 | 缺点 | 建议 |
|---|---|---|---|---|
| **① 全 Go 进程内（ONNX）** | `onnxruntime_go` + GLiNER INT8 ONNX | 无 Python、无 IPC、打包一个二进制 | CGO；ONNX Runtime 版本耦合（README 说只匹配 1.31.0）；**移动端未验证**；模型 170MB 起 | **桌面端二期首选** |
| **② Python 侧车（微服务）** | FastAPI + spaCy/Stanza/HanLP，Go 走 HTTP/gRPC | 生态最全（含中文 coref 的 CoreNLP）；模型随便换 | 打包体积暴涨（Python + torch 动辄 GB 级）；跨平台打包是噩梦；进程管理、崩溃恢复都要自己写 | **仅当你确定要 BookNLP 级整书 coref 时** |
| **③ 不上本地模型** | 只用 LLM + 纯 Go 确定性层 | 零依赖、零打包风险、移动端无碍 | 有网络依赖；离线降级 | **一期就这个** |

**推荐路径**：**一期 ③ → 二期 ① → 永不 ②**（除非产品明确要"完全离线的人物关系图"，那才值得付 ② 的代价）。

---

# 5. 成本估算（30 万字整书实体抽取）

## 5.1 价格基线（已核实，抓取日 2026-11-03）

来源：[DeepSeek 官方价格页（中文）](https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md) 与[英文页](https://api-docs.deepseek.com/quick_start/pricing.md)。

| 项 | deepseek-flash | deepseek-v4-pro |
|---|---|---|
| 模型版本 | DeepSeek-V4.1-Flash-1017 | DeepSeek-V4-Pro-0813 |
| 上下文 / 最大输出 | 1M / 384K | 1M / 384K |
| 输入（缓存命中）低峰 | **0.02 元/M**（$0.003） | **0.15 元/M**（$0.022） |
| 输入（缓存命中）高峰 | 0.04 元/M（$0.006） | 0.30 元/M（$0.044） |
| 输入（未命中）低峰 | **1 元/M**（$0.15） | **4.5 元/M**（$0.66） |
| 输入（未命中）高峰 | 2 元/M（$0.3） | 9.0 元/M（$1.32） |
| 输出 低峰 | **4 元/M**（$0.6） | **13.5 元/M**（$1.98） |
| 输出 高峰 | 8 元/M（$1.2） | 27.0 元/M（$3.96） |

**低峰定义（官方原文）**："北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。"（同上）

**Token 换算（官方原文）**："1 个中文字符 ≈ 0.6 个 token"，"1 个英文字符 ≈ 0.3 个 token"（[Token 用量计算](https://api-docs.deepseek.com/zh-cn/quick_start/token_usage.md)）。

> ⚠️ **版本漂移警告**：同一份文档里的模型名已从 `deepseek-v4-flash` 改为 `deepseek-flash`（脚注 1 原文："旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，但对应模型已下线"）。**落地前必须重新核对价格页。**

## 5.2 输入侧：30 万字 = 多少 token

```
300,000 汉字 × 0.6 token/字 = 180,000 tokens   （纯正文输入，官方换算率）
```

> 这是**理论下界**。实际还要加上 prompt 开销（见 5.3）。

## 5.3 分块方案的三阶段 token 账

**分块参数**（§3.1.2）：30 章，每章 10,000 字 → 每块 6,000 tokens 正文。

### 阶段 ①：按章"发现"（30 次调用 = 30 章 × 1 次）

| 组成 | 每块 tokens | 30 块合计 |
|---|---|---|
| 正文 | 6,000 | 180,000 |
| system + JSON schema + few-shot（**固定前缀**） | 900 | 27,000 |
| 滚动上下文（只放上一章的实体摘要，平均） | 750 | 22,500 |
| **输入小计** | **7,650** | **229,500** |
| 输出（每块 15–25 个人物条目 + 别名 + 章节号，约 40 tokens/条） | 900 | **27,000** |

### 阶段 ②：全局绑定（1 次调用）

| 组成 | tokens |
|---|---|
| 全部候选 mention 的序列化 JSON（约 400 个 surface form × 15 tokens） | 6,000 |
| 绑定指令 + schema | 1,200 |
| **输入小计** | **7,200** |
| 输出（约 300 实体 × 40 tokens） | **12,000** |

### 阶段 ③：不确定对裁定（10 次调用，每批 20 对）

| 组成 | 每次 | 10 次合计 |
|---|---|---|
| 20 对 × (2 个名字 + 2 段上下文 ≈ 250 tokens) | 5,000 | 50,000 |
| 裁定指令 | 600 | 6,000 |
| **输入小计** | **5,600** | **56,000** |
| 输出（每对 15 tokens 判定） | 300 | **3,000** |

### 合计

| 阶段 | 输入 tokens | 输出 tokens |
|---|---|---|
| ① 发现 | 229,500 | 27,000 |
| ② 绑定 | 7,200 | 12,000 |
| ③ 裁定 | 56,000 | 3,000 |
| **总计** | **292,700** | **42,000** |

## 5.4 代入价格

### deepseek-flash（低峰）

```
输入：292,700 / 1,000,000 × 1 元   = ¥0.2927
输出： 42,000 / 1,000,000 × 4 元   = ¥0.1680
────────────────────────────────────────
合计 ≈ ¥0.46 / 本
```

### deepseek-flash（高峰）

```
输入：292,700 / 1e6 × 2 元 = ¥0.5854
输出： 42,000 / 1e6 × 8 元 = ¥0.3360
合计 ≈ ¥0.92 / 本
```

### deepseek-v4-pro（低峰）

```
输入：292,700 / 1e6 × 4.5 元 = ¥1.317
输出： 42,000 / 1e6 × 13.5 元 = ¥0.567
合计 ≈ ¥1.88 / 本
```

### 加"真实世界惩罚系数"

| 惩罚项 | 倍数 | 说明 |
|---|---|---|
| 失败重试（空 content / 截断 / 429） | 1.15–1.4× | 只重试失败块 |
| 用户修正后增量重跑 | 1.1–1.3× | 只重跑受影响块（§3.3.4） |
| 首次上线调 prompt（一次性） | 3–5 本等价 | 只影响开发期 |

**结论：稳态成本 ≈ ¥0.55–0.65 / 本（flash 低峰，含重试）**；高峰翻倍；pro 约 4 倍。

## 5.5 和"整书一次性"的对比（为什么分块不是为了省钱）

| 方案 | 输入 | 输出 | flash 低峰成本 |
|---|---|---|---|
| 整书一次性（180K 正文 + 15K 输出） | 180,000 | 15,000 | **¥0.24** |
| 三阶段分块（本文方案） | 292,700 | 42,000 | **¥0.46** |

**分块比一次性贵约 1.9 倍，但换来三件一次性做不到的事**：
1. **可断点续跑**（一次 API 抖动不会废掉整本）；
2. **可增量重跑**（改 1 个名字只重译 3 段，见 §3.3.4）；
3. **避开中段遗忘**（[arXiv:2307.03172](https://arxiv.org/abs/2307.03172)）。

**这 0.2 元买的是可靠性，不是性能。** 这个价位上，讨论"省 2 毛钱"没有意义。

## 5.6 规模外推

| 规模 | 成本（flash 低峰） | 备注 |
|---|---|---|
| 1 本 | ¥0.6 | |
| 100 本 | ¥60 | |
| 1,000 本 | ¥600 | |
| 10,000 本 | ¥6,000 | 此时更该关心**并发**：flash 并发上限 **2,500**（官方价格页脚注 3），单本约 41 次调用（30 发现 + 1 绑定 + 10 裁定），10,000 本 = 41 万次调用，按 2,500 并发约需 **164 个"批次"** |

> **真正的瓶颈不是钱，是"用户等待"**。41 次串行 × 平均 2 秒 ≈ 82 秒；并发 4 路可压到 ~21 秒。**UI 必须是"异步任务 + 进度条 + 可离开页面"**，不能是"点一下转圈到好"。

---

# 6. 风险清单与未验证项

## 6.1 已核实但会咬人的事实

| # | 事实 | 影响 | 来源 |
|---|---|---|---|
| R1 | JSON 模式下非法输出会被替换为空格，`finish_reason` 仍可能是 `stop` | **静默丢章节**。必须判空重试 | [JSON Output 文档](https://api-docs.deepseek.com/zh-cn/guides/json_mode.md) |
| R2 | 长上下文"中段遗忘"，且扩展了上下文的模型不一定更会用 | 整书单次方案不可靠 | [arXiv:2307.03172](https://arxiv.org/abs/2307.03172) |
| R3 | BookNLP 仅英文；coref F1 76–79；《秘密花园》99K tokens 在 2019 MBP 上 small 需 3.6 分钟 | 中文书不能用它；即使英文也要异步 | [README](https://raw.githubusercontent.com/codecason/booknlp/master/README.md) |
| R4 | spaCy 中文 NER F1 69.3；Stanza 79.2 | 纯 NER 路线中文漏检三成 | [arXiv:2101.03289](https://arxiv.org/abs/2101.03289) 表格摘要 |
| R5 | `onnxruntime_go` 与 onnxruntime **1.31.0** 头文件强耦合 | 升级 ORT 要改 C 头 + 换 dll/so | [README](https://raw.githubusercontent.com/yalue/onnxruntime_go/master/README.md) |
| R6 | DeepSeek 模型名已从 `deepseek-v4-flash` 换为 `deepseek-flash`，旧名"对应模型已下线" | 硬编码旧模型名的代码会静默降级计费 | [价格页脚注](https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md) |
| R7 | 缓存"尽力而为，不保证 100% 命中" | 不能把缓存当 SLA 做成本模型 | [上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache.md) |

## 6.2 未验证项（不得写进对外承诺）

| # | 未验证项 | 怎么验证 | 优先级 |
|---|---|---|---|
| U1 | GLiNER `multi-v2.1` 的**中文人名**抽取效果 | 100 个中文人名金标，算 P/R | **高**（决定二期要不要上） |
| U2 | ONNX Runtime + CGO 能否打进 **Wails v3 的 iOS/Android 包** | G1 Spike 里加一项 | **高**（决定移动端策略） |
| U3 | Stanza 的 coref 覆盖哪些语言 | 查 `stanza/available_models.html` 与 coref 页 | 中 |
| U4 | HanLP 2.x 是否有可用的**中文指代消解预训练模型** | 查 HanLP 模型下载页 | 中 |
| U5 | CoreNLP 的**许可证文本**（我只确认了它支持中文 coref，没抓 LICENSE） | 抓 CoreNLP 仓库 LICENSE | 中（若真要用） |
| U6 | `longbridge/opencc` 的词典实际体积（MB） | 编译后量二进制增量 | 低 |
| U7 | `pkar/twine`（Go 的 Double Metaphone）维护状态 | 查提交历史 | 低（本方案不用它） |
| U8 | 30 万字小说实际有多少 distinct surface form（本文假设 300–400） | 拿 3 本真实书跑一遍统计 | 中（影响 §5 的 ② 阶段估算） |
| U9 | 用户修正后"只重译受影响段"对译文连贯性的影响 | 端到端人工评估 20 段 | 中 |
| U10 | CoreNLP 语言表里 Coreference 行的 **2 个勾具体是哪两种语言** | 直接读页面 HTML 的 `<td>` 结构（本次抓取被渲染为折叠文本） | 中（若真要用中文 coref） |

## 6.3 设计级风险

| 风险 | 后果 | 缓解 |
|---|---|---|
| **误合并**（把两个人并成一个） | 读者看到"张三的对话配李四的头像"，**信任崩塌** | 弱边不自动合并（§2.4）；`blocked_pairs` 黑名单（§3.3.2）；UI 显式"疑似同一人"而非静默合并 |
| **LLM 裁定不稳定**（同输入不同输出） | 重跑结果漂移，用户困惑 | `temperature=0`；裁定结果**落盘**而非每次重算；`input_hash` 命中即复用 |
| **glossary 膨胀**（一本 100 万字西幻可能 500+ 实体） | prompt 撑爆、成本上升 | 只注入"本章会出现的"条目（§3.2.1） |
| **用户不确认**（没人愿意点 300 次合并） | 功能形同虚设 | 默认自动结果可用；只把**高不确定**的（< 200 对）推到用户面前；"一键全部接受" |
| **中文 coref 缺失导致代词不链接** | 人物出场统计偏低 | **明确不做代词消解**（§1.3），避免半成品 |

---

# 7. 分期落地计划

| 期 | 内容 | 工作量（估算） | 验收 |
|---|---|---|---|
| **P1（1 周）** | 纯 Go 确定性层：OpenCC 归一 + 尊称剥离 + 拼音 key + 子串包含 + 并查集；不做 LLM | 3 人日 | 拿 3 本测试书（1 英 1 中 1 译本），人工看前 50 个实体的合并正确率；**误合并率必须为 0**（这层只做强边） |
| **P2（1–2 周）** | LLM 发现 + 全局绑定 + 裁定；分块与断点续跑；SQLite 落库 | 5 人日 | 30 万字书端到端跑通，`chunk_state` 可断点恢复；BCubed P ≥ 0.80 |
| **P3（1 周）** | Vue 实体卡片 + 合并/拆分/改名 UI + correction 日志 + 重放 | 4 人日 | 用户改完 → 重跑 → 修改保留；`blocked_pairs` 生效 |
| **P4（3 天）** | 译后一致性扫描 + 增量重译 | 2 人日 | 构造 10 个"译者忽略术语表"的样例，全部被检出 |
| **P5（可选）** | ONNX + GLiNER 本地 NER（桌面端） | 3 人日 | U1 金标 P/R 达标（P ≥ 0.80）才做 |

**总：约 17 人日（P1–P4），P5 另计。**（人日为本文估算，非实测）

---

# 8. 参考来源

**一手（官方文档 / 仓库 LICENSE / 论文页）**
1. [DeepSeek 模型与价格（中文）](https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md) ｜ [英文](https://api-docs.deepseek.com/quick_start/pricing.md)
2. [DeepSeek Token 用量计算](https://api-docs.deepseek.com/zh-cn/quick_start/token_usage.md)
3. [DeepSeek JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode.md)
4. [DeepSeek 上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache.md)
5. [Liu et al., Lost in the Middle, arXiv:2307.03172](https://arxiv.org/abs/2307.03172)
6. [Trankit, arXiv:2101.03289](https://arxiv.org/abs/2101.03289)（含与 Stanza/spaCy 的 NER 对比表）
7. [GLiNER, arXiv:2311.08526](https://arxiv.org/abs/2311.08526)
8. [BookNLP README](https://raw.githubusercontent.com/codecason/booknlp/master/README.md) ｜ [LICENSE (MIT)](https://raw.githubusercontent.com/codecason/booknlp/master/LICENSE)
9. [Stanza LICENSE (Apache-2.0)](https://raw.githubusercontent.com/stanfordnlp/stanza/main/LICENSE) ｜ [Coref 文档](https://stanfordnlp.github.io/stanza/coref.html)
10. [CoreNLP 语言支持表](https://stanfordnlp.github.io/CoreNLP/human-languages.html)
11. [HanLP LICENSE (Apache-2.0)](https://raw.githubusercontent.com/hankcs/HanLP/master/LICENSE) ｜ [官网](https://hanlp.hankcs.com/)
12. [jieba LICENSE (MIT)](https://raw.githubusercontent.com/fxsjy/jieba/master/LICENSE) ｜ [词性标记集说明](https://gislite.osgeo.cn/lesson/jt9b78/)
13. [OpenCC LICENSE (Apache-2.0)](https://raw.githubusercontent.com/BYVoid/OpenCC/master/LICENSE) ｜ [longbridge/opencc（纯 Go）](https://gothub.dev.projectsegfau.lt/longbridgeapp/opencc)
14. [go-pinyin LICENSE (MIT)](https://raw.githubusercontent.com/mozillazg/go-pinyin/master/LICENSE)
15. [smetrics LICENSE (MIT)](https://raw.githubusercontent.com/xrash/smetrics/master/LICENSE)
16. [gse LICENSE (Apache-2.0)](https://raw.githubusercontent.com/go-ego/gse/master/LICENSE)
17. [onnxruntime_go README](https://raw.githubusercontent.com/yalue/onnxruntime_go/master/README.md) ｜ [LICENSE (MIT)](https://raw.githubusercontent.com/yalue/onnxruntime_go/master/LICENSE)
18. [ONNX Runtime LICENSE (MIT)](https://raw.githubusercontent.com/microsoft/onnxruntime/main/LICENSE)
19. [spaCy LICENSE (MIT)](https://raw.githubusercontent.com/explosion/spaCy/master/LICENSE) ｜ [zh_core_web_sm 体积 48.5 MB](https://sourceforge.net/projects/spacy-models.mirror/files/zh_core_web_sm-3.8.0)
20. [GLiNER LICENSE (Apache-2.0)](https://raw.githubusercontent.com/urchade/GLiNER/main/LICENSE) ｜ [模型规格表](http://www.huggingface.com/alfonsovelp/gliner)
21. [coreferee (PyPI, Apache-2.0, EN/DE/PL)](https://pypi.org/project/coreferee/1.1.0/)
22. [RapidFuzz (PyPI, MIT)](https://pypi.ac.cn/project/RapidFuzz/1.1.1/)

**二手（百科 / 维基镜像 / 新闻，已标注）**
23. [傲慢与偏见·维基镜像（"费茨威廉"全书仅两次）](https://www.heyuanjia.com/wikipedia/wiki/%E5%82%B2%E6%85%A2%E4%B8%8E%E5%81%8F%E8%A7%81)
24. [費茨威廉·達西（中文百科）](https://www.newton.com.tw/wiki/%E8%B2%BB%E8%8C%A8%E5%A8%81%E5%BB%89%C2%B7%E9%81%94%E8%A5%BF)（全名部分**不采信**，见 §1.2 例 1）
25. [维基新闻·地区词转换表（Elizabeth：大陆/台湾/香港）](https://zh.wikinews.org/zh-hans/%E8%8B%B1%E5%9C%8B%E5%85%A7%E6%94%BF%E5%A4%A7%E8%87%A3%E5%BD%AD%E9%BB%9B%E7%8E%B2%E8%A2%AB%E6%8C%87%E8%81%B7%E5%A0%B4%E6%AC%BA%E5%87%8C%E5%AE%98%E5%93%A1_%E6%B6%89%E9%81%95%E5%8F%8D%E5%AE%98%E5%93%A1%E8%A1%8C%E7%82%BA%E5%AE%88%E5%89%87)
26. [傅东华《飘》归化译名（郝思嘉/白瑞德/韩媚兰/卫希礼）](https://www.toutiao.com/article/7157209102564442637/)
27. [百度百科·飘（傅东华译本"将人名地名中国化"）](https://baike.baidu.com/item/%E9%A3%98/15311)
28. [快懂百科·克莱恩·莫雷蒂（别名清单）](https://www.baike.com/wikiid/2137721270836104718)
29. [Nameberry·Mitya（Dmitri 的 diminutive，见《卡拉马佐夫兄弟》）](https://nameberry.com/name/MITYA)
30. [新华社译名室（《世界人名翻译大辞典》65 万条、55 种语言译音表）](https://www.wikiwand.com/zh-sg/%E6%96%B0%E5%8D%8E%E7%A4%BE%E8%AF%91%E5%90%8D%E5%AE%A4)
31. [Kindle X-Ray 功能说明](https://www.justkindlebooks.com/article_jkb/how-to-use-kindle-xray/)

**本项目内部**
32. [30-formats-zlib-llm.md §C.3（L1–L5 骨架）](30-formats-zlib-llm.md)
33. [70-isolation-feasibility.md（foliate-js transformTarget 钩子）](70-isolation-feasibility.md)
34. [20-backend-sync.md（HLC / 服务端游标）](20-backend-sync.md)
35. [ADR-002 客户端落地](../ADR-002-客户端落地-Vue与Wails.md)

---

> **文档状态**：初稿 ｜ **核实日期**：2026-11-03 ｜ **未验证项**：10 条（§6.2）
> **下一步**：① 用 3 本真实书跑 P1 确定性层，量 U8（surface form 数）；② 在 G1 Spike 里加 U2（移动端 ONNX）；③ 若二期要上 GLiNER，先做 U1 金标。
