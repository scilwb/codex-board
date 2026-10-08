'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEW_TYPE = 'chatgpt.conversationEditor';

function threadIdFromTab(tab) {
  const input = tab?.input;
  const uri = input?.uri;
  if (input?.viewType !== VIEW_TYPE || uri?.scheme !== 'openai-codex' || uri.authority !== 'route') return null;
  const match = /^\/local\/([^/]+)$/.exec(uri.path);
  return match && UUID.test(match[1]) ? match[1] : null;
}

function describeTabs(vscode) {
  const openThreads = new Set();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const id = threadIdFromTab(tab);
      if (id) openThreads.add(id);
    }
  }
  return {
    openThreads: [...openThreads],
    activeThreadId: threadIdFromTab(vscode.window.tabGroups.activeTabGroup?.activeTab),
  };
}

async function focusMainWindow(vscode, timeoutMs) {
  // Target this extension host's main window, rather than whichever auxiliary
  // document the workbench last considered focused.
  await vscode.commands.executeCommand('workbench.action.switchToMainWindow');
  if (vscode.window.state.focused) return;
  await new Promise((resolve, reject) => {
    let listener;
    const finish = error => {
      clearTimeout(timer);
      listener?.dispose();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('对话标签已定位，但系统未将 VS Code 窗口切到前台；请点击任务栏中的目标窗口。')), timeoutMs);
    listener = vscode.window.onDidChangeWindowState(state => { if (state.focused) finish(); });
    if (vscode.window.state.focused) finish();
  });
}

function createNavigator(vscode, { timeoutMs = 15000, focusTimeoutMs = 2000 } = {}) {
  let pending = null;
  return async function reveal(threadId, { allowUnfocused = false } = {}) {
    if (!UUID.test(threadId || '')) return { status: 'error', reused: false, message: '对话 ID 无效。' };
    if (pending) return { status: 'error', reused: false, message: 'VS Code 中的上一次打开仍未结束，请等待编辑器恢复后再试。' };
    let existing;
    for (const group of vscode.window.tabGroups.all) {
      const tab = group.tabs.find(item => threadIdFromTab(item) === threadId);
      if (tab) { existing = { tab, group }; break; }
    }
    const reused = Boolean(existing);
    const uri = existing?.tab.input.uri || vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: `/local/${threadId}` });
    const operation = (async () => {
      const codex = vscode.extensions.getExtension('openai.chatgpt');
      if (!codex) throw new Error('当前窗口未安装 Codex 扩展。');
      if (!codex.isActive) await codex.activate();
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
        viewColumn: existing?.group.viewColumn ?? vscode.ViewColumn.Active,
        preserveFocus: false,
        preview: false,
      });
      let focusError;
      try { await focusMainWindow(vscode, focusTimeoutMs); }
      catch (error) { if (!allowUnfocused) throw error; focusError = error; }
      const activeId = threadIdFromTab(vscode.window.tabGroups.activeTabGroup?.activeTab);
      if (activeId !== threadId) throw new Error('已请求打开，但 VS Code 尚未确认目标对话标签页处于活动状态。');
      return { status: 'opened', reused, windowFocused: vscode.window.state.focused === true,
        editorOpened: true, activeThreadId: activeId,
        ...(focusError ? { warning: '交接目标标签已确认；系统未将窗口切到前台，可点击任务栏查看。' } : {}) };
    })();
    pending = operation;
    // A timeout does not cancel VS Code's command. Keep the latch held until
    // it actually settles, so another click cannot add more loading work.
    operation.finally(() => { if (pending === operation) pending = null; }).catch(() => {});
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('VS Code 15 秒内未确认打开；请检查编辑器状态。不会自动重试。')), timeoutMs); }),
      ]);
    } catch (error) {
      return { status: 'error', reused, message: error?.message || 'VS Code 打开失败。' };
    } finally { clearTimeout(timer); }
  };
}

module.exports = { threadIdFromTab, describeTabs, createNavigator };
