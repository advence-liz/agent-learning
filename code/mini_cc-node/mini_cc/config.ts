/**
 * 运行配置：一个类收拢所有「可调旋钮」，避免散落在各模块的全局变量。（第 1 章起）
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL = "claude-opus-5-5";

function defaultHome(): string {
  return process.env.MINI_CC_HOME ?? join(homedir(), ".mini_cc");
}

export class Settings {
  model = DEFAULT_MODEL;
  // 流式请求给足空间（claude-api skill 的建议：streaming 默认 ~64000）
  maxTokens = 64000;
  // Opus 5.5 的 effort 默认就是 medium，这里显式写出来，方便 /status 展示
  effort = "medium";
  cwd = process.cwd();
  // 会话、设置等落盘位置（第 4 章开始用），测试里指向临时目录
  home = defaultHome();
  // 单轮最多跑多少次「模型 → 工具」来回，防止死循环烧 token
  maxIterations = 50;
  // 第 3 章：API 重试
  maxRetries = 5;
  retryBaseDelay = 1.0;
  retryMaxDelay = 30.0;
  // 服务端 refusal fallback（claude-api skill 推荐默认开启）；中转站不支持时 MINI_CC_FALLBACKS=0
  fallbacks = (process.env.MINI_CC_FALLBACKS ?? "1") !== "0";
  // 工具输出超过这么多字符就截断，防止一条 cat 把上下文撑爆
  maxToolOutput = 30000;
  // 第 5 章：权限模式 default | acceptEdits | auto | plan | bypassPermissions
  permissionMode = "default";
  // 第 14 章：上下文窗口与自动压缩。上一次请求的输入超过 window - buffer 就先压缩再请求
  // （Opus 5.5 是 1M 窗口；buffer 留给压缩请求本身和这一步新增的工具结果）
  contextWindow = 1_000_000;
  autoCompactBuffer = 40_000;
  autoCompact = true;

  constructor(init: Partial<Settings> = {}) {
    Object.assign(this, init);
  }
}
