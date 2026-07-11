# 测试

## claude

```shell

npm install

# 基本
node src/main.js run -t claude -c "claude-free-remote" \
   "say hi in one word" 2>/dev/null
echo $?

# 日志
node src/main.js run -t claude -c "claude-free-remote" -d \
   "say hi in one word"
echo $?

# 标准输出
node src/main.js run -t claude -c "claude-free-remote" -d \
   "say hi in one word"  2>/dev/null
echo $?



# 错误输出 ， 有思考过程 和 会话 id
node src/main.js run -t claude -c "claude-free-remote"  \
   "what is your name"  1>/dev/null
echo $?


# 错误命令
node src/main.js run -t claude -c "claude-free-bad"  \
   "what is your name" 
echo $?


------------------

# 正则匹配
node src/main.js run -t claude -c "claude-free-remote" -d \
  -e "bingo|Bingo" \
   "please say bingo in english"



# 重试控制, 基于相同会话 重试 
node src/main.js run -t claude -c "claude-free-remote" -d -r 2 \
  -e "no_bingo" \
   "say hi in one word ? reply me in english"



# 错误命令
node src/main.js run -t claude -c "claude-free-bad"  -d \
   "what is your name" 
echo $?



# 超时控制
node src/main.js run -t claude -c "claude-free-remote"  -d -o 1 \
   "please reply me after 10 seconds" 
echo $?


# 继续会话
node src/main.js run -t claude -c "claude-free-remote" -d "tomorow will rain" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
cat /tmp/sid
echo "session=${session}"
echo "------------------"
node src/main.js run -t claude -c "claude-free-remote" \
    -s ${session}  "tell me all what I have said in this session " 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"


# 重试的会话一致性
node src/main.js run -t claude -c "claude-free-remote"  -d "what is your name" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"
echo "------------------"
node src/main.js run -t claude -c "claude-free-remote" -d \
  -s ${session} \
  -e "no_bingo" \
   "tell me all what I have said in this session ? reply me in english"


```

## codex

```shell

npm install


# 基本
node src/main.js run -t codex  -d \
   "say hi in one word" 
echo $?  2>/dev/null


# 日志
node src/main.js run -t codex  -d \
   "say hi in one word" 
echo $?


# 命令
node src/main.js run -t codex -c 'codex exec --sandbox danger-full-access --skip-git-repo-check'  -d \
   "say hi in one word" 
echo $?


# 错误命令
node src/main.js run -t codex -c "codex-bad"  -d \
   "what is your name" 
echo $?



------------------

# 正则匹配
node src/main.js run -t codex  -d \
  -e "bingo|Bingo" \
   "please say bingo in english"
echo $?



# 重试控制, 基于相同会话 重试 
node src/main.js run -t codex -d -r 1 \
  -e "no_bingo" \
   "say hi in one word ? reply me in english"
echo $?



# 超时控制
node src/main.js run -t codex -d -o 1 \
   "please reply me after 10 seconds" 
echo $?




#   remuse 会话 
node src/main.js run -t codex   "tomorow is monday"  -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
cat /tmp/sid
echo "session=${session}"
echo "------------------"
node src/main.js run -t codex \
	-s ${session} \
	-d "tell me all what I have said in this session "  2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"


# 重试的会话一致性
node src/main.js run -t codex  "what is your name" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"
echo "------------------"
node src/main.js run -t codex -d \
  -s ${session} \
  -e "no_bingo" \
   "tell me all what I have said ? reply me in english"
echo $?




```




## copilot

```shell

npm install


# 基本
node src/main.js run -t copilot  \
   "say hi in one word"  2>/tmp/a
echo $?  
echo 
cat /tmp/a

# 日志
node src/main.js run -t copilot  -d \
   "say hi in one word" 
echo $?


# 命令
node src/main.js run -t copilot -c 'copilot --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user '  -d \
   "say hi in one word" 
echo $?


# 错误命令
node src/main.js run -t copilot -c "copilot-bad"  -d \
   "what is your name" 
echo $?



------------------

# 正则匹配
node src/main.js run -t copilot  -d \
  -e "bingo|Bingo" \
   "please say bingo in english"
echo $?



# 重试控制, 基于相同会话 重试 
node src/main.js run -t copilot -d -r 1 \
  -e "no_bingo" \
   "say hi in one word ? reply me in english"
echo $?



# 超时控制
node src/main.js run -t copilot -d -o 1 \
   "please reply me after 10 seconds" 
echo $?



#  remuse 会话 
node src/main.js run -t copilot   "tomorrow will rain"  -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
cat /tmp/sid
echo "session=${session}"
echo "------------------"
node src/main.js run -t copilot \
	-s ${session} \
	-d "tell me all what I have said in this session ? will it rain tomorrow "   2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"





# 重试的会话一致性
node src/main.js run -t copilot  "what is your name" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"
echo "------------------"
node src/main.js run -t copilot  -d \
  -s ${session} \
  -e "no_bingo" \
   "tell me all what I have said ? reply me in english"
echo $?




```


