// mkrsrc 生成 Windows 资源对象 (.syso)，供 Go 链接器打进 exe。
//
// 为什么不直接用 github.com/akavel/rsrc 的 CLI：
//
//  1. Go 链接器只接受一个 .rsrc 节 —— cmd/link/internal/ld/pe.go 的 setpersrc() 在
//     第二次收到资源符号时报 "too many .rsrc sections"，addpersrc() 只是把多个
//     .rsrc 符号的原始字节首尾相接，拼出来的是坏掉的资源目录。所以 manifest 和
//     图标必须打进同一个 .syso，不能分两次生成再一起链接。
//
//  2. walk 注册窗口类时硬编码取 ID 7 作为程序图标：
//     walk/window.go:488  hIcon := win.LoadIcon(hInst, win.MAKEINTRESOURCE(7))
//     // rsrc uses 7 for app icon
//     取不到就回落到 IDI_APPLICATION（通用白纸图标）。而 rsrc CLI 的资源 ID 是
//     自增分配的（rsrc/rsrc.go 的 newid）：manifest 先占掉 1，组图标就变成 2，
//     对不上 walk 期望的 7。
//
// 于是这里直接调用 rsrc 的导出子包（coff / ico / binutil）自己拼 COFF，
// 把 RT_GROUP_ICON 的 ID 固定成 7，RT_MANIFEST 固定成 1（CREATEPROCESS_MANIFEST_RESOURCE_ID）。
//
// 用法：
//
//	go run . -manifest ../OneWayFW.manifest -ico ../OneWayFW.ico -o ../rsrc_windows_amd64.syso
//
// 产物文件名必须带 _windows_amd64 后缀，否则非 Windows 平台构建也会把它算进去。
package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"os"
	"reflect"

	"github.com/akavel/rsrc/binutil"
	"github.com/akavel/rsrc/coff"
	"github.com/akavel/rsrc/ico"
)

// 资源 ID 约定
const (
	manifestID  = 1 // CREATEPROCESS_MANIFEST_RESOURCE_ID，系统按此 ID 找应用程序清单
	groupIconID = 7 // walk/window.go:488 硬编码读取的 ID
)

// grpIconDir 对应 RT_GROUP_ICON 的数据体，即 .ico 文件头去掉 ImageOffset 字段。
type grpIconDir struct {
	ico.ICONDIR
	Entries []grpIconDirEntry
}

func (g grpIconDir) Size() int64 {
	if len(g.Entries) == 0 {
		return int64(binary.Size(g.ICONDIR))
	}
	return int64(binary.Size(g.ICONDIR) + len(g.Entries)*binary.Size(g.Entries[0]))
}

type grpIconDirEntry struct {
	ico.IconDirEntryCommon
	Id uint16 // 指向 RT_ICON 里对应的资源 ID
}

func main() {
	var manifestPath, icoPath, outPath, arch string
	flag.StringVar(&manifestPath, "manifest", "", "应用程序清单 (.manifest) 路径，留空则不嵌入")
	flag.StringVar(&icoPath, "ico", "", "图标 (.ico) 路径，留空则不嵌入")
	flag.StringVar(&outPath, "o", "rsrc_windows_amd64.syso", "输出 .syso 路径")
	flag.StringVar(&arch, "arch", "amd64", "目标架构: 386, amd64, arm, arm64")
	flag.Parse()

	if manifestPath == "" && icoPath == "" {
		fmt.Fprintln(os.Stderr, "mkrsrc: 至少要指定 -manifest 或 -ico 之一")
		os.Exit(2)
	}
	if err := build(manifestPath, icoPath, outPath, arch); err != nil {
		fmt.Fprintln(os.Stderr, "mkrsrc:", err)
		os.Exit(1)
	}
}

