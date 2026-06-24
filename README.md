# readme




阅读当前工程 docs 目录下的各种相关文档，了解当前已经实现的各种 provided 的原理。
我希望新增一个对于 opencode 的这种 provider。
可以运行 opencode --help 获取他的这个工作方式，可以用 ACP 的方式来对接。我希望你先测试一下 acp 是否能够对接该 CLI，然后给出最终的方案。
默认 command 是 'opencode run  --dangerously-skip-permissions '


===============

当前我们有用正则式来匹配 agent 的标准输出 
  -e, --reg <模式>         用于匹配输出的正则表达式(大小写不敏感)，如果匹配失败，则会重试运行命令 

我希望新增一个对称的选项
  -x, --exclude <模式>      用于匹配标准输出的正则表达式(大小写不敏感)，如果匹配成功,则直接宣告当前 agent 失败，并且不再重试该 agent 




========================

main.js  我希望在该文件中新增如下一个字典
const LimitMsg = {
  // 未知， 还没有出发到。
  claude: "",
  codex: "hit your usage limit",
  copilot: "You have exceeded your monthly quota",
  gemini: "You have exhausted your capacity",
  // 未知， 还没有出发到。
  cursor: "",
  // 空的输出，并且返回码也是成功的
  agy: "",
};
它的作用就是，例如 如果当前调用到 codex 这个 Agent，如果LimitMsg 字典中它对应的值不是一个空串，并且 codex 的退出码是非零,那么我们对其标准的错误输出进行字典中 "You've hit your usage limit" 大小写不敏感的 正则匹配，如果匹配成功，说明该 Agent 的订阅额度当前已经消耗完。此时不再需要对其进行重试，直接宣告当前的 Agent 失败， 如果后续没有 fallback agent 了，那么直接 返回 非0 返回码  。




copilot 标准错误输出
You have exceeded your monthly quota
退出码 非 0


codex 标准错误输出
You've hit your usage limit
退出码 非 0



opencode 卡住没消息

