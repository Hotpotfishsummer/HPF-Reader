package httpapi

import (
	"os"
	"path/filepath"
	"testing"
)

// readFixture 读取 internal/sources/testdata 下的真实 OPDS fixture。
//
// 复用 sources 包的 fixture 而不是复制一份：这些文件是**真实抓取**的响应，
// 两份副本迟早会漂移，而"合法性判据"的测试必须用同一份真实数据。
func readFixture(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join("..", "sources", "testdata", name)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read fixture %s: %v", p, err)
	}
	return string(b)
}
