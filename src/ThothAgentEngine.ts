import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import * as https from 'https';
import { getCachedResponse, saveCachedResponse } from './cacheHelper';

export interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface SearchProgressSink {
    onChunk(text: string): void;
    onDone(text: string): void;
    onError(text: string): void;
    onCancelled(): void;
}

export interface DeepResearchProgressSink {
    onChunk(text: string): void;
    onDone(text: string, interactionId: string): void;
    onError(text: string): void;
    onStatus(status: any): void;
}

export interface ExecutionSink {
    onStarted(language: string): void;
    onResult(stdout?: string, stderr?: string, error?: string): void;
}

export class WebviewSearchSink implements SearchProgressSink {
    constructor(private readonly webview: vscode.Webview) {}
    onChunk(text: string) { this.webview.postMessage({ command: 'search_chunk', text }); }
    onDone(text: string) { this.webview.postMessage({ command: 'search_done', text }); }
    onError(text: string) { this.webview.postMessage({ command: 'error', text }); }
    onCancelled() { this.webview.postMessage({ command: 'search_cancelled' }); }
}

export class WebviewDeepResearchSink implements DeepResearchProgressSink {
    constructor(private readonly webview: vscode.Webview) {}
    onChunk(text: string) { this.webview.postMessage({ command: 'deep_research_chunk', text }); }
    onDone(text: string, interactionId: string) { this.webview.postMessage({ command: 'deep_research_done', text, interactionId }); }
    onError(text: string) { this.webview.postMessage({ command: 'error', text }); }
    onStatus(status: any) { this.webview.postMessage({ command: 'deep_research_status', status }); }
}

export class WebviewExecutionSink implements ExecutionSink {
    constructor(private readonly webview: vscode.Webview) {}
    onStarted(language: string) { this.webview.postMessage({ command: 'execution_started', language }); }
    onResult(stdout?: string, stderr?: string, error?: string) {
        this.webview.postMessage({ command: 'execution_result', stdout, stderr, error });
    }
}

let _outputChannel: vscode.LogOutputChannel | undefined;
let _secrets: vscode.SecretStorage | undefined;

export function initEngine(outputChannel: vscode.LogOutputChannel, secrets: vscode.SecretStorage) {
    _outputChannel = outputChannel;
    _secrets = secrets;
}

function log(msg: string) { _outputChannel?.info(msg); }
function logError(msg: string, err?: any) { _outputChannel?.error(msg, err); }

const MAX_CONVERSATION_TURNS = 10;

const RESULT_TOOL_NAME = 'submit_result';

const RESULT_TOOL_SCHEMA = {
    type: 'object',
    properties: {
        interpretation: { type: 'string', description: 'How you interpreted the query (max 20 words)' },
        result_summary: { type: 'string', description: 'Concise text/math answer (MAX 30 words)' },
        explanation_md: { type: 'string', description: 'Detailed Markdown explanation. Use $ for inline math. Use \`\`\`mermaid for diagrams. Use \`\`\`diff for diffs.' },
        table_data: {
            type: 'object',
            description: 'Optional tabular data',
            properties: {
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } }
            },
            required: ['headers', 'rows']
        },
        requires_simulation: { type: 'boolean', description: 'Set to true ONLY if the query explicitly asks for a visual simulation, animation, or interactive 3D/2D canvas rendering (like Three.js, moving particles, sorting visualizations). Do NOT set to true for static charts or text math.' },
        executable_code: {
            type: 'object',
            description: 'Optional code for local execution',
            properties: {
                language: { type: 'string', enum: ['python', 'javascript', 'bash'] },
                code: { type: 'string' }
            },
            required: ['language', 'code']
        },
        related_queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exactly 3 related follow-up queries'
        }
    },
    required: ['interpretation', 'result_summary', 'explanation_md', 'related_queries']
};

