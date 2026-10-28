---
name: pr-summary
description: 汇总当前分支相对 main 的改动并写成 PR 描述。触发：「写 PR 描述」「总结这次改动」。
argument-hint: "[base-branch]"
---

# PR 描述生成

基线分支：$0（默认 main）

## 当前环境
!`node --version`

## 步骤
1. 读 `git diff $0...HEAD --stat` 看改动面。
2. 按「动机 / 改动 / 验证」三段写。
3. 涉及 UI 的改动，查 ${CLAUDE_SKILL_DIR}/references/ui-checklist.md。
