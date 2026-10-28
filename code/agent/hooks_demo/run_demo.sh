#!/usr/bin/env bash
# 用 echo 手工构造 stdin JSON，直接喂给 hook 脚本 —— 不需要启动 Claude Code。
# 在 code/agent 目录下运行：bash hooks_demo/run_demo.sh
set -u
cd "$(dirname "$0")/.."

pre() {  # $1 = Bash 命令
  printf '{"session_id":"demo","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":%s,"description":"demo"},"tool_use_id":"toolu_demo"}' \
    "$PWD" "$(jq -Rn --arg c "$1" '$c')"
}

for cmd in "ls -la" "rm -rf /" "git push origin main --force" "npm publish" "python3 scripts/x.py"; do
  echo "### PreToolUse: $cmd"
  out=$(pre "$cmd" | python3 hooks_demo/guard_bash.py 2>/tmp/hooks_demo_err); code=$?
  echo "exit=$code"
  [ -n "$out" ] && echo "stdout=$out"
  [ -s /tmp/hooks_demo_err ] && echo "stderr=$(cat /tmp/hooks_demo_err)"
  echo
done

echo "### Stop（第一次，transcript 里没有 passed）"
tp=$(mktemp); echo '{"type":"assistant","text":"改完了"}' > "$tp"
echo "{\"hook_event_name\":\"Stop\",\"transcript_path\":\"$tp\",\"stop_hook_active\":false}" | python3 hooks_demo/stop_gate.py; echo "exit=$?"
echo
echo "### Stop（stop_hook_active=true，放行）"
echo "{\"hook_event_name\":\"Stop\",\"transcript_path\":\"$tp\",\"stop_hook_active\":true}" | python3 hooks_demo/stop_gate.py; echo "exit=$? (stdout 为空 = 允许停)"
rm -f "$tp" /tmp/hooks_demo_err
