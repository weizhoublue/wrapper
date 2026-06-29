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
  // 超额时，开源 opencode 它就卡住一直重试不退出，无法检测
  // 因此，我自己修改了一个版本来支持超额检测退出，并给出提示信息
  opencode: "free_tier_limit|account_rate_limit",
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
