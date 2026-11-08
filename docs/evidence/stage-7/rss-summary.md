# 阶段 7-8：多工作空间空闲内存

口径：Windows 本机，进程 WorkingSet（与阶段 1、2 的 RSS 口径一致），`LODE_LOG_LEVEL=warn`，启动并对账后空闲 15s 读取，默认空间保持 2 个 WebSocket 连接。每个空间 1000 篇笔记（gennotes 生成）。
基线 = main 上 6b43660（阶段 6 结束后的代码）用同一个脚本、同一台机器重新构建测量（`rss.ps1 -Bin`），不是历史数字，避免机器状态差异。
复现：`scripts/rss.ps1 -Workspaces K`（sh：`WORKSPACES=K scripts/rss.sh`），K 是默认空间之外再建的空间数。

| 情况 | 空闲 WorkingSet | 对比 | 验收 | 原始输出 |
|---|---:|---|---|---|
| 基线（6b43660），只有默认空间 | 23.1 / 23.3 / 23.2 MB（均值 23.2） | - | - | rss-baseline-run1~3.txt |
| 本分支，只有默认空间 | 23.3 / 23.2 / 23.3 MB（均值 23.3） | +0.1 MB | 增量 ≤ 2MB，通过 | rss-default-run1~3.txt |
| 3 个空间（默认 + 2）各 1000 篇，全部已打开 | 33.4 MB | 比只有默认空间 +10.1 MB | ≤ 80MB，通过 | rss-ws3-run1.txt |
| 4 个空间（默认 + 3）各 1000 篇，全部已打开 | 36.5 MB | +13.2 MB | ≤ 80MB，通过 | rss-ws4-run1.txt |

Git Bash 下 `WORKSPACES=2 sh scripts/rss.sh`（ps rss 口径）：33.8 MB，同样通过。

"3 个空间"可能指默认 + 2 或默认 + 3，两种都测了，都远低于 80MB。

## 占用来源

每多打开一个 1000 篇的空间约增加 3.3~5 MB 常驻内存（第一个额外空间约 5 MB，之后每个约 3 MB），来自该空间的 SQLite 连接与页缓存、FTS 索引缓存、笔记树和监听器。没有发现超出预算的单项，无需优化。私有内存（已提交）每个空间约增加 3 MB。
