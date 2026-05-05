import * as vscode from 'vscode';

interface ThothNotebookData {
    version: number;
    cells: ThothCellData[];
}

interface ThothCellData {
    kind: 'query' | 'markdown';
    source: string;
    outputs?: ThothCellOutput[];
}

interface ThothCellOutput {
    type: 'result';
    data: Record<string, unknown>;
    timestamp?: string;
}

export class ThothNotebookSerializer implements vscode.NotebookSerializer {
    async deserializeNotebook(content: Uint8Array, _token: vscode.CancellationToken): Promise<vscode.NotebookData> {
        const text = new TextDecoder().decode(content);
        let raw: ThothNotebookData;

        try {
            raw = JSON.parse(text);
        } catch {
            raw = { version: 2, cells: [] };
        }

        if (!raw.cells || !Array.isArray(raw.cells)) {
            raw.cells = [];
        }

        const cells = raw.cells.map(cell => {
            const kind = cell.kind === 'markdown'
                ? vscode.NotebookCellKind.Markup
                : vscode.NotebookCellKind.Code;
            const languageId = cell.kind === 'markdown' ? 'markdown' : 'thoth-query';

            const cellData = new vscode.NotebookCellData(kind, cell.source || '', languageId);

            if (cell.outputs && cell.outputs.length > 0) {
                cellData.outputs = cell.outputs.map(out => {
                    const json = JSON.stringify(out.data, null, 2);
                    return new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(json, 'text/x-json'),
                        vscode.NotebookCellOutputItem.text(this._renderResultAsMarkdown(out.data), 'text/markdown')
                    ]);
                });
            }

            return cellData;
        });

        if (cells.length === 0) {
            cells.push(new vscode.NotebookCellData(
                vscode.NotebookCellKind.Code,
                '',
                'thoth-query'
            ));
        }

        return new vscode.NotebookData(cells);
    }

    async serializeNotebook(data: vscode.NotebookData, _token: vscode.CancellationToken): Promise<Uint8Array> {
        const cells: ThothCellData[] = data.cells.map(cell => {
            const kind = cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' as const : 'query' as const;
            const cellData: ThothCellData = {
                kind,
                source: cell.value
            };

            if (cell.outputs && cell.outputs.length > 0) {
                cellData.outputs = cell.outputs.map(output => {
                    const jsonItem = output.items.find(i => i.mime === 'text/x-json');
                    let data: Record<string, unknown> = {};
                    if (jsonItem) {
                        try {
                            data = JSON.parse(new TextDecoder().decode(jsonItem.data));
                        } catch {}
                    }
                    return { type: 'result' as const, data };
                });
            }

            return cellData;
        });

        const notebook: ThothNotebookData = { version: 2, cells };
        return new TextEncoder().encode(JSON.stringify(notebook, null, 2));
    }

    private _renderResultAsMarkdown(data: Record<string, unknown>): string {
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
        if (data.related_queries && Array.isArray(data.related_queries)) {
            parts.push('\n**Related:** ' + (data.related_queries as string[]).map(q => `\`${q}\``).join(', '));
        }

        return parts.join('\n') || 'No results.';
    }
}
