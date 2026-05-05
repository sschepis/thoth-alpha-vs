import * as vscode from 'vscode';
import { ThothPanel } from './ThothPanel';
import { ThothEditorProvider } from './ThothEditorProvider';
import { ThothSidebarProvider } from './ThothSidebarProvider';
import { HistoryManager } from './HistoryManager';
import { ThothStatusBar } from './ThothStatusBar';
import { ThothCodeLensProvider } from './ThothCodeLensProvider';
import { registerChatParticipant } from './ThothChatParticipant';
import { registerTools } from './ThothTools';
import { initEngine } from './ThothAgentEngine';
import { ThothNotebookSerializer } from './ThothNotebookSerializer';
import { ThothNotebookController } from './ThothNotebookController';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Thoth Alpha', { log: true });
    context.subscriptions.push(outputChannel);
    outputChannel.info('Thoth Alpha extension activating');

    initEngine(outputChannel, context.secrets);

    const historyManager = new HistoryManager(context);
    context.subscriptions.push(historyManager);
    const statusBar = new ThothStatusBar();
    context.subscriptions.push(statusBar);

    // Core commands
    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.openSearch', () => {
            ThothPanel.createOrShow(context.extensionUri, historyManager, context.globalState);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.saveResults', async () => {
            const activePanel = ThothPanel.getActivePanel();
            if (activePanel) {
                activePanel.requestSaveResults();
            }
        })
    );

    // Analyze selection command (used by CodeLens, context menu, and keybinding)
    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.analyzeSelection', (document?: vscode.TextDocument, range?: vscode.Range) => {
            const editor = vscode.window.activeTextEditor;
            let code = '';
            let fileName = '';

            if (document && range) {
                code = document.getText(range);
                const endLine = Math.min(range.start.line + 30, document.lineCount - 1);
                const fullRange = new vscode.Range(range.start.line, 0, endLine, document.lineAt(endLine).text.length);
                code = document.getText(fullRange);
                fileName = document.fileName;
            } else if (editor) {
                const selection = editor.selection;
                code = editor.document.getText(selection.isEmpty ? undefined : selection);
                fileName = editor.document.fileName;
            }

            if (!code.trim()) {
                vscode.window.showInformationMessage('Select code in the editor to analyze with Thoth Alpha.');
                return;
            }

            ThothPanel.createOrShow(context.extensionUri, historyManager, context.globalState);
            setTimeout(() => {
                const panel = ThothPanel.getActivePanel();
                if (panel) {
                    const basename = fileName.split('/').pop() || '';
                    panel.fillQuery(`Analyze this code from ${basename}:\n\`\`\`\n${code.substring(0, 3000)}\n\`\`\``);
                }
            }, 500);
        })
    );

    // Explain code command (context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.explainCode', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) {
                vscode.window.showInformationMessage('Select code to explain with Thoth Alpha.');
                return;
            }
            const code = editor.document.getText(editor.selection);
            const fileName = editor.document.fileName.split('/').pop() || '';

            ThothPanel.createOrShow(context.extensionUri, historyManager, context.globalState);
            setTimeout(() => {
                const panel = ThothPanel.getActivePanel();
                if (panel) {
                    panel.fillQuery(`Explain this code from ${fileName}:\n\`\`\`\n${code.substring(0, 3000)}\n\`\`\``);
                }
            }, 500);
        })
    );

    // Set Gemini API key (secrets storage)
    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.setGeminiApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your Google Gemini API key',
                password: true,
                placeHolder: 'Paste your Gemini API key here',
                ignoreFocusOut: true
            });
            if (key !== undefined) {
                if (key === '') {
                    await context.secrets.delete('geminiApiKey');
                    vscode.window.showInformationMessage('Gemini API key removed.');
                } else {
                    await context.secrets.store('geminiApiKey', key);
                    vscode.window.showInformationMessage('Gemini API key saved securely.');
                }
            }
        })
    );

    // Custom editor
    context.subscriptions.push(
        ThothEditorProvider.register(context, historyManager)
    );

    // Sidebar
    const sidebarProvider = new ThothSidebarProvider(context.extensionUri, historyManager, context.globalState);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ThothSidebarProvider.viewType, sidebarProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    historyManager.onDidChangeHistory(entries => {
        sidebarProvider.updateHistory(entries);
    });

    // CodeLens
    const codeLensProvider = new ThothCodeLensProvider();
    context.subscriptions.push(codeLensProvider);
    const codeLensLanguages = [
        'python', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact',
        'r', 'julia', 'rust', 'go', 'java', 'kotlin', 'csharp'
    ];
    for (const lang of codeLensLanguages) {
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider({ language: lang, scheme: 'file' }, codeLensProvider)
        );
    }

    // Chat participant (@thoth)
    registerChatParticipant(context);

    // Language model tools
    registerTools(context);

    // Notebook support (.thoth files as notebooks)
    context.subscriptions.push(
        vscode.workspace.registerNotebookSerializer('thoth-notebook', new ThothNotebookSerializer(), {
            transientOutputs: false
        })
    );
    const notebookController = new ThothNotebookController();
    context.subscriptions.push(notebookController);

    outputChannel.info('Thoth Alpha extension activated');
}

export function deactivate() {}
