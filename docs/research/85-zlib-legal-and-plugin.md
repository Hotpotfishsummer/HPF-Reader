# HPF-Reader 调研报告 85:Z-Library 法律/可达性现状 + 书源插件框架合规设计

- 调研日期:**2026-11-03**(北京时间;以下所有「抓取日期」均为实际读取页面的日期,与网页自身发布日期分开标注)
- 范围:任务 A(Z-Library 法律与可达性)、任务 B(书源插件框架合规设计)
- 交付:仅本文档,未改动 `docs/research` 之外的任何文件,未写业务代码
- 取证方式:`mcp__searxng__searxng_web_search` / `web_url_read`;一手页面优先(政府/法院/检察院/Apple/OPDS 规范/GitHub 原始文件)

## 0. 取证可信度与不可达说明(先读这一段)

| 站点 | 状态 | 影响 |
| --- | --- | --- |
| `developer.apple.com/app-store/review/guidelines/` | 可达,正文已逐条取到 | Apple 条文为**已核实** |
| `specs.opds.io` / `opds.io` | 可达 | OPDS 规范为**已核实** |
| `chinacourt.cn`、`spp.gov.cn`(最高检)、`credit.dl.gov.cn`、`pazjw.gov.cn`、`ccct.net.cn`、`mhksfy.e-court.gov.cn` | 可达,条文/判例已取到 | 中国法律条文与判例为**已核实** |
| `github.com`(仓库页/原始文件) | 可达 | Legado 仓库现状、Calibre/KOReader/Foliate 机制为**已核实** |
| `en.wikipedia.org`、`web.archive.org`、`justice.gov`、`support.google.com`、`play.google.com`、`mp.weixin.qq.com` | 超时/403/需验证 | 相关结论标注**未验证**,只作旁证 |
| 搜索引擎 | SearXNG 对英文长查询返回大量不相关结果 | 英文议题改用 `web_url_read` 直取 |

**判读规则**:凡本报告写「已核实」= 我直接读到了一手页面的原文;写「未验证」= 只有二手报道或未能取得一手页;写「推断」= 基于已核实条文的法理推导,不是司法结论。

---

# 第一部分:Z-Library 的法律与可达性现状(截至 2026-11)

> 注意:本部分**刻意不提供任何 Z-Library 域名、镜像地址、访问方式或代理配置**。域名现状只做「数量与法律状态」的描述,不做可用性枚举。

## 1.1 一句话结论

| 议题 | 结论 | 状态 |
| --- | --- | --- |
| 是否仍在运营 | **仍在运营**。2026-06 起还上线了「白标镜像」功能,允许用户自建品牌化镜像站并分成 20% 捐赠收入 | 已核实(TorrentFreak 2026-06-08) |
| 美国刑事案进展 | 2022-10-21 纽约东区法院对 Anton Napolsky、Valeriia Ermakova 签发逮捕令并起诉(刑事版权侵权、电汇欺诈共谋、电汇欺诈、洗钱);2022-11-03 在阿根廷被捕;2024-07 法官批准引渡后二人**脱逃**,此后在逃;**2026-06 报道称 docket 已两年多无公开进展,案件实质冻结** | 已核实(TorrentFreak 2024-07-08、2026-06-08) |
| 域名状态 | 累计被查封域名数为**史上最多**(首轮约 140 个,2023-05、2023-11、2024-05 又有多轮);多国(英、法、印、德)有法院封锁令 | 已核实(TorrentFreak 2024-07-21) |
| 中国大陆可达性 | **不稳定/基本不可直连**。2024-04 官方博客称中国用户访问困难、新域名「很快被封」;2024-05 中国司法部门对站点、捐款渠道与社媒志愿者开展查处,微信/B 站账号 7 天内注销,微信/支付宝捐款通道永久停止 | 已核实(TorrentFreak 2024-05-07,引官方博客与微信公告英译) |
| 对本站的含义 | **不要内置、不要内置域名列表、不要做「自动换域名」逻辑**。理由见 1.3–1.5 | 推断(基于下述条文与判例) |

## 1.2 时间线(仅列可核实节点)

| 日期 | 事件 | 来源 |
| --- | --- | --- |
| 2022-10-21 | 纽约东区法院法官 Sanket J. Bulsara 签发逮捕令 | TorrentFreak 2024-07-08 |
| 2022-11-03 | 二人在阿根廷被拘留 | 同上 |
| 2022-11-04 | 美国 DOJ/FBI 开始查封 Z-Library 域名 | 同上 |
| 2022-11-17 | 联邦起诉书公开(刑事版权侵权、电汇欺诈共谋、电汇欺诈、洗钱) | TorrentFreak(该站 2022-11-17 报道,链接见于 2026-06 文中) |
| 2023-02-13 | 站点以「九头蛇」模式重回 clearnet | TorrentFreak 2023-02-13 |
| 2023-05-05 / 2023-11-08 | 又两轮域名查封 | TorrentFreak 2023-05-05 / 2023-11-08 |
| 2024-04-17 | 官方博客承认中国用户访问困难 | TorrentFreak 2024-05-07(引官方博客截图) |
| 2024-05 初 | 微信公告:因「中国司法部门对本站、捐款及社媒运营志愿者的查处」,大陆社媒账号 7 天内注销;微信/支付宝捐款永久停止 | TorrentFreak 2024-05-07(公告英译) |
| 2024-05-30 | 又一轮域名查封(含大量 .se 国别域名) | TorrentFreak 2024-07-21 |
| 2024-07-08 | 阿根廷法官批准引渡,二人随后脱离软禁出逃 | TorrentFreak 2024-07-08 |
| 2026-06-08 | 上线白标镜像(可自定义品牌、可设登录墙),镜像运营者分成 20% 捐赠(加密货币支付);报道称美国刑事案件 docket 两年多无公开进展 | TorrentFreak 2026-06-08 |
| 2026-10-24 | 该站仍是学术研究对象(有 AI 辅助论文引用了一篇并不存在的 TorrentFreak 文章) | TorrentFreak 2026-10-24 |