const SIMULATION_RULES = `SIMULATION RULES for simulation_js:
- The canvas element is already available as document.getElementById("simCanvas"). Use it for THREE.js or raw 2D rendering.
- You have access to these advanced libraries globally:
  * THREE.js (as THREE, including THREE.OrbitControls)
  * Chart.js (as Chart)
  * LightweightCharts (as LightweightCharts, for financial charts)
  * Leaflet (as L, for maps, bind to document.getElementById("simContainer"))
  * Vega-Lite (via vegaEmbed, e.g. vegaEmbed('#simContainer', spec))
  * vis.Network (as vis.Network, for node/edge graphs, bind to document.getElementById("simContainer"))
  * gridjs.Grid (as gridjs.Grid, for sortable tables, bind to document.getElementById("simContainer"))
- When using simContainer for libraries like vegaEmbed, vis.Network, or gridjs, DO NOT append new elements to document.body. Use document.getElementById("simContainer").
- For animation loops, ALWAYS use: window.currentSimLoop = requestAnimationFrame(animate);
- NEVER create new HTML elements (no document.createElement for divs, no overlays, no UI controls).
- NEVER modify document.body or add elements outside the canvas/container.
- NEVER use position:fixed or position:absolute on any created element.
- Keep simulations self-contained: all state in local variables, no global pollution.
- Handle errors gracefully - wrap risky operations in try/catch.`;

const GROUNDING = `GROUNDING: Use internal scientific knowledge. If the task requires local file processing, scripting, or heavy compute, include a script in the executable_code field and it will be run automatically.`;

export class ThothAgentEngine {
    private static _prepareQuery(query: string): string {
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
        return query;
    }

    private static _buildMessages(
        systemPrompt: string,
        query: string,
        conversationHistory?: ConversationMessage[]
    ): vscode.LanguageModelChatMessage[] {
        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(systemPrompt)
        ];

        if (conversationHistory && conversationHistory.length > 0) {
            const history = conversationHistory.length > MAX_CONVERSATION_TURNS * 2
                ? conversationHistory.slice(-MAX_CONVERSATION_TURNS * 2)
                : conversationHistory;
            for (const msg of history) {
                if (msg.role === 'user') {
                    messages.push(vscode.LanguageModelChatMessage.User(`Query: ${msg.content}`));
                } else {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
                }
            }
        }

