// Package ai 提供 LLM 网关：统一 OpenAI 兼容协议，支持流式翻译与后台任务。
//
// 设计要点：
//   - 后端持有 API Key（用户 BYOK 是后续扩展点）；
//   - provider=fake 让整套 SSE 链路在没有外部依赖时也能端到端跑通与测试；
//   - 超时、配额、失败降级都在这一层收敛，HTTP 层只负责协议转换。
package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ErrDisabled 表示 AI 功能被配置关闭。
var ErrDisabled = errors.New("ai: disabled")

// TranslateRequest 是一次翻译请求。
type TranslateRequest struct {
	Text       string
	TargetLang string
	SourceLang string
	Context    string
	// Glossary 是本书已确认的译名表（术语一致性）。
	Glossary map[string]string
	Model    string
}

// Translator 是所有翻译实现的统一接口。
type Translator interface {
	// TranslateStream 逐块返回译文。实现必须尊重 ctx 取消。
	TranslateStream(ctx context.Context, req TranslateRequest) (<-chan string, <-chan error, error)
	// Name 返回实现名（用于审计与 /metrics）。
	Name() string
}

// Config 是 AI 网关配置。
type Config struct {
	Provider string // fake | openai
	BaseURL  string
	APIKey   string
	Model    string
	Timeout  time.Duration
	// FakeChunkSize 是假实现的分块大小（字符数），便于客户端测流式渲染。
	FakeChunkSize int
	// FakeDelay 是假实现每块之间的间隔，模拟真实网络节奏。
	FakeDelay time.Duration
}

// New 按配置构造翻译器。
func New(cfg Config) (Translator, error) {
	switch cfg.Provider {
	case "fake", "":
		size := cfg.FakeChunkSize
		if size <= 0 {
			size = 12
		}
		delay := cfg.FakeDelay
		if delay <= 0 {
			delay = 15 * time.Millisecond
		}
		return &FakeTranslator{chunkSize: size, delay: delay}, nil
	case "openai":
		if strings.TrimSpace(cfg.BaseURL) == "" {
			return nil, errors.New("ai: base URL is required for provider=openai")
		}
		if strings.TrimSpace(cfg.APIKey) == "" {
			return nil, errors.New("ai: API key is required for provider=openai")
		}
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = 60 * time.Second
		}
		return &OpenAITranslator{
			baseURL: strings.TrimRight(cfg.BaseURL, "/"),
			apiKey:  cfg.APIKey,
			model:   orDefault(cfg.Model, "deepseek-chat"),
			client:  &http.Client{Timeout: timeout},
		}, nil
	default:
		return nil, fmt.Errorf("ai: unknown provider %q", cfg.Provider)
	}
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

