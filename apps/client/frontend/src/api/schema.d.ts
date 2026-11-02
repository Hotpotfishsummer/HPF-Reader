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
                    };
                };
            };
            responses: {
                /** @description 已创建 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthTokens"];
                    };
                };
                409: components["responses"]["Conflict"];
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
                /** @description 已存在（去重命中） */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description 已上传 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
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
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SyncPushResponse"];
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
                    cursor: number;
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
    "/v1/ai/translate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 流式翻译（SSE） */
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
        get?: never;
        put?: never;
        /** 提交后台 AI 任务（人名归一化、整书翻译等） */
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
            };
        };
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
    "/v1/sources/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 合法书源搜索（Gutenberg / Standard Ebooks / Open Library / OPDS） */
        get: {
            parameters: {
                query: {
                    q: string;
                    source?: string;
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
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Error: {
            /** @example invalid_credentials */
            code: string;
            message: string;
            details?: {
                [key: string]: unknown;
            };
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
        Device: {
            /** @description 设备 ID（HLC 前缀来源） */
            id: string;
            name: string;
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
                opId: string;
                /** @enum {string} */
                status: "applied" | "duplicate" | "rejected";
                reason?: string | null;
            }[];
            /**
             * Format: int64
             * @description 服务端已分配到的最新游标
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
            /** Format: int64 */
            nextCursor: number;
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
            kind: string;
            /** @enum {string} */
            status: "queued" | "running" | "succeeded" | "failed" | "canceled";
            progress?: number;
            result?: {
                [key: string]: unknown;
            } | null;
            error?: string | null;
        };
        SourceItem: {
            /** @example gutenberg */
            source: string;
            title: string;
            author?: string | null;
            language?: string | null;
            /** Format: uri */
            downloadUrl: string;
            /** Format: uri */
            coverUrl?: string | null;
            /** @description 授权标识，例如 public-domain / cc0 */
            license: string;
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
        /** @description 冲突 */
        Conflict: {
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