        messages.push(vscode.LanguageModelChatMessage.User(`Query: ${query}`));
        return messages;
    }

    private static async _selectModel(modelId: string | undefined): Promise<vscode.LanguageModelChat | undefined> {
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
            logError("Error selecting model:", e);
        }
        return model;
    }

    public static async handleSearch(
        query: string,
        modelId: string | undefined,
        sink: SearchProgressSink,
        token?: vscode.CancellationToken,
        conversationHistory?: ConversationMessage[],
        skipCache?: boolean
    ): Promise<string | undefined> {
        query = ThothAgentEngine._prepareQuery(query);

        const enableCaching = vscode.workspace.getConfiguration('thothAlpha').get<boolean>('enableCaching', true);
        const cacheKey = conversationHistory && conversationHistory.length > 0
            ? JSON.stringify(conversationHistory.map(m => m.content)) + '|||' + query
            : query;

        if (enableCaching && !skipCache) {
            const cachedResponse = await getCachedResponse(cacheKey);
            if (cachedResponse) {
                log(`Cache hit for query: ${query.substring(0, 80)}`);
                sink.onDone(cachedResponse);
                return cachedResponse;
            }
        }

        const model = await ThothAgentEngine._selectModel(modelId);
        if (!model) {
            sink.onError('No language model found.');
            return undefined;
        }

        log(`Search started: model=${model.name}, query="${query.substring(0, 80)}"`);
        const startTime = Date.now();
        const cancellationToken = token || new vscode.CancellationTokenSource().token;

        const conversationPrefix = (conversationHistory && conversationHistory.length > 0)
            ? `You are continuing a multi-turn conversation. Refer to prior exchanges when relevant and build on previous results.\n\n`
            : '';

        // Try structured tool-use approach first
        try {
            const toolPrompt = `${conversationPrefix}You are Thoth Alpha, a highly advanced computational search engine.
Analyze the user's query and submit your complete response by calling the ${RESULT_TOOL_NAME} tool.

${GROUNDING}`;

            const messages = ThothAgentEngine._buildMessages(toolPrompt, query, conversationHistory);
            const resultTool: vscode.LanguageModelChatTool = {
                name: RESULT_TOOL_NAME,
                description: 'Submit the computation result for the user query. You MUST call this tool with your complete answer.',
                inputSchema: RESULT_TOOL_SCHEMA
            };

            const chatResponse = await model.sendRequest(
                messages,
                { tools: [resultTool], toolMode: vscode.LanguageModelChatToolMode.Required },
                cancellationToken
            );

            let textAccum = '';
            let toolCallResult: Record<string, unknown> | undefined;
            let lastChunkTime = 0;
            let pendingChunk = false;

            for await (const part of chatResponse.stream) {
                if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCallResult = part.input as Record<string, unknown>;
                } else if (part instanceof vscode.LanguageModelTextPart) {
                    textAccum += part.value;
                    const now = Date.now();
                    if (now - lastChunkTime >= 250) {
                        sink.onChunk(textAccum);
                        lastChunkTime = now;
                        pendingChunk = false;
                    } else {
                        pendingChunk = true;
                    }
                }
            }
            if (pendingChunk) {
                sink.onChunk(textAccum);
            }

            let finalResult: string;
            if (toolCallResult) {
                finalResult = JSON.stringify(toolCallResult);
                log(`Search completed in ${Date.now() - startTime}ms (structured tool-use)`);
            } else if (textAccum) {
                finalResult = textAccum.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
                log(`Search completed in ${Date.now() - startTime}ms (tool-use text fallback)`);
            } else {
                throw new Error('Empty response from model');
            }

            await saveCachedResponse(cacheKey, finalResult);
            sink.onDone(finalResult);
            return finalResult;
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                log('Search cancelled by user');
                sink.onCancelled();
                return undefined;
            }
            log(`Tool-use request failed (${err.message}), falling back to text mode`);
        }

        // Fallback: text-based JSON output (for models that don't support tool-use)
        try {
            const textPrompt = `${conversationPrefix}You are Thoth Alpha, a highly advanced computational search engine.
Respond ONLY with a raw JSON object (no markdown formatting, no \`\`\`json block) matching this schema:
{
    "interpretation": "How you interpreted the query (max 20 words)",
    "result_summary": "Concise text/math (MAX 30 words).",
    "explanation_md": "Detailed Markdown explanation. Use $ for math. Use \`\`\`mermaid for diagrams.",
    "table_data": { "headers": ["col1"], "rows": [["val1"]] },
    "requires_simulation": false,
    "executable_code": { "language": "python|javascript|bash", "code": "print('hello')" },
    "related_queries": ["query 1", "query 2", "query 3"]
}

${GROUNDING}`;

            const messages = ThothAgentEngine._buildMessages(textPrompt, query, conversationHistory);
            const chatResponse = await model.sendRequest(messages, {}, cancellationToken);

            let responseText = '';
            let lastChunkTime = 0;
            let pendingChunk = false;

            for await (const fragment of chatResponse.text) {
                responseText += fragment;
                const now = Date.now();
                if (now - lastChunkTime >= 250) {
                    sink.onChunk(responseText);
                    lastChunkTime = now;
                    pendingChunk = false;
                } else {
                    pendingChunk = true;
                }
            }
            if (pendingChunk) {
                sink.onChunk(responseText);
            }

            responseText = responseText.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
            await saveCachedResponse(cacheKey, responseText);
            log(`Search completed in ${Date.now() - startTime}ms (text fallback)`);
            sink.onDone(responseText);
            return responseText;
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                log('Search cancelled by user');
                sink.onCancelled();
                return undefined;
            }
            logError('Search failed', err);
            sink.onError(err.message);
            return undefined;
        }
    }

    public static async handleGenerateSimulation(
        query: string,
        summary: string,
        explanation: string,
        modelId: string | undefined,
        sink: SearchProgressSink,
        token?: vscode.CancellationToken
    ): Promise<string | undefined> {
        const model = await ThothAgentEngine._selectModel(modelId);
        if (!model) {
            sink.onError('No language model found.');
            return undefined;
        }

        log(`Generate simulation started: query="${query.substring(0, 80)}"`);
        const cancellationToken = token || new vscode.CancellationTokenSource().token;

        const GENERATE_TOOL_NAME = 'submit_simulation';
        const generateToolSchema = {
            type: 'object',
            properties: {
                simulation_js: { type: 'string', description: 'The JavaScript simulation code' },
                description: { type: 'string', description: 'Brief description of the simulation' }
            },
            required: ['simulation_js']
        };

        const prompt = `You are Thoth Alpha. The user wants a simulation for the query: ${query}

Previous analysis:
${summary}
${explanation}

Write the JavaScript code to create this simulation.
Use the ${GENERATE_TOOL_NAME} tool to submit your code.

${SIMULATION_RULES}`;

        try {
            const messages = [vscode.LanguageModelChatMessage.User(prompt)];
            const tool: vscode.LanguageModelChatTool = {
                name: GENERATE_TOOL_NAME,
                description: 'Submit the simulation javascript',
                inputSchema: generateToolSchema
            };

            const chatResponse = await model.sendRequest(
                messages,
                { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Required },
                cancellationToken
            );

            let textAccum = '';
            let toolCallResult: Record<string, unknown> | undefined;

            for await (const part of chatResponse.stream) {
                if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCallResult = part.input as Record<string, unknown>;
                } else if (part instanceof vscode.LanguageModelTextPart) {
                    textAccum += part.value;
                }
            }

            if (toolCallResult) {
                const result = JSON.stringify(toolCallResult);
                log('Generate simulation completed (tool-use)');
                sink.onDone(result);
                return result;
            } else if (textAccum) {
                const cleaned = textAccum.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/, '').trim();
                const result = JSON.stringify({ simulation_js: cleaned, description: 'Generated via text fallback' });
                log('Generate simulation completed (text fallback)');
                sink.onDone(result);
                return result;
            }
            throw new Error('Empty response from model');
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                sink.onCancelled();
                return undefined;
            }
            log(`Generate simulation tool-use failed (${err.message}), trying text mode`);
        }

        try {
            const textPrompt = `You are Thoth Alpha. The user wants a simulation for the query: ${query}

Previous analysis:
${summary}
${explanation}

Write the JavaScript code to create this simulation. Return ONLY raw JavaScript code (no markdown, no explanation).

${SIMULATION_RULES}`;

            const messages = [vscode.LanguageModelChatMessage.User(textPrompt)];
            const chatResponse = await model.sendRequest(messages, {}, cancellationToken);
            let responseText = '';
            for await (const fragment of chatResponse.text) {
                responseText += fragment;
            }
            responseText = responseText.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/, '').trim();
            const result = JSON.stringify({ simulation_js: responseText, description: 'Generated via text mode' });
            log('Generate simulation completed (text mode)');
            sink.onDone(result);
            return result;
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                sink.onCancelled();
                return undefined;
            }
            logError('Generate simulation failed', err);
            sink.onError(err.message);
            return undefined;
        }
    }

    public static async handleFixSimulation(
        originalQuery: string,
        brokenCode: string,
        errorMessage: string,
        modelId: string | undefined,
        sink: SearchProgressSink,
        token?: vscode.CancellationToken
    ): Promise<string | undefined> {
        const model = await ThothAgentEngine._selectModel(modelId);
        if (!model) {
            sink.onError('No language model found.');
            return undefined;
        }

        log(`Fix simulation started: error="${errorMessage.substring(0, 80)}"`);
        const cancellationToken = token || new vscode.CancellationTokenSource().token;

        const FIX_TOOL_NAME = 'submit_fixed_simulation';
        const fixToolSchema = {
            type: 'object',
            properties: {
                fixed_simulation_js: { type: 'string', description: 'The corrected simulation JavaScript code' },
                fix_explanation: { type: 'string', description: 'Brief explanation of what was fixed' }
            },
            required: ['fixed_simulation_js']
        };

        const fixPrompt = `You are Thoth Alpha. A simulation was generated for the query below, but it threw an error.
Fix the simulation_js code so it runs without errors. Return ONLY the fixed code via the ${FIX_TOOL_NAME} tool.

Original query: ${originalQuery}
Error message: ${errorMessage}

Broken code:
\`\`\`javascript
${brokenCode}
\`\`\`

${SIMULATION_RULES}`;

        try {
            const messages = [vscode.LanguageModelChatMessage.User(fixPrompt)];
            const fixTool: vscode.LanguageModelChatTool = {
                name: FIX_TOOL_NAME,
                description: 'Submit the corrected simulation JavaScript code.',
                inputSchema: fixToolSchema
            };

            const chatResponse = await model.sendRequest(
                messages,
                { tools: [fixTool], toolMode: vscode.LanguageModelChatToolMode.Required },
                cancellationToken
            );

            let toolCallResult: Record<string, unknown> | undefined;
            let textAccum = '';

            for await (const part of chatResponse.stream) {
                if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCallResult = part.input as Record<string, unknown>;
                } else if (part instanceof vscode.LanguageModelTextPart) {
                    textAccum += part.value;
                }
            }

            if (toolCallResult) {
                const result = JSON.stringify(toolCallResult);
                log('Fix simulation completed (tool-use)');
                sink.onDone(result);
                return result;
            } else if (textAccum) {
                const cleaned = textAccum.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/, '').trim();
                const result = JSON.stringify({ fixed_simulation_js: cleaned, fix_explanation: 'Fixed via text fallback' });
                log('Fix simulation completed (text fallback)');
                sink.onDone(result);
                return result;
            }
            throw new Error('Empty response from model');
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                sink.onCancelled();
                return undefined;
            }
            log(`Fix simulation tool-use failed (${err.message}), trying text mode`);
        }

        try {
            const textPrompt = `You are Thoth Alpha. A simulation threw an error. Fix ONLY the JavaScript code. Return ONLY raw JavaScript code (no markdown, no explanation).

Original query: ${originalQuery}
Error: ${errorMessage}

Broken code:
${brokenCode}

${SIMULATION_RULES}`;

            const messages = [vscode.LanguageModelChatMessage.User(textPrompt)];
            const chatResponse = await model.sendRequest(messages, {}, cancellationToken);
            let responseText = '';
            for await (const fragment of chatResponse.text) {
                responseText += fragment;
            }
            responseText = responseText.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/, '').trim();
            const result = JSON.stringify({ fixed_simulation_js: responseText, fix_explanation: 'Fixed via text mode' });
            log('Fix simulation completed (text mode)');
            sink.onDone(result);
            return result;
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                sink.onCancelled();
                return undefined;
            }
            logError('Fix simulation failed', err);
            sink.onError(err.message);
            return undefined;
        }
    }

    public static async handleDeepResearch(
        query: string,
        sink: DeepResearchProgressSink,
        conversationHistory?: ConversationMessage[],
        previousInteractionId?: string
    ): Promise<{ responseText: string; interactionId: string } | undefined> {

        let apiKey = await _secrets?.get('geminiApiKey') || '';
        if (!apiKey) {
            apiKey = vscode.workspace.getConfiguration('thothAlpha').get<string>('geminiApiKey', '');
        }
        if (!apiKey) {
            sink.onError('Gemini API key not configured. Run "Thoth Alpha: Set Gemini API Key" from the command palette, or set it in Settings.');
            return undefined;
        }

        const modelId = vscode.workspace.getConfiguration('thothAlpha').get<string>(
            'deepResearchModel', 'deep-research-pro-preview-12-2025'
        );

        let input = query;
        if (conversationHistory && conversationHistory.length > 0) {
            const contextSummary = conversationHistory.map(m =>
                m.role === 'user' ? `User: ${m.content}` : `Assistant: ${m.content.substring(0, 500)}`
            ).join('\n');
            input = `Previous conversation context:\n${contextSummary}\n\nNew query: ${query}`;
        }

        log(`Deep Research started: model=${modelId}, query="${query.substring(0, 80)}"`);
        const startTime = Date.now();

        const requestBody: Record<string, unknown> = {
            model: `models/${modelId}`,
            input: input,
            stream: true
        };

        if (previousInteractionId) {
            requestBody.previous_interaction_id = previousInteractionId;
        }

        const postData = JSON.stringify(requestBody);

        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'generativelanguage.googleapis.com',
                path: `/v1beta/interactions?key=${encodeURIComponent(apiKey)}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (res) => {
                let fullText = '';
                let interactionId = '';
                let buffer = '';
                let lastChunkTime = 0;

                if (res.statusCode && res.statusCode >= 400) {
                    let errorBody = '';
                    res.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
                    res.on('end', () => {
                        logError(`Deep Research API error (${res.statusCode})`, errorBody);
                        sink.onError(`Deep Research API error (${res.statusCode}): ${errorBody.substring(0, 200)}`);
                        resolve(undefined);
                    });
                    return;
                }

                res.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) { continue; }
                        const jsonStr = line.substring(6).trim();
                        if (jsonStr === '[DONE]') { continue; }
                        try {
                            const event = JSON.parse(jsonStr);

                            if (event.serverContent?.modelTurn?.parts) {
                                for (const part of event.serverContent.modelTurn.parts) {
                                    if (part.text) {
                                        fullText += part.text;
                                    }
                                }
                                const now = Date.now();
                                if (now - lastChunkTime >= 300) {
                                    sink.onChunk(fullText);
                                    lastChunkTime = now;
                                }
                            }

                            if (event.serverContent?.turnComplete) {
                                interactionId = event.interactionId || interactionId;
                            }

                            if (event.interactionId) {
                                interactionId = event.interactionId;
                            }

                            if (event.status) {
                                sink.onStatus(event.status);
                            }
                        } catch (_e) {
                            // skip unparseable SSE lines
                        }
                    }
                });

                res.on('end', () => {
                    log(`Deep Research completed in ${Date.now() - startTime}ms`);
                    sink.onDone(fullText, interactionId);
                    resolve({ responseText: fullText, interactionId });
                });

                res.on('error', (err) => {
                    logError('Deep Research stream error', err);
                    sink.onError(err.message);
                    resolve(undefined);
                });
            });

            req.on('error', (err) => {
                logError('Deep Research request failed', err);
                sink.onError(`Deep Research request failed: ${err.message}`);
                resolve(undefined);
            });

            req.write(postData);
            req.end();
        });
    }

    public static async executeLocalCode(language: string, code: string, sink: ExecutionSink) {
        sink.onStarted(language);
        log(`Executing ${language} code (${code.length} chars)`);
        try {
            let cmd = '';
            let tmpFile = '';
            if (language.toLowerCase() === 'python') {
                tmpFile = path.join(os.tmpdir(), `thoth_${Date.now()}.py`);
                await fs.promises.writeFile(tmpFile, code, 'utf8');
                cmd = `python3 "${tmpFile}"`;
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
                    fs.promises.unlink(tmpFile).catch(() => {});
                }
                log(`Code execution finished: ${error ? 'error' : 'success'}`);
                sink.onResult(stdout, stderr, error ? error.message : undefined);
            });
        } catch (e: any) {
            logError('Code execution failed', e);
            sink.onResult(undefined, undefined, e.message);
        }
    }

    public static async executeInTerminal(language: string, code: string) {
        const extMap: Record<string, string> = { python: 'py', javascript: 'js', node: 'js', bash: 'sh', sh: 'sh' };
        const cmdMap: Record<string, string> = { python: 'python3', javascript: 'node', node: 'node', bash: 'bash', sh: 'bash' };
        const lang = language.toLowerCase();
        const ext = extMap[lang];
        const runner = cmdMap[lang];
        if (!ext || !runner) {
            vscode.window.showErrorMessage(`Unsupported execution language: ${language}`);
            return;
        }
        const tmpFile = path.join(os.tmpdir(), `thoth_${Date.now()}.${ext}`);
        await fs.promises.writeFile(tmpFile, code, 'utf8');
        const terminal = vscode.window.createTerminal({ name: `Thoth: ${language}` });
        terminal.show();
        terminal.sendText(`${runner} "${tmpFile}"`);
        log(`Opened terminal for ${language} execution`);
    }
}
