# Triage labels

| Canonical role | Label | 含义 |
| --- | --- | --- |
| needs-triage | needs-triage | 维护者需要评估 |
| needs-info | needs-info | 等待报告者补充 |
| ready-for-agent | ready-for-agent | 规格、依赖、验收充分，可自主实现 |
| ready-for-human | ready-for-human | 需要人工实现或决策 |
| wontfix | wontfix | 不处理，记录原因 |

同一条任务最多保留一个分诊状态标签。转换时移除旧状态，保留其他分类标签。前置依赖未完成或上下文不足时不得标记 ready-for-agent。
