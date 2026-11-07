//go:build windows

package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// processMemoryCounters 对应 Win32 的 PROCESS_MEMORY_COUNTERS。
type processMemoryCounters struct {
	cb                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

var getProcessMemoryInfo = windows.NewLazySystemDLL("psapi.dll").NewProc("GetProcessMemoryInfo")

// rssMB 返回进程的工作集（Windows 上对应 RSS）。
func rssMB(pid int) (float64, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(h)
	var c processMemoryCounters
	c.cb = uint32(unsafe.Sizeof(c))
	if r, _, err := getProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&c)), uintptr(c.cb)); r == 0 {
		return 0, err
	}
	return float64(c.WorkingSetSize) / (1 << 20), nil
}
