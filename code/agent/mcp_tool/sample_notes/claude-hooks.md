# Claude Code hooks 笔记

- SessionStart 的 stdout / additionalContext 会被注入上下文
- PreToolUse 可以返回 permissionDecision: deny 拦截工具调用
- Stop hook 返回 decision: block 可以让 Claude 继续干活，注意别死循环
