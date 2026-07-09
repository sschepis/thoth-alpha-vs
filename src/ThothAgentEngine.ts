import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import * as https from 'https';
import * as crypto from 'crypto';
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
    onCancelled(): void;
    onStatus(status: any): void;
}

export interface CourseGenerationSink extends SearchProgressSink {
    onPhase(phase: 'outline' | 'content', lessonIndex?: number, totalLessons?: number): void;
    onLessonComplete(lessonIndex: number, totalLessons: number, lessonTitle: string): void;
}

interface CourseOutline {
    title: string;
    description: string;
    sections: {
        title: string;
        lessons: {
            title: string;
            slideDescriptions: { title: string; description: string }[];
        }[];
    }[];
    vocabularyPlan: { term: string; introducedInLesson: number; definition: string }[];
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
    onCancelled() { this.webview.postMessage({ command: 'search_cancelled' }); }
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
        approach: {
            type: 'array',
            description: 'Polished step-by-step methodology used to arrive at the answer. NOT a thinking transcript — each step is a clean, reader-facing statement. 3-6 steps.',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Short step title (2-5 words)' },
                    detail: { type: 'string', description: 'One-sentence explanation of this step. Third-person, present tense. No meta-commentary.' }
                },
                required: ['title', 'detail']
            }
        },
        formulas: {
            type: 'array',
            description: 'Key mathematical formulas relevant to the answer. Raw LaTeX (no $ delimiters).',
            items: {
                type: 'object',
                properties: {
                    label: { type: 'string', description: 'Human-readable name (e.g. "Kinetic Energy")' },
                    tex: { type: 'string', description: 'Raw LaTeX expression (e.g. "E_k = \\frac{1}{2}mv^2")' },
                    where: { type: 'string', description: 'Variable definitions (e.g. "m = mass, v = velocity")' }
                },
                required: ['label', 'tex']
            }
        },
        citations: {
            type: 'array',
            description: 'Authoritative references. Real URLs only — never invent.',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Source title' },
                    url: { type: 'string', description: 'URL to the source' },
                    note: { type: 'string', description: 'Brief relevance note' }
                },
                required: ['title', 'url']
            }
        },
        explanation_md: { type: 'string', description: 'Detailed Markdown explanation. Use $ for inline math, $$ for display math. Reference citation numbers as [1], [2] etc. DO NOT output source code for simulations in this field. Use \`\`\`mermaid for diagrams.' },
        table_data: {
            type: 'object',
            description: 'Optional tabular data',
            properties: {
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } }
            },
            required: ['headers', 'rows']
        },
        is_graphable: { type: 'boolean', description: 'Set to true if the result can be visualized as a chart/graph.' },
        graph_type: { type: 'string', enum: ['line', 'bar', 'scatter', 'polar'], description: 'Type of graph to render.' },
        graph_expression: { type: 'string', description: 'LaTeX expression of the graphed function.' },
        graph_data: {
            type: 'array',
            description: 'Data points for chart visualization. 30-80 points recommended.',
            items: {
                type: 'object',
                properties: {
                    label: { type: 'string' },
                    x: { type: 'number' },
                    y: { type: 'number' }
                },
                required: ['x', 'y']
            }
        },
        requires_simulation: { type: 'boolean', description: 'Set to true ONLY if the query explicitly asks for a visual simulation, animation, or interactive 3D/2D canvas rendering (like Three.js, moving particles, sorting visualizations). Do NOT set to true for static charts or text math.' },
        animation_js: { type: 'string', description: 'Manim-style didactic animation code. Receives an `api` argument with { ctx, canvas, mjs, theme, fps }. Only for step-by-step mathematical/scientific animations.' },
        animation_caption: { type: 'string', description: 'Brief caption describing the animation.' },
        animation_steps: {
            type: 'array',
            description: 'Narration steps synchronized with the animation timeline.',
            items: {
                type: 'object',
                properties: {
                    t: { type: 'number', description: 'Time in seconds when this step occurs' },
                    label: { type: 'string', description: 'Short label for the step' },
                    speech: { type: 'string', description: 'Narration text for this step' }
                },
                required: ['t', 'label', 'speech']
            }
        },
        executable_code: {
            type: 'object',
            description: 'Optional code for local execution. DO NOT use this for visual simulations.',
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
- The system automatically cleans up previous state before running your code. DO NOT call simContainer.innerHTML = '' or remove/replace existing DOM elements inside simContainer.
- The canvas element is already available as document.getElementById("simCanvas"). Use it for raw 2D rendering or THREE.js. The variables \`simCanvas\` and \`canvas\` are pre-set to this element.
- For THREE.js, you MUST bind the renderer to the existing canvas like this: \`new THREE.WebGLRenderer({ canvas: document.getElementById('simCanvas') });\`. NEVER use \`document.body.appendChild\`.
- You have access to these advanced libraries globally:
  * THREE.js (as THREE, including THREE.OrbitControls)
  * Chart.js (as Chart)
  * LightweightCharts (as LightweightCharts, for financial charts)
  * Leaflet (as L, for maps, bind to document.getElementById("simContainer"))
  * Vega-Lite (via vegaEmbed, e.g. vegaEmbed('#simContainer', spec))
  * vis.Network (as vis.Network, for node/edge graphs, bind to document.getElementById("simContainer"))
  * gridjs.Grid (as gridjs.Grid, for sortable tables, bind to document.getElementById("simContainer"))
- When using a 2D DOM library (like Leaflet, Vega, Network, Grid), explicitly hide the canvas: \`document.getElementById('simCanvas').style.display = 'none';\` and ensure container is visible.
- When using a Canvas library (like THREE.js, Chart.js), ensure the canvas is visible and sized to its container.
- When using simContainer, DO NOT append new elements to document.body. Use document.getElementById("simContainer").
- For animation loops, ALWAYS use: window.currentSimLoop = requestAnimationFrame(animate);
- ALWAYS handle viewport sizing using \`window.addEventListener('resize', ...)\` to keep your simulation bounded.
- NEVER create new HTML elements outside the canvas/container.
- NEVER modify document.body.
- NEVER set simContainer.innerHTML or remove the simCanvas element.
- DO NOT wrap everything in a try/catch that swallows errors. Fail loudly or throw explicitly so the system can catch the error and trigger the self-correction agent.`;

const GROUNDING = `GROUNDING: Use internal scientific knowledge. If the task requires local file processing, scripting, or heavy compute, include a script in the executable_code field and it will be run automatically.`;

export class ThothAgentEngine {
    private static _prepareQuery(query: string): string {
        if (query.startsWith('__CONTEXT_INJECTED__')) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const code = activeEditor.document.getText();
                const language = activeEditor.document.languageId;
                const fileName = path.basename(activeEditor.document.fileName);
                const maxCodeLen = 8000;
                const truncated = code.length > maxCodeLen ? code.substring(0, maxCodeLen) + `\n...(truncated, ${code.length - maxCodeLen} more chars)` : code;
                query = query.replace('__CONTEXT_INJECTED__', `\n\nContext from active file (${fileName}, ${language}):\n\`\`\`\n${truncated}\n\`\`\`\n`);
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

    /**
     * Extract text from a PDF and format it as context for the LLM.
     * paperId may be either an absolute filesystem path to a PDF or a
     * workspace-relative path. Returns undefined if extraction fails so
     * the search continues with the users query unchanged.
     */
    private static _redactSecrets(text: string): string {
        return text
            .replace(/x-goog-api-key[:\s]+\S+/gi, 'x-goog-api-key: [REDACTED]')
            .replace(/x-api-key[:\s]+\S+/gi, 'x-api-key: [REDACTED]')
            .replace(/xi-api-key[:\s]+\S+/gi, 'xi-api-key: [REDACTED]')
            .replace(/"apiKey"\s*:\s*"[^"]+"/gi, '"apiKey":"[REDACTED]"');
    }

    private static _resolvePathWithinWorkspace(relativePath: string): string | undefined {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!ws) { return undefined; }
        const resolved = path.resolve(ws, relativePath);
        if (resolved !== ws && !resolved.startsWith(ws + path.sep)) {
            return undefined;
        }
        return resolved;
    }

    private static async _extractPdfContext(paperId: string): Promise<string | undefined> {
        try {
            let pdfPath = paperId;
            if (!path.isAbsolute(pdfPath)) {
                const resolved = ThothAgentEngine._resolvePathWithinWorkspace(pdfPath);
                if (!resolved) { return undefined; }
                pdfPath = resolved;
            } else {
                const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!ws) { return undefined; }
                const normalized = path.resolve(pdfPath);
                if (normalized !== ws && !normalized.startsWith(ws + path.sep)) {
                    return undefined;
                }
                pdfPath = normalized;
            }
            if (!fs.existsSync(pdfPath)) return undefined;
            const data = new Uint8Array(fs.readFileSync(pdfPath));
            // pdfjs-dist legacy build works in Node without a worker.
            const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
            const loadingTask = pdfjsLib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true });
            const doc = await loadingTask.promise;
            const parts: string[] = [];
            const maxPages = Math.min(doc.numPages, 50);
            for (let i = 1; i <= maxPages; i++) {
                const page = await doc.getPage(i);
                const content = await page.getTextContent();
                const strings = content.items.map((it: any) => (typeof it.str === 'string' ? it.str : '')).filter(Boolean);
                parts.push(strings.join(' '));
            }
            const text = parts.join('\n\n').slice(0, 60000);
            const fileName = path.basename(pdfPath);
            const header = 'The user has attached a PDF document ("' + fileName + '"). Use its contents below as primary context when answering. Ground your answer in this document.';
            return [header, '--- BEGIN PDF CONTENT ---', text, '--- END PDF CONTENT ---'].join('\n');
        } catch (e) {
            console.warn('[Thoth] PDF extraction failed:', e);
            return undefined;
        }
    }

    public static async handleSearch(
        query: string,
        modelId: string | undefined,
        sink: SearchProgressSink,
        token?: vscode.CancellationToken,
        conversationHistory?: ConversationMessage[],
        skipCache?: boolean,
        paperId?: string
    ): Promise<string | undefined> {
        query = ThothAgentEngine._prepareQuery(query);
        if (paperId) {
            const pdfContext = await ThothAgentEngine._extractPdfContext(paperId);
            if (pdfContext) {
                query = pdfContext + '\n\n' + query;
            }
        }

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
        let ownCts: vscode.CancellationTokenSource | undefined;
        const cancellationToken = token || (ownCts = new vscode.CancellationTokenSource()).token;

        try {
            const conversationPrefix = (conversationHistory && conversationHistory.length > 0)
                ? `You are continuing a multi-turn conversation. Refer to prior exchanges when relevant and build on previous results.\n\n`
                : '';

            // Try structured tool-use approach first
            try {
                const toolPrompt = `${conversationPrefix}You are Thoth Alpha, a highly advanced computational search engine.
Analyze the user's query and submit your complete response by calling the ${RESULT_TOOL_NAME} tool.

REQUIRED FIELDS: interpretation, result_summary, explanation_md, related_queries.

STRONGLY RECOMMENDED FIELDS (include when relevant):
- approach: 3-6 polished reasoning steps showing HOW you arrived at the answer. Each step has a short title and a one-sentence detail. Third-person, present tense. Never include meta-commentary like "let me think" or "wait, error".
- formulas: Key mathematical formulas as raw LaTeX (no $ delimiters). Include a label and optional "where" clause defining variables.
- citations: 3-6 authoritative references with real URLs (NIST, Wikipedia, arXiv, textbooks, official docs). Never invent URLs.
- graph_data + is_graphable + graph_type: When the result involves a function or data that can be plotted, provide 30-80 data points.
- animation_js + animation_steps: For topics that benefit from step-by-step visual explanation (physics, geometry, algorithms).

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
    "approach": [{"title": "Step name", "detail": "One-sentence explanation, third-person, present tense."}],
    "formulas": [{"label": "Formula Name", "tex": "raw LaTeX, no $ delimiters", "where": "variable definitions"}],
    "citations": [{"title": "Source Title", "url": "https://real-url.com", "note": "relevance note"}],
    "explanation_md": "Detailed Markdown explanation. Use $ for inline math, $$ for display math. Reference citations as [1], [2]. DO NOT output source code for simulations in this field. Use \`\`\`mermaid for diagrams.",
    "table_data": { "headers": ["col1"], "rows": [["val1"]] },
    "is_graphable": false,
    "graph_type": "line|bar|scatter|polar",
    "graph_data": [{"x": 0, "y": 0}],
    "requires_simulation": false,
    "executable_code": { "language": "python|javascript|bash", "code": "print('hello')", "description": "DO NOT use for visual simulations." },
    "related_queries": ["query 1", "query 2", "query 3"]
}
Include approach, formulas, and citations whenever they are relevant. Only include graph_data when there is a function or dataset to plot.

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
        } finally {
            ownCts?.dispose();
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
        let ownCts: vscode.CancellationTokenSource | undefined;
        const cancellationToken = token || (ownCts = new vscode.CancellationTokenSource()).token;

        const GENERATE_TOOL_NAME = 'submit_simulation';
        const generateToolSchema = {
            type: 'object',
            properties: {
                reasoning: { type: 'string', description: 'Step-by-step plan for visual setup, library choice, and DOM/Canvas management.' },
                simulation_js: { type: 'string', description: 'The JavaScript simulation code' },
                description: { type: 'string', description: 'Brief description of the simulation' }
            },
            required: ['reasoning', 'simulation_js']
        };

        const prompt = `You are Thoth Alpha. The user wants a simulation for the query: ${query}

Previous analysis:
${summary}
${explanation}

Write the JavaScript code to create this simulation. First provide a detailed step-by-step plan in the reasoning field.
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
                const match = textAccum.match(/```(?:javascript|js)?\n([\s\S]*?)\n```/i);
                const cleaned = match ? match[1].trim() : textAccum.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/, '').trim();
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
            const match = responseText.match(/```(?:javascript|js)?\n([\s\S]*?)\n```/i);
            const cleaned = match ? match[1].trim() : responseText.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/, '').trim();
            const result = JSON.stringify({ simulation_js: cleaned, description: 'Generated via text mode' });
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
                reasoning: { type: 'string', description: 'Step-by-step reasoning on why the error occurred and how to fix it.' },
                fixed_simulation_js: { type: 'string', description: 'The corrected simulation JavaScript code' },
                fix_explanation: { type: 'string', description: 'Brief explanation of what was fixed' }
            },
            required: ['reasoning', 'fixed_simulation_js']
        };

        const fixPrompt = `You are Thoth Alpha. A simulation was generated for the query below, but it threw an error.
Fix the simulation_js code so it runs without errors. First provide reasoning on why the error occurred, then submit the fixed code via the ${FIX_TOOL_NAME} tool.

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
        previousInteractionId?: string,
        token?: vscode.CancellationToken
    ): Promise<{ responseText: string; interactionId: string } | undefined> {

        const apiKey = await _secrets?.get('geminiApiKey') || '';
        if (!apiKey) {
            sink.onError('Gemini API key not configured. Run "Thoth Alpha: Set Gemini API Key" from the command palette.');
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
                path: `/v1beta/interactions`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'x-goog-api-key': apiKey
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
                        logError(`Deep Research API error (${res.statusCode})`, ThothAgentEngine._redactSecrets(errorBody));
                        sink.onError(`Deep Research API error (${res.statusCode}): ${ThothAgentEngine._redactSecrets(errorBody.substring(0, 200))}`);
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

            const timeout = vscode.workspace.getConfiguration('thothAlpha').get<number>('deepResearchTimeout', 600000);
            req.setTimeout(timeout, () => {
                req.destroy(new Error('Request timeout'));
            });

            if (token) {
                token.onCancellationRequested(() => {
                    req.destroy();
                    sink.onCancelled();
                    resolve(undefined);
                });
            }

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
                tmpFile = path.join(os.tmpdir(), `thoth_${crypto.randomBytes(16).toString('hex')}.py`);
                await fs.promises.writeFile(tmpFile, code, 'utf8');
                cmd = `python3 "${tmpFile}"`;
            } else if (language.toLowerCase() === 'javascript' || language.toLowerCase() === 'node') {
                tmpFile = path.join(os.tmpdir(), `thoth_${crypto.randomBytes(16).toString('hex')}.js`);
                await fs.promises.writeFile(tmpFile, code, 'utf8');
                cmd = `node "${tmpFile}"`;
            } else if (language.toLowerCase() === 'bash' || language.toLowerCase() === 'sh') {
                tmpFile = path.join(os.tmpdir(), `thoth_${crypto.randomBytes(16).toString('hex')}.sh`);
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

    public static async handleSearchAnthropic(
        query: string,
        modelId: string | undefined,
        sink: SearchProgressSink,
        token?: vscode.CancellationToken,
        conversationHistory?: ConversationMessage[]
    ): Promise<string | undefined> {
        const apiKey = await _secrets?.get('anthropicApiKey') || '';
        if (!apiKey) {
            sink.onError('Anthropic API key not configured. Run "Thoth Alpha: Set Anthropic API Key" from the command palette.');
            return undefined;
        }

        query = ThothAgentEngine._prepareQuery(query);
        const anthropicModel = modelId || 'claude-sonnet-4-6';
        log(`Anthropic search started: model=${anthropicModel}, query="${query.substring(0, 80)}"`);
        const startTime = Date.now();

        const conversationPrefix = (conversationHistory && conversationHistory.length > 0)
            ? 'You are continuing a multi-turn conversation. Refer to prior exchanges when relevant.\n\n' : '';

        const systemPrompt = `${conversationPrefix}You are Thoth Alpha, a highly advanced computational search engine.
