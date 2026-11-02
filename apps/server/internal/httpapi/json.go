package httpapi

import "encoding/json"

// mustJSON 序列化，失败返回 nil（调用方已保证可序列化）。
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}
