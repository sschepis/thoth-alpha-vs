import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import { getCachedResponse, saveCachedResponse } from './cacheHelper';

export class ThothAgentEngine {
    public static async handleSearch(
        query: string, 
        modelId: string | undefined, 
        webviewPanel: vscode.WebviewPanel, 
        token?: vscode.CancellationToken
    ) {
        if (query.startsWith('__CONTEXT_INJECTED__')) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const code = activeEditor.document.getText();
                const language = activeEditor.document.languageId;
                const fileName = path.basename(activeEditor.document.fileName);
                query = query.replace('__CONTEXT_INJECTED__', `\n\nContext from active file (${fileName}, ${language}):\n\`\`\`\n${code}\n\`\`\`\n`);
            } else {
                query = query.replace('__CONTEXT_INJECTED__', '');
            }
        }

        const enableCaching = vscode.workspace.getConfiguration('thothAlpha').get<boolean>('enableCaching', true);
        if (enableCaching) {
            const cachedResponse = await getCachedResponse(query);
            if (cachedResponse) {
                webviewPanel.webview.postMessage({ command: 'search_done', text: cachedResponse });
                try {
                    const parsed = JSON.parse(cachedResponse);
                    // Handled in UI
                } catch (e) { }
                return;
            }
        }

        let model: vscode.LanguageModelChat | undefined;
        try {
            const allModels = await vscode.lm.selectChatModels();
            if (modelId) {
                model = allModels.find(m => m.id === modelId);
            }
            if (!model) {
                const defaultModels = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
                model = defaultModels && defaultModels.length > 0 ? defaultModels[0] : allModels[0];
            }
        } catch (e) {
            console.error("Error selecting model:", e);
        }

        if (!model) {
            webviewPanel.webview.postMessage({ command: 'error', text: 'No language model found.' });
            return;
        }

        const systemPrompt = `You are Thoth Alpha, a highly advanced computational search engine. 
Respond ONLY with a raw JSON object (no markdown formatting, no \`\`\`json block) matching this schema:
{
    "interpretation": "How you interpreted the query (max 20 words)",
    "result_summary": "Concise text/math (MAX 30 words).",
    "explanation_md": "Detailed Markdown explanation. Use $ for math.",
    "table_data": { "headers": ["col1"], "rows": [["val1"]] }, // optional
    "simulation_js": "IIFE function for 'simCanvas'. BLACK background. Use window.currentSimLoop. THREE.js is available globally (THREE) + THREE.OrbitControls.", // optional
    "executable_code": { "language": "python|javascript|bash", "code": "print('hello')" }, // optional, for local execution
    "related_queries": ["query 1", "query 2", "query 3"]
}
GROUNDING: Use internal scientific knowledge. If the task requires local file processing, scripting, or heavy compute, output a script in \`executable_code\` and it will be run automatically.`;

        const messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt),
            vscode.LanguageModelChatMessage.User(`Query: ${query}`)
        ];

        try {
            const chatResponse = await model.sendRequest(messages, {}, token || new vscode.CancellationTokenSource().token);
            let responseText = '';
            
            for await (const fragment of chatResponse.text) {
                responseText += fragment;
                webviewPanel.webview.postMessage({ command: 'search_chunk', text: responseText });
            }

            responseText = responseText.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
            await saveCachedResponse(query, responseText);
            webviewPanel.webview.postMessage({ command: 'search_done', text: responseText });

            try {
                const parsed = JSON.parse(responseText);
                // Executable code parsing is now handled by the UI
            } catch (e) { }
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                webviewPanel.webview.postMessage({ command: 'search_cancelled' });
                return;
            }
            webviewPanel.webview.postMessage({ command: 'error', text: err.message });
        }
    }

    public static async executeLocalCode(language: string, code: string, webviewPanel: vscode.WebviewPanel) {
        webviewPanel.webview.postMessage({ command: 'execution_started', language });
        try {
            let cmd = '';
            let tmpFile = '';
            if (language.toLowerCase() === 'python') {
                tmpFile = path.join(os.tmpdir(), `thoth_${Date.now()}.py`);
                await fs.promises.writeFile(tmpFile, code, 'utf8');
                cmd = `python3 "${tmpFile}"`; // or python depending on env
            } else if (language.toLowerCase() === 'javascript' || language.toLowerCase() === 'node') {
                tmpFile = path.join(os.tmpdir(), `thoth_${Date.now()}.js`);
                await fs.promises.writeFile(tmpFile, code, 'utf8');
                cmd = `node "${tmpFile}"`;
            } else if (language.toLowerCase() === 'bash' || language.toLowerCase() === 'sh') {
                tmpFile = path.join(os.tmpdir(), `thoth_${Date.now()}.sh`);
                await fs.promises.writeFile(tmpFile, code, 'utf8');
                cmd = `bash "${tmpFile}"`;
            } else {
                throw new Error(`Unsupported execution language: ${language}`);
            }

            cp.exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
                if (tmpFile) {
                    fs.promises.unlink(tmpFile).catch(() => {}); // Cleanup safely
                }
                webviewPanel.webview.postMessage({ 
                    command: 'execution_result', 
                    stdout: stdout, 
                    stderr: stderr,
                    error: error ? error.message : undefined 
                });
            });
        } catch (e: any) {
            webviewPanel.webview.postMessage({ 
                command: 'execution_result', 
                error: e.message 
            });
        }
    }
}
