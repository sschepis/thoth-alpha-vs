import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export abstract class BaseManager<TEntity extends { id: string; createdAt: string }, TIndex extends { id: string }> implements vscode.Disposable {
    protected _index: TIndex[] = [];
    protected _onDidChange = new vscode.EventEmitter<TIndex[]>();
    readonly onDidChange = this._onDidChange.event;

    constructor(
        protected readonly _context: vscode.ExtensionContext,
        protected readonly indexKey: string,
        protected readonly dirName: string
    ) {
        this._index = this._context.globalState.get<TIndex[]>(this.indexKey, []);
    }

    protected abstract toIndex(entity: TEntity): TIndex;

    protected _generateId(): string {
        return crypto.randomUUID();
    }

    protected _dataDir(): string | undefined {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!ws) { return undefined; }
        const dir = path.join(ws, '.thothalpha', this.dirName);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    protected async _save(entity: TEntity): Promise<void> {
        const dir = this._dataDir();
        if (!dir) { return; }
        await fs.promises.writeFile(
            path.join(dir, `${entity.id}.json`),
            JSON.stringify(entity, null, 2),
            'utf8'
        );
    }

    async get(id: string): Promise<TEntity | undefined> {
        const dir = this._dataDir();
        if (!dir) { return undefined; }
        try {
            const raw = await fs.promises.readFile(path.join(dir, `${id}.json`), 'utf8');
            return JSON.parse(raw) as TEntity;
        } catch {
            return undefined;
        }
    }

    list(): TIndex[] {
        return this._index;
    }

    async delete(id: string): Promise<boolean> {
        const dir = this._dataDir();
        if (!dir) { return false; }
        try {
            await fs.promises.unlink(path.join(dir, `${id}.json`));
        } catch {
            // already gone
        }
        this._index = this._index.filter(e => e.id !== id);
        await this._persist();
        return true;
    }

    protected async _persist(): Promise<void> {
        await this._context.globalState.update(this.indexKey, this._index);
        this._onDidChange.fire(this._index);
    }

    protected _updateIndexField(id: string, fields: Partial<TIndex>): void {
        const idx = this._index.findIndex(e => e.id === id);
        if (idx >= 0) {
            this._index[idx] = { ...this._index[idx], ...fields };
        }
        this._persist();
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
