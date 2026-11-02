package sources

import "os"

// liveEnabled 判断是否开启真实网络测试。
func liveEnabled() bool {
	return os.Getenv("HPF_LIVE_SOURCES") == "1"
}
