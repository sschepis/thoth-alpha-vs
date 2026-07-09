import * as vscode from 'vscode';
import { DossierManager, Dossier } from './DossierManager';
import { ThothAgentEngine, SearchProgressSink } from './ThothAgentEngine';
import { diffDossiers, DossierDiff } from './agendaDiff';

export interface Agenda {
    id: string;
    topic: string;
    cadenceHours: number;
    status: 'active' | 'paused' | 'exhausted';
    lastRunAt?: string;
    nextDueAt: string;
    maxRunsPerWeek: number;
    runsThisWeek: number;
    weekStartedAt: string;
    dossierIds: string[];
    createdAt: string;
}

export interface FeedItem {
    id: string;
    kind: 'rerun' | 'contradiction' | 'suggestion';
    payload: any;
    agendaId?: string;
    dossierId?: string;
    readAt?: string;
    dismissedAt?: string;
    createdAt: string;
}

const AGENDAS_KEY = 'thothAlpha.agendas';
const FEED_KEY = 'thothAlpha.feedItems';
const MAX_FEED_ITEMS = 100;

export class AgendaManager implements vscode.Disposable {
    private _agendas: Agenda[] = [];
    private _feedItems: FeedItem[] = [];
    private _timer?: ReturnType<typeof setInterval>;
    private _onDidChange = new vscode.EventEmitter<Agenda[]>();
    private _onFeedChange = new vscode.EventEmitter<FeedItem[]>();
    readonly onDidChange = this._onDidChange.event;
    readonly onFeedChange = this._onFeedChange.event;

    constructor(
        private readonly _globalState: vscode.Memento,
        private readonly _dossierManager: DossierManager,
        private readonly _outputChannel: vscode.LogOutputChannel
    ) {
        this._agendas = this._globalState.get<Agenda[]>(AGENDAS_KEY, []);
        this._feedItems = this._globalState.get<FeedItem[]>(FEED_KEY, []);
        this._startScheduler();
    }

    private _log(msg: string) { this._outputChannel.info(`[Agenda] ${msg}`); }