**来源 URL**
- https://torrentfreak.com/z-library-admins-escape-house-arrest-after-judge-approves-u-s-extradition-240708/ (发布 2024-07-08,抓取 2026-11-03)
- https://torrentfreak.com/z-library-confusion-as-official-social-media-announces-crackdown-in-china-240507/ (发布 2024-05-07,抓取 2026-11-03)
- https://torrentfreak.com/z-library-more-domains-seized-than-any-other-pirate-site-in-history-240721/ (发布 2024-07-21,抓取 2026-11-03)
- https://torrentfreak.com/z-library-lets-people-run-white-label-login-only-pirate-mirrors/ (发布 2026-06-08,抓取 2026-11-03)
- https://torrentfreak.com/tag/z-library/ (归档页,抓取 2026-11-03)

> **未验证**:美国 DOJ 原始新闻稿(`justice.gov`)与法院 docket 原文在本环境不可达(超时/403)。上述程序性事实来自 TorrentFreak 的一手报道,该站对法院文书有长期引用惯例,但**不能等同于判决书原文**。若需用于对外材料,须另行取得 PACER/法院文书。

## 1.3 中国大陆「提供工具帮助他人下载侵权电子书」的法律定性

### 1.3.1 直接命中本案的判例(最重要的一条)

**「×读」(即 Legado/开源阅读)开发者案 —— 2026 年判决,上海闵行区检察院公诉**

已核实要点(来自上海嘉定检察/闵行检察通报的转载与整理):
- 被告人葛某某、吴某某因**侵犯著作权罪**,分别被判处**有期徒刑二年、一年九个月**,各并处罚金;
- 非法获利 100 余万元,侵权近 **4000 部**文学作品(与权利人独家信息网络传播权作品相似度 >90%);
- 葛某某主动退缴 120 万元、吴某某退缴 20 万元;
- 关键事实链:用户从微信公众号/QQ 群获取「**书源**」文件 → 导入软件 → **无需跳转即可在软件内读完本盗版小说**;
- 检察机关定性工具:**「深度链接」+「用户感知标准」**——「书源」文件「本质上是一个个预设了抓取规则的深度链接指令包」;被告人「提供链接工具(软件和规则),更通过运营的多个网络社群,系统性地搜集、整理、发布和推荐这些『书源』」;
- 检察官原话:「葛某某的行为客观上**架空了权利人对其作品传播渠道与使用方式的有效控制**,是网络侵权技术升级的典型表现。」

来源:
- https://www.appinn.com/xxdu-app-developers-jailed-for-copyright-infringement/ (发布 2026-05-30,转载并大段摘录「闵行检察」2026-03-24 原文,抓取 2026-11-03)
- 原始通报:闵行检察微信公众号 https://mp.weixin.qq.com/s/noePG3iG9gOWUXgAPK9P_g (**未验证**:本环境被微信「环境异常」验证页拦截,仅有转载全文)

> **对本项目的直接含义**:本项目「Go 后端 + Vue 前端 + 书源插件」的形态,与本案被定罪的行为形态**高度同构**——同样是「不存储内容、只提供规则去抓取并渲染进自己的阅读界面」。本案说明:**在中国大陆,这个形态已经被实际判过刑,不是理论风险**。

### 1.3.2 刑事路径:刑法第 217 条(侵犯著作权罪)

条文原文(最高人民检察院网站「法条链接」栏目,已核实):

> **第二百一十七条【侵犯著作权罪】** 以营利为目的,有下列侵犯著作权或者与著作权有关的权利的情形之一,违法所得数额较大或者有其他严重情节的,处三年以下有期徒刑,并处或者单处罚金;违法所得数额巨大或者有其他特别严重情节的,处三年以上十年以下有期徒刑,并处罚金:
> (一)未经著作权人许可,**复制发行、通过信息网络向公众传播**其文字作品、音乐、美术、视听作品、计算机软件及法律、行政法规规定的其他作品的;
> ……
> (六)未经著作权人或者与著作权有关的权利人许可,故意避开或者破坏权利人为其作品……采取的保护著作权或者与著作权有关的权利的技术措施的。

来源:https://www.spp.gov.cn/zdgz/202504/t20250422_693634.shtml (发布 2025-04-22,抓取 2026-11-03)

**入罪门槛(法释〔2025〕5 号,2025-04-26 施行,已核实)**

《最高人民法院、最高人民检察院关于办理侵犯知识产权刑事案件适用法律若干问题的解释》(法释〔2025〕5 号)第十三条:

> 实施刑法第二百一十七条规定的侵犯著作权……的行为,**违法所得数额在三万元以上的**,应当认定为「违法所得数额较大」;具有下列情形之一的,应当认定为「其他严重情节」:
> (一)非法经营数额在五万元以上的;
> (二)二年内因实施……受过刑事处罚或者行政处罚后再次实施,违法所得数额在二万元以上或者非法经营数额在三万元以上的;
> (三)复制发行他人作品……复制件数量合计在五百份(张)以上的;
> (四)**通过信息网络向公众传播他人作品……数量合计在五百件(部)以上的,或者下载数量达到一万次以上的,或者被点击数量达到十万次以上的,或者以会员制方式传播,注册会员数量达到一千人以上的**;
> (五)其他情节严重的情形。

同解释第十一条、第十二条明确:
- 「未经著作权人许可」包含**超出授权许可范围**;
- 「通过信息网络向公众传播」= 「以有线或者无线的方式向公众提供,使公众可以在其选定的时间和地点获得作品」。

同解释**第二十二条(共犯条款)**:

