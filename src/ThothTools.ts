import * as vscode from 'vscode';
import * as fs from 'fs';
import { ThothAgentEngine, SearchProgressSink, ExecutionSink } from './ThothAgentEngine';

class CollectorSearchSink implements SearchProgressSink {
    private _result = '';
    onChunk(_text: string) {}
    onDone(text: string) { this._result = text; }
    onError(text: string) { this._result = JSON.stringify({ error: text }); }
    onCancelled() { this._result = JSON.stringify({ error: 'cancelled' }); }
    getResult() { return this._result; }
}

class CollectorExecutionSink implements ExecutionSink {
    private _result = { stdout: '', stderr: '', error: '' };
    onStarted(_language: string) {}
    onResult(stdout?: string, stderr?: string, error?: string) {
        this._result = { stdout: stdout || '', stderr: stderr || '', error: error || '' };
    }
    getResult() { return this._result; }
}

interface ComputeInput { query: string }
interface ExecuteCodeInput { language: string; code: string }
interface SearchWorkspaceInput { pattern?: string; maxFiles?: number }

class ThothComputeTool implements vscode.LanguageModelTool<ComputeInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ComputeInput>, token: vscode.CancellationToken) {
        const sink = new CollectorSearchSink();
        await ThothAgentEngine.handleSearch(options.input.query, undefined, sink, token);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(sink.getResult())
        ]);
    }
}

class ThothExecuteCodeTool implements vscode.LanguageModelTool<ExecuteCodeInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ExecuteCodeInput>, _token: vscode.CancellationToken) {
        const sink = new CollectorExecutionSink();
        await new Promise<void>(resolve => {
            const originalOnResult = sink.onResult.bind(sink);
            sink.onResult = (stdout, stderr, error) => {
                originalOnResult(stdout, stderr, error);
                resolve();
            };
            ThothAgentEngine.executeLocalCode(options.input.language, options.input.code, sink);
        });
        const result = sink.getResult();
        const text = result.error
            ? `Error: ${result.error}`
            : `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text)
        ]);
    }
}

class ThothSearchWorkspaceTool implements vscode.LanguageModelTool<SearchWorkspaceInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<SearchWorkspaceInput>, _token: vscode.CancellationToken) {
        const pattern = options.input.pattern || '**/*.{csv,json,md,txt,log}';
        const maxFiles = options.input.maxFiles || 5;

        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxFiles);
        const results: string[] = [];

        for (const file of files) {
            const content = await fs.promises.readFile(file.fsPath, 'utf8');
            const preview = content.substring(0, 2000);
            results.push(`File: ${vscode.workspace.asRelativePath(file)}\n${preview}${content.length > 2000 ? '\n...(truncated)' : ''}`);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(results.join('\n\n---\n\n') || 'No matching files found.')
        ]);
    }
}

export function registerTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('thoth-alpha_compute', new ThothComputeTool())
    );
    context.subscriptions.push(
        vscode.lm.registerTool('thoth-alpha_execute-code', new ThothExecuteCodeTool())
    );
    context.subscriptions.push(
        vscode.lm.registerTool('thoth-alpha_search-workspace', new ThothSearchWorkspaceTool())
    );
}
