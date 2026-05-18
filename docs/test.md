# 测试

## claude

```shell

npm install

# 基本
node src/main.js -t claude -c "claude-free-remote" \
  -p "say hi in one word" 2>/dev/null
echo $?

# 日志
node src/main.js -t claude -c "claude-free-remote" -d \
  -p "say hi in one word"
echo $?

# 标准输出
node src/main.js -t claude -c "claude-free-remote" -d \
  -p "say hi in one word"  2>/dev/null
echo $?



# 错误输出 ， 有思考过程 和 会话 id
node src/main.js -t claude -c "claude-free-remote"  \
  -p "what is your name"  1>/dev/null
echo $?


# 错误命令
node src/main.js -t claude -c "claude-free-bad"  \
  -p "what is your name" 
echo $?


------------------

# 正则匹配
node src/main.js -t claude -c "claude-free-remote" -d \
  -e "bingo|Bingo" \
  -p "please say bingo in english"



# 重试控制, 基于相同会话 重试 
node src/main.js -t claude -c "claude-free-remote" -d -r 2 \
  -e "no_bingo" \
  -p "say hi in one word ? reply me in english"



# 错误命令
node src/main.js -t claude -c "claude-free-bad"  -d \
  -p "what is your name" 
echo $?



# 超时控制
node src/main.js -t claude -c "claude-free-remote"  -d -o 1 \
  -p "please reply me after 10 seconds" 
echo $?


# 继续会话
node src/main.js -t claude -c "claude-free-remote" -p "tomorow will rain"  -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
cat /tmp/sid
echo "session=${session}"
echo "------------------"
node src/main.js -t claude -c "claude-free-remote" \
    -s ${session} -p "tell me all what I have said in this session " 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"


# 重试的会话一致性
node src/main.js -t claude -c "claude-free-remote" -p "what is your name" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"
echo "------------------"
node src/main.js -t claude -c "claude-free-remote" -d \
  -s ${session} \
  -e "no_bingo" \
  -p "tell me all what I have said in this session ? reply me in english"


```

## codex

```shell

npm install


# 基本
node src/main.js -t codex  -d \
  -p "say hi in one word" 
echo $?  2>/dev/null


# 日志
node src/main.js -t codex  -d \
  -p "say hi in one word" 
echo $?


# 命令
node src/main.js -t codex -c 'codex exec --sandbox danger-full-access --skip-git-repo-check'  -d \
  -p "say hi in one word" 
echo $?


# 错误命令
node src/main.js -t codex -c "codex-bad"  -d \
  -p "what is your name" 
echo $?



------------------

# 正则匹配
node src/main.js -t codex  -d \
  -e "bingo|Bingo" \
  -p "please say bingo in english"
echo $?



# 重试控制, 基于相同会话 重试 
node src/main.js -t codex -d -r 1 \
  -e "no_bingo" \
  -p "say hi in one word ? reply me in english"
echo $?



# 超时控制
node src/main.js -t codex -d -o 1 \
  -p "please reply me after 10 seconds" 
echo $?




#   remuse 会话 
node src/main.js -t codex  -p "tomorow is monday"  -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
cat /tmp/sid
echo "session=${session}"
echo "------------------"
node src/main.js -t codex \
	-s ${session} \
	-d -p  "tell me all what I have said in this session "  2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"


# 重试的会话一致性
node src/main.js -t codex -p "what is your name" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"
echo "------------------"
node src/main.js -t codex -d \
  -s ${session} \
  -e "no_bingo" \
  -p "tell me all what I have said ? reply me in english"
echo $?




```




## copilot

```shell

npm install


# 基本
node src/main.js -t copilot  \
  -p "say hi in one word"  2>/dev/null
echo $?  


# 日志
node src/main.js -t copilot  -d \
  -p "say hi in one word" 
echo $?


# 命令
node src/main.js -t copilot -c 'copilot --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user '  -d \
  -p "say hi in one word" 
echo $?


# 错误命令
node src/main.js -t copilot -c "copilot-bad"  -d \
  -p "what is your name" 
echo $?



------------------

# 正则匹配
node src/main.js -t copilot  -d \
  -e "bingo|Bingo" \
  -p "please say bingo in english"
echo $?



# 重试控制, 基于相同会话 重试 
node src/main.js -t copilot -d -r 1 \
  -e "no_bingo" \
  -p "say hi in one word ? reply me in english"
echo $?



# 超时控制
node src/main.js -t copilot -d -o 1 \
  -p "please reply me after 10 seconds" 
echo $?



#  remuse 会话 
node src/main.js -t copilot  -p "tomorrow will rain"  -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
cat /tmp/sid
echo "session=${session}"
echo "------------------"
node src/main.js -t copilot \
	-s ${session} \
	-d -p  "tell me all what I have said in this session ? will it rain tomorrow "   2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"





# 重试的会话一致性
node src/main.js -t copilot -p "what is your name" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"
echo "------------------"
node src/main.js -t copilot  -d \
  -s ${session} \
  -e "no_bingo" \
  -p "tell me all what I have said ? reply me in english"
echo $?




```


## gemini

```shell


# 基本
node src/main.js -t gemini  \
  -p "say hi in one word"  2>/dev/null
echo $?  


# 日志
node src/main.js -t gemini  -d \
  -p "say hi in one word" 
echo $?


# 命令
node src/main.js -t gemini -c 'gemini --approval-mode=yolo --skip-trust'  -d \
  -p "say hi in one word" 
echo $?


# 错误命令
node src/main.js -t gemini -c "gemini-bad"  -d \
  -p "what is your name" 
echo $?



------------------

# 正则匹配
node src/main.js -t gemini  -d \
  -e "bingo|Bingo" \
  -p "please say bingo in english"
echo $?



# 重试控制, 基于相同会话 重试 
node src/main.js -t gemini -d -r 1 \
  -e "no_bingo" \
  -p "say hi in one word ? reply me in english"
echo $?



# 超时控制
node src/main.js -t gemini -d -o 1 \
  -p "please reply me after 10 seconds" 
echo $?



#  remuse 会话 
node src/main.js -t gemini  -p "tomorrow will rain"  -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
cat /tmp/sid
echo "session=${session}"
echo "------------------"
node src/main.js -t gemini \
	-s ${session} \
	-d -p  "tell me all what I have said in this session ? will it rain tomorrow "  2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"





# 重试的会话一致性
node src/main.js -t gemini -p "what is your name" -d 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=${session}"
echo "------------------"
node src/main.js -t gemini  -d \
  -s ${session} \
  -e "no_bingo" \
  -p "tell me all what I have said ? reply me in english"
echo $?





```