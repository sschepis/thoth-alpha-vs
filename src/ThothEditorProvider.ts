import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ThothAgentEngine, ConversationMessage, WebviewSearchSink, WebviewDeepResearchSink, WebviewExecutionSink } from './ThothAgentEngine';
import { ThothPanel } from './ThothPanel';
import { HistoryManager } from './HistoryManager';

export class ThothEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'thothAlpha.editor';

    public static register(context: vscode.ExtensionContext, historyManager: HistoryManager): vscode.Disposable {
        const provider = new ThothEditorProvider(context, historyManager);
        return vscode.window.registerCustomEditorProvider(ThothEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true }
        });
    }

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly _historyManager: HistoryManager
    ) { }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri)]
        };

        webviewPanel.webview.html = await this.getHtmlForWebview(webviewPanel.webview);

        const updateWebview = () => {
            try {
                const text = document.getText();
                if (text.trim().length > 0) {
                    const state = JSON.parse(text);
                    webviewPanel.webview.postMessage({ command: 'load_state', state });
                }
            } catch (e) {
                // Not valid JSON yet, ignore
            }
        };

        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                // If it was modified externally, we might want to update,
                // but usually the webview drives the changes.
            }
        });

        let isInitializing = true;
        let currentSearchTokenSource: vscode.CancellationTokenSource | undefined;
        let conversationHistory: ConversationMessage[] = [];
        let lastDeepResearchInteractionId: string | undefined;

        const searchSink = new WebviewSearchSink(webviewPanel.webview);
        const deepResearchSink = new WebviewDeepResearchSink(webviewPanel.webview);
        const executionSink = new WebviewExecutionSink(webviewPanel.webview);

        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'save_state': {
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(
                        document.uri,
                        new vscode.Range(0, 0, document.lineCount, 0),
                        JSON.stringify(message.state, null, 2)
                    );
                    vscode.workspace.applyEdit(edit);
                    return;
                }
                case 'search': {
                    if (currentSearchTokenSource) {
                        currentSearchTokenSource.cancel();
                    }
                    currentSearchTokenSource = new vscode.CancellationTokenSource();
                    const rawQuery = message.query;

                    const responseText = await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: 'Thoth Alpha: Searching...', cancellable: true },
                        async (_progress, progressToken) => {
                            progressToken.onCancellationRequested(() => {
                                currentSearchTokenSource?.cancel();
                            });
                            return ThothAgentEngine.handleSearch(
                                message.query, message.modelId, searchSink,
                                currentSearchTokenSource!.token,
                                conversationHistory
                            );
                        }
                    );

                    if (responseText) {
                        conversationHistory.push({ role: 'user', content: rawQuery });
                        conversationHistory.push({ role: 'assistant', content: responseText });
                    }
                    currentSearchTokenSource = undefined;
                    return;
                }
                case 'cancel_search':
                    if (currentSearchTokenSource) {
                        currentSearchTokenSource.cancel();
                        currentSearchTokenSource = undefined;
                    }
                    return;
                case 'request_context': {
                    let contextString = '';

                    if (message.query.includes('__CONTEXT_INJECTED__')) {
                        const activeEditor = vscode.window.activeTextEditor;
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
                        } catch (e) {}
                        message.query = message.query.replace('__WORKSPACE_INJECTED__', '');
                    }

                    webviewPanel.webview.postMessage({
                        command: 'inject_context_and_search',
                        query: message.query + contextString,
                        modelId: message.modelId
                    });
                    return;
                }
                case 'deep_research': {
                    if (currentSearchTokenSource) {
                        currentSearchTokenSource.cancel();
                    }

                    const drResult = await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: 'Thoth Alpha: Deep Research...', cancellable: false },
                        async () => {
                            return ThothAgentEngine.handleDeepResearch(
                                message.query, deepResearchSink,
                                conversationHistory,
                                lastDeepResearchInteractionId
                            );
                        }
                    );

                    if (drResult) {
                        lastDeepResearchInteractionId = drResult.interactionId;
                        conversationHistory.push({ role: 'user', content: `[Deep Research] ${message.query}` });
                        conversationHistory.push({ role: 'assistant', content: drResult.responseText });
                    }
                    return;
                }
                case 'new_conversation':
                    conversationHistory = [];
                    lastDeepResearchInteractionId = undefined;
                    return;
                case 'webview_ready':
                    if (isInitializing) {
                        updateWebview();
                        isInitializing = false;

                        vscode.lm.selectChatModels().then(models => {
                            const modelInfo = models.map(m => ({ id: m.id, name: m.name, family: m.family }));
                            const lastModelId = this.context.globalState.get<string>('thothAlpha.lastModelId', '');
                            webviewPanel.webview.postMessage({ command: 'set_models', models: modelInfo, lastModelId });
                        });
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
                    ThothPanel.createOrShow(this.context.extensionUri, this._historyManager, this.context.globalState);
                    return;
                case 'notify_history': {
                    this._historyManager.addEntry(
                        message.query,
                        message.isDeepResearch || false,
                        message.resultSummary
                    );
                    return;
                }
                case 'set_last_model': {
                    this.context.globalState.update('thothAlpha.lastModelId', message.modelId);
                    return;
                }
                case 'fix_simulation': {
                    const fixSink: import('./ThothAgentEngine').SearchProgressSink = {
                        onChunk: () => {},
                        onDone: (text) => webviewPanel.webview.postMessage({ command: 'fix_simulation_done', text }),
                        onError: (text) => webviewPanel.webview.postMessage({ command: 'fix_simulation_error', text }),
                        onCancelled: () => webviewPanel.webview.postMessage({ command: 'fix_simulation_error', text: 'Cancelled' })
                    };
                    await ThothAgentEngine.handleFixSimulation(
                        message.originalQuery,
                        message.brokenCode,
                        message.errorMessage,
                        message.modelId,
                        fixSink,
                        currentSearchTokenSource?.token
                    );
                    return;
                }
                case 'regenerate_simulation': {
                    if (currentSearchTokenSource) {
                        currentSearchTokenSource.cancel();
                    }
                    currentSearchTokenSource = new vscode.CancellationTokenSource();
                    const regenQuery = message.query + '\n\n[IMPORTANT: Generate a COMPLETELY NEW and DIFFERENT simulation_js for this query. Do not reuse any previous approach.]';
                    const regenSink: import('./ThothAgentEngine').SearchProgressSink = {
                        onChunk: () => {},
                        onDone: (text) => webviewPanel.webview.postMessage({ command: 'regenerate_simulation_done', text }),
                        onError: (text) => webviewPanel.webview.postMessage({ command: 'regenerate_simulation_error', text }),
                        onCancelled: () => webviewPanel.webview.postMessage({ command: 'regenerate_simulation_error', text: 'Cancelled' })
                    };
                    await ThothAgentEngine.handleSearch(
                        regenQuery, message.modelId, regenSink,
                        currentSearchTokenSource.token,
                        conversationHistory
                    );
                    currentSearchTokenSource = undefined;
                    return;
                }
            }
        });
    }

    private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'index.html');
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
                if (message.command === 'load_state') {
                    if (window.loadState) window.loadState(message.state);
                }
                else if (message.command === 'fill_query') {
                    var input = document.getElementById('queryInput');
                    if (input) input.value = message.query;
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
                else if (message.command === 'inject_context_and_search') {
                    performSearch(message.query, message.modelId);
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
            });
            window.addEventListener('load', () => vscode.postMessage({ command: 'webview_ready' }));
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
                                if (window.renderPartialResults) window.renderPartialResults(partial);
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