> **明知他人实施侵犯知识产权犯罪,具有下列行为之一的,以共同犯罪论处**,但法律和司法解释另有规定的除外:
> (一)提供生产、制造侵权产品的主要原材料……生产技术、配方等帮助的;
> (二)提供贷款、资金、账号、许可证件、支付结算等服务的;
> (三)提供生产、经营场所或者运输、仓储、保管、快递、邮寄等服务的;
> (四)**提供互联网接入、服务器托管、网络存储、通讯传输等技术支持的**;
> (五)**其他帮助侵犯知识产权犯罪的情形**。

来源:https://www.chinacourt.cn/article/detail/2025/04/id/8809673.shtml (发布 2025-04-24,抓取 2026-11-03;该页为发布会通稿 + 全文)

> 法理映射(推断):若本站内置/分发指向盗版站点的书源规则,或提供「自动发现书源」的在线仓库,则同时落入 217 条(一)「通过信息网络向公众传播」与第二十二条(四)(五)「提供技术支持/其他帮助」的射程。**是否「以营利为目的」、传播数量是否达 500 部/1 万次下载/10 万次点击,是量刑分水岭,不是有无罪的分水岭。**

### 1.3.3 民事路径:帮助侵权(三层规范)

**(1)民法典第 1169 条(帮助侵权的一般规则)**

> 第一千一百六十九条 **教唆、帮助他人实施侵权行为的,应当与行为人承担连带责任。**

来源:http://www.gsgz.gov.cn/gzzfxxgk/xzjdxxgk/dzz/ggflfw_7115/202607/t20260723_1566673.html (政府信息公开页,发布 2026-07-23,抓取 2026-11-03)

**(2)最高人民法院《关于审理侵害信息网络传播权民事纠纷案件适用法律若干问题的规定》第七条、第八条、第九条**

> **第七条** 网络服务提供者在提供网络服务时**教唆或者帮助网络用户实施侵害信息网络传播权行为**的,人民法院应当判令其承担侵权责任。
> 网络服务提供者以言语、**推介技术支持**、奖励积分等方式诱导、鼓励网络用户实施侵害信息网络传播权行为的,人民法院应当认定其构成**教唆侵权行为**。
> 网络服务提供者明知或者应知网络用户利用网络服务侵害信息网络传播权,**未采取删除、屏蔽、断开链接等必要措施,或者提供技术支持等帮助行为**的,人民法院应当认定其构成**帮助侵权行为**。
>
> **第八条** ……网络服务提供者**未对网络用户侵害信息网络传播权的行为主动进行审查的,人民法院不应据此认定其具有过错**。网络服务提供者能够证明已采取合理、有效的技术措施,仍难以发现……的,人民法院应当认定其不具有过错。
>
> **第九条** ……认定「应知」的综合因素:(一)服务性质、方式及引发侵权的可能性大小;(二)作品的类型、知名度及**侵权信息的明显程度**;(三)**是否主动对作品进行了选择、编辑、修改、推荐等**;(四)是否积极采取了预防侵权的合理措施;(五)是否设置便捷程序接收侵权通知并及时反应;(六)是否针对同一用户的重复侵权行为采取了合理措施;(七)其他。

来源:https://credit.dl.gov.cn/credit-portal/dl/article/detail/817327 (来源标注「中国网信网」,发布 2020-12-29,抓取 2026-11-03)

> 注意第八条第二款:**「未主动审查」本身不构成过错**——这是设计上的重要空间(见 2.6)。但第九条(三)「主动选择、编辑、推荐」会把「官方书源商店/推荐榜单」直接推入「应知」。

**(3)《信息网络传播权保护条例》第二十三条(链接服务的避风港)**

> **第二十三条** 网络服务提供者为服务对象提供**搜索或者链接服务**,在接到权利人的通知书后,根据本条例规定断开与侵权的作品……的链接的,**不承担赔偿责任**;但是,**明知或者应知所链接的作品……侵权的,应当承担共同侵权责任**。

来源:https://www.gov.cn/zhengce/2006-05/29/content_2602449.htm (国务院令第 468 号,2006-07-01 施行,抓取 2026-11-03)

**(4)真实民事判例(链接服务构成帮助侵权)**

温州市鹿城区人民法院,「着迷」APP 提供盗版影视网站链接案:
- 法院认定:被告「明知或者应知被链接网站存在侵害相关作品信息网络传播权的行为,仍提供搜索、链接的网络技术服务……**构成帮助侵权**」;
- 赔偿 8000 元(考虑作品知名度、热播期等因素);
- 法官说理要点:被告系经营性互联网文化单位,「对电视剧版权问题的注意标准应高于普通个人」,且「在提供链接服务时**未尽到合理的注意义务**」。

来源:https://www.pazjw.gov.cn/shuoan/202403/t20240326_26736173.shtml (浙江法治报,发布 2024-03-26,抓取 2026-11-03)

**(5)刑事判例:只提供链接也构成 217 条(网盘盗链案)**

上海嘉定检察院,常某某案(2026 年):
- 网站服务器**不存储任何作品文件**,仅编写程序抓取、保存他人网盘中的侵权作品链接,有偿提供搜索;
- 收录侵权作品 3000 余部,注册会员 6.9 万余人,非法经营数额 200 余万元;
- 判决:**侵犯著作权罪,有期徒刑二年八个月,缓刑二年八个月,罚金 120 万元**;
- 检察官定性:「这种模式实质上是通过网络技术手段,实施了刑法第二百一十七条中未经著作权人许可『**通过信息网络向公众传播**』的行为。」

来源:https://www.ccct.net.cn/html/bqzx/2026/0429/6727.html (湖北省宣传事业发展中心转载上海市检察院/嘉定检察,发布 2026-04-29,抓取 2026-11-03)

