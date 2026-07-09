import * as vscode from 'vscode';
import { BaseManager } from './BaseManager';

export interface DossierSource {
    title: string;
    url?: string;
    publisher?: string;
    snippet?: string;
}

export interface DossierSection {
    heading: string;
    body_md: string;
    citations?: number[];
}

export interface Dossier {
    id: string;
    title: string;
    query: string;
    summary?: string;
    sections: DossierSection[];
    sources: DossierSource[];
    model?: string;
    createdAt: string;
    updatedAt: string;
}

export interface DossierIndex {
    id: string;
    title: string;
    query: string;
    summary?: string;
    createdAt: string;
}

export class DossierManager extends BaseManager<Dossier, DossierIndex> {
    protected readonly indexKey = 'thothAlpha.dossierIndex';
    protected readonly dirName = 'dossiers';

    constructor(context: vscode.ExtensionContext) {
        super(context, 'thothAlpha.dossierIndex', 'dossiers');
    }

    protected toIndex(entity: Dossier): DossierIndex {
        return {
            id: entity.id,
            title: entity.title,
            query: entity.query,
            summary: entity.summary,
            createdAt: entity.createdAt
        };
    }

    async create(data: Omit<Dossier, 'id' | 'createdAt' | 'updatedAt'>): Promise<Dossier> {
        const now = new Date().toISOString();
        const dossier: Dossier = {
            ...data,
            id: this._generateId(),
            createdAt: now,
            updatedAt: now
        };

        await this._save(dossier);

        this._index.unshift(this.toIndex(dossier));
        await this._persist();
        return dossier;
    }

    async update(id: string, patch: Partial<Omit<Dossier, 'id' | 'createdAt'>>): Promise<Dossier | undefined> {
        const dossier = await this.get(id);
        if (!dossier) { return undefined; }

        const updated: Dossier = {
            ...dossier,
            ...patch,
            id: dossier.id,
            createdAt: dossier.createdAt,
            updatedAt: new Date().toISOString()
        };

        await this._save(updated);

        const idx = this._index.findIndex(e => e.id === id);
        if (idx >= 0) {
            this._index[idx] = this.toIndex(updated);
        }
        await this._persist();
        return updated;
    }
}
