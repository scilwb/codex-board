import { HANDOFF_PROMPT_LIMIT } from './handoff.mjs';
export const REPAIR_PROMPT_LIMIT = HANDOFF_PROMPT_LIMIT + 2000;

export function buildRepairPrompt(handoff) {
  if (!handoff?.source?.id || typeof handoff.prompt !== 'string' || !handoff.prompt.trim()) throw new Error('找不到可补发的来源交接资料。');
  const prefix = `【继承上下文修复：明确来源的可见更正消息】

唯一直接来源对话 ID：${JSON.stringify(handoff.source.id)}
来源标题：${JSON.stringify(handoff.source.title || '')}

此前交接没有完成。请现在加载下方正确来源资料，并纠正本对话的任务归属：
1. 当前任务和进度以本消息指定的直接来源为准。下方旧记录中的其他对话 ID 仅代表祖先或历史引用，不能替代直接来源。
2. IDE 当前打开的其他项目、同一工作目录下的其他任务及最近文件，均不代表用户切换了本次继承任务。
3. 保留此前交流作为记录；其中与指定来源不一致的目标、进度、数据和文件归属，不应混入本次任务。
4. 本轮只做交接理解和确认：复述完整来源 ID、任务目标、最新进展、关键文件路径、待办和未知信息。区分来源证据和你尚未核实的推断。
5. 本轮不执行业务操作，不修改项目文件，不启动机器人、打印或其他设备，也不自动继续旧任务。确认交接后等待我的下一条业务指令。

以下为原交接资料，保留完整原文：

`;
  const prompt = prefix + handoff.prompt;
  if (prompt.length > REPAIR_PROMPT_LIMIT) throw new Error('更正交接内容过长，请缩短来源交接资料后再修复。');
  return prompt;
}