Respond ONLY with a raw JSON object matching this schema:
{
    "interpretation": "How you interpreted the query (max 20 words)",
    "result_summary": "Concise text/math (MAX 30 words).",
    "approach": [{"title": "Step name", "detail": "One-sentence explanation."}],
    "formulas": [{"label": "Formula Name", "tex": "raw LaTeX", "where": "variable definitions"}],
    "citations": [{"title": "Source Title", "url": "https://real-url.com", "note": "relevance note"}],
    "explanation_md": "Detailed Markdown explanation with $inline math$ and $$display math$$.",
    "related_queries": ["query 1", "query 2", "query 3"]
}
Include approach, formulas, and citations whenever relevant. ${GROUNDING}`;

        const messages: any[] = [];
        if (conversationHistory) {
            for (const msg of conversationHistory.slice(-MAX_CONVERSATION_TURNS * 2)) {
                messages.push({ role: msg.role, content: msg.content });
            }
        }
        messages.push({ role: 'user', content: `Query: ${query}` });

        const postData = JSON.stringify({
            model: anthropicModel,
            max_tokens: 4096,
            system: systemPrompt,
            messages,
            stream: true
        });

        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'api.anthropic.com',
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (res) => {
                let fullText = '';
                let buffer = '';
                let lastChunkTime = 0;

                if (res.statusCode && res.statusCode >= 400) {
                    let errorBody = '';
                    res.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
                    res.on('end', () => {
                        logError(`Anthropic API error (${res.statusCode})`, ThothAgentEngine._redactSecrets(errorBody));
                        sink.onError(`Anthropic API error (${res.statusCode}): ${ThothAgentEngine._redactSecrets(errorBody.substring(0, 200))}`);
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
                            if (event.type === 'content_block_delta' && event.delta?.text) {
                                fullText += event.delta.text;
                                const now = Date.now();
                                if (now - lastChunkTime >= 250) {
                                    sink.onChunk(fullText);
                                    lastChunkTime = now;
                                }
                            }
                        } catch (_e) {
                            // skip unparseable SSE lines
                        }
                    }
                });

                res.on('end', () => {
                    fullText = fullText.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
                    log(`Anthropic search completed in ${Date.now() - startTime}ms`);
                    sink.onDone(fullText);
                    resolve(fullText);
                });

                res.on('error', (err) => {
                    logError('Anthropic stream error', err);
                    sink.onError(err.message);
                    resolve(undefined);
                });
            });

            req.on('error', (err) => {
                logError('Anthropic request failed', err);
                sink.onError(`Anthropic request failed: ${err.message}`);
                resolve(undefined);
            });

            if (token) {
                token.onCancellationRequested(() => {
                    req.destroy();
                    sink.onCancelled();
                    resolve(undefined);
                });
            }

            req.write(postData);
            req.end();
        });
    }

    public static async handleEnhance(
        query: string,
        currentResult: Record<string, any>,
        weakDimensions: string[],
        modelId: string | undefined,
        sink: SearchProgressSink,
        token?: vscode.CancellationToken
    ): Promise<string | undefined> {
        const model = await ThothAgentEngine._selectModel(modelId);
        if (!model) {
            sink.onError('No language model found.');
            return undefined;
        }

        const validDims = weakDimensions.filter(d =>
            ['derivation', 'edge_cases', 'validation', 'evidence', 'visual'].includes(d)
        );
        if (validDims.length === 0) {
            sink.onError('No valid enhancement dimensions specified.');
            return undefined;
        }

        log(`Enhance started: dims=${validDims.join(',')}, query="${query.substring(0, 80)}"`);
        const cancellationToken = token || new vscode.CancellationTokenSource().token;

        const DIM_INSTRUCTIONS: Record<string, string> = {
            derivation: 'Derivation: add 2-4 key `formulas[]` entries (raw LaTeX, NO $ delimiters) AND a markdown block titled `### Derivation` in `explanation_md` walking through the key algebra/calculus.',
            edge_cases: 'Edge cases: add a markdown block `### Edge cases & limits` in `explanation_md` covering >=2 limiting/boundary/degenerate cases. Use $...$ inline math.',
            validation: 'Validation: add `### Sanity checks` in `explanation_md` with 1-2 concrete cross-checks against a known result, dimensional analysis, or limiting case.',
            evidence: 'Citations: add 3-6 authoritative `citations[]` (NIST, MathWorld, arXiv, primary literature, established docs). Real URLs only — never invent.',
            visual: 'Visual: produce either `graph_data` (30-80 points with {x,y}) plus `is_graphable=true`, `graph_type` and `graph_expression`, OR a `table_data` { headers:[], rows:[[]] } if not graphable.'
        };

        const dimBlock = validDims.map(d => `- ${DIM_INSTRUCTIONS[d]}`).join('\n');

        const ctx = {
            interpretation: currentResult.interpretation,
            result_summary: currentResult.result_summary,
            existing_formula_labels: (currentResult.formulas ?? []).map((f: any) => f?.label).filter(Boolean),
            existing_citations: (currentResult.citations ?? []).map((c: any) => c?.url).filter(Boolean),
            explanation_excerpt: typeof currentResult.explanation_md === 'string'
                ? currentResult.explanation_md.slice(0, 1200) : ''
        };

        const ENHANCE_TOOL_NAME = 'enhance_response';
        const enhanceToolSchema = {
            type: 'object',
            properties: {
                formulas: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, tex: { type: 'string' }, where: { type: 'string' } }, required: ['label', 'tex'] } },
                citations: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, note: { type: 'string' } }, required: ['title', 'url'] } },
                explanation_md: { type: 'string' },
                is_graphable: { type: 'boolean' },
                graph_type: { type: 'string', enum: ['line', 'bar', 'scatter', 'polar'] },
                graph_expression: { type: 'string' },
                graph_data: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
                table_data: { type: 'object', properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } },
                related_queries: { type: 'array', items: { type: 'string' } }
            }
        };

        const systemPrompt = `You are the Thoth Alpha enhancer. The user already has an answer; you ADD targeted depth.
ABSOLUTELY FORBIDDEN: Meta-commentary ("Wait", "actually", "let me reconsider"), streams of bare nouns, restating the question. Every field is polished, reader-facing, third-person, present tense.

Return ONLY new content for these requested dimensions — do NOT restate, modify, or paraphrase existing fields. Omit any property you have nothing new to add for. Output via the ${ENHANCE_TOOL_NAME} tool only.

REQUESTED ENHANCEMENTS:
${dimBlock}

Markdown blocks must use proper "###" headings. LaTeX in formulas[].tex is raw — no $ delimiters. Inline math inside markdown uses $...$, display math $$...$$.`;

        const userMsg = `QUERY: ${query}\n\nEXISTING ANSWER (context, do not duplicate):\n${JSON.stringify(ctx, null, 0)}`;

        try {
            const messages = [
                vscode.LanguageModelChatMessage.User(systemPrompt),
                vscode.LanguageModelChatMessage.User(userMsg)
            ];
            const tool: vscode.LanguageModelChatTool = {
                name: ENHANCE_TOOL_NAME,
                description: 'Return ONLY the additions for the requested dimensions.',
                inputSchema: enhanceToolSchema
            };

            const chatResponse = await model.sendRequest(
                messages,
                { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Required },
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
                log(`Enhance completed (tool-use), dims=${validDims.join(',')}`);
                sink.onDone(result);
                return result;
            } else if (textAccum) {
                const cleaned = textAccum.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
                log(`Enhance completed (text fallback), dims=${validDims.join(',')}`);
                sink.onDone(cleaned);
                return cleaned;
            }
            throw new Error('Empty response from model');
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                sink.onCancelled();
                return undefined;
            }
            logError('Enhance failed', err);
            sink.onError(err.message);
            return undefined;
        }
    }

    public static async handleRepairAnimation(
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

        log(`Repair animation started: error="${errorMessage.substring(0, 80)}"`);
        const cancellationToken = token || new vscode.CancellationTokenSource().token;

        const REPAIR_TOOL_NAME = 'submit_fixed_animation';
        const repairToolSchema = {
            type: 'object',
            properties: {
                reasoning: { type: 'string', description: 'Step-by-step reasoning on why the error occurred and how to fix it.' },
                fixed_animation_js: { type: 'string', description: 'The corrected animation JavaScript code' },
                fix_explanation: { type: 'string', description: 'Brief explanation of what was fixed' }
            },
            required: ['reasoning', 'fixed_animation_js']
        };

        const repairPrompt = `You are Thoth Alpha. A Manim-style animation was generated for the query below, but it threw an error.
Fix the animation_js code so it runs without errors. The animation receives an \`api\` argument with { ctx, canvas, mjs, theme, fps }.

Original query: ${originalQuery}
Error message: ${errorMessage}

Broken code:
\`\`\`javascript
${brokenCode}
\`\`\`

First provide reasoning on why the error occurred, then submit the fixed code via the ${REPAIR_TOOL_NAME} tool.`;

        try {
            const messages = [vscode.LanguageModelChatMessage.User(repairPrompt)];
            const tool: vscode.LanguageModelChatTool = {
                name: REPAIR_TOOL_NAME,
                description: 'Submit the corrected animation JavaScript code.',
                inputSchema: repairToolSchema
            };

            const chatResponse = await model.sendRequest(
                messages,
                { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Required },
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
                log('Repair animation completed (tool-use)');
                sink.onDone(result);
                return result;
            } else if (textAccum) {
                const cleaned = textAccum.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/, '').trim();
                const result = JSON.stringify({ fixed_animation_js: cleaned, fix_explanation: 'Fixed via text fallback' });
                log('Repair animation completed (text fallback)');
                sink.onDone(result);
                return result;
            }
            throw new Error('Empty response from model');
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                sink.onCancelled();
                return undefined;
            }
            logError('Repair animation failed', err);
            sink.onError(err.message);
            return undefined;
        }
    }

    public static async handleDossierGeneration(
        query: string,
        modelId: string | undefined,
        sink: SearchProgressSink,
        token?: vscode.CancellationToken
    ): Promise<string | undefined> {
        const model = await ThothAgentEngine._selectModel(modelId);
        if (!model) {
            sink.onError('No language model found.');
            return undefined;
        }

        log(`Dossier generation started: query="${query.substring(0, 80)}"`);
        const cancellationToken = token || new vscode.CancellationTokenSource().token;

        const DOSSIER_TOOL_NAME = 'submit_dossier';
        const dossierToolSchema = {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Concise title for the research dossier' },
                summary: { type: 'string', description: '2-3 sentence summary of findings' },
                sections: {
                    type: 'array',
                    description: '3-8 sections covering different aspects of the topic',
                    items: {
                        type: 'object',
                        properties: {
                            heading: { type: 'string', description: 'Section heading' },
                            body_md: { type: 'string', description: 'Section content in Markdown. Use $ for inline math, $$ for display math. Reference sources by index: [1], [2].' },
                            citations: { type: 'array', items: { type: 'number' }, description: 'Indices into the sources array used in this section' }
                        },
                        required: ['heading', 'body_md']
                    }
                },
                sources: {
                    type: 'array',
                    description: 'Authoritative references. Real URLs only.',
                    items: {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            url: { type: 'string' },
                            publisher: { type: 'string' },
                            snippet: { type: 'string' }
                        },
                        required: ['title']
                    }
                }
            },
            required: ['title', 'summary', 'sections', 'sources']
        };

        const dossierPrompt = `You are Thoth Alpha Research. Generate a comprehensive research dossier on the given topic.

The dossier must have:
- A concise title
- A 2-3 sentence summary of key findings
- 3-8 well-organized sections, each with a heading and detailed markdown body
- 5-10 authoritative sources with real URLs

Each section should be substantive (200-500 words), use proper markdown formatting, and reference sources by index [1], [2] etc. Use $...$ for inline math and $$...$$ for display math where appropriate.

Submit via the ${DOSSIER_TOOL_NAME} tool.`;

        try {
            const messages = [
                vscode.LanguageModelChatMessage.User(dossierPrompt),
                vscode.LanguageModelChatMessage.User(`Research topic: ${query}`)
            ];
            const tool: vscode.LanguageModelChatTool = {
                name: DOSSIER_TOOL_NAME,
                description: 'Submit the complete research dossier.',
                inputSchema: dossierToolSchema
            };

            const chatResponse = await model.sendRequest(
                messages,
                { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Required },
                cancellationToken
            );

            let toolCallResult: Record<string, unknown> | undefined;
            let textAccum = '';
            let lastChunkTime = 0;

            for await (const part of chatResponse.stream) {
                if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCallResult = part.input as Record<string, unknown>;
                } else if (part instanceof vscode.LanguageModelTextPart) {
                    textAccum += part.value;
                    const now = Date.now();
                    if (now - lastChunkTime >= 300) {
                        sink.onChunk(textAccum);
                        lastChunkTime = now;
                    }
                }
            }

            if (toolCallResult) {
                const result = JSON.stringify(toolCallResult);
                log('Dossier generation completed (tool-use)');
                sink.onDone(result);
                return result;
            } else if (textAccum) {
                const cleaned = textAccum.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
                log('Dossier generation completed (text fallback)');
                sink.onDone(cleaned);
                return cleaned;
            }
            throw new Error('Empty response from model');
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                sink.onCancelled();
                return undefined;
            }
            logError('Dossier generation failed', err);
            sink.onError(err.message);
            return undefined;
        }
    }

    public static async handleDeepRun(
        query: string,
        modelId: string | undefined,
        onPlan: (subQuestions: string[]) => void,
        onStage: (stage: { kind: string; question?: string; text: string; citations?: any[] }) => void,
        onDone: (result: string) => void,
        onError: (msg: string) => void,
        token?: vscode.CancellationToken
    ): Promise<void> {
        const model = await ThothAgentEngine._selectModel(modelId);
        if (!model) {
            onError('No language model found.');
            return;
        }

        log(`Deep Run started: query="${query.substring(0, 80)}"`);
        const startTime = Date.now();
        const cancellationToken = token || new vscode.CancellationTokenSource().token;

        // Stage 1: Plan — decompose into sub-questions
        try {
            const planPrompt = `You are a research planner. Decompose the following research query into 3-5 focused sub-questions that together would fully answer the original query.

Return ONLY a JSON array of strings, each a self-contained sub-question. No markdown, no explanation.

Query: ${query}`;

            const planMessages = [vscode.LanguageModelChatMessage.User(planPrompt)];
            const planResponse = await model.sendRequest(planMessages, {}, cancellationToken);
            let planText = '';
            for await (const fragment of planResponse.text) {
                planText += fragment;
            }
            planText = planText.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

            let subQuestions: string[];
            try {
                subQuestions = JSON.parse(planText);
                if (!Array.isArray(subQuestions)) { throw new Error('Not an array'); }
            } catch {
                subQuestions = planText.split('\n').filter(l => l.trim().length > 10).slice(0, 5);
            }

            log(`Deep Run plan: ${subQuestions.length} sub-questions`);
            onPlan(subQuestions);

            // Stage 2: Research each sub-question
            for (let i = 0; i < subQuestions.length; i++) {
                if (cancellationToken.isCancellationRequested) {
                    onError('Deep Run cancelled.');
                    return;
                }

                const sq = subQuestions[i];
                const stageStart = Date.now();

                const researchPrompt = `You are a focused researcher. Answer this specific sub-question thoroughly and cite sources.

Sub-question: ${sq}
(Part of the larger query: ${query})

Provide a detailed answer in markdown. Include citations as [Title](URL) links. Be thorough but focused on this specific sub-question.`;

                const researchMessages = [vscode.LanguageModelChatMessage.User(researchPrompt)];
                const researchResponse = await model.sendRequest(researchMessages, {}, cancellationToken);
                let researchText = '';
                for await (const fragment of researchResponse.text) {
                    researchText += fragment;
                }

                const stage = {
                    kind: 'research' as const,
                    question: sq,
                    text: researchText,
                    ms: Date.now() - stageStart
                };
                log(`Deep Run stage ${i + 1}/${subQuestions.length} completed in ${stage.ms}ms`);
                onStage(stage);
            }

            // Stage 3: Synthesis — combine all research into final AlphaResult
            if (cancellationToken.isCancellationRequested) {
                onError('Deep Run cancelled.');
                return;
            }

            const researchSummary = subQuestions.map((sq, i) => `### Sub-question ${i + 1}: ${sq}`).join('\n');
            const synthSink: SearchProgressSink = {
                onChunk: () => {},
                onDone: (text) => {
                    const totalMs = Date.now() - startTime;
                    log(`Deep Run completed in ${totalMs}ms`);
                    onStage({ kind: 'synthesis', text });
                    onDone(text);
                },
                onError: (text) => onError(text),
                onCancelled: () => onError('Deep Run cancelled during synthesis.')
            };

            const synthQuery = `Synthesize the following research into a comprehensive answer for: ${query}\n\n${researchSummary}\n\nProvide a thorough, well-structured answer that integrates all sub-question findings.`;

            await ThothAgentEngine.handleSearch(
                synthQuery, modelId, synthSink, cancellationToken
            );
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                onError('Deep Run cancelled.');
                return;
            }
            logError('Deep Run failed', err);
            onError(err.message);
        }
    }

    private static async _generateCourseOutline(
        model: vscode.LanguageModelChat,
        topic: string,
        dossierContext: string | undefined,
        cancellationToken: vscode.CancellationToken
    ): Promise<CourseOutline | undefined> {
        const TOOL_NAME = 'submit_course_outline';
        const toolSchema = {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Course title' },
                description: { type: 'string', description: '2-3 sentence course description' },
                sections: {
                    type: 'array', description: '2-6 course sections',
                    items: {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            lessons: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        title: { type: 'string' },
                                        slideDescriptions: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    title: { type: 'string', description: 'Slide title' },
                                                    description: { type: 'string', description: 'One-line description of what this slide covers' }
                                                },
                                                required: ['title', 'description']
                                            }
                                        }
                                    },
                                    required: ['title', 'slideDescriptions']
                                }
                            }
                        },
                        required: ['title', 'lessons']
                    }
                },
                vocabularyPlan: {
                    type: 'array', description: 'Ordered list of technical terms introduced in the course',
                    items: {
                        type: 'object',
                        properties: {
                            term: { type: 'string' },
                            introducedInLesson: { type: 'number', description: 'Zero-based lesson index (across all sections) where this term is first introduced' },
                            definition: { type: 'string', description: 'Plain-language definition' }
                        },
                        required: ['term', 'introducedInLesson', 'definition']
                    }
                }
            },
            required: ['title', 'description', 'sections', 'vocabularyPlan']
        };

        const dossierBlock = dossierContext
            ? `\n\nUse this research dossier as the primary source for course content:\n${dossierContext.substring(0, 8000)}`
            : '';

        const prompt = `You are an expert curriculum designer. Plan the structure of a comprehensive course on the given topic.

Generate ONLY the course outline — do NOT write slide content yet. For each slide, provide just a title and a one-line description of what it will cover.

The outline must have:
- 2-6 sections, each containing 1-4 lessons
- Each lesson has 2-5 slides
- Each slide has a title and a brief description (one sentence)

You must also produce a vocabularyPlan: an ordered list of every technical term or concept the course will introduce. For each term, specify which lesson (zero-based index across all sections) introduces it, and give a plain-language definition. Terms must be ordered so that no lesson uses a term that hasn't been introduced yet.
${dossierBlock}

Submit via the ${TOOL_NAME} tool.`;

        const messages = [
            vscode.LanguageModelChatMessage.User(prompt),
            vscode.LanguageModelChatMessage.User(`Topic: ${topic}`)
        ];
        const tool: vscode.LanguageModelChatTool = {
            name: TOOL_NAME,
            description: 'Submit the course outline with vocabulary plan.',
            inputSchema: toolSchema
        };

        const chatResponse = await model.sendRequest(
            messages,
            { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Required },
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

        const raw = toolCallResult || (textAccum ? JSON.parse(textAccum.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim()) : undefined);
        if (!raw) { return undefined; }
        return raw as unknown as CourseOutline;
    }

    private static async _generateLessonContent(
        model: vscode.LanguageModelChat,
        lessonInfo: { title: string; slideDescriptions: { title: string; description: string }[] },
        courseContext: { courseTitle: string; totalLessons: number; lessonIndex: number; outlineSummary: string },
        termsAlreadyIntroduced: string[],
        termsToIntroduce: { term: string; definition: string }[],
        cancellationToken: vscode.CancellationToken
    ): Promise<{ slides: { title: string; markdown: string; courseText: string; narrationScript: string; newTerms: string[] }[] } | undefined> {
        const TOOL_NAME = 'submit_lesson_content';
        const toolSchema = {
            type: 'object',
            properties: {
                slides: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            markdown: { type: 'string', description: 'Rich slide content: key points, examples, code blocks, formulas ($ for inline math, $$ for display). Visual and scannable.' },
                            courseText: { type: 'string', description: '2-4 paragraphs of clear explanatory prose that teaches the concept. Must stand alone as readable text.' },
                            narrationScript: { type: 'string', description: 'Speaker notes for presenting this slide.' },
                            newTerms: { type: 'array', items: { type: 'string' }, description: 'Technical terms introduced and defined in this slide.' }
                        },
                        required: ['title', 'markdown', 'courseText', 'narrationScript', 'newTerms']
                    }
                }
            },
            required: ['slides']
        };

        const slideList = lessonInfo.slideDescriptions
            .map((s, i) => `  ${i + 1}. "${s.title}" — ${s.description}`)
            .join('\n');

        const knownTerms = termsAlreadyIntroduced.length > 0
            ? termsAlreadyIntroduced.join(', ')
            : '(none — this is the beginning of the course)';

        const termsToDefine = termsToIntroduce.length > 0
            ? termsToIntroduce.map(t => `"${t.term}" — ${t.definition}`).join('\n  ')
            : '(no new technical terms in this lesson)';

        const prompt = `You are writing lesson ${courseContext.lessonIndex + 1} of ${courseContext.totalLessons} in a course titled "${courseContext.courseTitle}".

This lesson is called "${lessonInfo.title}" and covers these slides:
${slideList}

WRITING RULES — follow these strictly:

1. COURSE TEXT: Each slide's courseText must be 2-4 paragraphs of clear, explanatory prose that thoroughly teaches the concept. Write as if the reader has no prior knowledge of this topic beyond what was covered in previous lessons. Use concrete examples, analogies, and step-by-step reasoning.

2. VOCABULARY: When you introduce a technical term, define it immediately in plain language the first time you use it. Never use jargon, acronyms, or technical language that hasn't been defined — either in this lesson or in a previous one.

3. Terms already introduced (you may use these freely without re-defining):
   ${knownTerms}

4. Terms you MUST introduce and define in THIS lesson:
   ${termsToDefine}

5. SLIDE MARKDOWN: The markdown field should be rich visual content for a slide view — key points as bullet points, code examples in fenced blocks, formulas with $ and $$, tables where helpful. This complements the courseText but is distinct from it.

6. NARRATION: Write speaker notes as if a teacher is presenting to a class — conversational, guiding, occasionally noting common mistakes or misconceptions.

Course outline for context:
${courseContext.outlineSummary}

Submit via the ${TOOL_NAME} tool.`;

        const messages = [
            vscode.LanguageModelChatMessage.User(prompt)
        ];
        const tool: vscode.LanguageModelChatTool = {
            name: TOOL_NAME,
            description: 'Submit the full content for this lesson.',
            inputSchema: toolSchema
        };

        const chatResponse = await model.sendRequest(
            messages,
            { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Required },
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

        const raw = toolCallResult || (textAccum ? JSON.parse(textAccum.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim()) : undefined);
        if (!raw) { return undefined; }
        return raw as unknown as { slides: { title: string; markdown: string; courseText: string; narrationScript: string; newTerms: string[] }[] };
    }

    public static async handleGenerateCourse(
        topic: string,
        modelId: string | undefined,
        sink: CourseGenerationSink,
        token?: vscode.CancellationToken,
        dossierContext?: string
    ): Promise<string | undefined> {
        const model = await ThothAgentEngine._selectModel(modelId);
        if (!model) {
            sink.onError('No language model found.');
            return undefined;
        }

        log(`Course generation started: topic="${topic.substring(0, 80)}"`);
        const cancellationToken = token || new vscode.CancellationTokenSource().token;

        try {
            // Phase 1: Generate outline
            sink.onPhase('outline');
            const outline = await ThothAgentEngine._generateCourseOutline(model, topic, dossierContext, cancellationToken);
            if (!outline) { throw new Error('Failed to generate course outline'); }
            log(`Course outline generated: ${outline.title}, ${outline.sections.length} sections`);

            // Flatten lessons for sequential processing
            const allLessons: { sectionIndex: number; sectionTitle: string; lessonIndex: number; lesson: CourseOutline['sections'][0]['lessons'][0] }[] = [];
            for (let si = 0; si < outline.sections.length; si++) {
                for (let li = 0; li < outline.sections[si].lessons.length; li++) {
                    allLessons.push({
                        sectionIndex: si,
                        sectionTitle: outline.sections[si].title,
                        lessonIndex: allLessons.length,
                        lesson: outline.sections[si].lessons[li]
                    });
                }
            }
            const totalLessons = allLessons.length;

            // Build compact outline summary for context
            const outlineSummary = outline.sections.map(s =>
                `${s.title}: ${s.lessons.map(l => l.title).join(', ')}`
            ).join('\n');

            // Phase 2: Generate content lesson by lesson
            sink.onPhase('content', 0, totalLessons);
            const termsIntroduced: string[] = [];
            const generatedSections = outline.sections.map(s => ({
                title: s.title,
                lessons: s.lessons.map(l => ({
                    title: l.title,
                    slides: l.slideDescriptions.map(sd => ({
                        title: sd.title,
                        markdown: sd.description,
                        courseText: '',
                        narrationScript: '',
                        newTerms: [] as string[]
                    }))
                }))
            }));

            for (const entry of allLessons) {
                if (cancellationToken.isCancellationRequested) {
                    log('Course generation cancelled mid-content');
                    break;
                }

                const termsForLesson = (outline.vocabularyPlan || [])
                    .filter(v => v.introducedInLesson === entry.lessonIndex)
                    .map(v => ({ term: v.term, definition: v.definition }));

                try {
                    const lessonContent = await ThothAgentEngine._generateLessonContent(
                        model,
                        entry.lesson,
                        { courseTitle: outline.title, totalLessons, lessonIndex: entry.lessonIndex, outlineSummary },
                        [...termsIntroduced],
                        termsForLesson,
                        cancellationToken
                    );

                    if (lessonContent?.slides) {
                        const section = generatedSections[entry.sectionIndex];
                        const lessonInSection = outline.sections[entry.sectionIndex].lessons.indexOf(entry.lesson);
                        const targetLesson = section.lessons[lessonInSection];

                        for (let i = 0; i < targetLesson.slides.length && i < lessonContent.slides.length; i++) {
                            targetLesson.slides[i] = lessonContent.slides[i];
                        }
                        if (lessonContent.slides.length > targetLesson.slides.length) {
                            targetLesson.slides.push(...lessonContent.slides.slice(targetLesson.slides.length));
                        }

                        for (const slide of lessonContent.slides) {
                            if (slide.newTerms) {
                                termsIntroduced.push(...slide.newTerms);
                            }
                        }
                    }
                } catch (lessonErr: any) {
                    log(`Warning: lesson "${entry.lesson.title}" content generation failed: ${lessonErr.message}`);
                }

                sink.onLessonComplete(entry.lessonIndex, totalLessons, entry.lesson.title);
                sink.onPhase('content', entry.lessonIndex + 1, totalLessons);
            }

            const result = JSON.stringify({
                title: outline.title,
                description: outline.description,
                sections: generatedSections,
                vocabularyPlan: termsIntroduced,
                generationVersion: 2
            });

            log('Course generation completed');
            sink.onDone(result);
            return result;
        } catch (err: any) {
            if (err instanceof vscode.CancellationError || err.name === 'Canceled') {
                sink.onCancelled();
                return undefined;
            }
            logError('Course generation failed', err);
            sink.onError(err.message);
            return undefined;
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
        const tmpFile = path.join(os.tmpdir(), `thoth_${crypto.randomBytes(16).toString('hex')}.${ext}`);
        await fs.promises.writeFile(tmpFile, code, 'utf8');
        const terminal = vscode.window.createTerminal({ name: `Thoth: ${language}` });
        terminal.show();
        terminal.sendText(`${runner} "${tmpFile}"`);
        const cleanupDisposable = vscode.window.onDidCloseTerminal(async (closed) => {
            if (closed === terminal) {
                cleanupDisposable.dispose();
                await fs.promises.unlink(tmpFile).catch(() => {});
            }
        });
        log(`Opened terminal for ${language} execution`);
    }
}
