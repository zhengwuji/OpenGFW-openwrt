// OneWayFW 文件日志
//
// 程序以 -H windowsgui 构建（无控制台窗口），因此不能再用标准错误输出，
// 统一把日志写到 %ProgramData%\OneWayFW\onewayfw.log。
package main

import (
	"io"
	"log"
	"os"
	"path/filepath"
)

var logFile *os.File

// initLogging 打开数据目录下的日志文件；失败时退回丢弃输出，不阻断启动。
func initLogging() {
	log.SetFlags(log.LstdFlags)

	dir := storeDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.SetOutput(io.Discard)
		return
	}

	f, err := os.OpenFile(filepath.Join(dir, "onewayfw.log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.SetOutput(io.Discard)
		return
	}

	logFile = f
	log.SetOutput(f)
}

func closeLogging() {
	if logFile != nil {
		_ = logFile.Close()
		logFile = nil
	}
}
