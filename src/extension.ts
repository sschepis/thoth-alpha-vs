import * as vscode from 'vscode';
import * as path from 'path';
import { ThothPanel } from './ThothPanel';
import { ThothEditorProvider } from './ThothEditorProvider';
import { ThothSidebarProvider } from './ThothSidebarProvider';
import { HistoryManager } from './HistoryManager';
import { DossierManager } from './DossierManager';
import { DeepRunManager } from './DeepRunManager';
import { ThothStatusBar } from './ThothStatusBar';
import { ThothCodeLensProvider } from './ThothCodeLensProvider';
import { registerChatParticipant } from './ThothChatParticipant';
import { registerTools } from './ThothTools';
import { initEngine } from './ThothAgentEngine';
import { ThothNotebookSerializer } from './ThothNotebookSerializer';
import { ThothNotebookController } from './ThothNotebookController';
import { initNarration } from './NarrationEngine';
import { AgendaManager } from './AgendaManager';
import { CourseManager } from './CourseManager';
import { CoursePresenter } from './CoursePresenter';
import { clearCache } from './cacheHelper';

export function activate(context: vscode.ExtensionContext) {
    const vsVersion = vscode.version.split('.');
    const major = parseInt(vsVersion[0] || '0', 10);
    const minor = parseInt(vsVersion[1] || '0', 10);
    if (major < 1 || (major === 1 && minor < 90)) {
        vscode.window.showErrorMessage('Thoth Alpha requires VS Code 1.90 or later.');
        return;
    }

    const outputChannel = vscode.window.createOutputChannel('Thoth Alpha', { log: true });
    context.subscriptions.push(outputChannel);
    outputChannel.info('Thoth Alpha extension activating');

    initEngine(outputChannel, context.secrets);
    initNarration(context.secrets, context.globalState, outputChannel);

    const historyManager = new HistoryManager(context);
    context.subscriptions.push(historyManager);
    const dossierManager = new DossierManager(context);
    context.subscriptions.push(dossierManager);
    const deepRunManager = new DeepRunManager(context);
    context.subscriptions.push(deepRunManager);
    const agendaManager = new AgendaManager(context.globalState, dossierManager, outputChannel);
    context.subscriptions.push(agendaManager);
    const courseManager = new CourseManager(context);
    context.subscriptions.push(courseManager);
    const coursePresenter = new CoursePresenter(courseManager);
    context.subscriptions.push(coursePresenter);
    ThothPanel.setManagers(dossierManager, deepRunManager, agendaManager, courseManager);
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
                    const basename = path.basename(fileName) || '';
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
            const fileName = path.basename(editor.document.fileName);

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

    // Set Anthropic API key
    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.setAnthropicApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your Anthropic API key',
                password: true,
                placeHolder: 'Paste your Anthropic API key here',
                ignoreFocusOut: true
            });
            if (key !== undefined) {
                if (key === '') {
                    await context.secrets.delete('anthropicApiKey');
                    vscode.window.showInformationMessage('Anthropic API key removed.');
                } else {
                    await context.secrets.store('anthropicApiKey', key);
                    vscode.window.showInformationMessage('Anthropic API key saved securely.');
                }
            }
        })
    );

    // Set ElevenLabs API key
    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.setElevenLabsApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your ElevenLabs API key',
                password: true,
                placeHolder: 'Paste your ElevenLabs API key here',
                ignoreFocusOut: true
            });
            if (key !== undefined) {
                if (key === '') {
                    await context.secrets.delete('elevenLabsApiKey');
                    vscode.window.showInformationMessage('ElevenLabs API key removed.');
                } else {
                    await context.secrets.store('elevenLabsApiKey', key);
                    vscode.window.showInformationMessage('ElevenLabs API key saved securely.');
                }
            }
        })
    );

    // Dossier commands
    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.createDossier', () => {
            ThothPanel.createOrShow(context.extensionUri, historyManager, context.globalState);
            setTimeout(() => {
                const panel = ThothPanel.getActivePanel();
                if (panel) {
                    panel.fillQuery('[Generate a research dossier on this topic]');
                }
            }, 500);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.listDossiers', () => {
            const panel = ThothPanel.getActivePanel();
            if (panel) {
                panel.postMessage({ command: 'dossier_list', items: dossierManager.list() });
            } else {
                const items = dossierManager.list();
                if (items.length === 0) {
                    vscode.window.showInformationMessage('No dossiers found. Create one with "Thoth Alpha: Create Dossier".');
                } else {
                    const picks = items.map(d => ({ label: d.title, description: d.query, detail: d.createdAt, id: d.id }));
                    vscode.window.showQuickPick(picks, { placeHolder: 'Select a dossier to view' }).then(async pick => {
                        if (pick) {
                            ThothPanel.createOrShow(context.extensionUri, historyManager, context.globalState);
                            setTimeout(async () => {
                                const p = ThothPanel.getActivePanel();
                                const dossier = await dossierManager.get(pick.id);
                                if (p && dossier) {
                                    p.postMessage({ command: 'dossier_loaded', dossier });
                                }
                            }, 500);
                        }
                    });
                }
            }
        })
    );

    // Deep Run command
    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.startDeepRun', () => {
            ThothPanel.createOrShow(context.extensionUri, historyManager, context.globalState);
        })
    );

    // Agenda commands
    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.createAgenda', async () => {
            const topic = await vscode.window.showInputBox({
                prompt: 'Enter a research topic to watch',
                placeHolder: 'e.g. "quantum computing error correction advances"'
            });
            if (!topic) { return; }
            const cadenceStr = await vscode.window.showInputBox({
                prompt: 'Re-research cadence (hours)',
                value: '24',
                placeHolder: '24'
            });
            const cadence = parseInt(cadenceStr || '24', 10) || 24;
            await agendaManager.createAgenda(topic, cadence);
            vscode.window.showInformationMessage(`Research agenda created: "${topic}" (every ${cadence}h)`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.listAgendas', () => {
            const agendas = agendaManager.listAgendas();
            if (agendas.length === 0) {
                vscode.window.showInformationMessage('No research agendas. Create one with "Thoth Alpha: Create Research Agenda".');
                return;
            }
            const picks = agendas.map(a => ({
                label: `${a.status === 'active' ? '●' : a.status === 'paused' ? '❚❚' : '○'} ${a.topic}`,
                description: `Every ${a.cadenceHours}h | ${a.runsThisWeek}/${a.maxRunsPerWeek} runs this week`,
                detail: a.lastRunAt ? `Last run: ${new Date(a.lastRunAt).toLocaleString()}` : 'Not yet run',
                id: a.id
            }));
            vscode.window.showQuickPick(picks, { placeHolder: 'Research agendas' });
        })
    );

    // Course commands
    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.createCourse', async () => {
            const topic = await vscode.window.showInputBox({
                prompt: 'Enter a topic for your course',
                placeHolder: 'e.g. "Introduction to Quantum Computing"'
            });
            if (!topic) { return; }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Thoth Alpha: Generating course...', cancellable: true },
                async (progress, progressToken) => {
                    const { ThothAgentEngine } = await import('./ThothAgentEngine');
                    return new Promise<void>((resolve) => {
                        ThothAgentEngine.handleGenerateCourse(topic, undefined, {
                            onChunk: () => {},
                            onDone: async (text) => {
                                try {
                                    const data = JSON.parse(text);
                                    await courseManager.create({
                                        title: data.title || topic,
                                        description: data.description || '',
                                        syllabus: { sections: data.sections || [] },
                                        vocabularyPlan: data.vocabularyPlan,
                                        generationVersion: data.generationVersion || 2
                                    });
                                    vscode.window.showInformationMessage(`Course "${data.title || topic}" created! Use "Thoth Alpha: Present Course" to view it.`);
                                } catch (e: any) {
                                    vscode.window.showErrorMessage(`Failed to create course: ${e.message}`);
                                }
                                resolve();
                            },
                            onError: (text) => {
                                vscode.window.showErrorMessage(`Course generation failed: ${text}`);
                                resolve();
                            },
                            onCancelled: () => { resolve(); },
                            onPhase: (phase, lessonIndex, totalLessons) => {
                                if (phase === 'outline') {
                                    progress.report({ message: 'Planning course structure...' });
                                } else {
                                    progress.report({ message: `Writing lesson ${(lessonIndex || 0) + 1} of ${totalLessons}...` });
                                }
                            },
                            onLessonComplete: () => {}
                        }, progressToken);
                    });
                }
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.listCourses', () => {
            const courses = courseManager.list();
            if (courses.length === 0) {
                vscode.window.showInformationMessage('No courses found. Create one with "Thoth Alpha: Create Course".');
                return;
            }
            const picks = courses.map(c => ({
                label: c.title,
                description: `${c.slideCount} slides`,
                detail: c.description,
                id: c.id
            }));
            vscode.window.showQuickPick(picks, { placeHolder: 'Select a course' });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.presentCourse', async () => {
            const courses = courseManager.list();
            if (courses.length === 0) {
                vscode.window.showInformationMessage('No courses to present. Create one first.');
                return;
            }
            const picks = courses.map(c => ({
                label: c.title,
                description: `${c.slideCount} slides`,
                id: c.id
            }));
            const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Select a course to present' });
            if (pick) {
                coursePresenter.present(pick.id, context.extensionUri);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.clearCache', async () => {
            await clearCache();
            vscode.window.showInformationMessage('Thoth Alpha response cache cleared.');
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

    sidebarProvider.setManagers(dossierManager, deepRunManager, agendaManager, courseManager, coursePresenter);

    context.subscriptions.push(historyManager.onDidChangeHistory(entries => {
        sidebarProvider.updateHistory(entries);
    }));
    context.subscriptions.push(dossierManager.onDidChange(items => {
        sidebarProvider.updateDossiers(items);
    }));
    context.subscriptions.push(deepRunManager.onDidChange(items => {
        sidebarProvider.updateDeepRuns(items);
    }));
    context.subscriptions.push(courseManager.onDidChange(items => {
        sidebarProvider.updateCourses(items);
    }));
    context.subscriptions.push(agendaManager.onDidChange(items => {
        sidebarProvider.updateAgendas(items);
    }));
    context.subscriptions.push(agendaManager.onFeedChange(items => {
        sidebarProvider.updateFeed(items, agendaManager.getUnreadCount());
    }));

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

export function deactivate() {
        // All disposables are tracked via context.subscriptions and disposed automatically by VS Code.
        // Module-level globals (_secrets, _outputChannel) are cleared by garbage collection when the extension host process ends.
}