// BuildMessages 把一次翻译请求变成 OpenAI 兼容的 messages。
// 术语表放在 system 前缀里只发一次：能让上游的 prefix cache 命中，显著降本。
func BuildMessages(req TranslateRequest) []chatMessage {
	var sys strings.Builder
	sys.WriteString("You are a precise translation engine for an e-book reader. ")
	sys.WriteString("Translate the user's text into ")
	sys.WriteString(req.TargetLang)
	sys.WriteString(". Preserve paragraph breaks and inline markup. ")
	sys.WriteString("Output ONLY the translation, with no explanations or quotes.")
	if req.SourceLang != "" {
		fmt.Fprintf(&sys, " The source language is %s.", req.SourceLang)
	}
	if len(req.Glossary) > 0 {
		sys.WriteString("\nUse this glossary exactly (source => target):")
		keys := make([]string, 0, len(req.Glossary))
		for k := range req.Glossary {
			keys = append(keys, k)
		}
		sortStrings(keys)
		for _, k := range keys {
			fmt.Fprintf(&sys, "\n- %s => %s", k, req.Glossary[k])
		}
	}
	msgs := []chatMessage{{Role: "system", Content: sys.String()}}
	if req.Context != "" {
		msgs = append(msgs, chatMessage{Role: "user", Content: "Previous context (do not translate): " + req.Context})
	}
	msgs = append(msgs, chatMessage{Role: "user", Content: req.Text})
	return msgs
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// ---------- 假实现 ----------

// FakeTranslator 是确定性假翻译器：
// 不调用外部服务，但严格按块 + 间隔产出，用于本地开发与端到端测试流式链路。
type FakeTranslator struct {
	chunkSize int
	delay     time.Duration
}

// Name 实现 Translator。
func (f *FakeTranslator) Name() string { return "fake" }

// TranslateStream 实现 Translator：把原文按块回显，并在前面加上目标语言标记。
func (f *FakeTranslator) TranslateStream(ctx context.Context, req TranslateRequest) (<-chan string, <-chan error, error) {
	out := make(chan string)
	errs := make(chan error, 1)
	go func() {
		defer close(out)
		defer close(errs)
		full := "[" + req.TargetLang + "] " + req.Text
		runes := []rune(full)
		for i := 0; i < len(runes); i += f.chunkSize {
			end := i + f.chunkSize
			if end > len(runes) {
				end = len(runes)
			}
			select {
			case <-ctx.Done():
				errs <- ctx.Err()
				return
			case out <- string(runes[i:end]):
			}
			if f.delay > 0 {
				select {
				case <-ctx.Done():
					errs <- ctx.Err()
					return
				case <-time.After(f.delay):
				}
			}
		}
	}()
	return out, errs, nil
}

// ---------- OpenAI 兼容实现 ----------

// OpenAITranslator 直连任何 OpenAI 兼容的 /chat/completions（DeepSeek / OpenAI / Ollama / vLLM）。
type OpenAITranslator struct {
	baseURL string
	apiKey  string
	model   string
	client  *http.Client
}

// Name 实现 Translator。
func (o *OpenAITranslator) Name() string { return "openai:" + o.model }

type chatRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
}

type chatChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

// TranslateStream 实现 Translator，使用 SSE 逐块读取上游响应。
func (o *OpenAITranslator) TranslateStream(ctx context.Context, req TranslateRequest) (<-chan string, <-chan error, error) {
	model := orDefault(req.Model, o.model)
	payload, err := json.Marshal(chatRequest{Model: model, Messages: BuildMessages(req), Stream: true})
	if err != nil {
		return nil, nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, o.baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+o.apiKey)
	httpReq.Header.Set("Accept", "text/event-stream")

	resp, err := o.client.Do(httpReq)
	if err != nil {
		return nil, nil, fmt.Errorf("ai: upstream request failed: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		return nil, nil, fmt.Errorf("ai: upstream status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	out := make(chan string)
	errs := make(chan error, 1)
	go func() {
		defer close(out)
		defer close(errs)
		defer func() { _ = resp.Body.Close() }()

		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, ":") {
				continue
			}
			data, ok := strings.CutPrefix(line, "data:")
			if !ok {
				continue
			}
			data = strings.TrimSpace(data)
			if data == "[DONE]" {
				return
			}
			var chunk chatChunk
			if err := json.Unmarshal([]byte(data), &chunk); err != nil {
				// 上游偶发非 JSON 保活帧，忽略而不是中断整条流。
				continue
			}
			if chunk.Error != nil {
				errs <- fmt.Errorf("ai: upstream error: %s", chunk.Error.Message)
				return
			}
			for _, c := range chunk.Choices {
				if c.Delta.Content == "" {
					continue
				}
				select {
				case <-ctx.Done():
					errs <- ctx.Err()
					return
				case out <- c.Delta.Content:
				}
			}
		}
		if err := scanner.Err(); err != nil && !errors.Is(err, context.Canceled) {
			errs <- fmt.Errorf("ai: read upstream stream: %w", err)
		}
	}()
	return out, errs, nil
}
