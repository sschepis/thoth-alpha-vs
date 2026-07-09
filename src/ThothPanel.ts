import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ThothAgentEngine, ConversationMessage, WebviewSearchSink, WebviewDeepResearchSink, WebviewExecutionSink, CourseGenerationSink } from './ThothAgentEngine';
import { HistoryManager } from './HistoryManager';
import { DossierManager } from './DossierManager';
import { DeepRunManager } from './DeepRunManager';
import { handleNarrate, getSettings as getNarrationSettings, saveSettings as saveNarrationSettings, VOICES } from './NarrationEngine';
import { AgendaManager } from './AgendaManager';
import { CourseManager } from './CourseManager';
import { setWebviewSecurity, isSensitiveFile } from './webviewSecurity';
import { buildWebviewBridgeScript, buildCallAgentScript } from './webviewBridge';

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

    private static _dossierManager?: DossierManager;
    private static _deepRunManager?: DeepRunManager;
    private static _agendaManager?: AgendaManager;
    private static _courseManager?: CourseManager;

    private static _onSearchStateChanged = new vscode.EventEmitter<boolean>();
    public static readonly onSearchStateChanged = ThothPanel._onSearchStateChanged.event;

    public static setManagers(dossierManager: DossierManager, deepRunManager: DeepRunManager, agendaManager?: AgendaManager, courseManager?: CourseManager) {
        ThothPanel._dossierManager = dossierManager;
        ThothPanel._deepRunManager = deepRunManager;
        ThothPanel._agendaManager = agendaManager;
        ThothPanel._courseManager = courseManager;
    }

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
                localResourceRoots: [vscode.Uri.joinPath(extensionUri)],
                enableCommandUris: false,
                enableFindWidget: false
            }
        );
        setWebviewSecurity(panel.webview);

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
                    case 'webview_ready': {
                        const models = await vscode.lm.selectChatModels();
                        const modelInfo = models.map(m => ({ id: m.id, name: m.name, family: m.family }));
                        const lastModelId = this._globalState?.get?.('thothAlpha.lastModelId', '') || '';
                        this._panel.webview.postMessage({ command: 'set_models', models: modelInfo, lastModelId });

                        const recentItems: { type: string; title: string; id: string; createdAt: string }[] = [];
                        for (const d of (ThothPanel._dossierManager?.list() || [])) {
                            recentItems.push({ type: 'dossier', title: d.title, id: d.id, createdAt: d.createdAt });
                        }
                        for (const r of (ThothPanel._deepRunManager?.list() || [])) {
                            recentItems.push({ type: 'deep_run', title: r.query, id: r.id, createdAt: r.createdAt });
                        }
                        for (const c of (ThothPanel._courseManager?.list() || [])) {
                            recentItems.push({ type: 'course', title: c.title, id: c.id, createdAt: c.createdAt });
                        }
                        recentItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
                        this._panel.webview.postMessage({ command: 'set_recent_activity', items: recentItems.slice(0, 5) });
                        return;
                    }
                    case 'search': {
                        if (this._currentSearchTokenSource) {
                            this._currentSearchTokenSource.cancel();
                            this._currentSearchTokenSource.dispose();
                        }
                        this._currentSearchTokenSource = new vscode.CancellationTokenSource();
                        const rawQuery = message.query;
                        this._setSearching(true);

                        try {
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
                                        message.skipCache,
                                        message.paperId
                                    );
                                }
                            );

                            if (responseText) {
                                this._conversationHistory.push({ role: 'user', content: rawQuery });
                                this._conversationHistory.push({ role: 'assistant', content: responseText });
                            }
                        } catch (err: any) {
                            searchSink.onError(err.message || 'Search failed');
                        } finally {
                            this._setSearching(false);
                            this._currentSearchTokenSource?.dispose();
                            this._currentSearchTokenSource = undefined;
                        }
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
                                    const relPath = vscode.workspace.asRelativePath(file);
                                    if (isSensitiveFile(relPath)) { continue; }
                                    const content = await fs.promises.readFile(file.fsPath, 'utf8');
                                    wsContext += `File: ${relPath}\n\`\`\`\n${content.substring(0, 1500)}${content.length > 1500 ? '...' : ''}\n\`\`\`\n\n`;
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
                            this._currentSearchTokenSource.dispose();
                        }
                        this._currentSearchTokenSource = new vscode.CancellationTokenSource();
                        this._setSearching(true);

                        try {
                            const drResult = await vscode.window.withProgress(
                                { location: vscode.ProgressLocation.Notification, title: 'Thoth Alpha: Deep Research...', cancellable: true },
                                async (_progress, progressToken) => {
                                    progressToken.onCancellationRequested(() => {
                                        this._currentSearchTokenSource?.cancel();
                                    });
                                    return ThothAgentEngine.handleDeepResearch(
                                        message.query, deepResearchSink,
                                        this._conversationHistory,
                                        this._lastDeepResearchInteractionId,
                                        this._currentSearchTokenSource?.token
                                    );
                                }
                            );

                            if (drResult) {
                                this._lastDeepResearchInteractionId = drResult.interactionId;
                                this._conversationHistory.push({ role: 'user', content: `[Deep Research] ${message.query}` });
                                this._conversationHistory.push({ role: 'assistant', content: drResult.responseText });
                            }
                        } catch (err: any) {
                            deepResearchSink.onError(err.message || 'Deep research failed');
                        } finally {
                            this._setSearching(false);
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
                            message.resultSummary
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
                        try {
                            await ThothAgentEngine.handleFixSimulation(
                                message.originalQuery,
                                message.brokenCode,
                                message.errorMessage,
                                message.modelId,
                                fixSink,
                                this._currentSearchTokenSource?.token
                            );
                        } catch (err: any) {
                            fixSink.onError(err.message || 'Fix simulation failed');
                        }
                        return;
                    }
                    case 'generate_simulation': {
                        const genSink: import('./ThothAgentEngine').SearchProgressSink = {
                            onChunk: () => {},
                            onDone: (text) => this._panel.webview.postMessage({ command: 'generate_simulation_done', text }),
                            onError: (text) => this._panel.webview.postMessage({ command: 'generate_simulation_error', text }),
                            onCancelled: () => this._panel.webview.postMessage({ command: 'generate_simulation_error', text: 'Cancelled' })
                        };
                        try {
                            await ThothAgentEngine.handleGenerateSimulation(
                                message.query,
                                message.summary,
                                message.explanation,
                                message.modelId,
                                genSink,
                                this._currentSearchTokenSource?.token
                            );
                        } catch (err: any) {
                            genSink.onError(err.message || 'Generate simulation failed');
                        }
                        return;
                    }
                    case 'enhance_result': {
                        const enhanceSink: import('./ThothAgentEngine').SearchProgressSink = {
                            onChunk: () => {},
                            onDone: (text) => this._panel.webview.postMessage({ command: 'enhance_done', text }),
                            onError: (text) => this._panel.webview.postMessage({ command: 'enhance_error', text }),
                            onCancelled: () => this._panel.webview.postMessage({ command: 'enhance_error', text: 'Cancelled' })
                        };
                        try {
                            await ThothAgentEngine.handleEnhance(
                                message.query,
                                message.currentResult,
                                message.weakDimensions,
                                message.modelId,
                                enhanceSink,
                                this._currentSearchTokenSource?.token
                            );
                        } catch (err: any) {
                            enhanceSink.onError(err.message || 'Enhance failed');
                        }
                        return;
                    }
                    case 'repair_animation': {
                        const animRepairSink: import('./ThothAgentEngine').SearchProgressSink = {
                            onChunk: () => {},
                            onDone: (text) => this._panel.webview.postMessage({ command: 'repair_animation_done', text }),
                            onError: (text) => this._panel.webview.postMessage({ command: 'repair_animation_error', text }),
                            onCancelled: () => this._panel.webview.postMessage({ command: 'repair_animation_error', text: 'Cancelled' })
                        };
                        try {
                            await ThothAgentEngine.handleRepairAnimation(
                                message.originalQuery,
                                message.brokenCode,
                                message.errorMessage,
                                message.modelId,
                                animRepairSink,
                                this._currentSearchTokenSource?.token
                            );
                        } catch (err: any) {
                            animRepairSink.onError(err.message || 'Repair animation failed');
                        }
                        return;
                    }
                    case 'regenerate_simulation': {
                        if (this._currentSearchTokenSource) {
                            this._currentSearchTokenSource.cancel();
                            this._currentSearchTokenSource.dispose();
                        }
                        this._currentSearchTokenSource = new vscode.CancellationTokenSource();
                        const regenQuery = message.query + '\n\n[IMPORTANT: Generate a COMPLETELY NEW and DIFFERENT simulation_js for this query. Do not reuse any previous approach.]';
                        const regenSink: import('./ThothAgentEngine').SearchProgressSink = {
                            onChunk: () => {},
                            onDone: (text) => this._panel.webview.postMessage({ command: 'regenerate_simulation_done', text }),
                            onError: (text) => this._panel.webview.postMessage({ command: 'regenerate_simulation_error', text }),
                            onCancelled: () => this._panel.webview.postMessage({ command: 'regenerate_simulation_error', text: 'Cancelled' })
                        };
                        try {
                            await ThothAgentEngine.handleSearch(
                                regenQuery, message.modelId, regenSink,
                                this._currentSearchTokenSource.token,
                                this._conversationHistory
                            );
                        } catch (err: any) {
                            regenSink.onError(err.message || 'Regenerate simulation failed');
                        } finally {
                            this._currentSearchTokenSource?.dispose();
                            this._currentSearchTokenSource = undefined;
                        }
                        return;
                    }
                    case 'create_dossier': {
                        if (!ThothPanel._dossierManager) {
                            this._panel.webview.postMessage({ command: 'dossier_error', text: 'Dossier manager not initialized.' });
                            return;
                        }
                        this._setSearching(true);
                        const dossierSink: import('./ThothAgentEngine').SearchProgressSink = {
                            onChunk: (text) => this._panel.webview.postMessage({ command: 'dossier_chunk', text }),
                            onDone: async (text) => {
                                try {
                                    const data = JSON.parse(text);
                                    const dossier = await ThothPanel._dossierManager!.create({
                                        title: data.title || message.query,
                                        query: message.query,
                                        summary: data.summary,
                                        sections: data.sections || [],
                                        sources: data.sources || [],
                                        model: message.modelId
                                    });
                                    this._panel.webview.postMessage({ command: 'dossier_created', dossier });
                                } catch (e: any) {
                                    this._panel.webview.postMessage({ command: 'dossier_error', text: e.message });
                                }
                                this._setSearching(false);
                            },
                            onError: (text) => {
                                this._panel.webview.postMessage({ command: 'dossier_error', text });
                                this._setSearching(false);
                            },
                            onCancelled: () => {
                                this._panel.webview.postMessage({ command: 'dossier_error', text: 'Cancelled' });
                                this._setSearching(false);
                            }
                        };
                        try {
                            await ThothAgentEngine.handleDossierGeneration(
                                message.query, message.modelId, dossierSink, this._currentSearchTokenSource?.token
                            );
                        } catch (err: any) {
                            dossierSink.onError(err.message || 'Dossier generation failed');
                        }
                        return;
                    }
                    case 'list_dossiers': {
                        const items = ThothPanel._dossierManager?.list() || [];
                        this._panel.webview.postMessage({ command: 'dossier_list', items });
                        return;
                    }
                    case 'load_dossier': {
                        const dossier = await ThothPanel._dossierManager?.get(message.id);
                        if (dossier) {
                            this._panel.webview.postMessage({ command: 'dossier_loaded', dossier });
                        } else {
                            this._panel.webview.postMessage({ command: 'dossier_error', text: 'Dossier not found.' });
                        }
                        return;
                    }
                    case 'delete_dossier': {
                        await ThothPanel._dossierManager?.delete(message.id);
                        const items = ThothPanel._dossierManager?.list() || [];
                        this._panel.webview.postMessage({ command: 'dossier_list', items });
                        return;
                    }
                    case 'start_deep_run': {
                        if (!ThothPanel._deepRunManager) {
                            this._panel.webview.postMessage({ command: 'deep_run_error', text: 'Deep run manager not initialized.' });
                            return;
                        }
                        this._setSearching(true);
                        const run = await ThothPanel._deepRunManager.create(message.query, message.modelId);
                        this._panel.webview.postMessage({ command: 'deep_run_started', id: run.id });

                        if (this._currentSearchTokenSource) {
                            this._currentSearchTokenSource.cancel();
                            this._currentSearchTokenSource.dispose();
                        }
                        this._currentSearchTokenSource = new vscode.CancellationTokenSource();

                        const deepRunErrorSink = {
                            onError: (text: string) => {
                                this._panel.webview.postMessage({ command: 'deep_run_error', id: run.id, text });
                                this._setSearching(false);
                                this._currentSearchTokenSource?.dispose();
                                this._currentSearchTokenSource = undefined;
                            }
                        };

                        try {
                            await ThothAgentEngine.handleDeepRun(
                                message.query,
                                message.modelId,
                                async (subQuestions) => {
                                    await ThothPanel._deepRunManager!.setPlan(run.id, subQuestions);
                                    this._panel.webview.postMessage({ command: 'deep_run_plan', id: run.id, subQuestions });
                                },
                                async (stage) => {
                                    await ThothPanel._deepRunManager!.addStage(run.id, stage as any);
                                    this._panel.webview.postMessage({ command: 'deep_run_stage', id: run.id, stage });
                                },
                                async (resultText) => {
                                    try {
                                        const result = JSON.parse(resultText);
                                        await ThothPanel._deepRunManager!.complete(run.id, result, Date.now() - Date.parse(run.createdAt));
                                        this._panel.webview.postMessage({ command: 'deep_run_done', id: run.id, result });
                                    } catch {
                                        await ThothPanel._deepRunManager!.complete(run.id, resultText, Date.now() - Date.parse(run.createdAt));
                                        this._panel.webview.postMessage({ command: 'deep_run_done', id: run.id, result: resultText });
                                    }
                                    this._setSearching(false);
                                    this._currentSearchTokenSource?.dispose();
                                    this._currentSearchTokenSource = undefined;
                                },
                                async (errorMsg) => {
                                    await ThothPanel._deepRunManager!.fail(run.id, errorMsg);
                                    this._panel.webview.postMessage({ command: 'deep_run_error', id: run.id, text: errorMsg });
                                    this._setSearching(false);
                                    this._currentSearchTokenSource?.dispose();
                                    this._currentSearchTokenSource = undefined;
                                },
                                this._currentSearchTokenSource.token
                            );
                        } catch (err: any) {
                            deepRunErrorSink.onError(err.message || 'Deep run failed');
                        }
                        return;
                    }
                    case 'list_deep_runs': {
                        const runs = ThothPanel._deepRunManager?.list() || [];
                        this._panel.webview.postMessage({ command: 'deep_run_list', items: runs });
                        return;
                    }
                    case 'load_deep_run': {
                        const deepRun = await ThothPanel._deepRunManager?.get(message.id);
                        if (deepRun) {
                            this._panel.webview.postMessage({ command: 'deep_run_loaded', run: deepRun });
                        } else {
                            this._panel.webview.postMessage({ command: 'deep_run_error', text: 'Deep run not found.' });
                        }
                        return;
                    }
                    case 'delete_deep_run': {
                        await ThothPanel._deepRunManager?.delete(message.id);
                        const runs = ThothPanel._deepRunManager?.list() || [];
                        this._panel.webview.postMessage({ command: 'deep_run_list', items: runs });
                        return;
                    }
                    case 'search_anthropic': {
                        if (this._currentSearchTokenSource) {
                            this._currentSearchTokenSource.cancel();
                            this._currentSearchTokenSource.dispose();
                        }
                        this._currentSearchTokenSource = new vscode.CancellationTokenSource();
                        const rawQuery = message.query;
                        this._setSearching(true);
                        const anthropicSink = new WebviewSearchSink(this._panel.webview);

                        try {
                            const responseText = await ThothAgentEngine.handleSearchAnthropic(
                                message.query, message.modelId, anthropicSink,
                                this._currentSearchTokenSource.token,
                                this._conversationHistory
                            );

                            if (responseText) {
                                this._conversationHistory.push({ role: 'user', content: rawQuery });
                                this._conversationHistory.push({ role: 'assistant', content: responseText });
                            }
                        } catch (err: any) {
                            anthropicSink.onError(err.message || 'Anthropic search failed');
                        } finally {
                            this._setSearching(false);
                            this._currentSearchTokenSource?.dispose();
                            this._currentSearchTokenSource = undefined;
                        }
                        return;
                    }
                    case 'get_providers': {
                        const providers = [
                            { id: 'vscode', name: 'VS Code Models', requiresKey: false },
                            { id: 'gemini', name: 'Google Gemini', requiresKey: true, keyCommand: 'thothAlpha.setGeminiApiKey' },
                            { id: 'anthropic', name: 'Anthropic Claude', requiresKey: true, keyCommand: 'thothAlpha.setAnthropicApiKey' }
                        ];
                        this._panel.webview.postMessage({ command: 'providers_list', providers });
                        return;
                    }
                    case 'set_preferred_provider': {
                        if (this._globalState?.update) {
                            this._globalState.update('thothAlpha.preferredProvider', message.provider);
                        }
                        return;
                    }
                    case 'narrate_request': {
                        const audioResult = await handleNarrate(message.text, message.settings);
                        if (audioResult) {
                            this._panel.webview.postMessage({
                                command: 'narrate_audio_ready',
                                audioBase64: audioResult.audioBase64,
                                requestId: message.requestId
                            });
                        } else {
                            this._panel.webview.postMessage({
                                command: 'narrate_error',
                                text: 'Narration failed. Check your ElevenLabs API key.',
                                requestId: message.requestId
                            });
                        }
                        return;
                    }
                    case 'get_narration_settings': {
                        const settings = getNarrationSettings();
                        this._panel.webview.postMessage({ command: 'narration_settings', settings, voices: VOICES });
                        return;
                    }
                    case 'save_narration_settings': {
                        const updated = await saveNarrationSettings(message.settings);
                        this._panel.webview.postMessage({ command: 'narration_settings', settings: updated, voices: VOICES });
                        return;
                    }
                    case 'create_agenda': {
                        if (!ThothPanel._agendaManager) {
                            this._panel.webview.postMessage({ command: 'agenda_error', text: 'Agenda manager not initialized.' });
                            return;
                        }
                        const agenda = await ThothPanel._agendaManager.createAgenda(
                            message.topic,
                            message.cadenceHours || 24,
                            message.maxRunsPerWeek || 10
                        );
                        this._panel.webview.postMessage({ command: 'agenda_created', agenda });
                        return;
                    }
                    case 'list_agendas': {
                        const agendas = ThothPanel._agendaManager?.listAgendas() || [];
                        this._panel.webview.postMessage({ command: 'agenda_list', items: agendas });
                        return;
                    }
                    case 'pause_agenda': {
                        await ThothPanel._agendaManager?.pauseAgenda(message.id);
                        const agendas = ThothPanel._agendaManager?.listAgendas() || [];
                        this._panel.webview.postMessage({ command: 'agenda_list', items: agendas });
                        return;
                    }
                    case 'resume_agenda': {
                        await ThothPanel._agendaManager?.resumeAgenda(message.id);
                        const agendas = ThothPanel._agendaManager?.listAgendas() || [];
                        this._panel.webview.postMessage({ command: 'agenda_list', items: agendas });
                        return;
                    }
                    case 'delete_agenda': {
                        await ThothPanel._agendaManager?.deleteAgenda(message.id);
                        const agendas = ThothPanel._agendaManager?.listAgendas() || [];
                        this._panel.webview.postMessage({ command: 'agenda_list', items: agendas });
                        return;
                    }
                    case 'get_feed': {
                        const items = ThothPanel._agendaManager?.getFeedItems(message.unreadOnly) || [];
                        const unreadCount = ThothPanel._agendaManager?.getUnreadCount() || 0;
                        this._panel.webview.postMessage({ command: 'feed_items', items, unreadCount });
                        return;
                    }
                    case 'mark_feed_read': {
                        await ThothPanel._agendaManager?.markFeedRead(message.id);
                        return;
                    }
                    case 'dismiss_feed': {
                        await ThothPanel._agendaManager?.dismissFeed(message.id);
                        return;
                    }
                    case 'mark_all_feed_read': {
                        await ThothPanel._agendaManager?.markAllRead();
                        return;
                    }
                    case 'create_course': {
                        if (!ThothPanel._courseManager) {
                            this._panel.webview.postMessage({ command: 'course_error', text: 'Course manager not initialized.' });
                            return;
                        }
                        this._setSearching(true);
                        const courseSink: CourseGenerationSink = {
                            onChunk: (text) => {
                                this._panel.webview.postMessage({ command: 'course_progress', text });
                            },
                            onDone: async (text) => {
                                try {
                                    const data = JSON.parse(text);
                                    const course = await ThothPanel._courseManager!.create({
                                        title: data.title || message.topic,
                                        description: data.description || '',
                                        syllabus: { sections: data.sections || [] },
                                        backingDossierId: message.dossierId,
                                        vocabularyPlan: data.vocabularyPlan,
                                        generationVersion: data.generationVersion || 2
                                    });
                                    this._panel.webview.postMessage({ command: 'course_created', course });
                                } catch (e: any) {
                                    this._panel.webview.postMessage({ command: 'course_error', text: e.message });
                                }
                                this._setSearching(false);
                            },
                            onError: (text) => {
                                this._panel.webview.postMessage({ command: 'course_error', text });
                                this._setSearching(false);
                            },
                            onCancelled: () => {
                                this._panel.webview.postMessage({ command: 'course_error', text: 'Cancelled' });
                                this._setSearching(false);
                            },
                            onPhase: (phase, lessonIndex, totalLessons) => {
                                const msg = phase === 'outline'
                                    ? 'Planning course structure...'
                                    : `Writing lesson content (${(lessonIndex || 0) + 1} of ${totalLessons})...`;
                                this._panel.webview.postMessage({ command: 'course_progress', text: msg });
                            },
                            onLessonComplete: (lessonIndex, totalLessons, lessonTitle) => {
                                this._panel.webview.postMessage({
                                    command: 'course_progress',
                                    text: `Completed "${lessonTitle}" (${lessonIndex + 1}/${totalLessons})`
                                });
                            }
                        };

                        let dossierContext: string | undefined;
                        if (message.dossierId && ThothPanel._dossierManager) {
                            const dossier = await ThothPanel._dossierManager.get(message.dossierId);
                            if (dossier) {
                                dossierContext = dossier.sections.map(s => `## ${s.heading}\n${s.body_md}`).join('\n\n');
                            }
                        }

                        try {
                            await ThothAgentEngine.handleGenerateCourse(
                                message.topic, message.modelId, courseSink,
                                this._currentSearchTokenSource?.token,
                                dossierContext
                            );
                        } catch (err: any) {
                            courseSink.onError(err.message || 'Course generation failed');
                        }
                        return;
                    }
                    case 'list_courses': {
                        const courses = ThothPanel._courseManager?.list() || [];
                        this._panel.webview.postMessage({ command: 'course_list', items: courses });
                        return;
                    }
                    case 'load_course': {
                        const course = await ThothPanel._courseManager?.get(message.id);
                        if (course) {
                            this._panel.webview.postMessage({ command: 'course_loaded', course });
                        } else {
                            this._panel.webview.postMessage({ command: 'course_error', text: 'Course not found.' });
                        }
                        return;
                    }
                    case 'delete_course': {
                        await ThothPanel._courseManager?.delete(message.id);
                        const courses = ThothPanel._courseManager?.list() || [];
                        this._panel.webview.postMessage({ command: 'course_list', items: courses });
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

    public postMessage(message: any) {
        this._panel.webview.postMessage(message);
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
    }

    private async _getHtmlForWebview(webview: vscode.Webview) {
        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'index.html');
        let html = '';
        try {
            html = await fs.promises.readFile(htmlPath.fsPath, 'utf8');
        } catch (e) {
            const safeErr = String(e).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<!DOCTYPE html><html><body>Error loading UI: ${safeErr}</body></html>`;
        }

        html = html.replace(/(src|href)="\/([^"]+)"/g, (match, p1, p2) => {
            if (p2.startsWith('http')) return match;
            const uri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, p2));
            return `${p1}="${uri}"`;
        });

        const scriptInjection = `<script>${buildWebviewBridgeScript({ supportPaperId: true })}</script>`;
        html = html.replace('</head>', `${scriptInjection}</head>`);

        const newCallAgent = buildCallAgentScript({ supportPaperId: true });
        html = html.replace(/async function callAgent\([\s\S]*?(?=async function executeLoop)/, newCallAgent);

        return html;
    }
}
