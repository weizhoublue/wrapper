# readme


阅读当前工程 docs 目录下的各种相关文档，了解当前已经实现的各种 provided 的原理。
我希望新增一个对于 agy 的这种 provider。
 它和 Gemini 都是谷歌推出的，所以它们应该很类似。
 可以运行 agy --help 获取他的这个工作方式，也许我们还可以用 ACP 的方式来对接。我希望你先测试一下 acp 是否能够对接该 CI，然后给出最终的方案。

agy 的默认 command 是 'agy --dangerously-skip-permissions --prompt '




阅读当前工程 docs 目录下的各种相关文档，了解当前已经实现的各种 provided 的原理。
我希望新增一个对于 opencode 的这种 provider。
可以运行 opencode --help 获取他的这个工作方式，可以用 ACP 的方式来对接。我希望你先测试一下 acp 是否能够对接该 CLI，然后给出最终的方案。

agy 的默认 command 是 'opencode run  --dangerously-skip-permissions '



当前我们有用正则式来匹配输出内容的如下选项。
  -e, --reg <模式>         用于匹配输出的正则表达式(大小写不敏感)，如果不匹配，则会重试运行命令 

我希望新增一个选项，也是大小写不敏感的正则式匹配。如果匹配成功，直接宣告这个 Agent 运行失败，而且也不再需要重试
  -x, --exclude <模式>      用于匹配输出的正则表达式(大小写不敏感)，如果匹配成功,则直接宣告当前 agent 失败，不会失败 



