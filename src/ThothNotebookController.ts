import * as vscode from 'vscode';
import { ThothAgentEngine, ConversationMessage, SearchProgressSink } from './ThothAgentEngine';

class NotebookSearchSink implements SearchProgressSink {
    private _result = '';
    onChunk(_text: string) {}
    onDone(text: string) { this._result = text; }
    onError(text: string) { this._result = JSON.stringify({ error: text }); }
    onCancelled() { this._result = JSON.stringify({ error: 'cancelled' }); }
    getResult() { return this._result; }
}

export class ThothNotebookController implements vscode.Disposable {
    private readonly _controller: vscode.NotebookController;
    private _executionOrder = 0;

    constructor() {
        this._controller = vscode.notebooks.createNotebookController(
            'thoth-alpha-controller',
            'thoth-notebook',
            'Thoth Alpha'
        );
        this._controller.supportedLanguages = ['thoth-query'];
        this._controller.supportsExecutionOrder = true;
        this._controller.executeHandler = this._executeAll.bind(this);
    }

    private async _executeAll(
        cells: vscode.NotebookCell[],
        _notebook: vscode.NotebookDocument,
        controller: vscode.NotebookController
    ): Promise<void> {
        for (const cell of cells) {
            await this._executeCell(cell, controller);
        }
    }

    private async _executeCell(
        cell: vscode.NotebookCell,
        _controller: vscode.NotebookController
    ): Promise<void> {
        const execution = this._controller.createNotebookCellExecution(cell);
        execution.executionOrder = ++this._executionOrder;
        execution.start(Date.now());

        const query = cell.document.getText().trim();
        if (!query) {
            execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text('Enter a query to execute.', 'text/markdown')
                ])
            ]);
            execution.end(true, Date.now());
            return;
        }

        const conversationHistory: ConversationMessage[] = [];
        const notebook = cell.notebook;
        for (let i = 0; i < cell.index; i++) {
            const prevCell = notebook.cellAt(i);
            if (prevCell.kind === vscode.NotebookCellKind.Code) {
                conversationHistory.push({ role: 'user', content: prevCell.document.getText() });
                if (prevCell.outputs.length > 0) {
                    const jsonItem = prevCell.outputs[0].items.find(i => i.mime === 'text/x-json');
                    if (jsonItem) {
                        conversationHistory.push({
                            role: 'assistant',
                            content: new TextDecoder().decode(jsonItem.data)
                        });
                    }
                }
            }
        }

        const sink = new NotebookSearchSink();
        const tokenSource = new vscode.CancellationTokenSource();
        execution.token.onCancellationRequested(() => tokenSource.cancel());

        try {
            await ThothAgentEngine.handleSearch(query, undefined, sink, tokenSource.token, conversationHistory);
            const rawResult = sink.getResult();

            if (!rawResult) {
                execution.replaceOutput([
                    new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text('No response received.', 'text/markdown')
                    ])
                ]);
                execution.end(false, Date.now());
                return;
            }

            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(rawResult);
            } catch {
                execution.replaceOutput([
                    new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(rawResult, 'text/markdown')
                    ])
                ]);
                execution.end(true, Date.now());
                return;
            }

            const markdown = this._renderResult(parsed);
            execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(JSON.stringify(parsed, null, 2), 'text/x-json'),
                    vscode.NotebookCellOutputItem.text(markdown, 'text/markdown')
                ])
            ]);
            execution.end(true, Date.now());
        } catch (err: any) {
            execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.error(err)
                ])
            ]);
            execution.end(false, Date.now());
        }
    }

    private _renderResult(data: Record<string, unknown>): string {
        const parts: string[] = [];

        if (data.interpretation) {
            parts.push(`**${data.interpretation}**\n`);
        }
        if (data.result_summary) {
            parts.push(`> ${data.result_summary}\n`);
        }
        if (data.explanation_md) {
            parts.push(data.explanation_md as string);
        }
        if (data.table_data && typeof data.table_data === 'object') {
            const table = data.table_data as { headers?: string[]; rows?: string[][] };
            if (table.headers && table.rows) {
                parts.push('\n| ' + table.headers.join(' | ') + ' |');
                parts.push('| ' + table.headers.map(() => '---').join(' | ') + ' |');
                for (const row of table.rows) {
                    parts.push('| ' + row.join(' | ') + ' |');
                }
                parts.push('');
            }
        }
        if (data.executable_code && typeof data.executable_code === 'object') {
            const code = data.executable_code as { language?: string; code?: string };
            if (code.language && code.code) {
                parts.push(`\n\`\`\`${code.language}\n${code.code}\n\`\`\`\n`);
            }
        }
        if (data.simulation_js) {
            parts.push('\n*This result includes an interactive simulation. Open in Thoth Panel to view.*\n');
        }
        if (data.related_queries && Array.isArray(data.related_queries)) {
            parts.push('\n**Related:** ' + (data.related_queries as string[]).map(q => `\`${q}\``).join(', '));
        }

        return parts.join('\n') || 'No results.';
    }

    dispose() {
        this._controller.dispose();
    }
}
