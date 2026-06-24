# readme



我希望这个命令能够支持这个 fallback 冗余 的特性。
在命令行选项中能够指定多个不同的 Agent。当前面的 Agent 失败时，下一次就会尝试下一个 Agent；如果前一个 Agent 成功了，那就直接结束。

（1）基本的轮转策略。
例如， 我们可以通过多次指定杠 T，先尝试 Copilot。如果 Copilot 成功了，那就直接成功；如果 Copilot 失败了，则尝试下一个 agent codex。
wrapper -t copilot -t codex -p "say hi in one word"


 这是另一个例子。我们知道，-T 和 -C 可以作为一个组合来实现命令的再次自定义，那么我们通过两组 -T 和 -C 选项来实现冗余调用 claude-deepseek 和  claude-deepseek-flash
wrapper -t claude -c "claude-deepseek" -t claude -c "claude-deepseek-flash"  -p "say hi in one word"

（2）其他命令行选项 配合
在多个 Agent 冗余调用的场景下，命令行选项的如下参数，其实都适用于每一个 Agent 的调用。
  -e, --reg <pattern>     Regex pattern to match against output
  -r, --retry <n>         Max retry count (default: 3)
  -s, --resume <id>       Resume a previous session
  -o, --timeout <sec>     Timeout in seconds (default: 0, no timeout)
例子: 以下 Copilot 会尝试 3 次，如果失败了，那么 codex 尝试 3 次。
wrapper -t copilot -t codex -r 3 -p "say hi in one word"



（3）命令输出
  stdout  = child process stdout
  stderr  = child process stderr + session ID (last line)
  exit code = child process exit code

stderr 这个标准的错误输出做一下修改，使得它倒数第二行输出最终成功调用的 agent 的 command 的名字。
  stderr  = child process stderr + agentCommandName(倒数第二行) + session ID (last line)

例子: 
wrapper -t copilot -t codex -r 3 -p "say hi in one word"

例如如上，如果 Copilot 失败了，而 Codex 成功了。
那么 stderr 的 倒数第二行就是  codex （ -t codex 类型的 --command 参数值，也许是默认值，也许是用户 -c 覆盖了新值 ）



stdout 输最后一个 Agent 的标准输出
stderr 输出所有 Agent 标准输出和标准错误输出，便于调试
exit code 出最后一个 Agent 的退出码。


-t claude -c "claude-deepseek" -c "claude-deepseek-remote" -t copilot

-t claude -r 3 -c "claude-deepseek-remote" -t copilot






