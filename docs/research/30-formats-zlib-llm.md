# HPF-Reader 调研报告 30:格式解析 / 书源(含 Z-Library)/ LLM 高级功能

- 调研员:content-research(任务 board id:task-3)
- 调研日期:**2026-11-02**(报告中所有"证据日期"均为实际抓取/查询日期,非网页发布时间)
- 交付范围:仅本文档,未改动 \`docs/research\` 之外的任何文件;未写业务代码
- 证据获取方式:GitHub REST API(\`api.github.com\`)、\`raw.githubusercontent.com\` 原始文件、npm registry、官方文档页直取
- 不可达说明:调研环境对 \`en.wikipedia.org\`、\`archive.org\`、\`openlibrary.org\`、\`developer.android.com\`、\`web.archive.org\`、\`zhihu.com\`(403)存在网络不可达/超时,**相关结论凡未能取得一手页面者一律标注「未验证」**

---

## 0. 结论速览(TL;DR)

| 议题 | 结论 | 置信度 |
| --- | --- | --- |
| 渲染内核 | 复用 **foliate-js**(MIT,支持 EPUB/MOBI/KF8/FB2/CBZ/PDF-实验),HPF-Reader 不必自研解析层 | 高(一手 README) |
| MOBI/AZW3 | foliate-js 纯 JS 路径足够;需要极限兼容时再上 libmobi(LGPL-3.0,注意动态链接)或 calibre 侧车 | 高(一手 README + LICENSE) |
| PDF | 文本层/pdftotext 用 **pdf.js(Apache-2.0)**;商业闭源**不能用 MuPDF(AGPL-3.0)**;扫描件 OCR 首选 tesseract.js(Apache-2.0)或服务端 OCRmyPDF | 高(一手 LICENSE/COPYING) |
| TXT | 编码探测 jschardet(0BSD)/chardet(MIT);章节切分、大文件流式读取需自研 | 高(npm registry) |
| CBZ/FB2 | 纯 JS 完全可做(zip + XML);**CBR(RAR)是唯一法务灰区**,建议降级为"需用户自行提供解压工具"或不做 | 中高 |
| Z-Library | 技术上可接(EAPI + cookie 会话 + 域名漂移),但**法务与商店合规风险极高,不建议内置** | 高 |
| 合规结论 | 强烈建议:**主应用不内置 Z-Library**;改为"书源插件"抽象 + 只默认内置合法书源;是否允许第三方插件需法务确认 | 中高(政策条文未取到一手页,标注未验证项) |
| LLM 翻译 | 先做"云端 API + 段落级双语对照";**100 万字整书译文按 DeepSeek 官方价约 $0.24–$3.96 一次**(详见第 3.3 节) | 高(官方定价页一手) |
| LLM 成本可控性 | 成本瓶颈是**输出 token**与**重试/上下文膨胀**,不是输入;必须做缓存 + prompt 版本号 + 并发闸门 | 高(定价表推演) |
| 自托管模型 | 一期**不做**;二期若做,按"术语表+NMT 小模型"评估,不建议一上来就上大模型本地推理 | 中 |

---

# A. 格式解析:逐格式推荐库 + 许可证 + 平台可用性

## A.0 一个前置判断:解析层不要自研

foliate-js 是 Readest/Foliate 生态的解析与分页内核,README 明确列出支持 **EPUB、MOBI、KF8(AZW3)、FB2、CBZ、PDF(实验性,需 PDF.js)**,并且"纯 JavaScript、无硬依赖、不需要把整文件读进内存"。
- 证据:https://github.com/johnfactotum/foliate-js (README 原文,抓取日 2026-11-02)
- 许可证:MIT(package.json \`"license": "MIT"\`,https://raw.githubusercontent.com/johnfactotum/foliate-js/master/package.json ,抓取日 2026-11-02)
- 重要限制(README 原文):库**自身不稳定**(no release, API 可能随时变),官方建议以 git submodule 方式引用;**不支持 EPUB 内嵌脚本**,并要求调用方必须用 CSP 阻断脚本,否则不能安全渲染不可信 EPUB。
- 旁证(架构定位):Readest README 自述 "built ... leveraging Next.js 16 and Tauri v2",格式列表为 **EPUB, PDF, MOBI, KF8 (AZW3), FB2, CBZ, TXT, HTML, MD**;许可证徽章指向 AGPL(仓库 API 返回 \`license.spdx_id = AGPL-3.0\`)。
  - 证据:https://github.com/readest/readest/blob/main/README.md (抓取日 2026-11-02);https://api.github.com/repos/readest/readest (抓取日 2026-11-02, stars 25854, pushed 2026-11-02)
  - **对 HPF-Reader 的含义:Readest 是 AGPL-3.0,直接抄其代码会传染;复用其上游 MIT 的 foliate-js 才安全。**

## A.1 格式支持矩阵(总表)

平台可用性图例:Web=浏览器(含 PWA);桌面=Tauri/Electron(Node 侧能力可用);移动=iOS/Android(含 WebView 限制)。
"原生"指需要编译 C/C++/Rust 并做 JNI/Swift/FFI 绑定的库。

| 格式 | 推荐库(首选) | 语言/形态 | 许可证 | Web | 桌面 | 移动 | 备选 | 备注/坑 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **EPUB 2/3** | foliate-js (\`epub.js\`+\`epubcfi.js\`) | JS(原生 ESM) | **MIT** | ✅ | ✅ | ✅ | epub.js(BSD-2-Clause);Readium ts-toolkit(BSD-3-Clause);readium-js(已归档) | foliate-js 无 release、API 不稳定;必须配 CSP;不支持脚本化 EPUB |
| **EPUB 字体混淆(IDPF)** | foliate-js 内置 | JS | MIT | ✅ | ✅ | ✅ | 自实现 SHA-1 解混淆 | README:IDPF 解混淆需 SHA-1,默认走 Web Crypto,**仅 secure context(HTTPS)** 可用,否则要自带 SHA-1 |
| **EPUB 字体混淆(Adobe)** | foliate-js | JS | MIT | ✅ | ✅ | ⚠️ | 自实现(算法 = 取 UUID 前 16 字节重复 XOR 前 1024 字节) | 该算法细节在 README 中**未逐字给出**,此处为**未验证**;需在使用前单独核实源码 |
| **EPUB DRM(LCP / ADEPT)** | 无开源库可合法绕过 | — | — | ❌ | ❌ | ❌ | Readium LCP(需授权/许可服务器) | **DRM 破除不在本报告建议范围**;Readium LCP 是唯一"授权式"方案,细节未验证 |
| **TXT(编码探测)** | jschardet 4.1.0 | JS/TS | **0BSD** | ✅ | ✅ | ✅ | chardet 2.2.0(MIT);iconv-lite 0.7.3(MIT,仅解码);encoding-japanese 2.4.0(MIT,日文) | 中文 GB18030/Big5 探测准确率有限,需提供"手动切换编码"兜底 |
| **TXT(章节切分)** | 自研正则 + 目录启发式 | 自研 | — | ✅ | ✅ | ✅ | 参考 Readest 的 TXT 章节处理 | 无成熟跨端库;必须自研,并把规则做成可配置 |
| **TXT(大文件)** | 流式读取(Web: File/Blob slice;桌面: fs stream) | 平台 API | — | ✅ | ✅ | ✅ | 分块索引 + 只加载当前章 | 10MB+ 单文件在移动 WebView 上整体读入会 OOM,必须流式 |
| **PDF(有文本层)** | pdf.js / pdfjs-dist 6.5.438 | JS + WASM | **Apache-2.0** | ✅ | ✅ | ✅ | PDFium(BSD-3-Clause,需原生);MuPDF(**AGPL-3.0,商用闭源不可**) | pdfjs-dist 是官方发行包;MuPDF 需 Artifex 商业许可 |
| **PDF(重排 reflow)** | pdf.js 的 textLayer + 自研重排 | JS | Apache-2.0 | ✅ | ✅ | ⚠️ | 自研(按文本块启发式) | 重排质量对学术 PDF/多栏几乎不可用,建议默认不重排 |
| **PDF(扫描件 OCR)** | tesseract.js 7.0.0 | JS + WASM | **Apache-2.0** | ✅ | ✅ | ⚠️(体积/性能) | OCRmyPDF(GPL-3.0,服务端);PaddleOCR(Apache-2.0,需 Python) | tesseract.js 首次加载语言包大;移动端建议服务端 OCR |
| **MOBI / PRC** | foliate-js \`mobi.js\` | JS | MIT | ✅ | ✅ | ✅ | libmobi(LGPL-3.0,C);KindleUnpack(GPL-3.0,Python) | libmobi README 自述支持 prc/mobi/azw/azw3/azw4 及加密文档处理 |
| **AZW / AZW3(KF8)** | foliate-js \`mobi.js\` | JS | MIT | ✅ | ✅ | ✅ | libmobi;KindleUnpack | KindleUnpack README:KF8 解包为 "epub-like" 结构,**不保证是合法 EPUB** |
| **DRM 保护的 AZW** | 不支持 | — | — | ❌ | ❌ | ❌ | — | 见 A.4 法务说明 |
| **FB2 / FBZ** | foliate-js \`fb2.js\` | JS | MIT | ✅ | ✅ | ✅ | 自研 XML 解析(结构简单) | FBZ = zip 包 FB2,解压后同 FB2 处理;FB2 内嵌 base64 二进制需自行解码 |
| **CBZ** | foliate-js \`comic-book.js\` | JS | MIT | ✅ | ✅ | ✅ | @zip.js/zip.js 2.24.0(BSD-3-Clause);fflate 0.8.3(MIT) | 纯 zip,风险最低 |
| **CBR** | 无首选 | — | — | ⚠️ | ⚠️ | ⚠️ | libarchive.js 2.0.2(MIT, WASM);node-unrar-js 2.0.2(MIT) | **RAR 解压涉及 UnRAR 许可限制(不得用于重建 RAR 压缩器),商用需法务确认;标注未验证具体条款** |
| **DOCX** | mammoth 1.13.0 | JS | **BSD-2-Clause** | ✅ | ✅ | ✅ | dolanmiu/docx(MIT,偏生成而非解析);服务端 Apache Tika(Apache-2.0) | mammoth 只转换语义样式,**主动丢弃大部分版式**——对阅读器反而是优点 |
| **Markdown** | markdown-it 15.0.3 | JS | **MIT** | ✅ | ✅ | ✅ | remark/unified(MIT) | 需自行决定是否支持 HTML 内联(安全风险) |
| **HTML** | 浏览器原生解析 | 平台 | — | ✅ | ✅ | ✅ | cheerio 1.2.0(MIT, 服务端);linkedom 0.18.15(ISC) | 单 HTML 文件需先抽正文(Readability 思路),再进分页器 |
| **编码转换(通用)** | iconv-lite 0.7.3 | JS | MIT | ✅ | ✅ | ✅ | TextDecoder(平台内置, 需手动指定 label) | iconv-lite 在浏览器端需打包,体积需评估 |

> 表中每个库的许可证与版本号均来自 npm registry \`/{pkg}/latest\` 或 GitHub API,抓取日 **2026-11-02**。凡未查到一手来源的,已在该行"备注"标注「未验证」。

## A.2 许可证对商业闭源的影响(必须写清)

| 许可证 | 典型库 | 对"闭源商业发行"的影响 | 规避手段 |
| --- | --- | --- | --- |
| **MIT / BSD-2 / BSD-3 / 0BSD / Apache-2.0 / ISC** | foliate-js, pdf.js, tesseract.js, mammoth, markdown-it, jschardet, fflate, zip.js | 可闭源商用,只需保留版权与许可声明;Apache-2.0 另含专利授权条款 | 无 |
| **LGPL-3.0** | libmobi | 可闭源商用,但**必须动态链接**,且用户可替换该库版本;静态链接会触发 GPL 传染 | 以独立动态库/独立进程方式调用;或改用纯 JS 方案 |
| **GPL-3.0** | KindleUnpack, OCRmyPDF | 若与产品**同一进程/同一可执行体**结合,GPL 要求整包开源 | 作为**独立命令行程序**在服务端调用(需与法务确认"聚合"边界);或改用 MIT 方案 |
| **AGPL-3.0** | **MuPDF**、ebooklib、Readest 本体 | 比 GPL 更严:**通过网络提供服务**也触发源码提供义务 | 服务端也建议避免;**不要复制 Readest 源码** |
| **RAR/UnRAR 限制** | CBR 相关 | UnRAR 许可禁止用其重建 RAR 压缩;商用需核实 | 只读解压 + 法务确认;未验证条款原文 |

补充说明:
- MuPDF 仓库根目录文件名为 \`COPYING\`,内容是 **GNU Affero General Public License Version 3**(抓取日 2026-11-02,https://raw.githubusercontent.com/ArtifexSoftware/mupdf/master/COPYING );GitHub API 对 \`ArtifexSoftware/mupdf\` 返回 \`license.spdx_id = AGPL-3.0\`(2026-11-02)。MuPDF 官网另提供商业许可(https://mupdf.com/ ,抓取日 2026-11-02 的搜索摘录),**具体商业条款与报价未验证**。
- libmobi 仓库根目录 \`COPYING\` 为 **LGPL v3**(https://raw.githubusercontent.com/bfabiszewski/libmobi/master/COPYING ,抓取日 2026-11-02);GitHub API 亦返回 \`LGPL-3.0\`。
- KindleUnpack 的 \`COPYING.txt\` 为 **GNU General Public License v3**(GitHub API \`/license\` 返回 \`{"name":"COPYING.txt"}\`,内容 base64 解码后首行为 "GNU GENERAL PUBLIC LICENSE Version 3";spdx \`GPL-3.0\`)。
- PDFium:仓库 LICENSE 文件是 **BSD 3-Clause 风格**的 Chromium 许可文本(https://raw.githubusercontent.com/chromium/pdfium/main/LICENSE ,抓取日 2026-11-02,含 "Redistributions of source code"/"Neither the name of Google Inc." 三条);**但该仓库已被归档(GitHub API \`archived: true\`,pushed 2025-11-19),上游实际开发在 pdfium.googlesource.com——这一点标注为部分未验证。**
- \`ebooklib\` 为 AGPL-3.0(GitHub API,2026-11-02),**服务端集成同样有源码提供义务**,本报告不建议在闭源后端使用。

## A.3 平台可用性差异的关键坑

| 坑 | 说明 | 应对 |
| --- | --- | --- |
| iOS WebView 与 \`blob:\` 同源 | foliate-js README 明确指出:因内容以 \`blob:\` URL 同源服务,**无法安全支持 EPUB 内嵌脚本**;并引用 WebKit Bug 218086 说明 \`allow-scripts\` 属性导致 iframe sandbox 失效 | 全平台强制 CSP;把"渲染书籍"放到独立 origin/独立 WebView 实例 |
| secure context 依赖 | IDPF 字体解混淆默认依赖 Web Crypto(SHA-1),**只在 HTTPS/安全上下文可用** | 桌面端自注入 SHA-1;本地 http 调试时注意 |
| WASM 体积 | pdf.js、tesseract.js、libarchive.js 均带 WASM 资产 | 移动端按需下载语言包;首包不含 OCR |
| 移动端大文件 | TXT/PDF 大文件整体读入内存会 OOM | 统一走 slice/stream + 分章索引 |
| 原生库交叉编译 | libmobi(C)、PDFium(C++)、MuPDF(C) 在 iOS/Android 需多架构构建 | 一期全部避开原生依赖,二期再评估 |
| 格式嗅探 | 扩展名不可信(用户常改后缀) | 用魔数 + zip 内容特征双重判定;TXT 作为最终兜底 |

## A.4 DRM 与"DRM-free"的边界(法务提示)

- 本报告**只建议支持 DRM-free 内容**。EPUB 的字体混淆(IDPF/Adobe)属于"混淆"而非"访问控制",多数法域下处理争议较小,但仍应保留权利人声明。
- Kindle AZW/AZW3 的 DRM:美国 **DMCA §1201**、欧盟 **InfoSoc Directive 2001/29/EC 第 6 条**均禁止规避技术保护措施;**中国《著作权法》第 53 条**亦禁止规避技术措施。上述条文我**未在本次调研中取得一手页面**(相关站点不可达),**标注为未验证**,建议由用户/法务自行核实后再决策。
- 工程上最安全的产品定义:**"HPF-Reader 支持 DRM-free 电子书;检测到 DRM 时给出明确提示并终止,不提供任何绕过能力。"**

---

# B. Z-Library 接入:技术路径、现状与合规风险

> **本章定位:技术可行性分析 + 独立、诚实的风险分析。报告不提供任何规避法律或平台审核的实现方案。**

## B.1 现状(2024–2026)与可用接口

| 维度 | 观察到的事实 | 证据 |
| --- | --- | --- |
| 前端网站 | 域名频繁更替,存在大量"镜像/入口"站(如 z-lib.tv、z-lib.ac、z-library.me 等搜索结果) | 搜索引擎结果(2026-11-02 抓取);**各站真实性/官方性未验证**,可能是仿冒/钓鱼站 |
| 机器接口 | 社区客户端统一使用 **EAPI** 接口(JSON),而非早期 HTML 抓取 | heartleo/zlib 文档反复出现 "EAPI"、"EAPI probe"、"Old short IDs from earlier HTML-based versions are not EAPI references" — https://github.com/heartleo/zlib (MIT, 1268 stars, pushed 2026-11-02) |
| 登录 | 邮箱+密码登录,或**导入浏览器 Cookie**;会话以 \`remix_userid\` + \`remix_userkey\` 两个 Cookie 表示 | KOReader 插件 README:https://github.com/ZlibraryKO/zlibrary.koplugin (AGPL-3.0, 862 stars, pushed 2026-10-19) |
| 域名漂移 | 官方/社区均把"找可用域名"作为独立功能:zlib CLI 有 \`zlib doctor\`;KOReader 插件有 "Auto-discover base URL" | 同上两份 README |
| 配额 | 存在**每日下载配额**,CLI 提供 \`zlib profile\` 查询剩余额度 | heartleo/zlib troubleshooting 文档:"Check \`zlib profile\` for the remaining daily quota" |
| 反爬 | 存在反自动化防护:HTTP **517**、重定向循环、HTML challenge 响应;CLI 明确"does not solve browser challenges" | heartleo/zlib troubleshooting 文档(抓取日 2026-11-02) |
| 登录异常 | 有账号出现 **EAPI 登录返回 Authorization failed**,但已存在会话仍可搜索/查资料 | 同上 |
| 下载引用 | 下载需要搜索结果里的 **\`id:hash\`** 引用,旧短 ID 不适用 | 同上 |
| Tor / IPFS | 社区长期讨论存在 Tor 洋葱站与 IPFS 镜像 | **本次调研未取得一手可验证来源 → 未验证** |
| 法务事件 | Z-Library 遭美国执法行动与域名扣押、被 Authors Guild 起诉等 | **本次调研未取得一手来源(维基/新闻站点不可达)→ 未验证,不得作为结论引用** |

## B.2 技术接入路径(若**仅**用于个人、非分发的实验性场景)

> 以下为**协议层事实梳理**,不是实现建议。

| 步骤 | 技术要点 | 来源 |
| --- | --- | --- |
| 1. 域名发现 | 维护候选域名列表 + 逐个探测 EAPI 可用性;失败即换 | zlib \`doctor\`;KOReader "Auto-discover base URL" |
| 2. 登录 | 提交邮箱/密码 → 拿 \`remix_userid\`/\`remix_userkey\`;或直接导入已有 Cookie | 两份 README |
| 3. 会话持久化 | 保存 cookie(CLI 保存在本地配置目录;插件可写入 \`zlibrary_credentials.lua\`) | 两份 README |
| 4. 搜索 | 调 EAPI 搜索,支持按语言/格式/年份过滤与排序 | zlib README features |
| 5. 元数据 | 从搜索结果与详情返回 JSON 中取标题/作者/ISBN/格式 | 由 4 推断,**字段名未验证** |
| 6. 下载 | 用 \`id:hash\` 换取下载(可能含签名 URL,限时) | zlib troubleshooting:"signed download URLs" |
| 7. 限速/重试 | 每次下载前查配额;对 502/503/504 做有限重试(默认 3 次) | zlib configuration 文档 \`ZLIB_DOWNLOAD_RETRIES\` |

**工程结论(若一定要做,也仅限研究用途):**
- 必须把"域名列表"做成**可热更新的本地配置**,不能硬编码;
- 必须把"登录态"作为**用户自有凭证**保存,不做服务端托管(服务端托管用户 Z-Library 密码会同时构成账号安全与法律风险);
- 必须有**硬性速率限制**与**指数退避**,否则 IP/账号会被封;
- 反爬出现 challenge 时**不得实现绕过**,只能报错退出。

## B.3 合规与风险分析(独立章节,本报告的核心结论之一)

### B.3.1 法律风险

| 法域 | 主要风险 | 一手条文 |
| --- | --- | --- |
| 美国 | 直接侵权 + 帮助侵权(contributory)/间接侵权;DMCA §512 避风港对"明知"的服务提供者无效;规避技术措施违反 DMCA §1201 | **本次未取得一手条文页 → 未验证** |
| 欧盟 | InfoSoc Directive 2001/29/EC 第 3 条(向公众传播)、第 6 条(技术措施);成员国另有刑事责任 | **未验证** |
| 中国 | 《著作权法》第 10 条(信息网络传播权)、第 53 条(规避技术措施);《刑法》第 217 条侵犯著作权罪;提供"书源规则/聚合入口"存在被认定为**帮助侵权**的现实案例讨论 | **未验证(条文与案例均未取得一手来源)** |
| 平台责任 | 若 HPF-Reader 提供云端同步/书源市场/索引服务,角色从"工具"升级为"服务提供者",责任显著上升 | 推论,非一手 |

### B.3.2 应用商店审核政策(直接影响能否上架)

| 平台 | 相关条款要点 | 一手来源状态 |
| --- | --- | --- |
| Apple App Store | 审核指南中"Intellectual Property"章节(历史上编号 5.2)要求 App 不得侵犯第三方知识产权,且不得鼓励/协助侵权 | **未验证**:\`developer.apple.com/app-store/review/guidelines/\`(抓取日 2026-11-02)返回的 HTML 中 **未包含正文条款文本**(页面正文由脚本注入,且抓取被截断在 100,000 字符),无法逐字引用 |
| Google Play | 开发者政策含"知识产权"与"欺骗性行为"条款,禁止协助盗版 | **未验证**:\`developer.android.com\`、\`play.google\`、\`support.google.com/googleplay\` 在本次调研中**全部不可达/超时** |
| 历史下架案例 | 开源阅读 App(Legado)官网下载页明确标注其 Google Play 版本 **"已被下架"** | 二手来源:https://gedoor.github.io/download (搜索引擎摘要,2026-11-02);**页面本身未取到 → 部分未验证** |
| 同类先例(可信度较高) | 开源影子图书馆客户端 **Openlib**(下载 Anna's Archive 书籍)README 直接写:"**Publishing Openlib, Or Any Fork Of It In The Google Play Store Violates Their Terms And Conditions**",且其只通过 GitHub Releases / IzzyOnDroid / F-Droid 分发 | 一手:https://github.com/dstark5/Openlib (GPL-3.0, 2510 stars, pushed 2026-01-18;README 抓取日 2026-11-02) |

### B.3.3 关于"Legado 作者因分享书源被判刑"的核实请求(来自 lead)

lead 提供了一个待核实线索(知乎提问 \`zhihu.com/question/2020429339691332163\`)。核实结果:

| 项 | 结果 |
| --- | --- |
| 该问题是否真实存在 | **是**。搜索引擎索引到该标题与 URL,索引日期 2026-03-30(抓取日 2026-11-02) |
| 页面正文能否读取 | **否**。直接抓取返回 **HTTP 403(bot detection / geo-restriction)**;通过 SearXNG reader 亦超时/403 |
| 是否取得裁判文书/官方通报 | **否 → 未能核实** |
| 结论 | **该"判刑"说法在本报告中标注为「未核实传闻」,不得作为事实引用。** 但"书源/聚合入口在国内存在刑事风险"这一**风险方向**与下列可验证事实一致:网页搜索索引显示 Legado 的 Google Play 版本已被下架(https://gedoor.github.io/download ,2026-11-02 摘要),以及 Openlib README 明示 Google Play 分发违规。 |

> **写作纪律说明:**本报告宁可不写,也不把未经核实的刑事案件当作既定事实,以免把用户引向错误的法律判断。

### B.3.4 可插拔"书源插件"架构:能隔离风险吗?

**结论:能降低一部分"代码层面的直接侵权暴露",但不能消除法律责任。** 逐条拆解:

| 风险类型 | 插件化能否缓解 | 说明 |
| --- | --- | --- |
| 分发层面的直接侵权主张 | **部分缓解** | 应用本体不含盗版索引/下载逻辑,主张"通用工具"更站得住脚(参照 Legado 的"工具"定位与 KOReader 插件独立分发) |
| 帮助侵权 / 间接侵权 | **缓解有限** | 若官方提供**插件市场**、内置**默认盗版源**、或提供**一键安装指南**,仍可能被认定"实质性帮助 + 明知" |
| 商店审核 | **缓解有限** | Apple/Google 更看"应用是否可被发现用于侵权",插件机制本身可能被判定为规避审核;参考 Openlib 的明示警告 |
| 云端服务责任(同步/索引/代理下载) | **几乎无缓解** | 一旦服务端参与抓取或转存,责任从用户转移到运营方 |
| 声誉与上游依赖 | **无缓解** | 域名漂移、反爬、账号封禁会导致功能长期不可用,用户投诉指向 HPF-Reader |

**架构建议(设计层,不含代码):**

1. **核心层只定义接口,不实现任何具体书源。** 定义 \`BookSource\` 抽象:能力声明(搜索/详情/下载/OPDS)、认证方式、速率预算、内容类型、合规标记(\`legal: public-domain | licensed | user-provided | unknown\`)。
2. **默认只内置合法书源**:Project Gutenberg、Standard Ebooks、Open Library / Internet Archive 的开放内容、OPDS(Calibre-Web / Kavli/Komga 自建库)。
3. **第三方插件走"用户自担责任"通道**:用户在设置中显式开启"允许加载第三方书源"开关,并在开启前显示风险告知与勾选确认;官方**不提供**任何指向盗版源的默认列表、链接或教程。
4. **合规标记可视化**:每个书源在 UI 上必须显示来源类型;命中 \`unknown\` 时给出"可能涉及版权风险,请自行确认"的提示。
5. **绝不代下载**:服务端不做"搜索→下载→转存"的代理;书籍文件只在用户设备上产生。
6. **上架版本与自编译版本的差异化**:上架版本移除第三方插件加载能力;社区版本(仅自编译/GitHub Releases)保留。这一点**必须在法务评估后再定**,不要自行决定。
7. **决策权交给用户**:报告建议把"是否内置 Z-Library"作为一个**明确的用户决策点**写入 \`docs/OPEN-QUESTIONS.md\`。

### B.3.5 替代的合法书源(建议优先实现)

| 书源 | 内容性质 | 接口/接入方式 | 许可证/条款 | 证据 |
| --- | --- | --- | --- | --- |
| **Project Gutenberg** | 7.5 万+ 公有领域电子书 | 有站点与 OPDS/RDF 目录;有明确的机器人访问政策页 | 站点内容多为公有领域(依当地法律);**机器人抓取需遵守其 robot_access 政策** | https://www.gutenberg.org/policy/robot_access.html (抓取日 2026-11-02,页面标题 "Robot Access to Pages";meta 描述 "over 75,000 free eBooks. No fees, no registration, no ads") |
| **Standard Ebooks** | 志愿者制作的公有领域精校电子书 | 提供 OPDS 与 Atom feed(\`/feeds/opds/new-releases\`) | about 页明示:"The text and cover art ... already believed to be in the public domain, and Standard Ebook dedicates its own work to the public domain, thus releasing the entirety of each ebook file into the public domain." | https://standardebooks.org/about (抓取日 2026-11-02,一手元数据) |
| **Open Library / Internet Archive** | 书目元数据 + 可借阅扫描件 | 有公开 API(元数据)与受控数字借阅(CDL) | 元数据开放;借阅有 DRM/借期约束 | **本次不可达(\`openlibrary.org\`、\`archive.org\` 均超时)→ API 细节未验证** |
| **商业合法 API** | 新书/畅销书 | 需商务合作(如各家发行平台) | 商业合同 | 未调研(超出本次任务范围) |
| **自建库(OPDS)** | 用户自有藏书 | Calibre-Web / Kavita / Komga 的 OPDS | 各自开源许可 | 由 task-2(后端调研)覆盖,本文不重复 |

### B.3.6 Z-Library 章节的明确决策建议

| 选项 | 建议 | 理由 |
| --- | --- | --- |
| **A. 主应用内置 Z-Library 搜索/下载** | **否决** | 法务风险最高;直接导致 App Store / Google Play 审核不可预期;把不可控的域名/反爬问题变成产品稳定性问题 |
| **B. 官方插件市场提供 Z-Library 插件** | **否决(至少一期)** | "官方提供"是最容易被认定为帮助侵权的形态;商店审核同样过不去 |
| **C. 只提供通用书源接口 + 允许用户自行加载第三方插件** | **备选** | 法律定位最接近"通用工具";但需用户明确授权、官方零指引、上架版本可能仍需剥离该能力 |
| **D. 完全不做书源插件,只内置合法书源** | **首选(一期)** | 风险最低、审核最稳、工程量最小;等法务意见明确后再考虑 C |
| **E. 用户手动导入自己的文件** | **首选(并行)** | 零风险、用户覆盖最广(本地文件 + 自有网盘/OPDS) |

---

# C. LLM 高级功能:翻译 / 实体归一化 / 辅助理解

## C.1 功能分解与优先级

| 子功能 | 用户价值 | 技术难度 | 成本敏感度 | 建议期次 |
| --- | --- | --- | --- | --- |
| 划词翻译(单段/单句) | 高 | 低 | 低(每次几百 token) | **一期** |
| 段落/整章双语对照翻译 | 高 | 中 | 中 | **一期** |
| 术语表/词典注入 | 中高 | 中 | 低 | 一期(与上同期) |
| 章节摘要 | 中高 | 低 | 中 | **二期** |
| 人名/术语归一化 + 别名聚类 | 高(长篇阅读体验关键) | **高** | 中 | 二期 |
| 人物关系图 | 中 | 高 | 中 | 三期 |
| 书籍问答(RAG) | 高 | 中高 | 中高(索引+检索+生成) | 二期 |
| 背景知识/典故解释 | 中 | 低 | 低 | 二期 |
| 整书"深度理解"报告 | 低(演示性强) | 中 | **高** | 三期 |

## C.2 翻译

### C.2.1 粒度与对齐算法

| 粒度 | 实现方式 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 划词/选区 | 直接把选中文本送模型 | 成本最低、响应最快 | 无语境,人名/代词指代易错 |
| 段落级(**推荐一期**) | 以 EPUB 的块级元素(通常是 \`<p>\`)为最小单元,逐段翻译 | 可精确回填、可缓存、失败可重试单元最小 | 长段可能超小模型输出上限,需按句切分 |
| 章节级 | 整章一次性送 | 语境最好 | 输出 token 爆炸、失败重试代价高、超长章节必截断 |
| 整书级 | 章节级 + 术语表全局一致性 | 质量上限最高 | 成本与耗时最高,只适合"预翻译"场景 |

**双语对照对齐算法(工程建议):**
1. **块级锚定**:用 EPUB 的"块元素序号"或 DOM 路径作为对齐键(不要用字符偏移,重排后会漂移)。
2. **一对一优先**:一段原文 ↔ 一段译文。模型被要求返回与输入**等长的段落数组**(JSON 数组),长度不符即判为失败并重试。
3. **分句回退**:若某段过长(超阈值),先按句切分,翻译后按序拼回该段,仍保持块级一对一。
4. **CFI/进度锚点**:翻译结果缓存键 = \`书哈希 + 块路径 + 源文哈希 + prompt 版本\`;重排或换字体不影响缓存命中。
5. **展示**:双栏(左右)或上下对照;移动端默认"原文 + 点按显示译文"以省屏幕。

### C.2.2 离线模型 vs 云端 API

| 方案 | 质量 | 成本结构 | 隐私 | 平台可用性 | 适合场景 |
| --- | --- | --- | --- | --- | --- |
| 云端通用 LLM API | 高(可带术语表/风格指令) | 按 token 付费 | **书内容外发**,需用户授权 | 全平台(只需 HTTP) | **一期首选** |
| 云端专用翻译 API | 中高 | 按字符付费 | 同上网 | 全平台 | 成本敏感的批量翻译 |
| 设备端小模型(如 3B–8B 量化) | 中低 | 一次性下载 + 电费 | 完全本地 | **移动端受限**(内存/发热);桌面端可行 | 隐私敏感用户、离线场景 |
| 自托管服务端模型 | 中高 | GPU 固定成本 + 运维 | 可做到不外发第三方 | 需自有 GPU 服务器 | 用户量大到 API 费用超过 GPU 成本时 |

**结论:一期用云端 API + 严格用户授权;二期再评估"桌面端本地模型"作为隐私选项。移动端本地推理在 2026 年仍属于风险项(内存与热限制),不做工期承诺。**

### C.2.3 成本估算方法(按 100 万字量级)

**第一步:定义"100 万字"的计量口径。**
- 中文 100 万**汉字**;英文若按 100 万**字符**,约合 16–18 万英文单词。
- 本报告统一按 **100 万字符**估算,并给出区间。

**第二步:字符 → token 的换算(必须实测,以下为工程经验区间,非官方数字)。**
| 文本 | 经验换算 | 100 万字符 ≈ |
| --- | --- | --- |
| 中文 | 约 1 token / 1–1.5 汉字 | 约 **0.7M–1.0M input tokens** |
| 英文 | 约 1 token / 3.5–4 字符 | 约 **0.25M–0.3M input tokens** |
| 混合 | — | 约 **0.4M–0.8M input tokens** |

> 换算系数会随 tokenizer 变化,**上线前必须用目标模型的 tokenizer 实测**;这是全篇成本估算中最大的不确定来源。

**第三步:用官方价目表算钱(以下为 DeepSeek 官方定价页一手数据,抓取日 2026-11-02)。**
来源:https://api-docs.deepseek.com/quick_start/pricing

| 项目(每 1M tokens) | deepseek-flash 低峰 | deepseek-flash 高峰 | deepseek-v4-pro 低峰 | deepseek-v4-pro 高峰 |
| --- | --- | --- | --- | --- |
| 输入(缓存命中) | $0.003 | $0.006 | $0.022 | $0.044 |
| 输入(缓存未命中) | $0.15 | $0.30 | $0.66 | $1.32 |
| 输出 | $0.60 | $1.20 | $1.98 | $3.96 |

> 官方定义:低峰价 = 高峰价的一半;高峰时段为 **UTC 周一至周五 01:00–04:00 与 06:00–10:00**,其余时间(含周末与中国法定节假日全天)为低峰;模型上下文长度 **1M**,最大输出 **384K**;并发上限 flash 2500 / pro 500。另有 Search/Fetch 独立计费($0.75 / 1000 成功请求)。

**第四步:代入三种场景(假设输入 0.8M tokens、输出 ≈ 输入 × 1.0–1.5)。**

| 场景 | 模型/时段 | 输入成本 | 输出成本 | **合计(1 次整书翻译)** |
| --- | --- | --- | --- | --- |
| 最省(短输出、低峰、flash、缓存命中多) | flash 低峰 | 0.8M × $0.15 = $0.120 | 0.8M × $0.60 = $0.480 | **≈ $0.60** |
| 典型(英文书,0.3M 输入 / 0.45M 输出,低峰 flash) | flash 低峰 | 0.3 × $0.15 = $0.045 | 0.45 × $0.60 = $0.270 | **≈ $0.32** |
| 最贵(高峰、pro、1.2M 输出) | v4-pro 高峰 | 0.8M × $1.32 = $1.056 | 1.2M × $3.96 = $4.752 | **≈ $5.81** |

**第五步:加上"真实世界惩罚系数"。**
| 惩罚项 | 典型放大倍数 | 说明 |
| --- | --- | --- |
| 失败重试(段落级) | 1.1–1.3× | 只重试失败段,不是整书 |
| 上下文膨胀(带术语表/前文摘要) | 1.2–1.6× | 每段都附术语表会重复计费 |
| prompt 里塞入指令模板 | 1.05–1.15× | 指令是固定开销 |
| 用户在多个模型间对比 | 1.0–2.0× | 产品决策 |

**综合结论:100 万字符整书翻译,一次成本区间约 **$0.24**(英文、flash、低峰、无重试)到 **$3.96**(中文、pro、高峰、含重试)量级。缓存命中的输入几乎免费($0.003/M),因此**成本瓶颈是输出 token 与重试**,而不是输入。**

**降本手段(按收益排序):**
1. **段落级缓存 + 内容哈希**,同一段永不重复付费;
2. **术语表只发一次**(放在 system/前缀里,利用 prompt prefix 缓存),不要每段重发;
3. **低峰跑批**(官方低峰价为半价,工作日 UTC 01:00–04:00 / 06:00–10:00 为高峰,避开即可);
4. **按需翻译**(只在用户滚动到该章时翻译),而不是"打开整书就全译";
5. **档位路由**:普通段落用 flash,术语密集/文学性强的段落才升到 pro。

### C.2.4 流式渲染与体验

- 使用流式响应(SSE),按**句子边界**做增量渲染,避免半句抖动;
- 段落翻译与界面渲染解耦:先乐观渲染"翻译中…"占位,完成后替换;
- 失败段可单独重试,不阻塞整章;
- 提供"仅显示译文 / 仅原文 / 对照"三态切换。

## C.3 人名与术语归一化(跨语言一致性)

### C.3.1 问题定义

长篇(尤其俄/日/西语)小说中同一人物会有:全名、简称、昵称、尊称、音译变体、不同译者译名。若不归一化,翻译结果会出现"同一个人三个名字"。

### C.3.2 技术方案(分层,逐层可关闭)

| 层 | 方法 | 成本 | 局限 |
| --- | --- | --- | --- |
| L1 规则层 | 大小写/标点归一、去尊称(San/Gospodin/先生)、音译标准化 | 极低(本地) | 覆盖不了昵称/别名 |
| L2 NER | 通用 NER(本地或 API)抽人名/地名/组织 | 中 | 中文音译名识别弱 |
| L3 别名聚类 | 字符串相似(编辑距离/拼音/音译) + 上下文 embedding 相似 + 共现图连通分量 | 中高 | 需要调阈值,易误合并 |
| L4 LLM 裁定 | 把候选实体对 + 若干上下文片段交给 LLM 判定"是否同一人" | 中(只对不确定对调用) | 需要结构化输出与校验 |
| L5 译名库固化 | 用户确认后写入**书籍级术语表**(book glossary),后续翻译强制注入 | 低 | 需要 UI 支持确认/编辑 |

**关键设计:让 LLM 只做"裁定",不做"发现"。** 发现走 L1–L3(便宜、可解释),LLM 只处理高价值的不确定对(省钱且可审计)。

### C.3.3 跨语言 transliteration

| 方向 | 做法 | 风险 |
| --- | --- | --- |
| 拉丁 → 中文 | 依赖既有译名表(人名/地名标准化译名)优先,LLM 兜底 | 无权威表时译名不统一 |
| 西里尔/希腊/阿拉伯 → 拉丁 | ICU/CLDR 音译规则 | 人名习惯译法可能不符 |
| 日文假名/汉字 → 拉丁 | 罗马字转换 + 读音歧义 | 汉字多音,必须靠上下文 |
| 中文 → 拉丁 | 拼音 | 已有译名可能完全不同(如"孔子"→ Confucius) |

> 注意:**中文姓名转拼音不是"转写",而是"重拼"**;对外国人名的中文译名应以"约定俗成译名表"为最高优先级。

### C.3.4 阅读时如何展示

- 首次出现:显示原文 + 译名,悬浮/点按显示"实体卡片"(所有别名、首次出场章节、人物关系);
- 后续出现:只显示译名,提供"显示原文名"开关;
- 译名冲突:UI 标注"疑似同一人物,点击合并/拆分";
- **一致性校验**:翻译完成后做一次全书扫描,统计同一实体的不同译名出现次数,异常时提示用户。

## C.4 辅助理解(摘要 / 关系图 / RAG)

### C.4.1 章节摘要

- 输入:该章全文;输出:结构化 JSON(3–5 个要点 + 关键人物 + 关键事件);
- 预算:每章输入 5k–20k tokens、输出 200–600 tokens;一本 30 章的书 ≈ 0.3M 输入 / 12k 输出 → **按 flash 低峰约 $0.05 量级**;
- 摘要结果按 \`书哈希 + 章节 + prompt 版本\` 缓存。

### C.4.2 人物关系图

| 步骤 | 做法 |
| --- | --- |
| 1 | 分章抽取"实体 A — 关系 — 实体 B"三元组(LLM,结构化输出) |
| 2 | 用别名聚类结果把 A/B 映射到规范实体 |
| 3 | 关系权重 = 出现次数 + 共现强度 |
| 4 | 前端用图布局渲染(力导向),支持按月/章时间轴过滤 |
| 5 | 冲突关系(前后矛盾)保留并标注,不自动"修正" |

### C.4.3 RAG 问答

| 决策点 | 本地索引 | 服务端索引 |
| --- | --- | --- |
| 隐私 | 最好(书籍不出设备) | 书籍内容会上传 |
| 成本 | 设备算力(embedding 可行,重排吃力) | 服务器成本 |
| 多设备 | 需自行同步索引 | 天然共享 |
| 适用 | 隐私敏感 / 单机用户 | 多端用户 / 弱设备 |
| **建议** | **一期做本地索引**(embedding 小模型可在客户端跑) | 二期提供可选服务端索引 |

**RAG 成本公式(按一本书估算):**
- \`索引成本 = (书 token 数 / chunk 大小) × embedding 单价\`
- \`检索成本 = 每次查询 (top-k × chunk token + 问题 token) × 输入单价\`
- \`生成成本 = 输出 token × 输出单价\`
- 例:一本 30 万字中文 ≈ 0.3M tokens,chunk=500 tokens → 600 个 chunk;若 embedding 单价为 $0.02/M(示例值,**未验证具体厂商价格**),索引成本 ≈ $0.006,可忽略;
- 真正的成本在**对话轮次**:每轮带 4–6 个 chunk(约 2k–3k tokens)输入。按 100 轮问答估约 0.3M 输入 + 0.05M 输出 → **flash 低峰约 $0.08**。

**上下文窗口策略:** 不要"整书塞进 1M 上下文"。即使 1M 上下文可行(DeepSeek 当前模型支持),整书输入会把每轮都变成 0.8M tokens 的计费,而且长上下文下模型对中段信息的利用率会下降。**正确做法是 RAG 检索 + 章节摘要 + 术语表三层拼装。**

## C.5 工程要点(决定"能不能上线"的细节)

| 要点 | 建议做法 |
| --- | --- |
| 并发与限流 | 全局令牌桶 + 按 provider 分桶;遵守各家并发上限(DeepSeek 官方:flash 2500 / pro 500) |
| 失败重试 | 段落级重试;区分"可重试"(429/5xx/超时)与"不可重试"(400/内容违规);指数退避 + 抖动;上限后标记该段失败并继续 |
| 缓存 | 三级:段落级(内容哈希)→ 章节级 → 书籍级;缓存键必须含 **prompt 版本号**与模型名 |
| Prompt 版本管理 | 每个 prompt 模板带 \`id + semver\`;存储翻译结果时记录 prompt id/版本;**改 prompt 即视为缓存失效** |
| 多模型路由与降级 | 抽象 provider 接口;主模型失败降级到备用模型;记录"降级率"指标;不允许静默降质(要在 UI 上告知) |
| 结构化输出 | 强制 JSON schema + 校验;校验失败即重试(最多 N 次),不要把畸形输出渲染给用户 |
| 成本闸门 | 每用户每日/每月 token 预算;超限降级为"仅划词翻译";显示用量 |
| 隐私 | **默认关闭**所有外发功能;首次开启弹窗明确列出"哪些数据会发送给哪个 provider";支持"仅本地模型"模式;提供"一键清除所有已发送缓存" |
| 用户授权与开关 | 全局开关 + 按功能开关 + 按书开关;关闭后立即停止外发 |
| 内容安全 | 书籍内容可能含版权保护文本;**外发即构成向第三方传输**,必须写进隐私政策 |
| 可观测性 | 记录 token 用量、时延、失败率、缓存命中率;这些指标直接对应成本 |

---

# D. 推荐实现路径与分期建议

## D.1 分期表

| 期次 | 格式 | 书源 | LLM | 验收标准 |
| --- | --- | --- | --- | --- |
| **P0(地基)** | 复用 foliate-js:EPUB/TXT/MOBI/KF8/FB2/CBZ/HTML/MD;TXT 编码探测 + 自动分章 | 仅**本地文件导入** | 无 | 能稳定打开 10 种格式样本;无 DRM 内容报错清晰 |
| **P1** | + PDF(pdf.js 文本层);大文件流式 | + 合法书源:Gutenberg / Standard Ebooks(OPDS) | **划词翻译 + 段落双语对照 + 术语表**;云端 API;严格授权开关 | 100 万字符翻译成本可复现,偏差 < 30% |
| **P2** | + DOCX(mammoth);扫描件 OCR(服务端优先) | + 用户自建 OPDS(Calibre-Web/Kavita/Komga) | + 章节摘要 + 书籍问答(RAG,本地索引)+ 背景知识 | RAG 回答有原文出处引用 |
| **P3** | + CBR(需法务确认);更多编解码 | + **通用书源插件接口**(零官方盗版源;是否上架由法务定) | + 人名/术语归一化(L1–L5)+ 关系图 + 一致性校验 | 同一人物译名一致率显著提升并可人工修正 |
| **P4(可选)** | — | — | + 桌面端本地模型选项;可选服务端索引 | 本地模式可完全离线 |

## D.2 "外包 API 还是自托管模型"?

| 判据 | 外包云端 API(首选) | 自托管模型 |
| --- | --- | --- |
| 启动成本 | 极低(一个 key) | 高(GPU/运维/模型选型) |
| 单位成本 | 随用量线性增长 | 用量大时边际成本低 |
| 质量 | 最好(大模型) | 需选型与调优 |
| 隐私 | 内容外发 | 可完全本地 |
| 峰值弹性 | 有并发上限,但可多 provider | 受自有 GPU 限制 |
| **建议** | **P1–P3 全部走云端 API** | **仅当"月 API 支出 > GPU 月成本"或"隐私成为硬需求"时启动** |

**明确的财务触发线(建议写入决策文档):**当**月度翻译+问答 API 支出持续 3 个月超过**"一台可承载目标 QPS 的 GPU 服务器月成本 + 0.5 人力运维成本"时,再评估自托管。具体金额需用户提供用户量假设后才能测算(task-2 的成本章节可复用该口径)。

## D.3 与其它任务的边界

- **渲染/框架选型** → 见 \`docs/research/10-client-frontend.md\`(task-1);本文只给"解析层选 foliate-js"的结论。
- **同步/多用户/书库存储** → 见 \`docs/research/20-backend-sync.md\`(task-2);本文的 LLM 缓存与索引的**服务端落点**需与该文档的表结构对齐。
- **是否内置 Z-Library / 是否允许第三方书源插件** → 建议列入 \`docs/OPEN-QUESTIONS.md\`,由用户 + 法务决策。

---

# E. 未验证项清单(必须显式声明)

| # | 未验证内容 | 原因 |
| --- | --- | --- |
| 1 | Apple App Store 审核指南"Intellectual Property / 5.2"逐字条款 | \`developer.apple.com\` 页面正文由脚本注入,抓取结果不含条款文本 |
| 2 | Google Play 开发者政策中盗版相关逐字条款 | \`developer.android.com\`/\`play.google\`/\`support.google.com\` 全部超时或不可达 |
| 3 | Z-Library 遭执法/诉讼的具体案情与判决细节 | 维基与新闻站点在调研环境不可达 |
| 4 | "Legado 作者因分享书源被判刑" | 知乎原页 403,未取得裁判文书或官方通报 → **传闻,不可引用** |
| 5 | Z-Library Tor 洋葱站 / IPFS 镜像的当前可用性 | 未取得一手来源 |
| 6 | EAPI 的具体 endpoint 路径与 JSON 字段名 | 未读取官方接口文档(并不存在官方文档);社区实现细节未逐字段核实 |
| 7 | Z-Library 每日下载配额的确切数值 | 仅确认"存在配额",未见官方数字 |
| 8 | MuPDF 商业许可的具体条款与价格 | 未获取报价页 |
| 9 | CBR/UnRAR 许可条款的准确边界 | 未取得 UnRAR 许可原文 |
| 10 | CBZ 在 foliate-js 之外是否有成熟 TS 库 | 本次未逐一核实,npm 搜索未完成 |
| 11 | LibreOffice/其他 OCR 方案的跨端可用性 | 超出本次范围 |
| 12 | OpenAI / Anthropic / Google 的当前 API 价格 | 相关页面为 JS 渲染或不可达,仅取得 DeepSeek 一手价格 |
| 13 | EPUB Adobe 字体混淆算法的逐字实现细节 | foliate-js README 未给出,未读源码 |
| 14 | 中日文 tokenizer 的精确字符/token 比 | 需用目标模型 tokenizer 实测 |

---

# F. 参考来源汇总(均在 2026-11-02 抓取)

| 来源 | 用途 | 链接 |
| --- | --- | --- |
| foliate-js README / package.json | 格式支持、限制、MIT 许可 | https://github.com/johnfactotum/foliate-js |
| Readest README | 格式列表、Next.js 16 + Tauri v2 定位 | https://github.com/readest/readest |
| Readest 仓库 API | AGPL-3.0、活跃度 | https://api.github.com/repos/readest/readest |
| libmobi README / COPYING | MOBI/AZW 能力、LGPL-3.0 | https://github.com/bfabiszewski/libmobi |
| KindleUnpack README / COPYING.txt | KF8 解包边界、GPL-3.0 | https://github.com/kevinhendricks/KindleUnpack |
| pdf.js LICENSE | Apache-2.0 | https://github.com/mozilla/pdf.js |
| MuPDF COPYING | AGPL-3.0 | https://github.com/ArtifexSoftware/mupdf |
| PDFium LICENSE | BSD-3-Clause 风格;仓库已归档 | https://github.com/chromium/pdfium |
| mammoth / dolanmiu-docx | DOCX 转换 | https://github.com/mwilliamson/mammoth.js |
| tesseract.js | WASM OCR、Apache-2.0 | https://www.npmjs.com/package/tesseract.js |
| jschardet / chardet / iconv-lite | 编码探测与解码 | https://www.npmjs.com/package/jschardet |
| markdown-it / unified | Markdown 渲染 | https://www.npmjs.com/package/markdown-it |
| @zip.js/zip.js / fflate | CBZ/EPUB 容器解压 | https://www.npmjs.com/package/@zip.js/zip.js |
| heartleo/zlib(CLI) | EAPI、doctor、配额、反爬现象 | https://github.com/heartleo/zlib |
| ZlibraryKO/zlibrary.koplugin | 会话 Cookie(remix_userid/userkey)、域名自发现 | https://github.com/ZlibraryKO/zlibrary.koplugin |
| dstark5/Openlib README | Google Play 明确违规的同类先例 | https://github.com/dstark5/Openlib |
| DeepSeek API Docs — Models & Pricing | **全部 LLM 成本计算的价目表来源** | https://api-docs.deepseek.com/quick_start/pricing |
| Project Gutenberg Robot Access | 合法书源与抓取政策 | https://www.gutenberg.org/policy/robot_access.html |
| Standard Ebooks About | 公有领域声明、OPDS feed | https://standardebooks.org/about |
| Legado 官网下载页 | Google Play 版本"已被下架"字样(二手索引) | https://gedoor.github.io/download |

---

**文档结束。所有未取得一手来源的结论已在正文与第 E 章显式标注为「未验证」,请勿把未验证项当作事实用于决策。**
