//go:build !windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// rssMB 返回进程的常驻内存：Linux 读 /proc，其他系统用 ps。
func rssMB(pid int) (float64, error) {
	if f, err := os.Open(fmt.Sprintf("/proc/%d/status", pid)); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if v, ok := strings.CutPrefix(sc.Text(), "VmRSS:"); ok {
				kb, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(v), "kB")), 64)
				return kb / 1024, err
			}
		}
	}
	out, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, err
	}
	kb, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	return kb / 1024, err
}
