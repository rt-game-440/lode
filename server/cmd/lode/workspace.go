package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/rt-game-440/lode/server/internal/config"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/ops"
	"github.com/rt-game-440/lode/server/internal/vault"
	"github.com/rt-game-440/lode/server/internal/workspace"
)

const workspaceUsage = `用法：
  lode workspace list [--json]
  lode workspace add <名称> [--dir <绝对路径>]
  lode workspace rename <id> <新名称>
  lode workspace remove <id>
服务运行中不能执行；语义与设置页、/api/workspaces 一致。`

// runWorkspace 实现 lode workspace：直接操作数据目录里的工作空间登记，必须先停止服务（和 restore 一样检查数据目录锁）。
// 复用 workspace.Manager，所以校验规则、错误信息和删除语义都和界面、接口一致：
// --dir 接入已有的外部目录；remove 把内置空间的目录移到 trash-workspaces/，外部目录只处理索引，笔记文件不动。
func runWorkspace(cfg config.Config, args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New(workspaceUsage)
	}
	sub, args := args[0], args[1:]
	switch sub {
	case "list", "add", "rename", "remove":
	default:
		return fmt.Errorf("未知的子命令 %q\n%s", sub, workspaceUsage)
	}
	// 先校验参数，免得参数错了还去抢锁
	var asJSON bool
	var name, id, dir string
	switch sub {
	case "list":
		for _, a := range args {
			if a != "--json" {
				return errors.New("用法：lode workspace list [--json]")
			}
			asJSON = true
		}
	case "add":
		var pos []string
		for i := 0; i < len(args); i++ {
			switch a := args[i]; {
			case a == "--dir":
				if i+1 >= len(args) {
					return errors.New("--dir 需要一个路径")
				}
				i++
				dir = args[i]
			case strings.HasPrefix(a, "--dir="):
				dir = strings.TrimPrefix(a, "--dir=")
			case strings.HasPrefix(a, "--"):
				return fmt.Errorf("未知的选项 %s", a)
			default:
				pos = append(pos, a)
			}
		}
		if len(pos) != 1 {
			return errors.New("用法：lode workspace add <名称> [--dir <绝对路径>]")
		}
		name = pos[0]
	case "rename":
		if len(args) != 2 {
			return errors.New("用法：lode workspace rename <id> <新名称>")
		}
		id, name = args[0], args[1]
	case "remove":
		if len(args) != 1 {
			return errors.New("用法：lode workspace remove <id>")
		}
		id = args[0]
	}

	unlock, err := ops.Lock(cfg.DataDir)
	switch {
	case errors.Is(err, ops.ErrLocked):
		return errors.New("lode 服务正在运行，请先停止服务再执行 lode workspace")
	case errors.Is(err, ops.ErrLockUnsupported):
		fmt.Fprintln(os.Stderr, "警告：无法锁定数据目录，请确认服务已停止")
	case err != nil:
		return err
	}
	defer unlock()
	ctx := context.Background()
	// 不新建数据库：LODE_DATA_DIR 写错时应报错，而不是在别处建一个空库并提示成功
	if _, err := os.Stat(cfg.DBPath()); err != nil {
		return fmt.Errorf("数据目录 %s 里没有数据库，请检查 LODE_DATA_DIR：%w", cfg.DataDir, err)
	}
	d, err := db.Open(ctx, cfg.DBPath())
	if err != nil {
		return err
	}
	defer d.Close()
	v, err := vault.New(cfg.VaultDir())
	if err != nil {
		return err
	}
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	m := workspace.New(workspace.Options{
		Default: notes.New(notes.Options{DB: d, Vault: v, TrashDir: cfg.TrashDir(), Logger: quiet}),
		DB:      d, DataDir: cfg.DataDir, Logger: quiet,
	})
	defer m.Close()

	switch sub {
	case "list":
		list, err := m.List(ctx)
		if err != nil {
			return err
		}
		if asJSON {
			enc := json.NewEncoder(out)
			enc.SetIndent("", "  ")
			return enc.Encode(map[string]any{"workspaces": list})
		}
		tw := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\t名称\t笔记数\t位置")
		for _, in := range list {
			where := in.Path
			if !in.External {
				where += "（数据目录内）"
			}
			fmt.Fprintf(tw, "%s\t%s\t%d\t%s\n", in.ID, in.Name, in.NoteCount, where)
		}
		return tw.Flush()
	case "add":
		in, err := m.Create(ctx, workspace.CreateOptions{Name: name, VaultDir: dir})
		if err != nil {
			return trimInvalid(err)
		}
		if in.External {
			fmt.Fprintf(out, "已接入工作空间 %s（%s），使用已有文件夹 %s，里面的笔记会在 Lode 启动后自动对账。\n", in.ID, in.Name, in.VaultDir)
		} else {
			fmt.Fprintf(out, "已新建工作空间 %s（%s），笔记放在数据目录的 %s。\n", in.ID, in.Name, in.Path)
		}
		return nil
	case "rename":
		in, err := m.Rename(ctx, id, name)
		if err != nil {
			return workspaceCLIError(err, id)
		}
		fmt.Fprintf(out, "已把工作空间 %s 改名为「%s」。\n", in.ID, in.Name)
		return nil
	case "remove":
		in, err := m.Info(ctx, id)
		if err != nil {
			return workspaceCLIError(err, id)
		}
		res, err := m.Remove(ctx, id)
		if err != nil {
			return workspaceCLIError(err, id)
		}
		if in.External {
			fmt.Fprintf(out, "已删除工作空间 %s（%s）。外部文件夹 %s 里的笔记文件没有动；索引和回收站移到了数据目录的 %s。\n", in.ID, in.Name, in.VaultDir, res.Trash)
		} else {
			fmt.Fprintf(out, "已删除工作空间 %s（%s），它的目录移到了数据目录的 %s，确认无误后可以手动清理。\n", in.ID, in.Name, res.Trash)
		}
		if res.RevokedTokens > 0 {
			fmt.Fprintf(out, "绑定它的 %d 个 MCP token 已作废。\n", res.RevokedTokens)
		}
		return nil
	}
	return nil
}

// trimInvalid 去掉 workspace.ErrInvalid 的英文前缀，错误信息可以直接给用户看。
func trimInvalid(err error) error {
	if errors.Is(err, workspace.ErrInvalid) {
		return errors.New(strings.TrimPrefix(err.Error(), workspace.ErrInvalid.Error()+": "))
	}
	return err
}

func workspaceCLIError(err error, id string) error {
	switch {
	case errors.Is(err, workspace.ErrNotFound):
		return fmt.Errorf("没有 id 为 %q 的工作空间（lode workspace list 可以查看）", id)
	case errors.Is(err, workspace.ErrProtected):
		return errors.New("默认工作空间不能删除")
	}
	return trimInvalid(err)
}
