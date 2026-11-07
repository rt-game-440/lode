# Lode

自托管、单用户、跨平台的 Web Markdown 笔记应用：可安装为 PWA，多端即时同步，自带 Agent 助手并对外提供 MCP。定位是"自托管、同步更方便、自带 agent 的 Obsidian"。

> 状态：规划中。开发分 6 个阶段推进，每个阶段对应一个带 `stage` 标签的 issue，issue 正文就是交给编码 agent 的任务说明。

- 产品规格：[docs/SPEC.md](docs/SPEC.md)
- 开发约定：[AGENTS.md](AGENTS.md)
- 各阶段任务：[docs/stages/](docs/stages/)

## 计划特性

- 笔记就是普通 `.md` 文件，可以直接用 Obsidian 打开
- `[[双向链接]]`、反链、标签、全文搜索（支持中文）、快速切换器
- 多设备即时保存与同步，离线可编辑，冲突不丢数据
- 可安装为 PWA，Apple 风格的界面与交互
- 内置 Agent：多个供应商的多个模型，每个模型单独设置上下文窗口、推理强度、输入模态
- 对外提供 MCP，其他 agent 可以搜索和编辑你的笔记
- Go 单二进制 + SQLite，适合 512MB 内存的小机器

## 许可证

[MIT](LICENSE)
