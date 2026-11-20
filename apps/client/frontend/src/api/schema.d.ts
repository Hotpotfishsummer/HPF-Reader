/**
 * 本文件由 scripts/gen-api-types.mjs 从 api/openapi.yaml 生成，请勿手改。
 * 重新生成: corepack pnpm run api:types
 */

export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 存活探针 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 注册 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** Format: email */
                        email: string;
                        password: string;
                        displayName?: string;
                        /** @description 会原样回显在 GET /v1/devices 的 name */
                        deviceName?: string;
                        /** @enum {string} */
                        platform?: "web" | "windows" | "macos" | "linux" | "android" | "ios";
                        /**
                         * Format: uuid
                         * @description 客户端生成的设备 ID。省略则服务端生成一个；
                         *     若已被其它账号占用返回 409（code=conflict），此时**不会**创建用户。
                         */
                        deviceId?: string;
                    };
                };
            };
            responses: {
                /** @description 已创建（用户与设备在同一事务内写入） */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthTokens"];
                    };
                };
                400: components["responses"]["BadRequest"];
                /**
                 * @description 注册已关闭（HPF_REGISTER_OPEN=false）。生产默认关闭：
                 *     开放注册 + 无邮箱验证 = 任何人可消耗 AI 配额与磁盘。
                 */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                /**
                 * @description 两种冲突，用 message 区分：邮箱已注册 / deviceId 已绑定其它账号。
                 *     deviceId 冲突时整个注册事务回滚，不会留下没有设备的用户。
                 */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 登录 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** Format: email */
                        email: string;
                        password: string;
                        deviceName?: string;
                    };
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthTokens"];
                    };
                };
                401: components["responses"]["Unauthorized"];
                /**
                 * @description 同一「邮箱 + 来源 IP」的失败次数超限，或触发全局认证限流。
                 *     注意：**口令正确时不会被这条规则拦下** —— 失败计数只影响错误口令，
                 *     因此任何人无法通过连续输错口令把别人的账号锁死。
                 *     账号级 failed_logins / locked_until 仍然写库用于审计，但不再阻断正确口令。
                 */
                429: components["responses"]["TooManyRequests"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 轮换刷新令牌 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        refreshToken: string;
                    };
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthTokens"];
                    };
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 登出（吊销 refresh token）
         * @description 允许空 body：此时只吊销 access token（客户端侧丢弃即可）。
         *     传 `refreshToken` 吊销该条；传 `allDevices: true` 吊销该账号全部会话。
         *
         *     因为空 body 是合法请求，客户端漏传 `allDevices` 时会**静默只登出一台**。
         *     需要「确定让所有设备下线」时请用 `POST /v1/auth/logout-all`。
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["LogoutRequest"];
                };
            };
            responses: {
                /** @description 已登出 */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 修改口令并吊销全部会话
         * @description 口令泄露后的**自救路径**。三个安全性质：
         *
         *     1. **必须提供当前口令**。只凭一个有效 access token 就允许改密，
         *        等于把「15 分钟内被偷到的 access token」升级成「永久接管账号」。
         *     2. **改密与吊销在同一个数据库事务里完成**。分成两步时会出现
         *        「口令换了但攻击者会话仍有效」（用户以为已安全）或
         *        「会话全掉了但旧口令仍有效」两种半成品，都不可接受。
         *     3. **新旧口令必须不同**。允许改成一样会让用户产生「我已经改过了」
         *        的假安全感，而旧口令实际依旧有效。
         *
         *     成功后该用户**全部** refresh token 被吊销（所有设备下线），
         *     access token 因不落库而无法逐个吊销，靠 15 分钟短 TTL 自然过期。
         *     客户端收到 204 后必须丢弃本地 token 并重新登录。
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["PasswordChangeRequest"];
                };
            };
            responses: {
                /**
                 * @description 口令已更新，该用户全部 refresh token 已吊销。
                 *     客户端必须丢弃本地 token 并重新登录。
                 */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                400: components["responses"]["BadRequest"];
                /**
                 * @description 未认证（缺 bearer / token 失效），或 `currentPassword` 校验失败
                 *     （code=`invalid_credentials`）。后者与登录失败共用同一套
                 *     「账号 + 来源 IP」失败计数，因此也可能返回 429。
                 */
                401: components["responses"]["Unauthorized"];
                429: components["responses"]["TooManyRequests"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/logout-all": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 吊销该账号全部 refresh token（所有设备下线）
         * @description 无请求体。与 `POST /v1/auth/logout` + `allDevices: true` 效果相同，
         *     但**不依赖客户端记得传参数**——一个不带 body 的 POST 就确定生效。
         *
         *     安全动作不应该建立在「客户端传对了字段」之上：登出接口允许空 body，
         *     漏传 `allDevices` 时只会静默登出一台设备。
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 全部会话已吊销 */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 当前用户 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["User"];
                    };
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 设备列表 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Device"][];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/books": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 书库列表 */
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                    updatedSince?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BookPage"];
                    };
                };
            };
        };
        put?: never;
        /** 创建书籍记录（随后上传文件） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["BookCreate"];
                };
            };
            responses: {
                /** @description 已创建 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Book"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/books/{bookId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                bookId: string;
            };
            cookie?: never;
        };
        /** 书籍详情 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    bookId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Book"];
                    };
                };
                404: components["responses"]["NotFound"];
            };
        };
        put?: never;
        post?: never;
        /** 删除书籍 */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    bookId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 已删除 */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        /** 更新元数据或阅读状态 */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    bookId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["BookUpdate"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Book"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/books/{bookId}/file": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                bookId: string;
            };
            cookie?: never;
        };
        /** 下载书籍文件（支持 Range） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    bookId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/octet-stream": string;
                    };
                };
                /** @description 部分内容 */
                206: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        /** 上传书籍文件（幂等：按 contentHash 去重） */
        put: {
            parameters: {
                query: {
                    /** @description 客户端计算的 sha256 */
                    contentHash: string;
                };
                header?: never;
                path: {
                    bookId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/octet-stream": string;
                };
            };
            responses: {
                /** @description 已存在（去重命中）：该 contentHash 对应的文件已在此账号下，未重复写入 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BookFileUploadResult"];
                    };
                };
                /** @description 已上传：文件已落盘，书籍记录已绑定 storageKey */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BookFileUploadResult"];
                    };
                };
                400: components["responses"]["BadRequest"];
                409: components["responses"]["Conflict"];
                413: components["responses"]["PayloadTooLarge"];
                /**
                 * @description 存储配额耗尽（users.quota_bytes）。秒传（deduplicated=true）同样受配额约束：
                 *     配额按「书架逻辑大小」计算，否则换个小号就能无限存书。
                 */
                507: components["responses"]["QuotaExceeded"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/push": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 推送本地变更（幂等，按 opId 去重） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["SyncPushRequest"];
                };
            };
            responses: {
                /**
                 * @description 整批全部拿到服务端裁决。每个 op 一定有一条 result，status 只会是 applied / duplicate / rejected。
                 *     reason 只在裁决非平凡时出现（duplicate / older_hlc / stale_no_rewind 等），普通 applied 不带 reason。
                 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SyncPushResponse"];
                    };
                };
                /**
                 * @description 整批被拒绝：至少一条 op 自身不合法（opId/entityId 非 UUID、entity/kind 未知、HLC 格式错误等）。
                 *     该批**没有任何一条被写入**（无半成品状态），details.ops[] 逐条指出 index/opId/field/message。
                 *     这是客户端数据问题，重试不会成功——必须先修正再重放整批。
                 */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/pull": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 拉取自 cursor 之后的变更（服务端权威结果） */
        get: {
            parameters: {
                query: {
                    /**
                     * @description 严格大于该 seq 的变更才会返回（半开区间 cursor, +∞）。
                     *     首次拉取传 0；之后每次都用上一次响应里的 cursor（不是 push 响应里的那个）。
                     */
                    cursor: number;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 服务端权威变更页。cursor 是**本页最后一条变更的 seq**；hasMore=true 时立即用该 cursor 续拉。 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SyncPullResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/books/{bookId}/annotations": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                bookId: string;
            };
            cookie?: never;
        };
        /** 标注列表 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    bookId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Annotation"][];
                    };
                };
            };
        };
        put?: never;
        /** 新建标注 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    bookId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["AnnotationCreate"];
                };
            };
            responses: {
                /** @description 已创建 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Annotation"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/annotations/{annotationId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                annotationId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 删除标注 */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    annotationId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 已删除 */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
                404: components["responses"]["NotFound"];
            };
        };
        options?: never;
        head?: never;
        /** 更新标注 */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    annotationId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["AnnotationCreate"];
                };
            };
            responses: {
                /** @description 已更新 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Annotation"];
                    };
                };
                401: components["responses"]["Unauthorized"];
                404: components["responses"]["NotFound"];
            };
        };
        trace?: never;
    };
    "/v1/ai/translate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 流式翻译（SSE）
         * @description 成本闸门：**在返回 200 与写入 SSE 之前**完成配额预扣。因此额度不足时
         *     得到的是标准 JSON 的 429，而不是一条已经开始吐字的流——一旦写了 200，
         *     HTTP 头就无法改回 429。
         *
         *     每次调用都会记账（写 ai_usage），**失败与中途断开也记**：
         *     上游可能已经生成并计费了部分 token，不记就是账目缺口。
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["TranslateRequest"];
                };
            };
            responses: {
                /** @description text/event-stream */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/event-stream": string;
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthorized"];
                /**
                 * @description 本周期配额已耗尽。**不要重试**：这不是限流，等到 resetAt 或提高配额才能恢复。
                 *     `details.scope=global` 表示全站月度预算耗尽（换账号也没用）。
                 */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["QuotaExceededError"];
                    };
                };
                /** @description AI 网关未配置 */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ai/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出 AI 后台任务 */
        get: {
            parameters: {
                query?: {
                    bookId?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AiJob"][];
                    };
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        put?: never;
        /**
         * 提交后台 AI 任务（人名归一化、整书翻译等）
         * @description 入队时预扣「1 次调用 + 一个保守的 token 估计」作为入场费。
         *     真实消耗由 worker 在**每个块处理前**逐块结算；超限时任务应置为 paused
         *     （可续跑）而不是 failed。也就是说入场预扣是占位，不是一次性买断。
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["AiJobCreate"];
                };
            };
            responses: {
                /** @description 已受理 */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AiJob"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthorized"];
                404: components["responses"]["NotFound"];
                /**
                 * @description 本周期配额已耗尽，任务未被创建。
                 *     `details.scope=global` 表示全站月度预算耗尽：此时任务**不入队**
                 *     （而不是入队后等 worker 才发现超额），避免用户空等一个永远不会跑的任务。
                 */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["QuotaExceededError"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ai/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 查询本周期 AI 配额与用量
         * @description 两个维度都返回：调用次数（防高频小请求）与 token 额度（防单次大任务）。
         *     判定时两个都要过，任一超限即 429。
         *
         *     周期为**自然月（UTC 边界）**：所有实例对「本月」的判定一致，
         *     不会出现两台机器各算各的账。
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AiUsage"];
                    };
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ai/jobs/{jobId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        /** 查询任务状态 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AiJob"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/ai/jobs/{jobId}/chunks": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        /** 获取整书翻译任务的分块结果 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            jobId: string;
                            chunks: components["schemas"]["TranslationChunk"][];
                        };
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthorized"];
                404: components["responses"]["NotFound"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 列出已注册的合法书源
         * @description 返回内置书源标识。全部为**合法公版 / 开放获取**资源：
         *     Project Gutenberg、Standard Ebooks、Open Library、Internet Archive。
         *     本项目**不含**通用抓取规则引擎，也不支持加载第三方书源。
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SourceList"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sources/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 合法书源搜索（Gutenberg / Standard Ebooks / Open Library / Internet Archive）
         * @description 聚合搜索内置书源；不指定 source 时搜索全部并聚合结果，
         *     部分源失败不影响整体（错误放在 details 里）。
         *
         *     **下载链的合法性判据在协议层**：OPDS 源只对带
         *     `http://opds-spec.org/acquisition/open-access` relation 的链接
         *     给出 downloadUrl。没有该 relation 的条目（借阅 / 试读 / 裸
         *     acquisition / Atom enclosure）**不会**出现在结果里 ——
         *     因此返回的每一条都可直接下载。
         */
        get: {
            parameters: {
                query: {
                    q: string;
                    source?: "gutenberg" | "standard-ebooks" | "open-library" | "internet-archive";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SourceItem"][];
                    };
                };
                /** @description q 缺失 / 过长，或 source 未知 */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                /** @description 上游书源不可用 */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/books/{bookId}/glossary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 读取术语表
         * @description 返回一本书在某个目标语言下的全部术语。
         *
         *     术语表的 **key 是归一化后的原文键**（如 `darcy`），不是原始写法。
         *     原因：同一人物会以多种写法出现（`Mr. Darcy` / `Darcy` / `达西先生`），
         *     若按原始写法存，同一个人会变成多条术语，译文一致性无从谈起。
         *
         *     `display` 保留原始写法供展示，`target` 是标准译名。
         */
        get: {
            parameters: {
                query: {
                    /** @description 目标语言。必填而非默认 zh——猜语言会产生难以解释的行为。 */
                    targetLang: string;
                };
                header?: never;
                path: {
                    bookId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Glossary"];
                    };
                };
                /** @description bookId 非 UUID，或缺少 targetLang */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthorized"];
                404: components["responses"]["NotFound"];
            };
        };
        /**
         * 批量写入 / 删除术语
         * @description **合并语义**，不是替换：只处理请求里出现的 key，未提及的术语保持不动。
         *     客户端因此可以只提交改动的那几条，不必回传整份术语表。
         *
         *     **来源优先级**：已有术语是 `user_confirmed` 时，`llm_extracted` /
         *     `deterministic` 的写入会被忽略。用户手工确认的译名**重跑不得覆盖**。
         *     这关乎信任而非精度：用户改的译名被自动流水线冲掉，会认为功能不可靠。
         *
         *     `key` 可省略，由服务端用归一化规则从 `display` 计算。
         *     客户端不应自行实现归一化——那是一套有版本的规则，重复实现必然不一致。
         *
         *     每次成功写入或删除都会使 `version` 递增。`version` 参与译文缓存键：
         *     术语变了，受影响块必须重译，否则会复用基于旧术语的错误译文。
         *
         *     写入同时进入同步通道（`book_config` 通道，
         *     entityId 形如 `glossary:<bookId>:<key>`），其它设备靠游标增量拉取。
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    bookId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["GlossaryPutRequest"];
                };
            };
            responses: {
                /** @description 更新后的完整术语表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Glossary"];
                    };
                };
                /** @description bookId 非 UUID / 缺 targetLang / 术语缺 target / source 非法 */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthorized"];
                404: components["responses"]["NotFound"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Error: {
            /** @description 机器可读错误码 */
            code: string;
            /** @description 人类可读说明 */
            message: string;
            /** @description 可选的附加信息 */
            details?: {
                [key: string]: unknown;
            };
        };
        GlossaryTerm: {
            /** @description 归一化原文键（如 `darcy`）。用于去重与按 key 删除。 */
            key: string;
            /** @description 展示用原始写法（保留大小写与尊称，如 `Mr. Darcy`）。 */
            display: string;
            /** @description 标准译名。 */
            target: string;
            aliases?: string[];
            /**
             * @description 术语来源。优先级 user_confirmed > llm_extracted > deterministic。
             *     `user_confirmed` 不会被自动流水线的重跑覆盖。
             * @enum {string}
             */
            source: "user_confirmed" | "llm_extracted" | "deterministic";
        };
        Glossary: {
            /** Format: uuid */
            bookId: string;
            targetLang: string;
            /**
             * Format: int64
             * @description 每次术语变更递增。参与译文 input_hash：
             *     术语变了，受影响块必须重译。
             */
            version: number;
            terms: components["schemas"]["GlossaryTerm"][];
        };
        GlossaryPutRequest: {
            targetLang: string;
            terms?: components["schemas"]["GlossaryTerm"][];
            /** @description 要删除的归一 key。与 terms 合并成一个请求，避免「先删后写」之间出现空窗。 */
            removeKeys?: string[];
        };
        /**
         * @description 两个字段都可选，因此空 body 是合法请求。
         *     - 只传 refreshToken：登出该设备；
         *     - 传 allDevices: true：登出该账号全部会话（忽略 refreshToken）。
         */
        LogoutRequest: {
            /** @description 要吊销的 refresh token 明文 */
            refreshToken?: string;
            /**
             * @description 吊销该账号全部 refresh token
             * @default false
             */
            allDevices: boolean;
        };
        PasswordChangeRequest: {
            /** @description 当前口令。必须校验通过才允许改密（防「偷到 access token 即永久接管」）。 */
            currentPassword: string;
            /**
             * @description 新口令。长度规则与注册完全一致（8~200），
             *     且必须与 currentPassword 不同（否则是「改了个寂寞」）。
             */
            newPassword: string;
        };
        AuthTokens: {
            accessToken: string;
            refreshToken: string;
            /** @description access token 有效期（秒） */
            expiresIn: number;
            user?: components["schemas"]["User"];
        };
        User: {
            /** Format: uuid */
            id: string;
            /** Format: email */
            email: string;
            displayName?: string | null;
            /** Format: date-time */
            createdAt?: string;
        };
        /**
         * @description 上传接口的响应体：200（去重命中 / 秒传）与 201（新写入）返回**同一结构**，
         *     只能用 deduplicated 区分，不要依赖状态码以外的差异。
         *     书籍与文件的绑定关系体现在该 bookId 资源上，不在响应里重复。
         */
        BookFileUploadResult: {
            /** @description 归一化后的 sha256:<64 hex> */
            contentHash: string;
            /**
             * Format: int64
             * @description 实际落盘字节数（与声明 hash 一致）
             */
            sizeBytes: number;
            /** @description 200 时为 true（服务端已有该 hash 的字节，秒传），201 时为 false（首次写入） */
            deduplicated: boolean;
        };
        /**
         * @description name 可为 null：设备名是可选信息，注册/登录时没提供就是 null。
         *     客户端应把 null 显示为「未命名设备」，不要与空字符串混淆。
         */
        Device: {
            /** @description 设备 ID（HLC 前缀来源） */
            id: string;
            /** @description 未提供设备名时为 null */
            name: string | null;
            /** @enum {string} */
            platform: "web" | "windows" | "macos" | "linux" | "android" | "ios";
            /** Format: date-time */
            lastSeenAt?: string;
        };
        /** @description Readium Locator；引擎专有定位放在 locations.fragments */
        Locator: {
            /** @description 章节/资源路径 */
            href: string;
            /** @description 媒体类型，如 application/xhtml+xml */
            type: string;
            title?: string | null;
            locations?: {
                /** @description 引擎专有定位，例如 EPUB CFI */
                fragments?: string[];
                /** @description 本章内进度 */
                progression?: number;
                position?: number;
                /** @description 全书进度 */
                totalProgression?: number;
            };
            text?: {
                before?: string;
                highlight?: string;
                after?: string;
            };
        };
        BookCreate: {
            title: string;
            author?: string | null;
            language?: string | null;
            /** @enum {string} */
            format?: "epub" | "pdf" | "txt" | "mobi" | "azw3" | "fb2" | "cbz";
            /** @description 文件 sha256，用于去重与多设备匹配 */
            contentHash?: string;
        };
        BookUpdate: {
            title?: string;
            author?: string | null;
            /** @enum {string} */
            readingState?: "unread" | "reading" | "finished" | "archived";
            rating?: number | null;
        };
        Book: {
            /** Format: uuid */
            id: string;
            title: string;
            author?: string | null;
            language?: string | null;
            format?: string | null;
            contentHash?: string | null;
            /** Format: int64 */
            sizeBytes?: number | null;
            /** @enum {string} */
            readingState?: "unread" | "reading" | "finished" | "archived";
            progress?: components["schemas"]["ReadingProgress"];
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        BookPage: {
            items: components["schemas"]["Book"][];
            nextCursor?: string | null;
        };
        /** @description 服务端权威的阅读进度 */
        ReadingProgress: {
            locator?: components["schemas"]["Locator"];
            /** @description 历史最远位置（不受回退影响） */
            furthestLocator?: components["schemas"]["Locator"];
            totalProgression?: number;
            /** @description 用户主动回退标记 */
            explicitRewind?: boolean;
            /** @description 该值的 HLC */
            hlc?: string;
            deviceId?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        /** @description 一次幂等变更操作 */
        SyncOp: {
            /** @description UUID v7，幂等键（服务端保留 7 天） */
            opId: string;
            /** @enum {string} */
            entity: "progress" | "annotation" | "book" | "book_config";
            entityId: string;
            bookId?: string | null;
            /** @enum {string} */
            kind: "upsert" | "delete";
            hlc: string;
            deviceId?: string;
            payload?: {
                [key: string]: unknown;
            };
        };
        SyncPushRequest: {
            deviceId: string;
            ops: components["schemas"]["SyncOp"][];
        };
        SyncPushResponse: {
            results: {
                /** Format: uuid */
                opId: string;
                /** @enum {string} */
                status: "applied" | "duplicate" | "rejected";
                /**
                 * @description 可选字段，只在裁决非平凡时出现，普通 applied 不带它（不是必填，客户端不要依赖它存在）：
                 *       - applied + newer_hlc / explicit_rewind / monotonic_forward / new_entity
                 *       - duplicate（幂等命中，重复的 opId）
                 *       - rejected + older_hlc / stale_no_rewind / tombstone_wins（以及 rejected:&lt;原因&gt; 形式）
                 */
                reason?: string | null;
            }[];
            /**
             * Format: int64
             * @description **推送提交后的服务端游标**，不是下一次 pull 的起始游标。
             *     语义：本批提交成功后 change_log 的最大 seq；整批没有任何写入时等于该用户当前的 MAX(seq)。
             *     客户端应保存「最近一次 pull 响应里的 cursor」用于续拉；
             *     push 返回的 cursor 只用于观察进度，直接拿它去 pull 会跳过尚未拉取的变更。
             */
            cursor: number;
        };
        SyncChange: {
            /** Format: int64 */
            cursor: number;
            /** @enum {string} */
            entity: "progress" | "annotation" | "book" | "book_config";
            entityId: string;
            bookId?: string | null;
            /** @enum {string} */
            kind: "upsert" | "delete";
            hlc: string;
            deviceId?: string | null;
            payload?: {
                [key: string]: unknown;
            };
        };
        SyncPullResponse: {
            changes: components["schemas"]["SyncChange"][];
            /**
             * Format: int64
             * @description 下一页起点 = 本页最后一条变更的 seq（无变更时等于请求里的 cursor）。
             *     直接作为下一次请求的 cursor 传入，不要自行 +1。
             */
            nextCursor: number;
            /** @description true 表示还有更多变更，应立即用 nextCursor 续拉 */
            hasMore: boolean;
        };
        AnnotationCreate: {
            locator: components["schemas"]["Locator"];
            /** @enum {string} */
            type: "highlight" | "underline" | "note" | "bookmark";
            color?: string | null;
            note?: string | null;
            /** @description 被标注的原文 */
            text?: string | null;
        };
        Annotation: components["schemas"]["AnnotationCreate"] & {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            bookId: string;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        TranslateRequest: {
            text: string;
            /** @example zh-CN */
            targetLang: string;
            sourceLang?: string | null;
            bookId?: string | null;
            /** @description 上文片段，用于保持术语一致 */
            context?: string | null;
        };
        AiJobCreate: {
            /** @enum {string} */
            kind: "entity_normalize" | "book_translate" | "summarize";
            /** Format: uuid */
            bookId: string;
            options?: {
                [key: string]: unknown;
            };
        };
        AiJob: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            kind: "entity_normalize" | "book_translate" | "summarize";
            /**
             * @description `paused` 与 `failed` 的区别是**可续跑性**：
             *     `paused` 表示额度耗尽，已完成的工作（块级译文）全部保留，
             *     额度恢复后（下个周期）可继续；`failed` 表示需要用户重新发起。
             *     配额超限必须用 `paused`——用 `failed` 会让用户以为任务坏了，
             *     且白扔掉已经付过费的进度。
             * @enum {string}
             */
            status: "queued" | "running" | "succeeded" | "failed" | "canceled" | "paused";
            /**
             * @description 按**已完成块数 / 总块数**算出，不是 worker 自增计数器。
             *     计数器在崩溃后会归零，导致进度条倒退、用户误以为重头开始。
             */
            progress?: number;
            result?: {
                [key: string]: unknown;
            } | null;
            error?: string | null;
        };
        /**
         * @description `book_translate` 任务的 result。
         *
         *     块级状态落库在 `book_translation_chunks`，因此任务中断重启后
         *     会从**第一个未完成的块**继续，已完成的块永不重译（`input_hash` 未变即可复用）。
         */
        BookTranslateResult: {
            targetLang: string;
            /** @description 实际使用的模型标识，例如 `openai:deepseek-chat` */
            model: string;
            /** @description 块总数（按章节 + 约 6000 token 切分） */
            totalChunks: number;
            /** @description 已完成块数 */
            doneChunks: number;
            /** @description 译文总字符数（用于成本核对） */
            translatedChars: number;
            /** @description 因 `input_hash` 命中而复用的块数（不重复计费） */
            reusedChunks?: number;
            /** @description 因配额耗尽而暂停（可续跑） */
            paused?: boolean;
            consistency?: components["schemas"]["ConsistencyScan"];
        };
        /**
         * @description 译后确定性扫描结果（零 LLM 成本）。
         *
         *     对每个标准译名，用**纯字符串统计**检查它在译文里出现的次数：
         *     出现 0 次即判定该段忽略了术语表。这把「祈祷模型听话」变成可验证断言。
         *
         *     判定刻意保守：只查「该用没用」，不查「用了但用错」（后者需语义理解）；
         *     也只检查原文里真的出现过的术语，否则必然误报。
         */
        ConsistencyScan: {
            /** @description 实际检查过的术语数（原文里出现过的） */
            checkedTerms: number;
            /** @description 存在违规的块数（按块计，不是按术语计） */
            violatingChunks: number;
            /** @description 违规明细。块序号可用于只重译该段，而不必重跑整本书。 */
            violations?: {
                chunkIndex: number;
                /** @description 原文写法 */
                source: string;
                /** @description 标准译名（译文中未出现） */
                target: string;
            }[];
        };
        /** @description 整书翻译任务的单个文本块与译文。 */
        TranslationChunk: {
            /** @description 块全局序号 */
            chunkIndex: number;
            /** @description 章节序号 */
            chapterIndex: number;
            /** @description 原文 */
            sourceText: string;
            /** @description 译文 */
            outputText?: string | null;
            /** @enum {string} */
            status: "pending" | "running" | "done" | "failed";
        };
        /** @description 一个配额维度的用量。 */
        QuotaDimension: {
            /**
             * Format: int64
             * @description 本周期已用量
             */
            used: number;
            /**
             * Format: int64
             * @description 本周期配额上限
             */
            quota: number;
            /** Format: int64 */
            remaining: number;
        };
        /**
         * @description 两个维度都返回。判定时两个都要过，任一超限即 429——
         *     只按调用次数计费会严重失真：划词翻译一次约 2000 字（成本几厘钱），
         *     整书翻译一次约 48 万 token（约 1~2 元），两者都算「1 次调用」。
         */
        AiUsage: {
            /**
             * Format: date-time
             * @description 本周期起点（UTC 自然月首）
             */
            periodStart: string;
            /**
             * Format: date-time
             * @description 额度重置时刻（下一个月首）
             */
            resetAt: string;
            calls: components["schemas"]["QuotaDimension"];
            tokens: components["schemas"]["QuotaDimension"];
            /** @description 本周期实际记账汇总（按 feature），用于核对配额消耗与真实成本是否一致。 */
            usage?: {
                [key: string]: {
                    /** Format: int64 */
                    calls?: number;
                    /** Format: int64 */
                    inputTokens?: number;
                    /** Format: int64 */
                    outputTokens?: number;
                    /**
                     * Format: int64
                     * @description 按官方单价折算，单位：分
                     */
                    costCents?: number;
                };
            };
        };
        /**
         * @description 配额耗尽。**这不是限流**：重试不会成功，必须等 resetAt 或提高配额。
         *     code 与 rate_limited 刻意分开，避免客户端做出错误的重试决策。
         */
        QuotaExceededError: {
            /** @enum {string} */
            code: "quota_exceeded";
            message: string;
            details: {
                /**
                 * @description 哪个维度超了。calls = 调用次数用完（高频小请求）；
                 *     tokens = token 额度用完（通常是跑了整书翻译这类大任务）。
                 * @enum {string}
                 */
                dimension: "calls" | "tokens";
                /**
                 * @description 谁的上限被撞到了。
                 *
                 *     - `user`：你自己的月度额度用完。等 resetAt 或提高
                 *       `users.quota_ai_calls` / `users.quota_ai_tokens`。
                 *     - `global`：**全站**月度调用预算用完
                 *       （`HPF_AI_GLOBAL_MONTHLY_CALLS`）。这与你的用量无关，
                 *       **换账号也不会恢复**——不要引导用户去注册小号，
                 *       那既没用又会让攻击面变大。只能等 resetAt。
                 *
                 *     缺省视为 `user`（老服务端不返回该字段）。
                 * @default user
                 * @enum {string}
                 */
                scope: "user" | "global";
                /** Format: int64 */
                limit: number;
                /** Format: int64 */
                used: number;
                /** Format: date-time */
                resetAt: string;
            };
        };
        SourceList: {
            /**
             * @example [
             *       "gutenberg",
             *       "standard-ebooks",
             *       "open-library",
             *       "internet-archive"
             *     ]
             */
            sources: string[];
        };
        SourceItem: {
            /** @example gutenberg */
            source: string;
            title: string;
            author?: string | null;
            language?: string | null;
            /**
             * Format: uri
             * @description 可直接下载的地址。**仅当**条目具有可验证的开放获取依据时才存在：
             *     - OPDS 源：必须带 `http://opds-spec.org/acquisition/open-access` relation
             *     - 内置 Gutenberg：由我们核实为公有领域
             *     没有依据的条目不会出现在结果里（而不是给一个空值）。
             */
            downloadUrl: string;
            /** Format: uri */
            coverUrl?: string | null;
            /**
             * @description 授权标识。
             *     - public-domain：公有领域（已核实）
             *     - open-access：OPDS 协议声明的开放获取
             *     - mixed-open-access：源内混合公版与借阅，条目级以 open-access relation 为准
             *     - unknown：未能核实（不应出现在下载结果里）
             * @enum {string}
             */
            license: "public-domain" | "open-access" | "mixed-open-access" | "cc0" | "unknown";
            /** @description 源站排障信息（例如 OPDS relation 与 MIME 类型） */
            extra?: {
                [key: string]: unknown;
            };
        };
    };
    responses: {
        /** @description 未认证 */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description 不存在 */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description 请求内容不合法（客户端数据问题，重试不会成功） */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description 冲突（邮箱已注册 / deviceId 已绑定其它账号） */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /**
         * @description 限流或失败次数超限。**可以重试**，但必须等 details.retryAfter / Retry-After 头。
         *     与 quota_exceeded 的区别：这里的限制会随时间自动解除。
         */
        TooManyRequests: {
            headers: {
                /** @description 建议等待的秒数 */
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description 存储配额耗尽（HTTP 507）。与 429 的区别：重试不会成功，必须先删书或提高 users.quota_bytes。 */
        QuotaExceeded: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description 单个请求体超过上限（HPF_MAX_UPLOAD_BYTES） */
        PayloadTooLarge: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
