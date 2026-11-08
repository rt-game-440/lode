# 领域文档

说明工程类技能在探索代码库时，应该怎样使用本仓库的领域文档。

## 探索前先读

- 根目录的 **`GLOSSARY.md`**；如果根目录有 **`GLOSSARY-MAP.md`**，它会指向每个上下文各自的 `GLOSSARY.md`，读和当前主题相关的那几份。
- **`docs/adr/`**：读涉及你要改动的那部分的 ADR。

这些文件不存在时，**直接继续，不要提**：不要指出它们缺失，也不要建议提前创建。`/domain-modeling` 技能（通过 `/grill-with-docs` 和 `/improve-codebase-architecture` 调用）会在确实厘清了术语或做出了决定时再创建它们。

本仓库是单一上下文。项目的规格和约定主要写在 `docs/SPEC.md` 和 `AGENTS.md`，各阶段说明在 `docs/stages/`，较大的功能设计单独成文（例如 `docs/workspaces.md`）。

## 文件结构

单一上下文（本仓库）：

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
├── server/
└── web/
```

## 使用术语表里的词

你的产出（issue 标题、重构方案、假设、测试名）里提到领域概念时，使用 `GLOSSARY.md` 定义的术语，不要换成术语表明确不用的同义词。

如果需要的概念还不在术语表里，说明两种可能：要么你在发明项目里不用的说法（重新考虑），要么术语表确实有缺口（记下来交给 `/domain-modeling`）。

## 指出和 ADR 的冲突

如果你的产出和已有的 ADR 矛盾，要明确指出，不要悄悄推翻：

> _与 ADR-0007（订单采用事件溯源）矛盾，但值得重新讨论，因为……_