## gemini

```shell


# 基本
node src/main.js run -t gemini  \
   "say hi in one word"  2>/dev/null
echo $?  


# 日志
node src/main.js run -t gemini  -d \
   "say hi in one word" 
echo $?


# 命令
node src/main.js run -t gemini -c 'gemini --approval-mode=yolo --skip-trust'  -d \
   "say hi in one word" 
echo $?


# 错误命令
node src/main.js run -t gemini -c "gemini-bad"  -d \
   "what is your name" 
echo $?



------------------

# 正则匹配
node src/main.js run -t gemini  -d \
  -e "bingo|Bingo" \
   "please say bingo in english"
echo $?



# 重试控制, 基于相同会话 重试 
node src/main.js run -t gemini -d -r 1 \
  -e "no_bingo" \
   "say hi in one word ? reply me in english"
echo $?



# 超时控制
node src/main.js run -t gemini -d -o 1 \
   "please reply me after 10 seconds" 
echo $?



#  remuse 会话 
node src/main.js run -t gemini   "tomorrow will rain"  -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
cat /tmp/sid
echo "session=${session}"
echo "------------------"
node src/main.js run -t gemini \
	-s ${session} \
	-d "tell me all what I have said in this session ? will it rain tomorrow "  2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"





# 重试的会话一致性
node src/main.js run -t gemini  "what is your name" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"
echo "------------------"
node src/main.js run -t gemini  -d \
  -s ${session} \
  -e "no_bingo" \
   "tell me all what I have said ? reply me in english"
echo $?





```





## cursor

```shell



# 日志
node src/main.js run -t cursor  -d \
   "查询今天上海温度"  2>/dev/null
echo $?


# 命令
node src/main.js run -t cursor -c 'cursor-agent --yolo'  -d \
   "say hi in one word" 
echo $?


# 错误命令
node src/main.js run -t cursor -c "cursor-bad"  -d \
   "what is your name" 
echo $?



------------------

# 正则匹配
node src/main.js run -t cursor  -d \
  -e "bingo|Bingo" \
   "please say bingo in english"
echo $?



# 重试控制, 基于相同会话 重试 
node src/main.js run -t cursor -d -r 1 \
  -e "no_bingo" \
   "say hi in one word ? reply me in english"
echo $?



# 超时控制
node src/main.js run -t cursor -d -o 1 \
   "please reply me after 10 seconds" 
echo $?



#  remuse 会话 
node src/main.js run -t cursor   "tomorrow will rain"  -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
cat /tmp/sid
echo "session=${session}"
echo "------------------"
node src/main.js run -t cursor \
	-s ${session} \
	-d "tell me all what I have said in this session ? will it rain tomorrow "  2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"





# 重试的会话一致性
node src/main.js run -t cursor  "what is your name" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"
echo "------------------"
node src/main.js run -t cursor  -d \
  -s ${session} \
  -e "no_bingo" \
   "tell me all what I have said ? reply me in english"
echo $?

```


## agy

```shell

npm install

# 1. 基本调用
node src/main.js run -t agy \
   "say hi in one word" -d 2>/tmp/a
echo $?
echo ""
cat /tmp/a


# 2. 自定义基础命令与模型选择
node src/main.js run -t agy -c 'agy --dangerously-skip-permissions --model="Gemini 3.5 Flash (High)"' -d \
   "say hi in one word"
echo $?

# 4. 错误命令处理（期望退出码 204）
node src/main.js run -t agy -c "agy-bad" -d \
   "what is your name"
echo $?

# 5. 正则输出匹配
node src/main.js run -t agy -d \
  -e "bingo|Bingo" \
   "please say bingo in english"
echo $?

# 6. 重试控制（相同会话内进行重试）
node src/main.js run -t agy -d -r 2 \
  -e "no_bingo" \
   "say hi in one word ? reply me in english"
echo $?

# 7. 超时控制（期望超时退出码 203）
node src/main.js run -t agy -d -o 1 \
   "please reply me after 10 seconds"
echo $?

# 8. 会话恢复 (Resume)
node src/main.js run -t agy  "tomorrow is monday" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
cat /tmp/sid
echo "session=${session}"
echo "------------------"
node src/main.js run -t agy \
  -s ${session} \
  -d  "tell me all what I have said in this session" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"

# 9. 重试过程中的会话一致性
node src/main.js run -t agy  "what is your name" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"
echo "------------------"
node src/main.js run -t agy -d \
  -s ${session} \
  -e "no_bingo" \
   "tell me all what I have said ? reply me in english"
echo $?

```


