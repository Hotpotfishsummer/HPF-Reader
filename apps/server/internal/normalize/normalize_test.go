package normalize

import "testing"

// TestNormalizeStripsHonorificAndPunctuation 锁定 L-a 层（形态归一）。
//
// 这一层是聚类的地基：`Mr. Darcy` / `Mr Darcy` / `Darcy` 若被算成不同 key，
// 后面所有逻辑都建立在错误的输入上。
func TestNormalizeStripsHonorificAndPunctuation(t *testing.T) {
	cases := []struct {
		form string
		want string
	}{
		{"Mr. Darcy", "darcy"},
		{"Mr Darcy", "darcy"},
		{"MR. DARCY", "darcy"},
		{"Darcy", "darcy"},
		{"  Darcy  ", "darcy"},
		{"Miss Elizabeth Bennet", "elizabeth bennet"},
		{"Dr. Watson", "watson"},
		{"Sir William Lucas", "william lucas"},
	}
	for _, c := range cases {
		got := Normalize(c.form).NormKey
		if got != c.want {
			t.Errorf("Normalize(%q).NormKey = %q, want %q", c.form, got, c.want)
		}
	}
}

// TestNormalizeStripsChineseHonorificSuffix 锁定中文称谓后缀。
//
// 「达西先生」与「达西」必须是同一个 key，否则中文书里同一个人会被拆成两个。
func TestNormalizeStripsChineseHonorificSuffix(t *testing.T) {
	cases := []struct{ form, want string }{
		{"达西先生", "达西"},
		{"达西小姐", "达西"},
		{"达西夫人", "达西"},
		{"达西教授", "达西"},
		{"达西先生阁下", "达西"},
	}
	for _, c := range cases {
		got := Normalize(c.form).NormKey
		if got != c.want {
			t.Errorf("Normalize(%q).NormKey = %q, want %q", c.form, got, c.want)
		}
	}
}

// TestNormalizeTraditionalToSimplified 锁定繁简归一。
//
// 同一本书的繁体版和简体版必须归一到同一实体，否则跨版本阅读体验断裂。
func TestNormalizeTraditionalToSimplified(t *testing.T) {
	pairs := [][2]string{
		{"伊麗莎白", "伊丽莎白"},
		{"達西", "达西"},
		{"斯嘉麗", "斯嘉丽"},
		{"郝思嘉", "郝思嘉"},
	}
	for _, pr := range pairs {
		a := Normalize(pr[0]).NormKey
		b := Normalize(pr[1]).NormKey
		if a != b {
			t.Errorf("繁简未归一: Normalize(%q)=%q 但 Normalize(%q)=%q", pr[0], a, pr[1], b)
		}
	}
}

// TestNormalizeStripsDiacritics 锁定变音符号剥离（英文人名）。
func TestNormalizeStripsDiacritics(t *testing.T) {
	cases := []struct{ form, want string }{
		{"Jos\u00e9", "jose"},
		{"M\u00fcller", "muller"},
		{"Fran\u00e7ois", "francois"},
		{"Zo\u00eb", "zoe"},
	}
	for _, c := range cases {
		got := Normalize(c.form).NormKey
		if got != c.want {
			t.Errorf("Normalize(%q).NormKey = %q, want %q", c.form, got, c.want)
		}
	}
}

// TestPinyinKeyEmptyForNonChinese 锁定**安全关键**语义：非中文拼音为空。
//
// 这条断言存在的原因：聚类把「拼音 key 相同」当强信号。
// 若非中文也返回非空，任意两个英文人名都会被误合并。
// 实测 py(Darcy) == py(Elizabeth) == ""，正是这个空值让判空成为必需。
func TestPinyinKeyEmptyForNonChinese(t *testing.T) {
	for _, s := range []string{"Darcy", "Mr. Darcy", "Elizabeth Bennet", "ABC", "123"} {
		if got := Normalize(s).PinyinKey; got != "" {
			t.Errorf("Normalize(%q).PinyinKey = %q, want empty（非中文必须为空）", s, got)
		}
	}
}

// TestPinyinKeyMergesHomophones 锁定**核心能力**：同音异形靠拼音合并。
//
// 实测：伊丽莎白 与 伊莉莎白 的拼音都是 yilishabai，
// 但它们的 Jaro 只有 0.8333——低于常见的 0.85 阈值。
// 也就是说**编辑距离抓不到这一对**，只有拼音能抓到。
func TestPinyinKeyMergesHomophones(t *testing.T) {
	a := Normalize("伊丽莎白").PinyinKey
	b := Normalize("伊莉莎白").PinyinKey
	if a == "" || a != b {
		t.Fatalf("拼音 key 未命中: 伊丽莎白=%q 伊莉莎白=%q", a, b)
	}
	if want := "yilishabai"; a != want {
		t.Errorf("拼音 key = %q, want %q", a, want)
	}
}

