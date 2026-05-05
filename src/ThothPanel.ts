import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ThothAgentEngine, ConversationMessage, WebviewSearchSink, WebviewDeepResearchSink, WebviewExecutionSink } from './ThothAgentEngine';
import { HistoryManager } from './HistoryManager';

export class ThothPanel {
    public static currentPanels: ThothPanel[] = [];
    public static readonly viewType = 'thothAlpha';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _historyManager: HistoryManager;
    private readonly _globalState: vscode.Memento;
    private _disposables: vscode.Disposable[] = [];
    private _currentSearchTokenSource?: vscode.CancellationTokenSource;
    private _conversationHistory: ConversationMessage[] = [];
    private _lastDeepResearchInteractionId?: string;
    private _lastResults?: { query: string; data: any; timestamp: number };
    private _isSearching = false;

    private static _onSearchStateChanged = new vscode.EventEmitter<boolean>();
    public static readonly onSearchStateChanged = ThothPanel._onSearchStateChanged.event;

    public static createOrShow(extensionUri: vscode.Uri, historyManager: HistoryManager, globalState?: vscode.Memento) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        const panel = vscode.window.createWebviewPanel(
            ThothPanel.viewType,
            'Thoth Alpha Search',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri)]
            }
        );

        const thothPanel = new ThothPanel(panel, extensionUri, historyManager, globalState);
        ThothPanel.currentPanels.push(thothPanel);
    }

    public static getActivePanel(): ThothPanel | undefined {
        return ThothPanel.currentPanels[ThothPanel.currentPanels.length - 1];
    }

    private _setSearching(value: boolean) {
        this._isSearching = value;
        ThothPanel._onSearchStateChanged.fire(value);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, historyManager: HistoryManager, globalState?: vscode.Memento) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._historyManager = historyManager;
        this._globalState = globalState || {} as vscode.Memento;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                const searchSink = new WebviewSearchSink(this._panel.webview);
                const deepResearchSink = new WebviewDeepResearchSink(this._panel.webview);
                const executionSink = new WebviewExecutionSink(this._panel.webview);

                switch (message.command) {
                    case 'search': {
                        if (this._currentSearchTokenSource) {
                            this._currentSearchTokenSource.cancel();
                        }
                        this._currentSearchTokenSource = new vscode.CancellationTokenSource();
                        const rawQuery = message.query;
                        this._setSearching(true);

                        const responseText = await vscode.window.withProgress(
                            { location: vscode.ProgressLocation.Notification, title: 'Thoth Alpha: Searching...', cancellable: true },
                            async (_progress, progressToken) => {
                                progressToken.onCancellationRequested(() => {
                                    this._currentSearchTokenSource?.cancel();
                                });
                                return ThothAgentEngine.handleSearch(
                                    message.query, message.modelId, searchSink,
                                    this._currentSearchTokenSource!.token,
                                    this._conversationHistory,
                                    message.skipCache
                                );
                            }
                        );

                        this._setSearching(false);
                        if (responseText) {
                            this._conversationHistory.push({ role: 'user', content: rawQuery });
                            this._conversationHistory.push({ role: 'assistant', content: responseText });
                        }
                        this._currentSearchTokenSource = undefined;
                        return;
                    }
                    case 'request_context': {
                        const activeEditor = vscode.window.activeTextEditor;
                        let contextString = '';

                        if (message.query.includes('__CONTEXT_INJECTED__')) {
                            if (activeEditor) {
                                const selection = activeEditor.selection;
                                let code = activeEditor.document.getText(selection);
                                if (!code) code = activeEditor.document.getText();
                                const language = activeEditor.document.languageId;
                                const fileName = path.basename(activeEditor.document.fileName);
                                contextString += `\n\n[Current Editor Context:\nFile: ${fileName}\nLanguage: ${language}\nCode:\n\`\`\`\n${code}\n\`\`\`]`;
                            }
                            message.query = message.query.replace('__CONTEXT_INJECTED__', '');
                        }

                        if (message.query.includes('__WORKSPACE_INJECTED__')) {
                            try {
                                const maxFiles = vscode.workspace.getConfiguration('thothAlpha').get<number>('maxWorkspaceFilesScanned', 5);
                                const files = await vscode.workspace.findFiles('**/*.{csv,json,md,txt,log}', '**/node_modules/**', maxFiles);
                                let wsContext = '\n\n[Workspace Data Context:\n';
                                for (const file of files) {
                                    const content = await fs.promises.readFile(file.fsPath, 'utf8');
                                    wsContext += `File: ${vscode.workspace.asRelativePath(file)}\n\`\`\`\n${content.substring(0, 1500)}${content.length > 1500 ? '...' : ''}\n\`\`\`\n\n`;
                                }
                                wsContext += ']';
                                contextString += wsContext;
                            } catch (e) {
                                console.error('Failed to load workspace context', e);
                            }
                            message.query = message.query.replace('__WORKSPACE_INJECTED__', '');
                        }

                        this._panel.webview.postMessage({
                            command: 'inject_context_and_search',
                            query: message.query + contextString,
                            modelId: message.modelId
                        });
                        return;
                    }
                    case 'deep_research': {
                        if (this._currentSearchTokenSource) {
                            this._currentSearchTokenSource.cancel();
                        }
                        this._setSearching(true);

                        const drResult = await vscode.window.withProgress(
                            { location: vscode.ProgressLocation.Notification, title: 'Thoth Alpha: Deep Research...', cancellable: false },
                            async () => {
                                return ThothAgentEngine.handleDeepResearch(
                                    message.query, deepResearchSink,
                                    this._conversationHistory,
                                    this._lastDeepResearchInteractionId
                                );
                            }
                        );

                        this._setSearching(false);
                        if (drResult) {
                            this._lastDeepResearchInteractionId = drResult.interactionId;
                            this._conversationHistory.push({ role: 'user', content: `[Deep Research] ${message.query}` });
                            this._conversationHistory.push({ role: 'assistant', content: drResult.responseText });
                        }
                        return;
                    }
                    case 'new_conversation':
                        this._conversationHistory = [];
                        this._lastDeepResearchInteractionId = undefined;
                        return;
                    case 'cancel_search':
                        if (this._currentSearchTokenSource) {
                            this._currentSearchTokenSource.cancel();
                            this._currentSearchTokenSource = undefined;
                        }
                        return;
                    case 'execute_code': {
                        const execMode = vscode.workspace.getConfiguration('thothAlpha').get<string>('codeExecutionMode', 'background');
                        if (execMode === 'terminal') {
                            ThothAgentEngine.executeInTerminal(message.language, message.code);
                        } else {
                            ThothAgentEngine.executeLocalCode(message.language, message.code, executionSink);
                        }
                        return;
                    }
                    case 'open_new_search':
                        ThothPanel.createOrShow(this._extensionUri, this._historyManager, this._globalState);
                        return;
                    case 'save_results': {
                        this._lastResults = {
                            query: message.query,
                            data: message.data,
                            timestamp: Date.now()
                        };
                        await this._saveResultsToFile(message.query, message.data, message.allResults);
                        return;
                    }
                    case 'notify_history': {
                        this._historyManager.addEntry(
                            message.query,
                            message.isDeepResearch || false,
                            message.resultSummary,
                            message.resultData
                        );
                        return;
                    }
                    case 'set_last_model': {
                        if (this._globalState?.update) {
                            this._globalState.update('thothAlpha.lastModelId', message.modelId);
                        }
                        return;
                    }
                    case 'fix_simulation': {
                        const fixSink: import('./ThothAgentEngine').SearchProgressSink = {
                            onChunk: () => {},
                            onDone: (text) => this._panel.webview.postMessage({ command: 'fix_simulation_done', text }),
                            onError: (text) => this._panel.webview.postMessage({ command: 'fix_simulation_error', text }),
                            onCancelled: () => this._panel.webview.postMessage({ command: 'fix_simulation_error', text: 'Cancelled' })
                        };
                        await ThothAgentEngine.handleFixSimulation(
                            message.originalQuery,
                            message.brokenCode,
                            message.errorMessage,
                            message.modelId,
                            fixSink,
                            this._currentSearchTokenSource?.token
                        );
                        return;
                    }
                    case 'generate_simulation': {
                        const genSink: import('./ThothAgentEngine').SearchProgressSink = {
                            onChunk: () => {},
                            onDone: (text) => this._panel.webview.postMessage({ command: 'generate_simulation_done', text }),
                            onError: (text) => this._panel.webview.postMessage({ command: 'generate_simulation_error', text }),
                            onCancelled: () => this._panel.webview.postMessage({ command: 'generate_simulation_error', text: 'Cancelled' })
                        };
                        await ThothAgentEngine.handleGenerateSimulation(
                            message.query,
                            message.summary,
                            message.explanation,
                            message.modelId,
                            genSink,
                            this._currentSearchTokenSource?.token
                        );
                        return;
                    }
                    case 'regenerate_simulation': {
                        if (this._currentSearchTokenSource) {
                            this._currentSearchTokenSource.cancel();
                        }
                        this._currentSearchTokenSource = new vscode.CancellationTokenSource();
                        const regenQuery = message.query + '\n\n[IMPORTANT: Generate a COMPLETELY NEW and DIFFERENT simulation_js for this query. Do not reuse any previous approach.]';
                        const regenSink: import('./ThothAgentEngine').SearchProgressSink = {
                            onChunk: () => {},
                            onDone: (text) => this._panel.webview.postMessage({ command: 'regenerate_simulation_done', text }),
                            onError: (text) => this._panel.webview.postMessage({ command: 'regenerate_simulation_error', text }),
                            onCancelled: () => this._panel.webview.postMessage({ command: 'regenerate_simulation_error', text: 'Cancelled' })
                        };
                        await ThothAgentEngine.handleSearch(
                            regenQuery, message.modelId, regenSink,
                            this._currentSearchTokenSource.token,
                            this._conversationHistory
                        );
                        this._currentSearchTokenSource = undefined;
                        return;
                    }
                }
            },
            null,
            this._disposables
        );
    }

    public requestSaveResults() {
        this._panel.webview.postMessage({ command: 'request_save_results' });
    }

    public fillQuery(query: string) {
        this._panel.webview.postMessage({ command: 'fill_query', query });
    }

    public showResult(query: string, resultData: any) {
        this._panel.webview.postMessage({ command: 'display_result', query, data: resultData });
    }

    public sendNewConversation() {
        this._conversationHistory = [];
        this._lastDeepResearchInteractionId = undefined;
        this._panel.webview.postMessage({ command: 'trigger_new_conversation' });
    }

    private async _saveResultsToFile(query: string, data: any, allResults?: any[]) {
        const results = allResults || [{ query, data, timestamp: new Date().toISOString() }];
        const content = {
            version: 1,
            created: new Date().toISOString(),
            results: results.map(r => ({
                query: r.query,
                timestamp: r.timestamp || new Date().toISOString(),
                interpretation: r.data?.interpretation,
                result_summary: r.data?.result_summary,
                explanation_md: r.data?.explanation_md,
                table_data: r.data?.table_data,
                graph_data: r.data?.graph_data,
                related_queries: r.data?.related_queries,
                executable_code: r.data?.executable_code
            }))
        };

        const slug = query.replace(/[^a-zA-Z0-9]+/g, '-').substring(0, 40).replace(/-$/, '');
        const defaultName = `${slug}.thothresults`;

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(
                path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', defaultName)
            ),
            filters: { 'Thoth Search Results': ['thothresults'], 'JSON': ['json'] }
        });

        if (uri) {
            await fs.promises.writeFile(uri.fsPath, JSON.stringify(content, null, 2), 'utf8');
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
            this._panel.webview.postMessage({ command: 'save_results_done' });
        }
    }

    public dispose() {
        ThothPanel.currentPanels = ThothPanel.currentPanels.filter(p => p !== this);
        this._setSearching(false);
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = await this._getHtmlForWebview(webview);

        const models = await vscode.lm.selectChatModels();
        const modelInfo = models.map(m => ({ id: m.id, name: m.name, family: m.family }));
        const lastModelId = this._globalState?.get?.('thothAlpha.lastModelId', '') || '';
        this._panel.webview.postMessage({ command: 'set_models', models: modelInfo, lastModelId });
    }

    private async _getHtmlForWebview(webview: vscode.Webview) {
        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'index.html');
        let html = '';
        try {
            html = await fs.promises.readFile(htmlPath.fsPath, 'utf8');
        } catch (e) {
            return `<!DOCTYPE html><html><body>Error loading UI: ${e}</body></html>`;
        }

        const scriptInjection = `
        <script>
            const vscode = acquireVsCodeApi();
            window.vscode = vscode;
            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'inject_context_and_search') {
                    performSearch(message.query, message.modelId);
                }
                else if (message.command === 'fill_query') {
                    var input = document.getElementById('queryInput');
                    if (input) input.value = message.query;
                }
                else if (message.command === 'display_result') {
                    if (window.loadState) window.loadState({ query: message.query, data: message.data });
                }
                else if (message.command === 'trigger_new_conversation') {
                    if (window.startNewConversation) window.startNewConversation();
                }
                else if (message.command === 'request_save_results') {
                    if (window.saveResults) window.saveResults();
                }
                else if (message.command === 'save_results_done') {
                    if (window.addThought) window.addThought('Results saved.', 'success');
                }
                else if (message.command === 'set_models') {
                    const select = document.getElementById('modelSelect');
                    if (select && message.models) {
                        select.innerHTML = '<option value="">Auto (VS Code Default)</option>';
                        message.models.forEach(m => {
                            const opt = document.createElement('option');
                            opt.value = m.id;
                            opt.textContent = m.name + ' (' + m.family + ')';
                            select.appendChild(opt);
                        });
                        if (message.lastModelId) {
                            select.value = message.lastModelId;
                        }
                    }
                }
                else if (message.command === 'execution_started') {
                    const pod = document.getElementById('terminalPod');
                    if (pod) {
                        pod.classList.remove('hidden');
                        document.getElementById('terminalContent').innerText = 'Executing ' + message.language + ' code...\\n';
                    }
                }
                else if (message.command === 'execution_result') {
                    const pod = document.getElementById('terminalPod');
                    if (pod) {
                        let text = document.getElementById('terminalContent').innerText;
                        if (message.error) {
                            text += '\\n[ERROR]\\n' + message.error;
                        } else {
                            if (message.stdout) text += '\\n[STDOUT]\\n' + message.stdout;
                            if (message.stderr) text += '\\n[STDERR]\\n' + message.stderr;
                        }
                        document.getElementById('terminalContent').innerText = text;
                    }
                }
                else if (message.command === 'deep_research_chunk') {
                    if (window.handleDeepResearchChunk) window.handleDeepResearchChunk(message.text);
                }
                else if (message.command === 'deep_research_done') {
                    if (window.handleDeepResearchDone) window.handleDeepResearchDone(message.text, message.interactionId);
                }
                else if (message.command === 'deep_research_status') {
                    if (window.handleDeepResearchStatus) window.handleDeepResearchStatus(message.status);
                }
                else if (message.command === 'regenerate_simulation_done') {
                    if (window.handleRegenerateSimulation) window.handleRegenerateSimulation(message.text);
                }
                else if (message.command === 'regenerate_simulation_error') {
                    if (window.handleRegenerateSimulationError) window.handleRegenerateSimulationError(message.text);
                }
                else if (message.command === 'fix_simulation_done') {
                    if (window.handleSimulationFix) window.handleSimulationFix(message.text);
                }
                else if (message.command === 'fix_simulation_error') {
                    if (window.handleSimulationFixError) window.handleSimulationFixError(message.text);
                }
                else if (message.command === 'generate_simulation_done') {
                    if (window.handleGenerateSimulationDone) window.handleGenerateSimulationDone(message.text);
                }
                else if (message.command === 'generate_simulation_error') {
                    if (window.handleGenerateSimulationError) window.handleGenerateSimulationError(message.text);
                }
            });
        </script>
        `;
        html = html.replace('</head>', `${scriptInjection}</head>`);

        const newCallAgent = `
        async function callAgent(query, modelId) {
            return new Promise((resolve, reject) => {
                vscode.postMessage({ command: 'search', query: query, modelId: modelId });
                let partialTimer = null;
                let latestChunk = '';
                function tryPartialRender() {
                    try {
                        let clean = latestChunk.replace(/^\\s*\\x60\\x60\\x60(json)?/i, '').replace(/\\x60\\x60\\x60\\s*$/, '').trim();
                        const endings = ["", "}", "\\"}", "]}", "\\"]}", "}}", "\\"}}", "\\"]}}"];
                        for(let ending of endings) {
                            try {
                                const partial = JSON.parse(clean + ending);
                                window.renderPartialResults(partial);
                                break;
                            } catch(e) {}
                        }
                    } catch(e) {}
                }
                const handler = function(event) {
                    const message = event.data;
                    if (message.command === 'search_chunk') {
                        latestChunk = message.text;
                        if (!partialTimer) {
                            partialTimer = setTimeout(() => { partialTimer = null; tryPartialRender(); }, 300);
                        }
                    }
                    else if (message.command === 'search_done') {
                        if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
                        window.removeEventListener('message', handler);
                        try {
                            resolve(JSON.parse(message.text));
                        } catch(e) {
                            reject(new Error("Failed to parse JSON response from LLM: " + message.text));
                        }
                    } else if (message.command === 'error') {
                        if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
                        window.removeEventListener('message', handler);
                        reject(new Error(message.text));
                    } else if (message.command === 'search_cancelled') {
                        if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
                        window.removeEventListener('message', handler);
                        reject(new Error('CANCELLED'));
                    }
                };
                window.addEventListener('message', handler);
            });
        }
        `;

        html = html.replace(/async function callAgent\([\s\S]*?(?=async function executeLoop)/, newCallAgent);

        return html;
    }
}
