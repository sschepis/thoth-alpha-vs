import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ThothAgentEngine } from './ThothAgentEngine';

export class ThothEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'thothAlpha.editor';

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new ThothEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(ThothEditorProvider.viewType, provider);
    }

    constructor(
        private readonly context: vscode.ExtensionContext
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

        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'save_state':
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(
                        document.uri,
                        new vscode.Range(0, 0, document.lineCount, 0),
                        JSON.stringify(message.state, null, 2)
                    );
                    vscode.workspace.applyEdit(edit);
                    return;
                case 'search':
                    if (currentSearchTokenSource) {
                        currentSearchTokenSource.cancel();
                    }
                    currentSearchTokenSource = new vscode.CancellationTokenSource();
                    await ThothAgentEngine.handleSearch(message.query, message.modelId, webviewPanel, currentSearchTokenSource.token);
                    currentSearchTokenSource = undefined;
                    return;
                case 'cancel_search':
                    if (currentSearchTokenSource) {
                        currentSearchTokenSource.cancel();
                        currentSearchTokenSource = undefined;
                    }
                    return;
                case 'request_context':
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
                case 'webview_ready':
                    if (isInitializing) {
                        updateWebview();
                        isInitializing = false;
                        
                        vscode.lm.selectChatModels().then(models => {
                            const modelInfo = models.map(m => ({ id: m.id, name: m.name, family: m.family }));
                            webviewPanel.webview.postMessage({ command: 'set_models', models: modelInfo });
                        });
                    }
                    return;
                case 'execute_code':
                    ThothAgentEngine.executeLocalCode(message.language, message.code, webviewPanel);
                    return;
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
            });
            window.addEventListener('load', () => vscode.postMessage({ command: 'webview_ready' }));
        </script>
        `;
        html = html.replace('</head>', `${scriptInjection}</head>`);

        const newCallAgent = `
        async function callAgent(query, modelId) {
            return new Promise((resolve, reject) => {
                vscode.postMessage({ command: 'search', query: query, modelId: modelId });
                const handler = function(event) {
                    const message = event.data;
                    if (message.command === 'search_chunk') {
                        try {
                            let clean = message.text.replace(/^\\s*\\x60\\x60\\x60(json)?/i, '').replace(/\\x60\\x60\\x60\\s*$/, '').trim();
                            const endings = ["", "}", "\\"}"]", "]}", "\\"]}", "}}", "\\"}}", "\\"]}}"];
                            for(let ending of endings) {
                                try { 
                                    const partial = JSON.parse(clean + ending); 
                                    if (window.renderPartialResults) window.renderPartialResults(partial);
                                    break;
                                } catch(e) {}
                            }
                        } catch(e) {}
                    }
                    else if (message.command === 'search_done') {
                        window.removeEventListener('message', handler);
                        try {
                            resolve(JSON.parse(message.text));
                        } catch(e) {
                            reject(new Error("Failed to parse JSON response from LLM: " + message.text));
                        }
                    } else if (message.command === 'error') {
                        window.removeEventListener('message', handler);
                        reject(new Error(message.text));
                    } else if (message.command === 'search_cancelled') {
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
