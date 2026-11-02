package store

// 这个文件里的测试需要一个真实 PostgreSQL（F-01 是数据完整性缺陷，
// 用 mock 断言「没有留下孤儿行」没有意义——必须查真表）。
//
// 通过环境变量提供连接串，未提供则跳过：
//   HPF_TEST_DATABASE_URL=postgres://hpf:xxx@127.0.0.1:5432/hpf_reader?sslmode=disable go test ./internal/store/
//
// 测试不 TRUNCATE 整表，而是每个用例自建独立用户，靠 user_id / 邮箱隔离。
// 因此可以指向**共享**测试库：多个测试包并行跑时不会互相清空数据。

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/db"
	syncengine "github.com/hpf-reader/hpf-reader/apps/server/internal/sync"
)

// testEmailSuffix 返回每次调用都不同的后缀，用于隔离同一库里的测试数据。
//
// 这些测试曾经依赖 `TRUNCATE users CASCADE` 保证邮箱唯一，
// 但那会与其它包的 DB 测试并行时互相清空。改用唯一后缀后，
// 每个用例的数据天然隔离，可安全地在共享库上并行运行。
func testEmailSuffix() string {
	return strconv.FormatInt(time.Now().UnixNano(), 36)
}

// testDeviceID 生成一个每次调用都不同的合法 UUID v4。
//
// 设备 ID 也必须唯一：库里残留的历史设备会让「注册成功」的断言直接失败。
// 用 UUID 而不是拼接字符串，是因为 devices.id 是 UUID 列，格式非法会先报 22P02。
func testDeviceID() string {
	var b [16]byte
	n := time.Now().UnixNano()
	for i := range b {
		b[i] = byte(n >> (uint(i) * 4))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func testStore(t *testing.T) (*Store, context.Context) {
	t.Helper()
	dsn := os.Getenv("HPF_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("HPF_TEST_DATABASE_URL 未设置，跳过需要真实数据库的测试")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	pool, err := db.Connect(ctx, dsn, 4, 10*time.Second)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	// 不做 TRUNCATE：各用例用不同的邮箱与 deviceId，天然隔离。
	// （曾经这里 TRUNCATE users CASCADE，导致与 worker 包的 DB 测试并行时互相清空，
	//   表现为「单独跑绿、全量跑红」的间歇性失败。）
	return New(pool), ctx
}

// TestRegisterAccountDeviceConflictLeavesNoOrphanUser 是 F-01 的回归测试。
//
// 缺陷复现（spikes/sync 联调，见 spikes/sync/RESULTS.md §6.1 与 evidence/db-evidence.txt）：
// deviceId 已被其它账号占用时，register 返回 404，且**用户行已经提交进库**——
// 邮箱被占用、没有设备、无法完成注册。
//
// 断言：
//  1. 错误是 ErrDeviceTaken（HTTP 层据此回 409，而不是 404）；
//  2. users 表里**没有**该邮箱的行（事务已回滚）；
//  3. 原账号的设备绑定不受影响。
func TestRegisterAccountDeviceConflictLeavesNoOrphanUser(t *testing.T) {
	s, ctx := testStore(t)
	// 邮箱带唯一后缀：多个测试共用同一个库时不会互相冲突（不再靠 TRUNCATE）。
	u := testEmailSuffix()
	devID := testDeviceID()

	// 1) 用户 A 正常注册，占用 devID。
	if _, _, err := s.RegisterAccount(ctx, "a-"+u+"@example.com", "hash-a", "A", DeviceRegistration{
		ID: devID, Name: "device-a", Platform: "windows",
	}, 0); err != nil {
		t.Fatalf("register A: %v", err)
	}

	// 2) 用户 B 用同一个 deviceId 注册 → 必须失败，且是「设备被占用」而非「找不到」。
	_, _, err := s.RegisterAccount(ctx, "b-"+u+"@example.com", "hash-b", "B", DeviceRegistration{
		ID: devID, Name: "device-b", Platform: "android",
	}, 0)
	if err == nil {
		t.Fatal("第二个用户用已占用的 deviceId 注册竟然成功了")
	}
	if !errors.Is(err, ErrDeviceTaken) {
		t.Fatalf("err = %v, want ErrDeviceTaken（HTTP 层应据此返回 409）", err)
	}

	// 3) 关键断言：没有孤儿用户行。
	var n int
	if err := s.Pool().QueryRow(ctx, `SELECT count(*) FROM users WHERE email = $1`, "b-"+u+"@example.com").Scan(&n); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if n != 0 {
		t.Fatalf("失败的注册留下了 %d 行孤儿用户（邮箱已被占用却无法完成注册）", n)
	}

	// 4) A 的绑定没有被破坏。
	var owner string
	if err := s.Pool().QueryRow(ctx, `SELECT user_id::text FROM devices WHERE id = $1`, devID).Scan(&owner); err != nil {
		t.Fatalf("query device owner: %v", err)
	}
	var aID string
	if err := s.Pool().QueryRow(ctx, `SELECT id::text FROM users WHERE email = $1`, "a-"+u+"@example.com").Scan(&aID); err != nil {
		t.Fatalf("query user A: %v", err)
	}
	if owner != aID {
		t.Fatalf("devices.user_id = %s, want A(%s)", owner, aID)
	}
}

// TestUpsertDeviceRejectsForeignDevice 直接覆盖 store 层的 409 语义。
//
// 之前这里靠 ON CONFLICT ... WHERE 不返回行 + pgx.ErrNoRows，被 wrap() 翻成
// ErrNotFound → HTTP 404（「资源不存在」），语义完全错了。
func TestUpsertDeviceRejectsForeignDevice(t *testing.T) {
	s, ctx := testStore(t)
	u := testEmailSuffix()
	devID := testDeviceID()

	if _, _, err := s.RegisterAccount(ctx, "owner-"+u+"@example.com", "h", "", DeviceRegistration{
		ID: devID, Name: "owner-device",
	}, 0); err != nil {
		t.Fatalf("register owner: %v", err)
	}
	// 另一个用户试图占用同一设备 ID。
	// other 在 if 之后还要用（传给 UpsertDevice），因此单独声明。
	other, _, err := s.RegisterAccount(ctx, "other-"+u+"@example.com", "h2", "", DeviceRegistration{
		ID: testDeviceID(),
	}, 0)
	if err != nil {
		t.Fatalf("register other: %v", err)
	}
	if _, err := s.UpsertDevice(ctx, devID, other.ID, "hijack", "windows", ""); !errors.Is(err, ErrDeviceTaken) {
		t.Fatalf("err = %v, want ErrDeviceTaken", err)
	}
}

// TestDeviceNameIsPersistedAndEchoed 是 F-03 的回归测试：
// 注册时传的 deviceName 必须真的落库，并能从 ListDevices 读回来。
func TestDeviceNameIsPersistedAndEchoed(t *testing.T) {
	s, ctx := testStore(t)
	u := testEmailSuffix()
	// dev 在 if 之后还要用，因此单独声明。
	_, dev, err := s.RegisterAccount(ctx, "named-"+u+"@example.com", "h", "", DeviceRegistration{
		ID: testDeviceID(), Name: "spike-device-A", Platform: "windows", AppVersion: "1.0",
	}, 0)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if dev.Name == nil || *dev.Name != "spike-device-A" {
		t.Fatalf("device.Name = %v, want spike-device-A", dev.Name)
	}
	list, err := s.ListDevices(ctx, dev.UserID)
	if err != nil {
		t.Fatalf("ListDevices: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("len(devices) = %d, want 1", len(list))
	}
	if list[0].Name == nil || *list[0].Name != "spike-device-A" {
		t.Fatalf("ListDevices name = %v, want spike-device-A", list[0].Name)
	}
}

// TestDeviceNameNullWhenNotProvided 保证「没有名字」返回 null，而不是空字符串冒充有值。
func TestDeviceNameNullWhenNotProvided(t *testing.T) {
	s, ctx := testStore(t)
	u := testEmailSuffix()
	_, dev, err := s.RegisterAccount(ctx, "anon-"+u+"@example.com", "h", "", DeviceRegistration{
		ID: testDeviceID(), Platform: "linux",
	}, 0)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if dev.Name != nil {
		t.Fatalf("device.Name = %q, want nil（未提供设备名时应为 NULL）", *dev.Name)
	}
}

// TestPushForeignKeyViolationIsClientError 覆盖 F-02 同类的第二条 5xx 路径。
//
// 客户端推送 progress 指向一本还不存在的书时，PostgreSQL 抛 23503（外键违例），
// 旧实现会把它当未知错误冒成 500 —— 客户端于是无限重试一条永远不可能成功的 op。
// 断言：返回 ErrInvalidInput（HTTP 层据此回 400）。
func TestPushForeignKeyViolationIsClientError(t *testing.T) {
	s, ctx := testStore(t)
	sfx := testEmailSuffix()
	u, _, err := s.RegisterAccount(ctx, "push-"+sfx+"@example.com", "h", "", DeviceRegistration{
		ID: testDeviceID(),
	}, 0)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	sy := NewSyncStore(s)
	payload := []byte(`{"totalProgression":0.5,"contentHash":"sha256:abc"}`)
	_, err = sy.Push(ctx, u.ID, testDeviceID(),
		[]syncengine.StoreOp{{
			Entity: syncengine.EntityProgress, EntityID: "99999999-9999-4999-8999-999999999999",
			Kind: syncengine.KindUpsert, HLC: "001a19d234920-00000000-a1a1a1a1", Payload: payload,
		}}, nil)
	if err == nil {
		t.Fatal("引用不存在的书竟然写入成功")
	}
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput（HTTP 层应据此返回 400，而不是 500）", err)
	}
}