// TestClusterMergesHomophoneForms 端到端：同音异形应被合并且标记为确定。
func TestClusterMergesHomophoneForms(t *testing.T) {
	gs := Cluster([]Form{
		{Surface: "伊丽莎白", Count: 10},
		{Surface: "伊莉莎白", Count: 3},
	})
	if len(gs) != 1 {
		t.Fatalf("应有 1 组，实际 %d 组: %+v", len(gs), gs)
	}
	if !gs[0].Certain {
		t.Errorf("拼音相同应标记为确定合并，实际 Certain=false")
	}
	if gs[0].Canonical != "伊丽莎白" {
		t.Errorf("canonical 应选出现次数最多的，实际 %q", gs[0].Canonical)
	}
	found := false
	for _, ev := range gs[0].Evidence {
		if ev.Kind == EvidencePinyin {
			found = true
		}
	}
	if !found {
		t.Errorf("缺少拼音证据，用户无法判断为何合并: %+v", gs[0].Evidence)
	}
}

// TestClusterDoesNotMergeNaturalizedNames 断言**设计上的已知边界**。
//
// 「郝思嘉」与「斯嘉丽」是《飘》的两个中译名（1940 年归化译本 vs 现代译本）。
// 实测 jaro=0.6296，拼音 haosijia vs sijiali 也不同。
//
// 这条测试断言的是「**不合并**」，不是「合并失败」——
// 纯字符串方法在归化译名上系统性做不到，这是规划里如实写明的边界。
// 把它写成「期望合并但失败」会让后人误以为是实现缺陷而去做无谓的调参。
func TestClusterDoesNotMergeNaturalizedNames(t *testing.T) {
	gs := Cluster([]Form{
		{Surface: "郝思嘉", Count: 20},
		{Surface: "斯嘉丽", Count: 15},
	})
	if len(gs) != 2 {
		t.Fatalf("归化译名不应被字符串方法合并，实际得到 %d 组: %+v", len(gs), gs)
	}
	for _, g := range gs {
		if g.Certain {
			t.Errorf("不应标记为确定合并: %+v", g)
		}
	}
}

// TestClusterNeverMergesDistinctEnglishNames 是**误合并回归测试**。
//
// 这条覆盖我实测发现的真实风险：拼音库对非中文返回空串。
// 若聚类时不判空，两个完全不同的英文人名会因为「拼音都是空」而被合并——
// 这是最严重的一类 bug（两个人变一个），且不会报错、不会让别的测试变红。
func TestClusterNeverMergesDistinctEnglishNames(t *testing.T) {
	gs := Cluster([]Form{
		{Surface: "Darcy", Count: 10},
		{Surface: "Elizabeth", Count: 8},
		{Surface: "Bennet", Count: 6},
	})
	if len(gs) != 3 {
		t.Fatalf("不同英文名必须各自成组，实际 %d 组（发生了误合并）: %+v", len(gs), gs)
	}
}

// TestClusterSubstringMergesFullAndShortName 锁定子串包含规则。
//
// 「Fitzwilliam Darcy」⊇「Darcy」，这是英文书里最常见的全名/姓氏指称。
func TestClusterSubstringMergesFullAndShortName(t *testing.T) {
	gs := Cluster([]Form{
		{Surface: "Fitzwilliam Darcy", Count: 2},
		{Surface: "Darcy", Count: 40},
	})
	if len(gs) != 1 {
		t.Fatalf("全名与姓氏应合并，实际 %d 组: %+v", len(gs), gs)
	}
	if !gs[0].Certain {
		t.Errorf("子串包含是确定性证据，应标记 Certain")
	}
}

// TestClusterSingleLetterDoesNotMergeEverything 锁定单字母防护。
//
// 若单字母 token 参与子串包含，"O" 会把所有含 o 的名字吃掉。
func TestClusterSingleLetterDoesNotMergeEverything(t *testing.T) {
	gs := Cluster([]Form{
		{Surface: "O", Count: 2},
		{Surface: "Darcy", Count: 10},
		{Surface: "Elizabeth Bennet", Count: 5},
	})
	if len(gs) < 2 {
		t.Fatalf("单字母不应把一切合并，实际 %d 组: %+v", len(gs), gs)
	}
}

// TestClusterDeterministic 锁定确定性：同样输入必须同样输出。
//
// 这条很重要——聚类结果会进 book_correction 的重放链路，
// 若两次跑出不同分组，「重放幂等」就无从谈起。
func TestClusterDeterministic(t *testing.T) {
	in := []Form{
		{Surface: "Elizabeth", Count: 5},
		{Surface: "伊丽莎白", Count: 5},
		{Surface: "Darcy", Count: 5},
	}
	var first string
	for i := 0; i < 5; i++ {
		gs := Cluster(in)
		s := ""
		for _, g := range gs {
			s += g.Canonical + "|"
			for _, m := range g.Members {
				s += m.Surface + ","
			}
			s += ";"
		}
		if i == 0 {
			first = s
			continue
		}
		if s != first {
			t.Fatalf("第 %d 次聚类结果不同", i+1)
		}
	}
}

// TestNormalizeEmptyInput 锁定边界：空输入不 panic、返回空 key。
func TestNormalizeEmptyInput(t *testing.T) {
	for _, s := range []string{"", "   ", "...", "---"} {
		k := Normalize(s)
		if k.NormKey != "" {
			t.Errorf("Normalize(%q).NormKey = %q, want empty", s, k.NormKey)
		}
	}
}
