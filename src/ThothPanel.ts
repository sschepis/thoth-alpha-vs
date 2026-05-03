import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ThothAgentEngine } from './ThothAgentEngine';

export class ThothPanel {
    public static currentPanels: ThothPanel[] = [];
    public static readonly viewType = 'thothAlpha';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _currentSearchTokenSource?: vscode.CancellationTokenSource;

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        const panel = vscode.window.createWebviewPanel(
            ThothPanel.viewType,
            'Thoth Alpha Search',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri)]
            }
        );

        const thothPanel = new ThothPanel(panel, extensionUri);
        ThothPanel.currentPanels.push(thothPanel);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'search':
                        if (this._currentSearchTokenSource) {
                            this._currentSearchTokenSource.cancel();
                        }
                        this._currentSearchTokenSource = new vscode.CancellationTokenSource();
                        await ThothAgentEngine.handleSearch(message.query, message.modelId, this._panel, this._currentSearchTokenSource.token);
                        this._currentSearchTokenSource = undefined;
                        return;
                    case 'request_context':
                        // Acknowledges the request and proxies it back as a search command with the flag.
                        const activeEditor = vscode.window.activeTextEditor;
                        let contextString = '';

                        if (message.query.includes('__CONTEXT_INJECTED__') && activeEditor) {
                            const selection = activeEditor.selection;
                            let code = activeEditor.document.getText(selection);
                            if (!code) code = activeEditor.document.getText(); // Fallback to full file
                            const language = activeEditor.document.languageId;
                            const fileName = path.basename(activeEditor.document.fileName);
                            contextString += `\n\n[Current Editor Context:\nFile: ${fileName}\nLanguage: ${language}\nCode:\n\`\`\`\n${code}\n\`\`\`]`;
                            message.query = message.query.replace('__CONTEXT_INJECTED__', '');
                        }

                        if (message.query.includes('__WORKSPACE_INJECTED__')) {
                            try {
                                const maxFiles = vscode.workspace.getConfiguration('thothAlpha').get<number>('maxWorkspaceFilesScanned', 5);
                                const files = await vscode.workspace.findFiles('**/*.{csv,json,md,txt,log}', '**/node_modules/**', maxFiles);
                                let wsContext = '\n\n[Workspace Data Context:\n';
                                for (const file of files) {
                                    const content = await fs.promises.readFile(file.fsPath, 'utf8');
                                    // Take up to 1500 chars to avoid prompt bloat
                                    wsContext += `File: ${vscode.workspace.asRelativePath(file)}\n\`\`\`\n${content.substring(0, 1500)}${content.length > 1500 ? '...' : ''}\n\`\`\`\n\n`;
                                }
                                wsContext += ']';
                                contextString += wsContext;
                            } catch (e) {
                                console.error('Failed to load workspace context', e);
                            }
                            message.query = message.query.replace('__WORKSPACE_INJECTED__', '');
                        }
                        
                        // Re-trigger the performSearch flow inside the webview, now with the appended context.
                        this._panel.webview.postMessage({ 
                            command: 'inject_context_and_search',
                            query: message.query + contextString,
                            modelId: message.modelId
                        });
                        return;
                    case 'cancel_search':
                        if (this._currentSearchTokenSource) {
                            this._currentSearchTokenSource.cancel();
                            this._currentSearchTokenSource = undefined;
                        }
                        return;
                    case 'execute_code':
                        ThothAgentEngine.executeLocalCode(message.language, message.code, this._panel);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        ThothPanel.currentPanels = ThothPanel.currentPanels.filter(p => p !== this);
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

        vscode.lm.selectChatModels().then(models => {
            const modelInfo = models.map(m => ({ id: m.id, name: m.name, family: m.family }));
            this._panel.webview.postMessage({ command: 'set_models', models: modelInfo });
        });
    }

    private async _getHtmlForWebview(webview: vscode.Webview) {
        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'index.html');
        let html = '';
        try {
            html = await fs.promises.readFile(htmlPath.fsPath, 'utf8');
        } catch (e) {
            return `<!DOCTYPE html><html><body>Error loading UI: ${e}</body></html>`;
        }

        // Inject VS Code API initialization
        const scriptInjection = `
        <script>
            const vscode = acquireVsCodeApi();
            window.vscode = vscode;
            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'inject_context_and_search') {
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
        </script>
        `;
        html = html.replace('</head>', `${scriptInjection}</head>`);

        // Replace the original callAgent implementation
        const newCallAgent = `
        async function callAgent(query, modelId) {
            return new Promise((resolve, reject) => {
                vscode.postMessage({ command: 'search', query: query, modelId: modelId });
                const handler = function(event) {
                    const message = event.data;
                    if (message.command === 'search_chunk') {
                        try {
                            let clean = message.text.replace(/^\\s*\\x60\\x60\\x60(json)?/i, '').replace(/\\x60\\x60\\x60\\s*$/, '').trim();
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
        
        // Use a regular expression to match from "async function callAgent" up to the next function "async function executeLoop"
        html = html.replace(/async function callAgent\([\s\S]*?(?=async function executeLoop)/, newCallAgent);

        return html;
    }
}
