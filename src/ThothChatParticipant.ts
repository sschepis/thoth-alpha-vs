import * as vscode from 'vscode';
import { ThothAgentEngine, ConversationMessage, SearchProgressSink } from './ThothAgentEngine';

class ChatSearchSink implements SearchProgressSink {
    private _fullText = '';
    constructor(private readonly stream: vscode.ChatResponseStream) {}
    onChunk(_text: string) {
        // Chat streams markdown progressively; we wait for onDone to parse JSON
    }
    onDone(text: string) { this._fullText = text; }
    onError(text: string) { this.stream.markdown(`\n\n**Error:** ${text}`); }
    onCancelled() { this.stream.markdown('\n\n*Search cancelled.*'); }
    getResult(): string { return this._fullText; }
}

export function registerChatParticipant(context: vscode.ExtensionContext): void {
    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ) => {
        const query = request.prompt;
        if (!query.trim()) {
            stream.markdown('Please provide a computational query. For example: `@thoth What is the escape velocity of Mars?`');
            return;
        }

        const conversationHistory: ConversationMessage[] = [];
        for (const turn of _chatContext.history) {
            if (turn instanceof vscode.ChatRequestTurn) {
                conversationHistory.push({ role: 'user', content: turn.prompt });
            } else if (turn instanceof vscode.ChatResponseTurn) {
                const parts = turn.response.map(p => {
                    if (p instanceof vscode.ChatResponseMarkdownPart) {
                        return p.value.value;
                    }
                    return '';
                }).join('');
                if (parts) {
                    conversationHistory.push({ role: 'assistant', content: parts });
                }
            }
        }

        const sink = new ChatSearchSink(stream);
        await ThothAgentEngine.handleSearch(query, undefined, sink, token, conversationHistory);

        const rawResult = sink.getResult();
        if (!rawResult) { return; }

        try {
            const result = JSON.parse(rawResult);

            if (result.interpretation) {
                stream.markdown(`**${result.interpretation}**\n\n`);
            }

            if (result.result_summary) {
                stream.markdown(`> ${result.result_summary}\n\n`);
            }

            if (result.explanation_md) {
                stream.markdown(result.explanation_md + '\n\n');
            }

            if (result.table_data?.headers && result.table_data?.rows) {
                const { headers, rows } = result.table_data;
                stream.markdown('| ' + headers.join(' | ') + ' |\n');
                stream.markdown('| ' + headers.map(() => '---').join(' | ') + ' |\n');
                for (const row of rows) {
                    stream.markdown('| ' + row.join(' | ') + ' |\n');
                }
                stream.markdown('\n');
            }

            if (result.executable_code) {
                stream.markdown(`\`\`\`${result.executable_code.language}\n${result.executable_code.code}\n\`\`\`\n\n`);
            }

            if (result.simulation_js) {
                stream.button({
                    title: 'View Simulation in Thoth Panel',
                    command: 'thothAlpha.openSearch'
                });
            }

            if (result.related_queries?.length) {
                stream.markdown('**Related queries:** ' + result.related_queries.map((q: string) => `\`${q}\``).join(', ') + '\n');
            }
        } catch {
            stream.markdown(rawResult);
        }
    };

    const participant = vscode.chat.createChatParticipant('thoth-alpha.thoth', handler);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
    context.subscriptions.push(participant);
}
