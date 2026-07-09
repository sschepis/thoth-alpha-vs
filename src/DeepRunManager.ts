import * as vscode from 'vscode';
import { BaseManager } from './BaseManager';

export interface DeepRunStage {
    kind: 'plan' | 'research' | 'synthesis';
    question?: string;
    text?: string;
    citations?: { title: string; url: string; note?: string }[];
    ms?: number;
}

export interface DeepRun {
    id: string;
    query: string;
    model?: string;
    plan: { sub_questions: string[] };
    stages: DeepRunStage[];
    result?: any;
    status: 'running' | 'completed' | 'failed';
    totalMs?: number;
    error?: string;
    createdAt: string;
}

export interface DeepRunIndex {
    id: string;
    query: string;
    status: string;
    createdAt: string;
}

export class DeepRunManager extends BaseManager<DeepRun, DeepRunIndex> {
    protected readonly indexKey = 'thothAlpha.deepRunIndex';
    protected readonly dirName = 'deep-runs';

    constructor(context: vscode.ExtensionContext) {
        super(context, 'thothAlpha.deepRunIndex', 'deep-runs');
    }

    protected toIndex(entity: DeepRun): DeepRunIndex {
        return {
            id: entity.id,
            query: entity.query,
            status: entity.status,
            createdAt: entity.createdAt
        };
    }

    async create(query: string, model?: string): Promise<DeepRun> {
        const run: DeepRun = {
            id: this._generateId(),
            query,
            model,
            plan: { sub_questions: [] },
            stages: [],
            status: 'running',
            createdAt: new Date().toISOString()
        };

        await this._save(run);

        this._index.unshift(this.toIndex(run));
        await this._persist();
        return run;
    }

    async addStage(id: string, stage: DeepRunStage): Promise<void> {
        const run = await this.get(id);
        if (!run) { return; }
        run.stages.push(stage);
        await this._save(run);
    }

    async setPlan(id: string, subQuestions: string[]): Promise<void> {
        const run = await this.get(id);
        if (!run) { return; }
        run.plan = { sub_questions: subQuestions };
        run.stages.push({ kind: 'plan', text: subQuestions.join('\n') });
        await this._save(run);
    }

    async complete(id: string, result: any, totalMs: number): Promise<void> {
        const run = await this.get(id);
        if (!run) { return; }
        run.status = 'completed';
        run.result = result;
        run.totalMs = totalMs;
        await this._save(run);
        this._updateIndexField(id, { status: 'completed' });
    }

    async fail(id: string, error: string): Promise<void> {
        const run = await this.get(id);
        if (!run) { return; }
        run.status = 'failed';
        run.error = error;
        await this._save(run);
        this._updateIndexField(id, { status: 'failed' });
    }
}