## opencode

```shell

npm install

# 1. 基本调用
node src/main.js run -t opencode \
   "say hi in one word" -d 2>/tmp/a
echo $?
echo ""
cat /tmp/a



# 4. 错误命令处理（期望退出码 204）
node src/main.js run -t opencode -c "opencode-bad" -d \
   "what is your name"
echo $?

# 5. 正则输出匹配
node src/main.js run -t opencode -d \
  -e "bingo|Bingo" \
   "please say bingo in english"  2>/tmp/a
echo $?
echo ""
cat /tmp/a


# 6. 重试控制（相同会话内进行重试）
node src/main.js run -t opencode -d -r 2 \
  -e "no_bingo" \
   "say hi in one word ? reply me in english"
echo $?


# 7. 超时控制（期望超时退出码 203）
node src/main.js run -t opencode -d -o 1 \
   "please reply me after 10 seconds"  2>/tmp/a
echo $?
echo ""
cat /tmp/a


# 8. 会话恢复 (Resume)
node src/main.js run -t opencode  "tomorrow is monday" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
cat /tmp/sid
echo "session=${session}"
echo "------------------"
node src/main.js run -t opencode \
  -s ${session} \
  -d  "tell me all what I have said in this session" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"


# 9. 重试过程中的会话一致性
node src/main.js run -t opencode  "what is your name" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"
echo "------------------"
node src/main.js run -t opencode -d \
  -s ${session} \
  -e "no_bingo" \
   "tell me all what I have said ? reply me in english"
echo $?

```


## 多 Agent Fallback (冗余调用)

```shell

多个 -t agent 类型，实现多个 agent 的 fallback 调用
- -t 选项后跟 0 个或者 1 个 -c 选项。实现 配对 解析  
    -t claude -c "claude-free" -t codex -t copilot -t opencode
- 标准输出: 最后一个 Agent 的输出。
- 错误输出: 是所有 Agent 的标准输出和错误输出。(倒数第二行是最终成功执行的 agent 名字， 倒数第一行是最终执行的 agent 的 session id )
- 退出码: 最后一个 Agent 的退出码，或 wrapper 定义的 200–205（如 205 = 排除正则匹配）。

# 10. 排除正则（-x）：命中后立即失败当前 agent，不重试
# 若 stdout 含排除模式，期望退出码 205（单 agent 且无 fallback 时）
node src/main.js run -t claude -c "claude-deepseek-flash" -d \
  -x "usage limit|fatal error" \
  -r 3 \
   "say hi in one word"
echo $?  # 期望 205

# 11. 排除正则 + fallback：第一个 agent 命中 exclude，第二个继续
node src/main.js run -t claude -c "claude-wrong" -t codex -d \
  -x "fatal error" \
   "say hi in one word" 2>/tmp/sid
echo $?  # 第二个 agent 成功时为 0
cat /tmp/sid



npm install
npm run build

# 1. 如果第一个 claude 失败了，会尝试下一个 codex
node src/main.js run -t claude -c "claude-deepseek-flash" -t codex  -d  "say hi in one word" 2>/tmp/sid
echo ""
echo $?
agentName=$( sed '$d' /tmp/sid | sed -n '$p' )
session=$(tail -1 /tmp/sid)
echo "succeeded agent=${agentName}"
echo "session id=${session}"


# 2. 第一个 失败， fallback 到第二个
node src/main.js run -t claude -c "claude-wrong" -t claude -c  "claude-deepseek-flash" -d  "say hi in one word" 2>/tmp/sid
echo ""
echo $?
cat /tmp/sid

node src/main.js run -t copilot -t codex -d  "say hi in one word" -e 'hi' 2>/tmp/sid
echo ""
echo $?
cat /tmp/sid


# 3. 错误校验：-t 后只能最多接 一个  -c 选项（抛错并退出 2）
node src/main.js run -t claude -c cmd1 -c cmd2  "hello"
echo $?

# 4. 错误校验：-c 和 -t 之间不能被其他选项截断（抛错并退出 2）
node src/main.js -c cmd -t claude  "hello"
echo $?

# 5. 错误校验：多 Agent 场景下, 不再支持  -s resume（抛错并退出 2）
node src/main.js run -t copilot -t codex -s "some-id"  "hello"
echo $?

```

