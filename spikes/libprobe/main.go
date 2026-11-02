package main

import (
	"fmt"

	"github.com/longbridgeapp/opencc"
	"github.com/mozillazg/go-pinyin"
	"github.com/xrash/smetrics"
)

func main() {
	s2t, err := opencc.New("t2s")
	if err != nil {
		fmt.Println("opencc init FAIL:", err)
		return
	}
	out, err := s2t.Convert("伊麗莎白與達西")
	if err != nil {
		fmt.Println("opencc convert FAIL:", err)
		return
	}
	fmt.Println("opencc t2s:", out)

	a := pinyin.NewArgs()
	fmt.Println("pinyin 伊丽莎白:", pinyin.Pinyin("伊丽莎白", a))
	fmt.Println("pinyin 伊莉莎白:", pinyin.Pinyin("伊莉莎白", a))

	fmt.Println("jaro(郝思嘉,斯嘉丽):", smetrics.Jaro("郝思嘉", "斯嘉丽"))
	fmt.Println("jaro(伊丽莎白,伊莉莎白):", smetrics.Jaro("伊丽莎白", "伊莉莎白"))
}