### 1.3.4 结论表(法律定性)

| 场景 | 民事 | 刑事 | 状态 |
| --- | --- | --- | --- |
| 用户**自己**写规则、自己导入、只自用 | 用户个人追责实务上极少;**软件方**通常主张工具中立 | 一般不入罪(无以营利为目的、无规模传播) | 推断 |
| 软件**内置**指向盗版站点的书源 | 高概率帮助侵权(民法典 1169 + 司法解释 7 条 + 条例 23 条) | 若具备营利目的 + 传播量达标 → 217 条(一)及解释 22 条共犯 | 推断(有 1.3.1 直接判例支撑) |
| 软件方**运营书源仓库/推荐榜单/社群分发** | 直接落入司法解释 9 条(三)「主动选择、编辑、推荐」→ 认定「应知」 | **已实际判刑**(葛某某、吴某某案) | **已核实判例** |
| 软件方**收钱/会员/广告分成** | 司法解释 11 条「直接获得经济利益」→ 更高注意义务 | 满足「以营利为目的」要件 | 已核实条文 |
| 软件方**做域名自动漂移/反封锁** | 可能额外触及技术措施条款(217 条(六))与规避封锁 | 加重情节 | 推断 |

> **不确定/需法务确认**:①「提供规则格式(DSL)本身」与「提供具体规则内容」的界线,中国目前**没有**像美国 Sony/Betamax 或 Grokster 那样的明确「实质性非侵权用途」抗辩成文法;②个人自用是否会被追责,缺少公开判例;③若仅支持 OPDS(标准协议、指向权利人自建目录),风险显著低于自定义抓取规则,但**没有判例直接确认**。

## 1.4 应用商店政策条文原文

### 1.4.1 Apple App Store 审核指南(已核实,逐条原文)

来源:https://developer.apple.com/app-store/review/guidelines/ (抓取 2026-11-03;**页面未标注最近修订日期,未验证**)

> **5.2 Intellectual Property**
> Make sure your app only includes content that you created or that you have a license to use. Your app may be removed if you have stepped over the line and used content without permission.
>
> **5.2.1 Generally:** Do not use protected third-party material such as trademarks, copyrighted works, or patented ideas in your app without permission, and do not include misleading, false, or copycat representations, names, or metadata in your app bundle or developer name. Apps should be submitted by the person or legal entity that owns or has licensed the intellectual property and other relevant rights.
>
> **5.2.2 Third-Party Sites/Services:** If your app uses, accesses, monetizes access to, or displays content from a third-party service, ensure that you are specifically permitted to do so under the service's terms of use. **Authorization must be provided upon request.**
>
> **5.2.3 Audio/Video Downloading:** Apps should not **facilitate illegal file sharing** or include the ability to save, convert, or download media from third-party sources (such as Apple Music, YouTube, SoundCloud, Vimeo, etc.) without explicit authorization from those sources. Streaming of audio/video content may also violate Terms of Use, so be sure to check before your app accesses those services. Authorization must be provided upon request.

> 判读:
> - **5.2.2 是本书源功能最直接的一条**——「displays content from a third-party service」且「ensure that you are specifically permitted to do so under the service's terms of use」、「Authorization must be provided upon request」。即:审核员一旦问「这个书源网站授权你了吗」,你必须有答案。**盗版站点给不出授权,这条就是硬伤。**
> - **5.2.3 字面针对音视频**,但「facilitate illegal file sharing」的措辞在审核实践中常被类推到电子书下载;本报告**未找到** Apple 明文覆盖电子书的具体条款(**未验证**)。
> - 5.4 VPN 条款与「提供代理访问被封锁站点」相关:VPN 类应用须用 `NEVPNManager`、须组织开发者、须在需牌照地区提供牌照信息。**本项目若内置任何「绕过网络封锁」的能力,会同时踩到 5.4 与中国大陆法规。**

### 1.4.2 Google Play

**未验证**。`support.google.com/googleplay/.../answer/9888077`(Intellectual Property policy)与 `play.google.com/about/developer-content-policy/` 在本环境**持续超时**,`web.archive.org` 亦不可达,未能取得条文原文。

已知(来自公开常识,但**未在本环境核实,勿直接引用**):Google Play 开发者政策含 Intellectual Property 与 Deceptive Behavior 章节,禁止协助侵犯版权、禁止促成未经授权的受版权保护内容传播。**建议上线前由法务直接以 Play Console 内的政策文本为准**。

> 对本项目的实操建议:**首发只报 Apple + 国内安卓商店,不要报 Google Play**;或在国内商店版本中彻底移除书源功能(见 2.7 的双轨构建)。

## 1.5 中国大陆「可达性」的合规解读(不是技术解读)

