import * as vscode from 'vscode';
import { ThothPanel } from './ThothPanel';
import { HistoryManager, HistoryEntry } from './HistoryManager';
import { DossierManager, DossierIndex } from './DossierManager';
import { DeepRunManager, DeepRunIndex } from './DeepRunManager';
import { CourseManager, CourseIndex } from './CourseManager';
import { AgendaManager, Agenda, FeedItem } from './AgendaManager';
import { CoursePresenter } from './CoursePresenter';
import { setWebviewSecurity } from './webviewSecurity';

export class ThothSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'thothAlpha.launcherView';

    private _view?: vscode.WebviewView;
    private _dossierManager?: DossierManager;
    private _deepRunManager?: DeepRunManager;
    private _courseManager?: CourseManager;
    private _agendaManager?: AgendaManager;
    private _coursePresenter?: CoursePresenter;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _historyManager: HistoryManager,
        private readonly _globalState?: vscode.Memento
    ) { }

    public setManagers(
        dossierManager: DossierManager,
        deepRunManager: DeepRunManager,
        agendaManager: AgendaManager,
        courseManager: CourseManager,
        coursePresenter: CoursePresenter
    ): void {
        this._dossierManager = dossierManager;
        this._deepRunManager = deepRunManager;
        this._agendaManager = agendaManager;
        this._courseManager = courseManager;
        this._coursePresenter = coursePresenter;
    }

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
        (webviewView.webview.options as any).enableFindWidget = false;
        (webviewView.webview.options as any).enableCommandUris = false;
        setWebviewSecurity(webviewView.webview, undefined, true);

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.postMessage({
            type: 'updateHistory',
            entries: this._historyManager.getWorkspaceEntries(),
            globalEntries: this._historyManager.getGlobalEntries()
        });
        this._pushManagerData();

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
                    if (entry) {
                        let panel = ThothPanel.getActivePanel();
                        if (!panel) {
                            ThothPanel.createOrShow(this._extensionUri, this._historyManager, this._globalState);
                            setTimeout(() => {
                                const p = ThothPanel.getActivePanel();
                                if (p) { p.fillQuery(entry.query); }
                            }, 500);
                        } else {
                            panel.fillQuery(entry.query);
                        }
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

                case 'createDossier':
                    vscode.commands.executeCommand('thothAlpha.createDossier');
                    break;
                case 'openDossier':
                    if (data.id && this._dossierManager) {
                        this._dossierManager.get(data.id).then(dossier => {
                            if (dossier) {
                                ThothPanel.createOrShow(this._extensionUri, this._historyManager, this._globalState);
                                setTimeout(() => {
                                    const p = ThothPanel.getActivePanel();
                                    if (p) { p.showResult(dossier.query, dossier); }
                                }, 500);
                            }
                        });
                    }
                    break;
                case 'deleteDossier':
                    if (data.id && this._dossierManager) {
                        this._dossierManager.delete(data.id);
                    }
                    break;

                case 'startDeepRun':
                    vscode.commands.executeCommand('thothAlpha.startDeepRun');
                    break;
                case 'openDeepRun':
                    if (data.id && this._deepRunManager) {
                        this._deepRunManager.get(data.id).then(run => {
                            if (run) {
                                ThothPanel.createOrShow(this._extensionUri, this._historyManager, this._globalState);
                                setTimeout(() => {
                                    const p = ThothPanel.getActivePanel();
                                    if (p) { p.showResult(run.query, run); }
                                }, 500);
                            }
                        });
                    }
                    break;
                case 'deleteDeepRun':
                    if (data.id && this._deepRunManager) {
                        this._deepRunManager.delete(data.id);
                    }
                    break;

                case 'createCourse':
                    vscode.commands.executeCommand('thothAlpha.createCourse');
                    break;
                case 'openCourse':
                    if (data.id && this._courseManager) {
                        this._courseManager.get(data.id).then(course => {
                            if (course) {
                                ThothPanel.createOrShow(this._extensionUri, this._historyManager, this._globalState);
                                setTimeout(() => {
                                    const p = ThothPanel.getActivePanel();
                                    if (p) { p.showResult(course.title, course); }
                                }, 500);
                            }
                        });
                    }
                    break;
                case 'presentCourse':
                    if (data.id && this._coursePresenter) {
                        this._coursePresenter.present(data.id, this._extensionUri);
                    }
                    break;
                case 'deleteCourse':
                    if (data.id && this._courseManager) {
                        this._courseManager.delete(data.id);
                    }
                    break;

                case 'createAgenda':
                    vscode.commands.executeCommand('thothAlpha.createAgenda');
                    break;
                case 'pauseAgenda':
                    if (data.id && this._agendaManager) {
                        this._agendaManager.pauseAgenda(data.id);
                    }
                    break;
                case 'resumeAgenda':
                    if (data.id && this._agendaManager) {
                        this._agendaManager.resumeAgenda(data.id);
                    }
                    break;
                case 'deleteAgenda':
                    if (data.id && this._agendaManager) {
                        this._agendaManager.deleteAgenda(data.id);
                    }
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

    public updateDossiers(items: DossierIndex[]): void {
        this._view?.webview.postMessage({ type: 'updateDossiers', items });
    }

    public updateDeepRuns(items: DeepRunIndex[]): void {
        this._view?.webview.postMessage({ type: 'updateDeepRuns', items });
    }

    public updateCourses(items: CourseIndex[]): void {
        this._view?.webview.postMessage({ type: 'updateCourses', items });
    }

    public updateAgendas(items: Agenda[]): void {
        this._view?.webview.postMessage({ type: 'updateAgendas', items });
    }

    public updateFeed(items: FeedItem[], unreadCount: number): void {
        this._view?.webview.postMessage({ type: 'updateFeed', items, unreadCount });
    }

    private _pushManagerData(): void {
        if (this._dossierManager) {
            this.updateDossiers(this._dossierManager.list());
        }
        if (this._deepRunManager) {
            this.updateDeepRuns(this._deepRunManager.list());
        }
        if (this._courseManager) {
            this.updateCourses(this._courseManager.list());
        }
        if (this._agendaManager) {
            this.updateAgendas(this._agendaManager.listAgendas());
            this.updateFeed(this._agendaManager.getFeedItems(), this._agendaManager.getUnreadCount());
        }
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

        .scroll-body {
            flex: 1;
            overflow-y: auto;
        }
        .scroll-body::-webkit-scrollbar { width: 4px; }
        .scroll-body::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 4px;
        }

        /* Collapsible sections */
        .section {
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
        }
        .section-header {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-sideBar-foreground));
            background: var(--vscode-sideBarSectionHeader-background, transparent);
            user-select: none;
        }
        .section-header:hover {
            background: var(--vscode-list-hoverBackground, rgba(90,93,94,0.12));
        }
        .section-chevron {
            font-size: 8px;
            width: 12px;
            text-align: center;
            transition: transform 0.15s;
            flex-shrink: 0;
        }
        .section-chevron.expanded {
            transform: rotate(90deg);
        }
        .section-icon {
            font-size: 12px;
            flex-shrink: 0;
        }
        .section-title {
            flex: 1;
        }
        .section-count {
            font-size: 10px;
            min-width: 16px;
            text-align: center;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 8px;
            padding: 0 5px;
            line-height: 16px;
        }
        .section-count:empty { display: none; }
        .section-add {
            width: 18px;
            height: 18px;
            border: none;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border-radius: 3px;
            cursor: pointer;
            font-size: 14px;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .section-add:hover {
            background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
            color: var(--vscode-sideBar-foreground);
        }
        .section-body {
            padding: 0;
        }
        .section-body.collapsed {
            display: none;
        }

        /* List items */
        .list-item {
            padding: 5px 12px 5px 30px;
            cursor: pointer;
            display: flex;
            align-items: flex-start;
            gap: 6px;
            font-size: 12px;
            line-height: 1.4;
            color: var(--vscode-sideBar-foreground);
            transition: background 0.1s;
            position: relative;
        }
        .list-item:hover {
            background: var(--vscode-list-hoverBackground, rgba(90,93,94,0.12));
        }
        .list-item-body {
            flex: 1;
            min-width: 0;
        }
        .list-item-title {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-weight: 500;
        }
        .list-item-meta {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .list-item-actions {
            display: none;
            align-items: center;
            gap: 2px;
            flex-shrink: 0;
        }
        .list-item:hover .list-item-actions {
            display: flex;
        }
        .item-action-btn {
            width: 18px;
            height: 18px;
            border: none;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .item-action-btn:hover {
            background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
            color: var(--vscode-sideBar-foreground);
        }
        .item-action-btn.danger:hover {
            color: var(--vscode-errorForeground, #f44747);
        }

        /* Status badges */
        .status-badge {
            font-size: 9px;
            padding: 1px 5px;
            border-radius: 3px;
            text-transform: uppercase;
            font-weight: 600;
            letter-spacing: 0.02em;
            white-space: nowrap;
        }
        .status-running { background: #1e40af33; color: #60a5fa; }
        .status-completed { background: #16653433; color: #4ade80; }
        .status-failed { background: #7f1d1d33; color: #f87171; }

        /* Status dots */
        .status-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            display: inline-block;
            margin-right: 4px;
            flex-shrink: 0;
            margin-top: 5px;
        }
        .status-dot.active { background: #4ade80; }
        .status-dot.paused { background: #fbbf24; }
        .status-dot.exhausted { background: #9ca3af; }

        /* History scope tabs */
        .scope-tabs {
            display: flex;
            padding: 4px 12px 0 30px;
            gap: 0;
        }
        .scope-tab {
            flex: 1;
            padding: 4px 6px;
            border: none;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
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

        .day-group { margin-bottom: 4px; }
        .day-label {
            font-size: 10px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            padding: 6px 12px 2px 30px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }

        .history-item {
            padding: 5px 12px 5px 34px;
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
        .history-item-icon.dr { color: #7c3aed; }
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

        .clear-btn-row {
            padding: 4px 12px 6px 30px;
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
            padding: 16px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            line-height: 1.5;
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

    <div class="scroll-body">
        <!-- Dossiers -->
        <div class="section" data-section="dossiers">
            <div class="section-header" onclick="toggleSection('dossiers')">
                <span class="section-chevron expanded" id="chevron-dossiers">&#x25B6;</span>
                <span class="section-icon">&#x1F4DA;</span>
                <span class="section-title">Dossiers</span>
                <span class="section-count" id="count-dossiers"></span>
                <button class="section-add" onclick="event.stopPropagation(); sendAction('createDossier')" title="New Dossier">+</button>
            </div>
            <div class="section-body" id="body-dossiers">
                <div class="empty-state">No dossiers yet</div>
            </div>
        </div>

        <!-- Deep Runs -->
        <div class="section" data-section="deepRuns">
            <div class="section-header" onclick="toggleSection('deepRuns')">
                <span class="section-chevron expanded" id="chevron-deepRuns">&#x25B6;</span>
                <span class="section-icon">&#x1F9EA;</span>
                <span class="section-title">Deep Runs</span>
                <span class="section-count" id="count-deepRuns"></span>
                <button class="section-add" onclick="event.stopPropagation(); sendAction('startDeepRun')" title="New Deep Run">+</button>
            </div>
            <div class="section-body" id="body-deepRuns">
                <div class="empty-state">No deep runs yet</div>
            </div>
        </div>

        <!-- Courses -->
        <div class="section" data-section="courses">
            <div class="section-header" onclick="toggleSection('courses')">
                <span class="section-chevron" id="chevron-courses">&#x25B6;</span>
                <span class="section-icon">&#x1F393;</span>
                <span class="section-title">Courses</span>
                <span class="section-count" id="count-courses"></span>
                <button class="section-add" onclick="event.stopPropagation(); sendAction('createCourse')" title="New Course">+</button>
            </div>
            <div class="section-body collapsed" id="body-courses">
                <div class="empty-state">No courses yet</div>
            </div>
        </div>

        <!-- Agendas -->
        <div class="section" data-section="agendas">
            <div class="section-header" onclick="toggleSection('agendas')">
                <span class="section-chevron" id="chevron-agendas">&#x25B6;</span>
                <span class="section-icon">&#x1F4C5;</span>
                <span class="section-title">Agendas</span>
                <span class="section-count" id="count-agendas"></span>
                <button class="section-add" onclick="event.stopPropagation(); sendAction('createAgenda')" title="New Agenda">+</button>
            </div>
            <div class="section-body collapsed" id="body-agendas">
                <div class="empty-state">No agendas yet</div>
            </div>
        </div>

        <!-- Search History -->
        <div class="section" data-section="history">
            <div class="section-header" onclick="toggleSection('history')">
                <span class="section-chevron expanded" id="chevron-history">&#x25B6;</span>
                <span class="section-icon">&#x1F554;</span>
                <span class="section-title">Search History</span>
                <span class="section-count" id="count-history"></span>
            </div>
            <div class="section-body" id="body-history">
                <div class="scope-tabs">
                    <button class="scope-tab active" id="tabWorkspace" onclick="switchScope('workspace')">Workspace</button>
                    <button class="scope-tab" id="tabGlobal" onclick="switchScope('global')">All History</button>
                </div>
                <div id="historyList">
                    <div class="empty-state">No searches yet</div>
                </div>
                <div class="clear-btn-row" id="clearRow" style="display:none;">
                    <button class="clear-btn" onclick="clearHistory()">Clear History</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        var currentScope = 'workspace';
        var workspaceEntries = [];
        var globalEntries = [];
        var dossiers = [];
        var deepRuns = [];
        var courses = [];
        var agendas = [];

        var defaultExpanded = { dossiers: true, deepRuns: true, courses: false, agendas: false, history: true };
        var sectionState = Object.assign({}, defaultExpanded);

        (function restoreState() {
            var saved = vscode.getState();
            if (saved && saved.sectionState) {
                sectionState = Object.assign({}, defaultExpanded, saved.sectionState);
            }
            Object.keys(sectionState).forEach(function(key) {
                var body = document.getElementById('body-' + key);
                var chevron = document.getElementById('chevron-' + key);
                if (body && chevron) {
                    if (sectionState[key]) {
                        body.classList.remove('collapsed');
                        chevron.classList.add('expanded');
                    } else {
                        body.classList.add('collapsed');
                        chevron.classList.remove('expanded');
                    }
                }
            });
        })();

        function saveState() {
            vscode.setState({ sectionState: sectionState, currentScope: currentScope });
        }

        function toggleSection(name) {
            var body = document.getElementById('body-' + name);
            var chevron = document.getElementById('chevron-' + name);
            if (!body || !chevron) return;
            var isExpanded = !body.classList.contains('collapsed');
            if (isExpanded) {
                body.classList.add('collapsed');
                chevron.classList.remove('expanded');
                sectionState[name] = false;
            } else {
                body.classList.remove('collapsed');
                chevron.classList.add('expanded');
                sectionState[name] = true;
            }
            saveState();
        }

        function sendAction(type, data) {
            vscode.postMessage(Object.assign({ type: type }, data || {}));
        }

        function openNewSearch() { sendAction('openNewSearch'); }
        function newConversation() { sendAction('newConversation'); }
        function saveResults() { sendAction('saveResults'); }
        function clearHistory() { sendAction('clearHistory'); }

        function escapeHtml(str) {
            var div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        function timeAgo(ts) {
            if (typeof ts === 'string') ts = new Date(ts).getTime();
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

        // --- Dossiers ---
        function renderDossiers() {
            var body = document.getElementById('body-dossiers');
            var count = document.getElementById('count-dossiers');
            count.textContent = dossiers.length || '';
            if (!dossiers.length) {
                body.innerHTML = '<div class="empty-state">No dossiers yet</div>';
                return;
            }
            var html = '';
            for (var i = 0; i < dossiers.length; i++) {
                var d = dossiers[i];
                html += '<div class="list-item" onclick="sendAction(\\'openDossier\\', {id:\\'' + d.id + '\\'})" title="' + escapeHtml(d.title) + '">';
                html += '  <div class="list-item-body">';
                html += '    <div class="list-item-title">' + escapeHtml(d.title) + '</div>';
                html += '    <div class="list-item-meta">' + escapeHtml((d.query || '').substring(0, 50)) + ' &middot; ' + timeAgo(d.createdAt) + '</div>';
                html += '  </div>';
                html += '  <div class="list-item-actions">';
                html += '    <button class="item-action-btn danger" onclick="event.stopPropagation(); sendAction(\\'deleteDossier\\', {id:\\'' + d.id + '\\'})" title="Delete">&#x1F5D1;</button>';
                html += '  </div>';
                html += '</div>';
            }
            body.innerHTML = html;
        }

        // --- Deep Runs ---
        function renderDeepRuns() {
            var body = document.getElementById('body-deepRuns');
            var count = document.getElementById('count-deepRuns');
            count.textContent = deepRuns.length || '';
            if (!deepRuns.length) {
                body.innerHTML = '<div class="empty-state">No deep runs yet</div>';
                return;
            }
            var html = '';
            for (var i = 0; i < deepRuns.length; i++) {
                var r = deepRuns[i];
                var statusClass = 'status-' + r.status;
                html += '<div class="list-item" onclick="sendAction(\\'openDeepRun\\', {id:\\'' + r.id + '\\'})" title="' + escapeHtml(r.query) + '">';
                html += '  <div class="list-item-body">';
                html += '    <div class="list-item-title">' + escapeHtml(r.query) + '</div>';
                html += '    <div class="list-item-meta"><span class="status-badge ' + statusClass + '">' + r.status + '</span> &middot; ' + timeAgo(r.createdAt) + '</div>';
                html += '  </div>';
                html += '  <div class="list-item-actions">';
                html += '    <button class="item-action-btn danger" onclick="event.stopPropagation(); sendAction(\\'deleteDeepRun\\', {id:\\'' + r.id + '\\'})" title="Delete">&#x1F5D1;</button>';
                html += '  </div>';
                html += '</div>';
            }
            body.innerHTML = html;
        }

        // --- Courses ---
        function renderCourses() {
            var body = document.getElementById('body-courses');
            var count = document.getElementById('count-courses');
            count.textContent = courses.length || '';
            if (!courses.length) {
                body.innerHTML = '<div class="empty-state">No courses yet</div>';
                return;
            }
            var html = '';
            for (var i = 0; i < courses.length; i++) {
                var c = courses[i];
                html += '<div class="list-item" onclick="sendAction(\\'openCourse\\', {id:\\'' + c.id + '\\'})" title="' + escapeHtml(c.title) + '">';
                html += '  <div class="list-item-body">';
                html += '    <div class="list-item-title">' + escapeHtml(c.title) + '</div>';
                html += '    <div class="list-item-meta">' + c.slideCount + ' slides &middot; ' + timeAgo(c.createdAt) + '</div>';
                html += '  </div>';
                html += '  <div class="list-item-actions">';
                html += '    <button class="item-action-btn" onclick="event.stopPropagation(); sendAction(\\'presentCourse\\', {id:\\'' + c.id + '\\'})" title="Present">&#x25B6;</button>';
                html += '    <button class="item-action-btn danger" onclick="event.stopPropagation(); sendAction(\\'deleteCourse\\', {id:\\'' + c.id + '\\'})" title="Delete">&#x1F5D1;</button>';
                html += '  </div>';
                html += '</div>';
            }
            body.innerHTML = html;
        }

        // --- Agendas ---
        function renderAgendas() {
            var body = document.getElementById('body-agendas');
            var count = document.getElementById('count-agendas');
            count.textContent = agendas.length || '';
            if (!agendas.length) {
                body.innerHTML = '<div class="empty-state">No agendas yet</div>';
                return;
            }
            var html = '';
            for (var i = 0; i < agendas.length; i++) {
                var a = agendas[i];
                var dotClass = 'status-dot ' + a.status;
                var toggleType = a.status === 'active' ? 'pauseAgenda' : 'resumeAgenda';
                var toggleIcon = a.status === 'active' ? '&#x23F8;' : '&#x25B6;';
                var toggleTitle = a.status === 'active' ? 'Pause' : 'Resume';
                var cadence = a.cadenceHours >= 24 ? Math.round(a.cadenceHours / 24) + 'd' : a.cadenceHours + 'h';
                html += '<div class="list-item" title="' + escapeHtml(a.topic) + '">';
                html += '  <div class="' + dotClass + '"></div>';
                html += '  <div class="list-item-body">';
                html += '    <div class="list-item-title">' + escapeHtml(a.topic) + '</div>';
                html += '    <div class="list-item-meta">every ' + cadence + ' &middot; ' + a.status + ' &middot; ' + a.dossierIds.length + ' runs</div>';
                html += '  </div>';
                html += '  <div class="list-item-actions">';
                if (a.status !== 'exhausted') {
                    html += '    <button class="item-action-btn" onclick="event.stopPropagation(); sendAction(\\'' + toggleType + '\\', {id:\\'' + a.id + '\\'})" title="' + toggleTitle + '">' + toggleIcon + '</button>';
                }
                html += '    <button class="item-action-btn danger" onclick="event.stopPropagation(); sendAction(\\'deleteAgenda\\', {id:\\'' + a.id + '\\'})" title="Delete">&#x1F5D1;</button>';
                html += '  </div>';
                html += '</div>';
            }
            body.innerHTML = html;
        }

        // --- Search History ---
        function switchScope(scope) {
            currentScope = scope;
            document.getElementById('tabWorkspace').className = scope === 'workspace' ? 'scope-tab active' : 'scope-tab';
            document.getElementById('tabGlobal').className = scope === 'global' ? 'scope-tab active' : 'scope-tab';
            renderHistory();
            saveState();
        }

        function renderHistory() {
            var entries = currentScope === 'workspace' ? workspaceEntries : globalEntries;
            var list = document.getElementById('historyList');
            var clearRow = document.getElementById('clearRow');
            var count = document.getElementById('count-history');

            var total = workspaceEntries.length + globalEntries.length;
            count.textContent = total || '';

            if (!entries || entries.length === 0) {
                var scopeLabel = currentScope === 'workspace' ? 'this workspace' : 'any workspace';
                list.innerHTML = '<div class="empty-state">No searches in ' + scopeLabel + ' yet</div>';
                clearRow.style.display = 'none';
                return;
            }

            clearRow.style.display = 'block';

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
                    html += '<div class="history-item" onclick="sendAction(\\'historyClick\\', {entryId:\\'' + item.id + '\\', query:\\'' + escapedQuery + '\\'})" title="' + item.query.replace(/"/g, '&quot;') + '">';
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

        // --- Message handler ---
        window.addEventListener('message', function(event) {
            var message = event.data;
            switch (message.type) {
                case 'updateHistory':
                    workspaceEntries = message.entries || [];
                    globalEntries = message.globalEntries || [];
                    renderHistory();
                    break;
                case 'updateDossiers':
                    dossiers = message.items || [];
                    renderDossiers();
                    break;
                case 'updateDeepRuns':
                    deepRuns = message.items || [];
                    renderDeepRuns();
                    break;
                case 'updateCourses':
                    courses = message.items || [];
                    renderCourses();
                    break;
                case 'updateAgendas':
                    agendas = message.items || [];
                    renderAgendas();
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
