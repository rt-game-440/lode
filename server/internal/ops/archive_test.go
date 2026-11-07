package ops

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"testing"
)

// writeTestArchive 写一个 tar.gz，条目名原样写入（用来构造恶意备份）。清单放在最前。
func writeTestArchive(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	order := []string{manifestName}
	for name := range files {
		if name != manifestName {
			order = append(order, name)
		}
	}
	for _, name := range order {
		body, ok := files[name]
		if !ok {
			continue
		}
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(body)), Typeflag: tar.TypeReg})
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
}