    private _generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }

    async createAgenda(topic: string, cadenceHours: number, maxRunsPerWeek: number = 10): Promise<Agenda> {
        const now = new Date();
        const agenda: Agenda = {
            id: this._generateId(),
            topic,
            cadenceHours,
            status: 'active',
            nextDueAt: new Date(now.getTime() + cadenceHours * 3600000).toISOString(),
            maxRunsPerWeek,
            runsThisWeek: 0,
            weekStartedAt: now.toISOString(),
            dossierIds: [],
            createdAt: now.toISOString()
        };

        this._agendas.push(agenda);
        await this._persist();

        this._runAgenda(agenda);

        return agenda;
    }

    listAgendas(): Agenda[] {
        return this._agendas;
    }

    async pauseAgenda(id: string): Promise<void> {
        const agenda = this._agendas.find(a => a.id === id);
        if (agenda) {
            agenda.status = 'paused';
            await this._persist();
        }
    }

    async resumeAgenda(id: string): Promise<void> {
        const agenda = this._agendas.find(a => a.id === id);
        if (agenda && agenda.status === 'paused') {
            agenda.status = 'active';
            const now = new Date();
            agenda.nextDueAt = new Date(now.getTime() + agenda.cadenceHours * 3600000).toISOString();
            await this._persist();
        }
    }

    async deleteAgenda(id: string): Promise<void> {
        this._agendas = this._agendas.filter(a => a.id !== id);
        await this._persist();
    }

    getFeedItems(unreadOnly: boolean = false): FeedItem[] {
        if (unreadOnly) {
            return this._feedItems.filter(f => !f.readAt && !f.dismissedAt);
        }
        return this._feedItems;
    }

    getUnreadCount(): number {
        return this._feedItems.filter(f => !f.readAt && !f.dismissedAt).length;
    }

    async markFeedRead(id: string): Promise<void> {
        const item = this._feedItems.find(f => f.id === id);
        if (item) {
            item.readAt = new Date().toISOString();
            await this._persistFeed();
        }
    }

    async dismissFeed(id: string): Promise<void> {
        const item = this._feedItems.find(f => f.id === id);
        if (item) {
            item.dismissedAt = new Date().toISOString();
            await this._persistFeed();
        }
    }

    async markAllRead(): Promise<void> {
        const now = new Date().toISOString();
        for (const item of this._feedItems) {
            if (!item.readAt) { item.readAt = now; }
        }
        await this._persistFeed();
    }

    private _startScheduler() {
        this._timer = setInterval(() => this._checkDueAgendas(), 60000);
        setTimeout(() => this._checkDueAgendas(), 5000);
    }

    private async _checkDueAgendas() {
        const now = new Date();
        for (const agenda of this._agendas) {
            if (agenda.status !== 'active') { continue; }

            const weekAge = now.getTime() - new Date(agenda.weekStartedAt).getTime();
            if (weekAge > 7 * 24 * 3600000) {
                agenda.runsThisWeek = 0;
                agenda.weekStartedAt = now.toISOString();
            }

            if (agenda.runsThisWeek >= agenda.maxRunsPerWeek) {
                agenda.status = 'exhausted';
                await this._persist();
                continue;
            }

            if (new Date(agenda.nextDueAt) <= now) {
                this._runAgenda(agenda);
            }
        }
    }

    private async _runAgenda(agenda: Agenda) {
        this._log(`Running agenda "${agenda.topic}"`);

        const sink: SearchProgressSink = {
            onChunk: () => {},
            onDone: async (text) => {
                try {
                    const data = JSON.parse(text);
                    const dossier = await this._dossierManager.create({
                        title: data.title || agenda.topic,
                        query: agenda.topic,
                        summary: data.summary,
                        sections: data.sections || [],
                        sources: data.sources || [],
                        model: 'agenda-auto'
                    });

                    agenda.dossierIds.push(dossier.id);
                    agenda.lastRunAt = new Date().toISOString();
                    agenda.nextDueAt = new Date(Date.now() + agenda.cadenceHours * 3600000).toISOString();
                    agenda.runsThisWeek++;
                    await this._persist();

                    await this._addFeedItem('rerun', {
                        summary: `Research on "${agenda.topic}" has been updated.`,
                        dossierTitle: dossier.title
                    }, agenda.id, dossier.id);

                    if (agenda.dossierIds.length >= 2) {
                        const prevId = agenda.dossierIds[agenda.dossierIds.length - 2];
                        const prev = await this._dossierManager.get(prevId);
                        if (prev) {
                            await this._detectChanges(agenda, prev, dossier);
                        }
                    }

                    this._log(`Agenda "${agenda.topic}" run completed, dossier ${dossier.id}`);
                } catch (e: any) {
                    this._log(`Agenda "${agenda.topic}" run failed: ${e.message}`);
                }
            },
            onError: (text) => {
                this._log(`Agenda "${agenda.topic}" run error: ${text}`);
            },
            onCancelled: () => {}
        };

        await ThothAgentEngine.handleDossierGeneration(agenda.topic, undefined, sink);
    }

    private async _detectChanges(agenda: Agenda, prev: Dossier, current: Dossier) {
        const diff = diffDossiers(prev.sections, current.sections, prev.sources, current.sources);

        if (diff.contradictions.length > 0) {
            await this._addFeedItem('contradiction', {
                summary: `${diff.contradictions.length} potential contradiction(s) detected in "${agenda.topic}".`,
                contradictions: diff.contradictions,
                addedClaims: diff.addedClaims.slice(0, 5),
                removedClaims: diff.removedClaims.slice(0, 5)
            }, agenda.id, current.id);
        }

        if (diff.addedSources.length > 3) {
            await this._addFeedItem('suggestion', {
                summary: `${diff.addedSources.length} new sources found for "${agenda.topic}".`,
                newSources: diff.addedSources.slice(0, 5)
            }, agenda.id, current.id);
        }
    }

    private async _addFeedItem(kind: FeedItem['kind'], payload: any, agendaId?: string, dossierId?: string) {
        const item: FeedItem = {
            id: this._generateId(),
            kind,
            payload,
            agendaId,
            dossierId,
            createdAt: new Date().toISOString()
        };

        this._feedItems.unshift(item);
        if (this._feedItems.length > MAX_FEED_ITEMS) {
            this._feedItems = this._feedItems.slice(0, MAX_FEED_ITEMS);
        }
        await this._persistFeed();

        const icon = kind === 'contradiction' ? '⚠️' : kind === 'suggestion' ? '💡' : '🔄';
        vscode.window.showInformationMessage(`${icon} Thoth Alpha: ${payload.summary}`);
    }

    private async _persist(): Promise<void> {
        await this._globalState.update(AGENDAS_KEY, this._agendas);
        this._onDidChange.fire(this._agendas);
    }

    private async _persistFeed(): Promise<void> {
        await this._globalState.update(FEED_KEY, this._feedItems);
        this._onFeedChange.fire(this._feedItems);
    }

    dispose(): void {
        if (this._timer) {
            clearInterval(this._timer);
        }
        this._onDidChange.dispose();
        this._onFeedChange.dispose();
    }
}
