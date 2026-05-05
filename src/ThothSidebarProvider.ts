import * as vscode from 'vscode';
import { ThothPanel } from './ThothPanel';
import { HistoryManager, HistoryEntry } from './HistoryManager';

export class ThothSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'thothAlpha.launcherView';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _historyManager: HistoryManager,
        private readonly _globalState?: vscode.Memento
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.postMessage({
            type: 'updateHistory',
            entries: this._historyManager.getWorkspaceEntries(),
            globalEntries: this._historyManager.getGlobalEntries()
        });

        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'openNewSearch':
                    ThothPanel.createOrShow(this._extensionUri, this._historyManager, this._globalState);
                    break;
                case 'newConversation': {
                    const panel = ThothPanel.getActivePanel();
                    if (panel) {
                        panel.sendNewConversation();
                    }
                    break;
                }
                case 'saveResults': {
                    const panel = ThothPanel.getActivePanel();
                    if (panel) {
                        panel.requestSaveResults();
                    }
                    break;
                }
                case 'historyClick': {
                    const entry = this._historyManager.getEntryById(data.entryId);
                    if (entry && entry.resultData) {
                        ThothPanel.createOrShow(this._extensionUri, this._historyManager, this._globalState);
                        setTimeout(() => {
                            const p = ThothPanel.getActivePanel();
                            if (p) { p.showResult(entry.query, entry.resultData); }
                        }, 500);
                    } else {
                        let panel = ThothPanel.getActivePanel();
                        if (!panel) {
                            ThothPanel.createOrShow(this._extensionUri, this._historyManager, this._globalState);
                            setTimeout(() => {
                                const p = ThothPanel.getActivePanel();
                                if (p) { p.fillQuery(data.query); }
                            }, 500);
                        } else {
                            panel.fillQuery(data.query);
                        }
                    }
                    break;
                }
                case 'clearHistory':
                    this._historyManager.clearHistory();
                    break;
            }
        });
    }

    public updateHistory(entries: HistoryEntry[]): void {
        this._view?.webview.postMessage({
            type: 'updateHistory',
            entries,
            globalEntries: this._historyManager.getGlobalEntries()
        });
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Thoth Alpha</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-sideBar-background);
            color: var(--vscode-sideBar-foreground);
            font-size: 12px;
            line-height: 1.5;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        .header {
            padding: 10px 12px;
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
        }
        .brand {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .brand-icon {
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-radius: 4px;
            font-size: 11px;
            font-weight: 700;
        }
        .brand-title {
            font-size: 13px;
            font-weight: 700;
            letter-spacing: -0.02em;
        }
        .header-actions {
            display: flex;
            gap: 2px;
        }
        .icon-btn {
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: none;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .icon-btn:hover {
            background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
            color: var(--vscode-sideBar-foreground);
        }

        .actions {
            padding: 10px 12px;
            display: flex;
            flex-direction: column;
            gap: 6px;
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
            flex-shrink: 0;
        }
        .action-btn {
            width: 100%;
            padding: 6px 10px;
            border: none;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            font-family: inherit;
        }
        .action-btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .action-btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .scope-tabs {
            display: flex;
            padding: 6px 12px 0;
            gap: 0;
            flex-shrink: 0;
        }
        .scope-tab {
            flex: 1;
            padding: 5px 8px;
            border: none;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            text-align: center;
            border-bottom: 2px solid transparent;
            font-family: inherit;
        }
        .scope-tab:hover {
            color: var(--vscode-sideBar-foreground);
        }
        .scope-tab.active {
            color: var(--vscode-sideBar-foreground);
            border-bottom-color: var(--vscode-focusBorder, var(--vscode-button-background));
        }

        .history-section {
            flex: 1;
            overflow-y: auto;
            padding: 8px 0;
        }
        .history-section::-webkit-scrollbar { width: 4px; }
        .history-section::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 4px;
        }

        .section-label {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: var(--vscode-descriptionForeground);
            padding: 4px 12px 4px;
        }

        .day-group {
            margin-bottom: 4px;
        }
        .day-label {
            font-size: 10px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            padding: 6px 12px 2px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }

        .history-item {
            padding: 5px 12px 5px 16px;
            cursor: pointer;
            display: flex;
            align-items: flex-start;
            gap: 6px;
            font-size: 12px;
            line-height: 1.4;
            color: var(--vscode-sideBar-foreground);
            transition: background 0.1s;
        }
        .history-item:hover {
            background: var(--vscode-list-hoverBackground, rgba(90,93,94,0.12));
        }
        .history-item-icon {
            flex-shrink: 0;
            width: 14px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            margin-top: 2px;
        }
        .history-item-icon.dr {
            color: #7c3aed;
        }
        .history-item-body {
            flex: 1;
            min-width: 0;
        }
        .history-item-query {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-weight: 500;
        }
        .history-item-meta {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .footer {
            padding: 8px 12px;
            border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
            flex-shrink: 0;
        }
        .clear-btn {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            cursor: pointer;
            padding: 2px 0;
            font-family: inherit;
        }
        .clear-btn:hover {
            color: var(--vscode-errorForeground, #f44747);
        }

        .empty-state {
            padding: 24px 16px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            line-height: 1.5;
        }
        .empty-state-icon {
            font-size: 28px;
            margin-bottom: 8px;
            opacity: 0.4;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="brand">
            <div class="brand-icon">&#x1F441;</div>
            <span class="brand-title">Thoth Alpha</span>
        </div>
        <div class="header-actions">
            <button class="icon-btn" onclick="newConversation()" title="New conversation">&#x1F9F9;</button>
            <button class="icon-btn" onclick="saveResults()" title="Save results">&#x1F4BE;</button>
        </div>
    </div>

    <div class="actions">
        <button class="action-btn action-btn-primary" onclick="openNewSearch()">
            + Open New Search
        </button>
    </div>

    <div class="scope-tabs">
        <button class="scope-tab active" id="tabWorkspace" onclick="switchScope('workspace')">This Workspace</button>
        <button class="scope-tab" id="tabGlobal" onclick="switchScope('global')">All History</button>
    </div>

    <div class="history-section" id="historySection">
        <div id="historyList">
            <div class="empty-state">
                <div class="empty-state-icon">&#x1F50D;</div>
                <div>No searches yet.<br>Open a search to get started.</div>
            </div>
        </div>
    </div>

    <div class="footer" id="footer" style="display:none;">
        <button class="clear-btn" onclick="clearHistory()">Clear History</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        var currentScope = 'workspace';
        var workspaceEntries = [];
        var globalEntries = [];

        function openNewSearch() {
            vscode.postMessage({ type: 'openNewSearch' });
        }
        function newConversation() {
            vscode.postMessage({ type: 'newConversation' });
        }
        function saveResults() {
            vscode.postMessage({ type: 'saveResults' });
        }
        function clearHistory() {
            vscode.postMessage({ type: 'clearHistory' });
        }
        function clickHistory(entryId, query) {
            vscode.postMessage({ type: 'historyClick', entryId: entryId, query: query });
        }

        function switchScope(scope) {
            currentScope = scope;
            document.getElementById('tabWorkspace').className = scope === 'workspace' ? 'scope-tab active' : 'scope-tab';
            document.getElementById('tabGlobal').className = scope === 'global' ? 'scope-tab active' : 'scope-tab';
            renderHistory(scope === 'workspace' ? workspaceEntries : globalEntries);
        }

        function timeAgo(ts) {
            var diff = Date.now() - ts;
            var mins = Math.floor(diff / 60000);
            if (mins < 1) return 'just now';
            if (mins < 60) return mins + 'm ago';
            var hrs = Math.floor(mins / 60);
            if (hrs < 24) return hrs + 'h ago';
            var days = Math.floor(hrs / 24);
            if (days === 1) return 'yesterday';
            if (days < 7) return days + 'd ago';
            return new Date(ts).toLocaleDateString();
        }

        function dayLabel(ts) {
            var now = new Date();
            var d = new Date(ts);
            var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            var yesterday = today - 86400000;
            if (ts >= today) return 'Today';
            if (ts >= yesterday) return 'Yesterday';
            var weekAgo = today - 6 * 86400000;
            if (ts >= weekAgo) return d.toLocaleDateString(undefined, { weekday: 'long' });
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        }

        function renderHistory(entries) {
            var list = document.getElementById('historyList');
            var footer = document.getElementById('footer');

            if (!entries || entries.length === 0) {
                var scopeLabel = currentScope === 'workspace' ? 'this workspace' : 'any workspace';
                list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#x1F50D;</div><div>No searches in ' + scopeLabel + ' yet.<br>Open a search to get started.</div></div>';
                footer.style.display = 'none';
                return;
            }

            footer.style.display = 'block';

            var groups = {};
            var groupOrder = [];
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                var label = dayLabel(e.timestamp);
                if (!groups[label]) {
                    groups[label] = [];
                    groupOrder.push(label);
                }
                groups[label].push(e);
            }

            var html = '';
            for (var g = 0; g < groupOrder.length; g++) {
                var grp = groupOrder[g];
                html += '<div class="day-group">';
                html += '<div class="day-label">' + grp + '</div>';
                var items = groups[grp];
                for (var j = 0; j < items.length; j++) {
                    var item = items[j];
                    var iconClass = item.isDeepResearch ? 'history-item-icon dr' : 'history-item-icon';
                    var icon = item.isDeepResearch ? '&#x1F9EA;' : '&#x1F554;';
                    var summary = item.resultSummary || '';
                    var escapedQuery = item.query.replace(/'/g, "\\\\'").replace(/"/g, '&quot;');
                    html += '<div class="history-item" onclick="clickHistory(\\'' + item.id + '\\', \\'' + escapedQuery + '\\')" title="' + item.query.replace(/"/g, '&quot;') + '">';
                    html += '  <div class="' + iconClass + '">' + icon + '</div>';
                    html += '  <div class="history-item-body">';
                    html += '    <div class="history-item-query">' + escapeHtml(item.query) + '</div>';
                    html += '    <div class="history-item-meta">' + timeAgo(item.timestamp);
                    if (summary) html += ' &middot; ' + escapeHtml(summary.substring(0, 60));
                    html += '</div>';
                    html += '  </div>';
                    html += '</div>';
                }
                html += '</div>';
            }

            list.innerHTML = html;
        }

        function escapeHtml(str) {
            var div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        window.addEventListener('message', function(event) {
            var message = event.data;
            if (message.type === 'updateHistory') {
                workspaceEntries = message.entries || [];
                globalEntries = message.globalEntries || [];
                renderHistory(currentScope === 'workspace' ? workspaceEntries : globalEntries);
            }
        });
    </script>
</body>
</html>`;
    }
}
