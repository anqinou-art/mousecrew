# Skills

Four role skills for an AI build crew, written in Chinese. Each folder is a self-contained skill (`SKILL.md` plus optional `references/`) that a single agent can load to do the whole workflow alone, or that a crew can split by role.

| Skill | Role |
| --- | --- |
| [`architect`](architect/SKILL.md) | 架构师：聊需求、盘存货、功能地图和两份架构图给人确认、验最没把握的假设、拆单写合同、裁边界、复验、汇报、维护文档 |
| [`coder`](coder/SKILL.md) | 代码鼠：接单核输入、写最小够用的实现、按风险出证据、写交付说明；写代码守则在 `references/写代码守则.md` |
| [`auditor`](auditor/SKILL.md) | 审计鼠：唯一的合并闸门——读调用链、残留扫描、补丁识别、四段报告，过了合主干，不过带行号驳回 |
| [`frontend-builder`](frontend-builder/SKILL.md) | 前端：从设备、功能、风格聊起，先做代表页，形成设计配方，整理素材，贯通核心链路再交付 |

Install: copy a folder into wherever your agent host loads skills (for Claude Code, `.claude/skills/`), keeping `SKILL.md` and `references/` together.

一个人只开一只 AI 时，按阶段依次用：立项和方案 `architect` → 写代码 `coder` / 做界面 `frontend-builder` → 审查 `auditor`。实现和审查分成两遍、换一个干净的工作区。