- 事实层面(已核实):2024-04 起中国用户访问困难、新域名「很快被封」;2024-05 官方承认大陆社媒与捐款渠道被查处关停。
- 法律层面(已核实):《著作权法》第 4 条「著作权人……行使权利,不得违反宪法和法律,不得损害公共利益。**国家对作品的出版、传播依法进行监督管理**」(来源:https://hlipa.hlj.gov.cn/hlipa/c103159/202111/c00_31316463.shtml ,发布 2021-11-26,抓取 2026-11-03)。
- **结论(推断)**:在大陆,该站点处于「被持续封锁 + 被司法查处」的状态。任何「帮助用户稳定访问该站点」的功能(自动换域名、内置域名池、代理、镜像托管),在事实上是**规避监管**,在证据法上是**主观明知的直接证明**——这比「技术中立」抗辩重要得多。**因此本报告不给域名、不给访问方法,这不是信息缺失,是刻意取舍。**

---

# 第二部分:书源插件框架的合规设计

## 2.1 先说一个必须知道的事实:Legado 上游已经没了

**已核实(GitHub 仓库页,抓取 2026-11-03)**

- `https://github.com/gedoor/legado`(47.2k stars / 5.6k forks)当前**只剩 1 个 commit**,README 全文替换为一份法律公告:

> 本项目涉及侵权行为的违法,也为此承担了相应的法律责任,在此郑重发布公告,删除项目内容并规劝所有人:请立刻停止一切侵权相关行为,不要再效仿、从事、传播各类侵权活动,切勿触碰法律红线,不要抱有任何侥幸心理。
> (附「阅文知识产权保护公告」链接 https://mp.weixin.qq.com/s/bcTbqBQA1T0YoRwq76xcWQ )

- 时间线佐证:`https://github.com/CCSSNE/legado` 自述「开源阅读原版**最后一个版本 2026-04-27** da17bb2」,GPL-3.0,6,559 commits(抓取 2026-11-03)。
- 第三方记录:`https://zendot.org/en/posts/gedoor-legado`(2026-09-26)称「仓库被清空,只剩一份停止侵权公告」。

> **这是本报告最重要的战略输入**:Legado 的规则格式(下文 2.2)是**判例中被点名的侵权工具形态**。**照抄 Legado 的 DSL 设计 = 照抄一个已被定罪的设计**。HPF-Reader 若要做书源,必须做**结构性切割**,而不是「换个字段名」。

## 2.2 Legado 书源规则格式(结构说明,用于理解而非照抄)

**已核实**:规则文档 https://celeter.github.io/ (《阅读3.0(Legado)规则说明》,页面标注更新时间 2020-03-06,抓取 2026-11-03)

### 2.2.1 顶层字段(书源对象)

| 字段 | 含义 |
| --- | --- |
| `bookSourceName` / `bookSourceUrl` / `bookSourceGroup` | 名称 / 唯一标识(必填、不可重复)/ 分组 |
| `bookSourceType` | 0=文本,1=音频 |
| `enabled` / `enabledExplore` / `weight` / `customOrder` | 启用、发现页启用、权重排序 |
| `searchUrl` / `exploreUrl` | 搜索地址、发现地址,内含 `{{key}}` / `{{page}}` 模板 |
| `ruleSearch` / `ruleExplore` / `ruleBookInfo` / `ruleToc` / `ruleContent` | 五类子规则(JSON 对象) |
| `bookUrlPattern` / `loginUrl` / `header` | 书籍 URL 正则、登录地址、请求头 |

### 2.2.2 子规则字段

- `ruleSearch`: `bookList, name, author, kind, wordCount, lastChapter, intro, coverUrl, bookUrl`
- `ruleExplore`: 同上
- `ruleBookInfo`: `bookInfoInit`(预处理), name, author, kind, wordCount, lastChapter, intro, coverUrl, tocUrl
- `ruleToc`: `chapterList, chapterName, chapterUrl, isVip, nextTocUrl`
- `ruleContent`: `content, nextContentUrl, webJs, sourceRegex`

### 2.2.3 规则语言:一个「多方言 + 可执行 JS」的表达式系统

规则字符串按「特征头」分派到不同解析器(已核实,同一文档):

| 前缀 | 引擎 | 例 |
| --- | --- | --- |
| 无前缀 / `@css:` | Jsoup Default / CSS 选择器 | `class.odd.0@tag.a.0@text` |
| `@XPath:` 或 `//` | XPath 1.0(JsoupXpath) | `//div[@class="book-list"]/a` |
| `@json:` 或 `$.` | JSONPath(Jayway) | `$.data.books[*].title` |
| `@js:` / `{{...}}` / `result` | **Rhino JavaScript 引擎** | `@js:java.ajax(url)` |
| `:` 开头 | 正则 AllInOne | `:(.*?)\|(.*?)`(竖线需转义,此处为示例) |
| `##正则##替换` | 正则净化(循环替换) | |

连接符:`&&`(合并)、`||`(首个非空)、`%%`(交错);另有 `@put/@get`、`java.ajax/java.base64Decode/java.md5Encode/java.getString` 等宿主能力,以及 `webView:true`(用 WebView 加载页面,可执行站点 JS)、`webJs`(模拟鼠标点击)、`sourceRegex`(嗅探媒体地址)。

> **风险清单(这套设计的每一处都是合规负资产)**
> 1. **执行任意 JS**(Rhino + `java.ajax`)→ 书源 = 可远程执行的代码,等于给用户装了一个不可审计的下载器;
> 2. **`webView:true` + `webJs`** → 可过登录/过验证码/过反爬,天然是「破解技术措施」的入口(刑法 217 条(六)、条例 19 条(一));
> 3. **`sourceRegex` 嗅探** → 直接抓媒体流,把「阅读器」变成「下载器」;
> 4. **`exploreUrl` 发现页 + 榜单** → 正中司法解释 9 条(三)「主动选择、编辑、推荐」。
>
> 结论:**这套格式不能兼容,只能「结构上等价、能力上阉割」。**

## 2.3 其他阅读器的插件机制(对比)

| 项目 | 有无插件机制 | 机制性质 | 许可证 | 状态 |
| --- | --- | --- | --- | --- |
| **Calibre** | 有,且是核心架构 | **Python ZIP 包**,`__init__.py` 定义 `FileTypePlugin`/`InterfaceActionBase` 等基类,`calibre-customize -b .` 安装;插件即**任意 Python 代码** | GPL-3.0(项目) | 已核实(https://manual.calibre-ebook.com/zh_CN/creating_plugins.html ,抓取 2026-11-03) |
| **KOReader** | 有 | 目录级 `*.koplugin`(Lua 插件文件夹),README 明列 "extensible: via plugins";`plugins/` 下可见 `calibre.koplugin`、`cloudstorage.koplugin`、`coverbrowser.koplugin` 等 | **AGPL-3.0** | 已核实(https://raw.githubusercontent.com/koreader/koreader/master/README.md 与 https://github.com/koreader/koreader/tree/master/plugins ,抓取 2026-11-03) |
| **Foliate** | **无插件机制** | GTK4/gjs 应用,能力靠内置;在线内容走 **OPDS**(仓库 topics 含 `opds`) | GPL-3.0 | 已核实(https://raw.githubusercontent.com/johnfactotum/foliate/gtk4/README.md ,抓取 2026-11-03;README 全文无 plugin/extension 章节) |

> 判读:**三个成熟项目里,两个的插件机制都是「执行任意代码」(Python / Lua)**。这条路在桌面端可行(用户自负其责、无应用商店审核),但**在应用商店分发的移动端不可行**——Apple 5.2.2 要求「授权须应要求提供」,一个能跑任意代码的书源等于无法尽调。**Foliate 的选择(不做插件、只做 OPDS)是最保守也最省事的范式,值得直接抄。**

## 2.4 OPDS:能否作为「合法书源」的标准接入方式

**能,而且应当作为一等公民。** 理由:OPDS 是**标准协议**,服务端**主动发布**目录与获取链接,客户端只做「读 feed + 下载」,不涉及抓取第三方页面、不涉及解析对方私有接口、不涉及执行对方 JS。

### 2.4.1 规范 URL(已核实)

| 版本 | 规范地址 | 媒体类型 | 说明 |
| --- | --- | --- | --- |
| OPDS 1.2 | https://specs.opds.io/opds-1.2 | `application/atom+xml;profile=opds-catalog`(导航 feed 加 `;kind=navigation`) | Atom + HTTP,2018-11-11 发布(Wikipedia 记载,**未验证**) |
| OPDS 2.0 | https://specs.opds.io/opds-2.0 | `application/opds+json` | 基于 Readium Web Publication Manifest,JSON;living standard,核心自 2017 稳定 |
| 项目主页 | https://opds.io/ | — | 规范仓库 https://github.com/opds-community/specs |

OPDS 2.0 原文要点(已核实):feed **must** 含 `navigation` / `publications` / `groups` 之一的 collection、**must** 在 `metadata` 含 `title`、**must** 用 `self` link 自引用。

### 2.4.2 获取链接关系(acquisition relations,已核实于 OPDS 2.0 页)

| relation | 含义 |
| --- | --- |
| `http://opds-spec.org/acquisition/open-access` | **完全免费、无任何前置条件(含无需认证)** |
| `.../acquisition/borrow` | 限时借阅 |
| `.../acquisition/buy` | 付费购买 |
| `.../acquisition/sample` | 试读片段 |
| `.../acquisition/subscribe` | 订阅 |

> **合规抓手**:把「书源」的合法性判据落在 **`open-access` 关系**上——只有声明了 open-access 的条目才允许「直接加入书架并下载」;`borrow/buy/subscribe` 一律走**跳转浏览器/应用内购买**,本站不代下、不代存。这是**协议层可验证**的规则,而不是靠人肉判断。

## 2.5 声明式 JSON 规则引擎:字段设计草案

### 2.5.1 设计目标(与「不变通用爬虫」的边界)

| 要 | 不要 |
| --- | --- |
| 能覆盖 **JSON API / HTML 列表页 / RSS / OPDS** 四类合法来源 | 不执行任意 JS(无 Rhino、无 `eval`、无 `@js:`) |
| 能表达「翻页、详情、目录、正文」四段流程 | 无 WebView 加载、无 `webJs` 点击模拟、无验证码处理 |
| 规则**可静态审计**(纯数据,无副作用) | 无 `sourceRegex` 媒体嗅探、无 `java.ajax` 任意请求 |
| 网络出口**白名单化**(同域、限方法、限频率) | 不允许跨域任意跳转、不允许 POST 任意 body |
| 规则**带来源声明**(`license` / `authorization` 字段) | 不内置任何「发现/榜单/推荐」聚合 |

### 2.5.2 顶层 schema(草案)

```json
{
  "schemaVersion": "hpf-source/1",
  "id": "org.example.opds-demo",
  "name": "示例公开目录",
  "type": "opds" | "json-api" | "html-list" | "rss",
  "lang": ["zh-CN"],
  "license": {
    "declared": "open-access" | "public-domain" | "cc" | "authorized" | "unknown",
    "evidenceUrl": "https://…",
    "verifiedAt": "2026-11-03"
  },
  "endpoints": {
    "baseUrl": "https://example.org",
    "allowedHosts": ["example.org", "cdn.example.org"],
    "methods": ["GET"],
    "rateLimit": { "rps": 0.5, "burst": 3 },
    "robotsRespect": true
  },
  "flows": {
    "search":  { "url": "/search?q={keyword}&page={page}", "extract": {} },
    "detail":  { "url": "/book/{bookId}",                "extract": {} },
    "toc":     { "url": "/book/{bookId}/toc",            "extract": {} },
    "content": { "url": "/chapter/{chapterId}",          "extract": {} }
  },
  "paging": { "mode": "page-number", "maxPages": 20, "stopWhen": "empty-list" }
}
```

### 2.5.3 `extract` 节点:受限表达式(核心)

**只允许四种选择器,且必须是纯数据**:

| 选择器 | 语法 | 说明 |
| --- | --- | --- |
| `json` | RFC 9535 JSONPath(`$.items[*].title`) | **只读**,不支持函数扩展 |
| `css` | CSS Selector Level 3 子集 | 仅 `tag / .class / #id / [attr=v] / 后代 / 子代 / :nth-child` |
| `xpath` | XPath 1.0 子集(**禁止** `document()` / `doc()` / `collection()`) | 防 XXE / 防任意文件读 |
| `regex` | RE2 语法(线性时间,无回溯) | 防 ReDoS;仅用于**文本后处理**,不用于定位资源 |

**取值操作符(替代 JS)**:

```json
"extract": {
  "list":   { "css": "li.item" },
  "fields": {
    "title":  { "css": "a.title", "take": "text",  "trim": true },
    "author": { "css": "span.author", "take": "text", "default": "佚名" },
    "bookUrl":{ "css": "a.title", "take": "attr", "attr": "href", "resolve": "base" },
    "cover":  { "css": "img.cover", "take": "attr", "attr": "src", "resolve": "base" },
    "intro":  { "css": "div.intro", "take": "html", "sanitize": true }
  },
  "postprocess": [
    { "op": "regexReplace", "pattern": "全文阅读", "replacement": "" },
    { "op": "truncate", "maxChars": 5000 }
  ]
}
```

**关键约束(写进引擎,不是写进文档)**:
1. `resolve` 只允许 `base`(相对 baseUrl 解析),不允许 `absolute` 任意跳域;
2. `take` 枚举封闭:`text | html | attr | value`,**没有** `eval`;
3. `postprocess` 是**固定算子白名单**(`regexReplace / trim / truncate / normalizeWs / stripHtml`),不是脚本;
4. 所有 URL 模板变量**只有** `{keyword} {page} {bookId} {chapterId}` 四个,且**必须做 URL 编码**;
5. 整个规则对象**可序列化、可 diff、可签名**——这是「可审计」的前提。

### 2.5.4 明确「不做」的能力(反通用爬虫的硬边界)

| 能力 | 决定 | 理由 |
| --- | --- | --- |
| 执行 JS | 永不 | 葛某某案的核心定性就是「预设抓取规则的深度链接指令包」;再叠 JS 就是加强版 |
| WebView 加载 | 永不 | 过登录/过验证 = 破解技术措施(217 条(六)) |
| 自定义任意 Header / Cookie 注入 | 仅允许 UA + Accept-Language,且**不可由规则文件设置** | 防止规则变成「带凭证的抓取器」 |
| 媒体流嗅探(`.m3u8/.mp3` 正则) | 永不 | 直接把阅读器变下载器,踩 Apple 5.2.3 |
| 书源在线市场 / 榜单 / 推荐 | 永不 | 司法解释 9 条(三)「主动选择、编辑、推荐」是「应知」的加速器 |
| 域名自动漂移 / 备用域名池 | 永不 | 事实规避监管 + 主观明知的证据 |
| 用户导入任意 URL 的规则文件 | 仅允许**本地文件导入 + 显式二次确认**,且默认关闭 | 见 2.6 |
| 内置 OPDS 目录 | 允许 | 标准协议,服务端主动发布 |

### 2.5.5 引擎侧必须实现的合规机制

1. **`license.declared` 门禁**:`unknown` 的源**不允许「加入书架」**,只能「在浏览器中打开」;`open-access / public-domain / cc` 才允许下载与离线缓存。
2. **`robots.txt` 与 `rateLimit` 强制执行**,且**不可被规则文件覆盖**(写死在引擎里)。
3. **请求日志与可导出审计报告**:谁在什么时候请求了哪个 host、命中哪条规则——出问题时这是「已采取合理有效技术措施」的证据(司法解释 8 条第二款)。
4. **侵权通知响应通道**(`/abuse` 端点 + 邮箱 + 处理时限 SLA),对应条例 23 条「接到通知后断开链接即不承担赔偿责任」。
5. **规则签名/版本号**:每条规则带 `id@version@sha256`,便于「下架某条规则」并留痕。
6. **不做「全自动发现」**:新增源必须人工 review 并记录 `evidenceUrl`。

### 2.5.6 对 Legado 规则的可迁移性评估(诚实结论)

| Legado 能力 | 能否在本引擎表达 | 备注 |
| --- | --- | --- |
| `ruleSearch.bookList` (CSS/XPath/JSONPath) | 可 | 一一映射 |
| `{{key}} / {{page}}` 模板 | 可(改为 `{keyword}/{page}`) | 去掉 `{{(page-1)*20}}` 这类表达式 → 改为 `paging.offsetExpr` 声明式字段 |
| `##正则##替换` 净化 | 可(`postprocess.regexReplace`) | |
| `&&` / `||` 连接符 | 部分(`||` → `fallback: []` 数组;`&&` 不支持) | 合并语义很少用 |
| `@js:` / `{{js}}` | 不可 | **这是最大断层**,Legado 生态里大量源依赖 JS 拼 URL |
| `webView:true` / `webJs` | 不可 | 刻意不支持 |
| `sourceRegex` 嗅探 | 不可 | 刻意不支持 |
| `exploreUrl` 发现页 | 不提供聚合入口(单源内可保留「分类浏览」) | 见 2.5.4 |

> **现实预期**:按此设计,**Legado 现成书源里能直接迁移的比例很低(推断,未实测)**。这不是缺陷,是设计目标——**能迁移的那部分,恰好就是「合法公开目录」那部分**。

## 2.6 为什么「不主动审查」反而是安全区(条文级论证)

司法解释第八条第二款原文:**「网络服务提供者未对网络用户侵害信息网络传播权的行为主动进行审查的,人民法院不应据此认定其具有过错。」**

> 这意味着:
> - 可以做:提供规则格式 + 让用户自己写/自己导入 + 不做推荐 + 不做审查;
> - 不能做:官方维护书源仓库、做榜单、做「一键导入精选源」、做社群分发 —— 这些是葛某某案被定罪的**具体行为**,也正是第九条(三)的「应知」触发点。
>
> **一句话:引擎可以有,内容不能有;格式可以公开,规则不能官方发。** 这条界线是本案判例给出的,不是我编的。

## 2.7 落地建议(给工程的 5 条)

| # | 建议 | 依据 |
| --- | --- | --- |
| 1 | **双轨构建**:`store` 变体(应用商店版)**彻底不含书源引擎**,只有 OPDS + 本地文件 + 自带公版书库;`full` 变体(自分发/GitHub Release)才含声明式规则引擎 | Apple 5.2.2 要求「授权应要求提供」,商店版无法尽调 |
| 2 | 商店版**不出现** Z-Library、「书源」、「盗版」、「破解」等任何字样与图标,ASO 关键词也不要用 | 审核员会按关键词搜 |
| 3 | 引擎默认 `license.declared = unknown` 时**只读不存**,并显示「该来源未声明授权」的显著提示 | 对应 5.2.2 与司法解释 8 条 |
| 4 | 建立 `/abuse` 侵权通知流程 + 24h 内下架规则的 SOP,并保留处理记录 | 条例 23 条避风港 |
| 5 | **不实现**任何自动换域名/代理/镜像托管;文档里也不写 | 1.5 节的论证 |

---

## 附录 A:已核实 / 未验证 总表

### A.1 已核实(一手页面原文已读到)

| 断言 | 来源 URL | 页面日期 | 抓取日期 |
| --- | --- | --- | --- |
| 刑法 217 条全文 | https://www.spp.gov.cn/zdgz/202504/t20250422_693634.shtml | 2025-04-22 | 2026-11-03 |
| 法释〔2025〕5 号 11/12/13/22 条 | https://www.chinacourt.cn/article/detail/2025/04/id/8809673.shtml | 2025-04-24 | 2026-11-03 |
| 民法典 1169 条 | http://www.gsgz.gov.cn/gzzfxxgk/xzjdxxgk/dzz/ggflfw_7115/202607/t20260723_1566673.html | 2026-07-23 | 2026-11-03 |
| 信息网络传播权司法解释 7/8/9 条 | https://credit.dl.gov.cn/credit-portal/dl/article/detail/817327 | 2020-12-29 | 2026-11-03 |
| 信息网络传播权保护条例 22/23 条 | https://www.gov.cn/zhengce/2006-05/29/content_2602449.htm | 2006-05-29 | 2026-11-03 |
| 著作权法(2020 修正)第 4/10 条 | https://hlipa.hlj.gov.cn/hlipa/c103159/202111/c00_31316463.shtml | 2021-11-26 | 2026-11-03 |
| 「着迷」APP 帮助侵权判决 | https://www.pazjw.gov.cn/shuoan/202403/t20240326_26736173.shtml | 2024-03-26 | 2026-11-03 |
| 常某某网盘盗链案(217 条) | https://www.ccct.net.cn/html/bqzx/2026/0429/6727.html | 2026-04-29 | 2026-11-03 |
| 「×读」两开发者判刑(经转载) | https://www.appinn.com/xxdu-app-developers-jailed-for-copyright-infringement/ | 2026-05-30 | 2026-11-03 |
| Apple 5.2 / 5.2.1 / 5.2.2 / 5.2.3 / 5.4 原文 | https://developer.apple.com/app-store/review/guidelines/ | 未标注 | 2026-11-03 |
| OPDS 1.2 规范 | https://specs.opds.io/opds-1.2 | — | 2026-11-03 |
| OPDS 2.0 规范 + acquisition relations | https://specs.opds.io/opds-2.0 | — | 2026-11-03 |
| Legado 仓库现为法律公告 | https://github.com/gedoor/legado | 2026 年内 | 2026-11-03 |
| Legado 规则格式(全字段) | https://celeter.github.io/ | 2020-03-06 | 2026-11-03 |
| Calibre 插件 = Python ZIP | https://manual.calibre-ebook.com/zh_CN/creating_plugins.html | — | 2026-11-03 |
| KOReader `.koplugin` + AGPL | https://raw.githubusercontent.com/koreader/koreader/master/README.md | — | 2026-11-03 |
| Foliate 无插件机制 | https://raw.githubusercontent.com/johnfactotum/foliate/gtk4/README.md | — | 2026-11-03 |
| Z-Library 案件时间线/域名查封/中国区 | TorrentFreak 4 篇(URL 见 1.2) | 2024-07-08 / 2024-05-07 / 2024-07-21 / 2026-06-08 | 2026-11-03 |

### A.2 未验证(勿直接对外引用)

| 项 | 原因 |
| --- | --- |
| 美国 DOJ 新闻稿原文、法院 docket、判决书 | `justice.gov` 超时、`courtlistener` 403 |
| Google Play 知识产权政策条文原文 | `support.google.com` / `play.google.com` 持续超时,archive 不可达 |
| Apple 审核指南「最近修订日期」 | 页面未标注 |
| 闵行检察微信公众号原文(葛某某案第一手通报) | 微信「环境异常」验证页拦截,仅有二手全文转载 |
| 阅文知识产权保护公告原文 | 同上 |
| OPDS 1.2 发布日 2018-11-11 | 仅见 Wikipedia 记载,规范页未直接读到 |
| Legado 书源中「依赖 JS 的比例」 | 未实测,报告中的「比例很低」是推断 |
| Wikipedia 的 Z-Library 条目 | `en.wikipedia.org` 超时 |

---

## 附录 B:本报告刻意不做的事

1. **不提供任何 Z-Library 域名、镜像、访问方式、代理配置、Tor 地址。**(任务要求,也是 1.5 节的合规结论)
2. **不提供任何可直接使用的盗版书源规则。** 2.5 的 JSON 全部是 `example.org` 占位。
3. **不提供 Legado 规则格式的完整兼容实现方案。** 只做「能力对照表」,因为兼容实现约等于复制被定罪的设计。

---

*报告结束。所有「推断」项在上线前须由法务复核;中国大陆部分建议直接咨询熟悉著作权刑事案件的律师,尤其是 2.7 的双轨构建是否足以隔离商店版风险。*
