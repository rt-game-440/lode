# Issue tracker：GitHub

本仓库的 issue 和规格都放在 GitHub Issues（`rt-game-440/lode`），所有操作都用 `gh` CLI。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。正文有多行时用 heredoc，或者先写入文件再用 `--body-file`。
- **读取 issue**：`gh issue view <编号> --json number,title,body,labels,comments`。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` 和 `--state` 筛选。
- **设为父 issue 的子 issue**：`gh issue create --parent <父编号> ...`，或者事后用 `gh issue edit <父编号> --add-sub-issue <子编号>`（需要 `gh` 2.94 及以上）。旧版 `gh`：`gh api --method POST repos/<owner>/<repo>/issues/<父编号>/sub_issues -F sub_issue_id=<子 issue 的 database id>`（database id 的取法见下面的 **阻塞关系**）。不用子 issue 时，在子 issue 正文开头写 `Part of #<父编号>`。
- **评论**：`gh issue comment <编号> --body "..."`
- **加 / 去标签**：`gh issue edit <编号> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <编号> --comment "..."`

仓库从 `git remote -v` 推断，在仓库目录里运行 `gh` 时会自动识别。

本仓库还有一个 `stage` 标签，表示开发阶段任务，正文就是编码 agent 的任务说明。具体规则见 `AGENTS.md` 开头。

## 把 PR 当作分诊来源

**是否把 PR 当作需求来源：否。**（如果本仓库把外部 PR 当作功能请求处理，就改成“是”；`/triage` 会读这个开关。）

改成“是”以后，PR 和 issue 共用同一套标签和状态，用对应的 `gh pr` 命令：

- **读取 PR**：`gh pr view <编号> --comments`，看 diff 用 `gh pr diff <编号>`。
- **列出待分诊的外部 PR**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论 / 加标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 和 PR 共用一套编号，单写 `#42` 可能指任意一种：先试 `gh pr view 42`，不是 PR 再用 `gh issue view 42`。

## 技能说“发布到 issue tracker”时

创建一个 GitHub issue。

## 技能说“获取相关 ticket”时

按上面的 **读取 issue** 读取。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图**（map）是一个 issue，下面挂若干**子 issue** 作为 ticket。

- **地图**：一个打了 `wayfinder:map` 标签的 issue，正文包含 Notes、Decisions-so-far、Fog 三部分。`gh issue create --label wayfinder:map`。
- **子 ticket**：以 GitHub 子 issue 的形式挂在地图下（见上面的 **设为父 issue 的子 issue**）。没有开启子 issue 功能时，在地图正文的任务列表里列出它，并在子 issue 正文开头写 `Part of #<地图编号>`。标签用 `wayfinder:<类型>`（`research` / `prototype` / `grilling` / `task`）。认领后指派给负责的开发者。
- **阻塞关系**：用 GitHub **原生的 issue 依赖**，这是标准做法，界面上也能看到。添加一条依赖：`gh api --method POST repos/<owner>/<repo>/issues/<子编号>/dependencies/blocked_by -F issue_id=<阻塞方的 database id>`。`<阻塞方的 database id>` 是数字形式的 **database id**，用 `gh api repos/<owner>/<repo>/issues/<n> --jq .id` 取得，不是 `#编号`，也不是 `node_id`。GitHub 的 `issue_dependencies_summary.blocked_by` 只统计还没关闭的阻塞方，以它为准。不能用依赖功能时，在子 issue 正文开头写一行 `Blocked by: #<n>, #<n>`。所有阻塞方都关闭后，ticket 才算解除阻塞。
- **可做 ticket 查询**：列出地图下所有未关闭的子 issue（`gh issue list --state open`，范围限定在地图的子 issue 或任务列表里），去掉还有未关闭阻塞方的（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里有未关闭的 issue），也去掉已经有人认领的；剩下的按地图里的顺序，取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是会话里的第一个写操作。
- **结案**：`gh issue comment <n> --body "<结论>"`，然后 `gh issue close <n>`，再在地图的 Decisions-so-far 里追加一条指向它的记录（要点 + 链接）。
