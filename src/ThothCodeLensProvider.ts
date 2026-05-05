import * as vscode from 'vscode';

export class ThothCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    dispose() { this._onDidChangeCodeLenses.dispose(); }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const enabled = vscode.workspace.getConfiguration('thothAlpha').get<boolean>('enableCodeLens', true);
        if (!enabled) { return []; }

        const lenses: vscode.CodeLens[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (this._isFunctionOrClassLine(line, document.languageId)) {
                const range = new vscode.Range(i, 0, i, line.length);
                lenses.push(new vscode.CodeLens(range, {
                    title: '$(beaker) Analyze with Thoth',
                    command: 'thothAlpha.analyzeSelection',
                    arguments: [document, range]
                }));
            }
        }
        return lenses;
    }

    private _isFunctionOrClassLine(line: string, languageId: string): boolean {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
            return false;
        }

        switch (languageId) {
            case 'python':
                return /^(async\s+)?def\s+\w+/.test(trimmed) || /^class\s+\w+/.test(trimmed);
            case 'javascript':
            case 'typescript':
            case 'javascriptreact':
            case 'typescriptreact':
                return /^(export\s+)?(async\s+)?function\s+\w+/.test(trimmed)
                    || /^(export\s+)?(default\s+)?class\s+\w+/.test(trimmed)
                    || /^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/.test(trimmed)
                    || /^(export\s+)?const\s+\w+\s*=\s*(async\s+)?function/.test(trimmed);
            case 'r':
                return /^\w+\s*<-\s*function\s*\(/.test(trimmed);
            case 'julia':
                return /^function\s+\w+/.test(trimmed);
            case 'rust':
                return /^(pub\s+)?(async\s+)?fn\s+\w+/.test(trimmed) || /^(pub\s+)?struct\s+\w+/.test(trimmed);
            case 'go':
                return /^func\s+/.test(trimmed) || /^type\s+\w+\s+struct/.test(trimmed);
            case 'java':
            case 'kotlin':
            case 'csharp':
                return /^(public|private|protected|static|final|abstract|override|suspend)?\s*(public|private|protected|static|final|abstract|override|suspend)?\s*(class|fun|void|int|String|boolean|async|Task)\s+\w+/.test(trimmed);
            default:
                return /^(export\s+)?(async\s+)?function\s+\w+/.test(trimmed)
                    || /^(export\s+)?class\s+\w+/.test(trimmed);
        }
    }
}