func build(manifestPath, icoPath, outPath, arch string) error {
	out := coff.NewRSRC()
	// Arch 必须在 NewRSRC 之后立刻调用，它决定重定位类型。
	if err := out.Arch(arch); err != nil {
		return err
	}

	// 清单：固定 ID 1
	if manifestPath != "" {
		mf, err := binutil.SizedOpen(manifestPath)
		if err != nil {
			return fmt.Errorf("打开清单 %s: %w", manifestPath, err)
		}
		defer mf.Close()
		out.AddResource(coff.RT_MANIFEST, manifestID, mf)
		fmt.Printf("RT_MANIFEST  id=%d  %s (%d 字节)\n", manifestID, manifestPath, mf.Size())
	}

	// 图标：RT_ICON 逐个条目 + RT_GROUP_ICON 汇总
	if icoPath != "" {
		if err := addIcon(out, icoPath); err != nil {
			return err
		}
	}

	out.Freeze()
	if err := writeCoff(out, outPath); err != nil {
		return err
	}

	fi, err := os.Stat(outPath)
	if err != nil {
		return err
	}
	fmt.Printf("已写出 %s (%d 字节)\n", outPath, fi.Size())
	return nil
}

func addIcon(out *coff.Coff, icoPath string) error {
	// 整个 .ico 读进内存：coff.AddResource 只是记下 Sizer，真正的字节要到
	// 最后的 writeCoff 才被读走，所以不能依赖文件句柄还开着。
	raw, err := os.ReadFile(icoPath)
	if err != nil {
		return fmt.Errorf("读取图标 %s: %w", icoPath, err)
	}

	icons, err := ico.DecodeHeaders(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("解析图标目录 %s: %w", icoPath, err)
	}
	if len(icons) == 0 {
		return fmt.Errorf("图标 %s 不含任何图像", icoPath)
	}

	group := grpIconDir{ICONDIR: ico.ICONDIR{
		Reserved: 0,
		Type:     1, // 1 = 图标
		Count:    uint16(len(icons)),
	}}

	// RT_ICON 的 ID 从 1 开始递增。AddResource 要求同一资源类型内 ID 递增，
	// 因为它是按"叶子顺序"往 DataEntries 里插入的。
	// 注意 RT_ICON 与 RT_GROUP_ICON 是两个独立的名字空间，ID 可以重复，互不影响。
	for i, icon := range icons {
		id := uint16(i + 1)
		sr := io.NewSectionReader(bytes.NewReader(raw), int64(icon.ImageOffset), int64(icon.BytesInRes))
		out.AddResource(coff.RT_ICON, id, sr)
		group.Entries = append(group.Entries, grpIconDirEntry{
			IconDirEntryCommon: icon.IconDirEntryCommon,
			Id:                 id,
		})
		// 宽度/高度是 byte，值为 0 在 ICO 格式里表示 256
		w, h := int(icon.Width), int(icon.Height)
		if w == 0 {
			w = 256
		}
		if h == 0 {
			h = 256
		}
		fmt.Printf("RT_ICON      id=%d  %dx%d %dbpp (%d 字节)\n", id, w, h, icon.BitCount, icon.BytesInRes)
	}

	// 组图标放在最后加，ID 固定 7（walk 硬编码读取的值）。
	out.AddResource(coff.RT_GROUP_ICON, groupIconID, group)
	fmt.Printf("RT_GROUP_ICON id=%d  %d 个尺寸 -> %s\n", groupIconID, len(icons), icoPath)
	return nil
}

// writeCoff 复刻 github.com/akavel/rsrc/internal.Write。
// internal 包受 Go 的 internal 规则保护（只能被 github.com/akavel/rsrc 模块内的代码
// 导入），所以这里用同样导出的 binutil 原语重新实现一遍。
func writeCoff(c *coff.Coff, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	w := binutil.Writer{W: f}
	binutil.Walk(c, func(v reflect.Value, _ string) error {
		if binutil.Plain(v.Kind()) {
			w.WriteLE(v.Interface())
			return nil
		}
		if sr, ok := v.Interface().(binutil.SizedReader); ok {
			w.WriteFromSized(sr)
			return binutil.WALK_SKIP
		}
		return nil
	})
	if w.Err != nil {
		return fmt.Errorf("写出 %s: %w", path, w.Err)
	}
	return nil
}
