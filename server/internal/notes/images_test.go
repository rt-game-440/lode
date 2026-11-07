package notes

import (
	"testing"
	"time"
)

func TestImagesListsVaultImagesNewestFirst(t *testing.T) {
	f := newFixture(t)
	f.writeDisk(t, "attachments/old.png", "x")
	time.Sleep(20 * time.Millisecond)
	f.writeDisk(t, "旅行/照片.JPG", "xy")
	f.writeDisk(t, "旅行/说明.md", "# 说明")
	f.writeDisk(t, "旅行/data.pdf", "%PDF")
	f.writeDisk(t, ".obsidian/icon.png", "x")
	got, err := f.svc.Images(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Path != "旅行/照片.JPG" || got[0].Size != 2 || got[1].Path != "attachments/old.png" {
		t.Fatalf("Images = %+v", got)
	}
	if got, _ := f.svc.Images(1); len(got) != 1 {
		t.Fatalf("limit 应生效：%+v", got)
	}
}
