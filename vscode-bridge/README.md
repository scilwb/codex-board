# Codex Board Bridge

Local companion for Codex Board. Each VS Code window registers itself with the
Board, including Codex editor tabs already open in that window. A navigation
request reuses the matching editor tab and focuses that window. It does not
send a model prompt or automatically retry an open command.

The Board must run on `127.0.0.1:4317`. Authentication uses the local token file
`~/.local/share/codex-board/bridge-token`. No conversation contents are sent.

"Opened" acknowledges that the matching editor tab is active and VS Code reports
its window focused. Window activation gets a separate two-second confirmation;
if the desktop blocks it, the bridge reports an error instead of success. A newly opened
Codex webview may still need to load its history; the bridge cannot guarantee
that the separate Codex extension has finished rendering.

VS Code exposes editor tabs through `tabGroups`, but Codex's sidebar is a
separate webview. The bridge cannot identify the sidebar's current conversation.
A conversation visible only there will open in a new editor tab and load its
history. Once opened as an editor tab, later requests can reuse that tab.

Build with `python3 vscode-bridge/build.py`, from the Codex Board repository.
Install the generated VSIX through VS Code's “Install from VSIX” action.

This uses the installed Codex extension's `chatgpt.conversationEditor` custom
editor and `openai-codex://route/local/<thread-id>` URI. These are implementation
details and may require adjustment after an extension update.
