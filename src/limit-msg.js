const LimitMsg = {
  // 多种模型: deepseek
  claude: "FreeUsageLimitError",
  // 未触发，未知
  cursor: "",
  codex: "hit your usage limit",
  copilot: "You have exceeded your monthly quota",
  gemini: "You have exhausted your capacity",
  // 超额时，它的返回码 0，没有消息，无法检测
  agy: "",
  // opencode v2 超额时立即失败，JSON error 事件的 error.type 为以下之一
  opencode: "provider\\.(quota|free-limit|go-limit|budget-limit|model-budget-limit|chatgpt-limit)",
};

function isQuotaExceeded(agentType, stdout, stderr) {
  const pattern = LimitMsg[agentType];
  if (!pattern) return false;
  const re = new RegExp(pattern, "i");
  const text = [stdout || "", stderr || ""].join("\n");
  return re.test(text);
}

function quotaReasonBrief(pattern) {
  return `quota exceeded: /${pattern}/i matched`;
}

module.exports = { LimitMsg, isQuotaExceeded, quotaReasonBrief };
