import * as vscode from 'vscode';

export interface HistoryEntry {
    id: string;
    query: string;
    timestamp: number;
    isDeepResearch: boolean;
    sessionId: string;
    resultSummary?: string;
}

const STORAGE_KEY = 'thothAlpha.searchHistory';
const MAX_ENTRIES = 100;

export class HistoryManager implements vscode.Disposable {
    private _globalEntries: HistoryEntry[] = [];
    private _workspaceEntries: HistoryEntry[] = [];
    private _sessionId: string;
    private _onDidChangeHistory = new vscode.EventEmitter<HistoryEntry[]>();
    readonly onDidChangeHistory = this._onDidChangeHistory.event;

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._sessionId = Date.now().toString(36);
        this._globalEntries = this._context.globalState.get<HistoryEntry[]>(STORAGE_KEY, []);
        this._workspaceEntries = this._context.workspaceState.get<HistoryEntry[]>(STORAGE_KEY, []);
    }

    addEntry(query: string, isDeepResearch: boolean, resultSummary?: string): void {
        const entry: HistoryEntry = {
            id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
            query,
            timestamp: Date.now(),
            isDeepResearch,
            sessionId: this._sessionId,
            resultSummary
        };

        this._globalEntries.unshift(entry);
        if (this._globalEntries.length > MAX_ENTRIES) {
            this._globalEntries = this._globalEntries.slice(0, MAX_ENTRIES);
        }

        this._workspaceEntries.unshift(entry);
        if (this._workspaceEntries.length > MAX_ENTRIES) {
            this._workspaceEntries = this._workspaceEntries.slice(0, MAX_ENTRIES);
        }

        this._persistGlobal();
        this._persistWorkspace();
        this._onDidChangeHistory.fire(this._workspaceEntries);
    }

    getEntries(): HistoryEntry[] {
        return this._workspaceEntries;
    }

    getGlobalEntries(): HistoryEntry[] {
        return this._globalEntries;
    }

    getWorkspaceEntries(): HistoryEntry[] {
        return this._workspaceEntries;
    }

    getEntryById(id: string): HistoryEntry | undefined {
        return this._workspaceEntries.find(e => e.id === id)
            || this._globalEntries.find(e => e.id === id);
    }

    clearHistory(): void {
        this._globalEntries = [];
        this._workspaceEntries = [];
        this._persistGlobal();
        this._persistWorkspace();
        this._onDidChangeHistory.fire(this._workspaceEntries);
    }

    private _persistGlobal(): void {
        this._context.globalState.update(STORAGE_KEY, this._globalEntries);
    }

    private _persistWorkspace(): void {
        this._context.workspaceState.update(STORAGE_KEY, this._workspaceEntries);
    }

    dispose(): void {
        this._onDidChangeHistory.dispose();
    }
}
