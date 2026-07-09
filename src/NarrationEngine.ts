import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface NarrationSettings {
    voiceId: string;
    speed: number;
    style: number;
    stability: number;
    mode: 'literal' | 'rewrite';
    autoplay: boolean;
    syncMode: 'audio' | 'timeline';
}

export interface NarrationVoice {
    id: string;
    name: string;
    description: string;
}

export const VOICES: NarrationVoice[] = [
    { id: 'GXFT8TF3KUtS6L4yLR0S', name: 'Atlas', description: 'Educational narrator (default)' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'Clear, neutral' },
    { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'Warm British baritone' },
    { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', description: 'Friendly, conversational' },
    { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', description: 'Authoritative' },
    { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', description: 'Bright, expressive' }
];

const DEFAULT_SETTINGS: NarrationSettings = {
    voiceId: 'GXFT8TF3KUtS6L4yLR0S',
    speed: 1.0,
    style: 0.3,
    stability: 0.5,
    mode: 'literal',
    autoplay: true,
    syncMode: 'audio'
};

const SETTINGS_KEY = 'thothAlpha.narrationSettings';

let _secrets: vscode.SecretStorage | undefined;
let _globalState: vscode.Memento | undefined;
let _outputChannel: vscode.LogOutputChannel | undefined;

function redactSecrets(text: string): string {
    return text.replace(/[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
        .replace(/xi-api-key[:\s]+\S+/gi, 'xi-api-key: [REDACTED]')
        .replace(/"apiKey"\s*:\s*"[^"]+"/gi, '"apiKey":"[REDACTED]"');
}

function log(msg: string) { _outputChannel?.info(`[Narration] ${msg}`); }
function logError(msg: string, err?: any) { _outputChannel?.error(`[Narration] ${msg}`, err); }

export function initNarration(secrets: vscode.SecretStorage, globalState: vscode.Memento, outputChannel: vscode.LogOutputChannel) {
    _secrets = secrets;
    _globalState = globalState;
    _outputChannel = outputChannel;
}

export function getSettings(): NarrationSettings {
    return _globalState?.get<NarrationSettings>(SETTINGS_KEY) || { ...DEFAULT_SETTINGS };
}

export async function saveSettings(settings: Partial<NarrationSettings>): Promise<NarrationSettings> {
    const current = getSettings();
    const updated = { ...current, ...settings };
    await _globalState?.update(SETTINGS_KEY, updated);
    return updated;
}

function sanitizeForSpeech(text: string): string {
    let s = text;
    s = s.replace(/\$\$([\s\S]*?)\$\$/g, ' [math expression] ');
    s = s.replace(/\$(.*?)\$/g, (_, tex) => {
        let spoken = tex;
        spoken = spoken.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '$1 over $2');
        spoken = spoken.replace(/\\sqrt\{([^}]*)\}/g, 'square root of $1');
        spoken = spoken.replace(/\\pi/g, 'pi');
        spoken = spoken.replace(/\\theta/g, 'theta');
        spoken = spoken.replace(/\\alpha/g, 'alpha');
        spoken = spoken.replace(/\\beta/g, 'beta');
        spoken = spoken.replace(/\\infty/g, 'infinity');
        spoken = spoken.replace(/\\int/g, 'integral of');
        spoken = spoken.replace(/\\sum/g, 'sum of');
        spoken = spoken.replace(/[\\{}^_]/g, ' ');
        return spoken.trim();
    });
    s = s.replace(/```[\s\S]*?```/g, ' [code block] ');
    s = s.replace(/`[^`]+`/g, (m) => m.replace(/`/g, ''));
    s = s.replace(/#{1,6}\s/g, '');
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    s = s.replace(/[*_~]+/g, '');
    s = s.replace(/\n{2,}/g, '. ');
    s = s.replace(/\n/g, ' ');
    s = s.replace(/\s{2,}/g, ' ');
    return s.trim();
}

function cacheDir(): string | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { return undefined; }
    const dir = path.join(ws, '.thothalpha', 'narration-cache');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function cacheKey(text: string, voiceId: string, mode: string): string {
    return crypto.createHash('md5').update(`${voiceId}:${mode}:${text}`).digest('hex');
}

export async function handleNarrate(
    text: string,
    settings?: Partial<NarrationSettings>
): Promise<{ audioBase64: string } | undefined> {
    const apiKey = await _secrets?.get('elevenLabsApiKey') || '';
    if (!apiKey) {
        vscode.window.showErrorMessage('ElevenLabs API key not configured. Run "Thoth Alpha: Set ElevenLabs API Key".');
        return undefined;
    }

    const opts = { ...getSettings(), ...settings };
    let spokenText = opts.mode === 'literal' ? sanitizeForSpeech(text) : text;

    if (opts.mode === 'rewrite') {
        spokenText = await rewriteForSpeech(spokenText) || sanitizeForSpeech(text);
    }

    const dir = cacheDir();
    const key = cacheKey(spokenText, opts.voiceId, opts.mode);
    if (dir) {
        const cached = path.join(dir, `${key}.mp3`);
        if (fs.existsSync(cached)) {
            log(`Cache hit for narration: ${key}`);
            const data = await fs.promises.readFile(cached);
            return { audioBase64: data.toString('base64') };
        }
    }

    log(`Narrating ${spokenText.length} chars with voice ${opts.voiceId}`);

    return new Promise((resolve) => {
        const postData = JSON.stringify({
            text: spokenText.substring(0, 5000),
            model_id: 'eleven_turbo_v2_5',
            voice_settings: {
                stability: opts.stability,
                similarity_boost: 0.75,
                style: opts.style,
                use_speaker_boost: true,
                speed: opts.speed
            }
        });

        const req = https.request({
            hostname: 'api.elevenlabs.io',
            path: `/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}/stream`,
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                let errorBody = '';
                res.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
                res.on('end', () => {
                    logError(`ElevenLabs error (${res.statusCode})`, redactSecrets(errorBody));
                    resolve(undefined);
                });
                return;
            }

            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
            res.on('end', () => {
                const audioBuffer = Buffer.concat(chunks);
                const audioBase64 = audioBuffer.toString('base64');

                if (dir) {
                    const cached = path.join(dir, `${key}.mp3`);
                    fs.promises.writeFile(cached, audioBuffer).catch(() => {});
                }

                log(`Narration complete: ${audioBuffer.length} bytes`);
                resolve({ audioBase64 });
            });
            res.on('error', (err) => {
                logError('ElevenLabs stream error', err);
                resolve(undefined);
            });
        });

        req.on('error', (err) => {
            logError('ElevenLabs request failed', err);
            resolve(undefined);
        });

        req.write(postData);
        req.end();
    });
}

async function rewriteForSpeech(text: string): Promise<string | undefined> {
    try {
        const models = await vscode.lm.selectChatModels();
        const model = models[0];
        if (!model) { return undefined; }

        const messages = [
            vscode.LanguageModelChatMessage.User(
                `Rewrite the following text into natural spoken English suitable for a 60-120 second narration. Remove all LaTeX, markdown formatting, and code blocks. Convert math into spoken language. Keep it engaging and educational.\n\nText:\n${text.substring(0, 3000)}`
            )
        ];

        const response = await model.sendRequest(messages, {});
        let result = '';
        for await (const fragment of response.text) {
            result += fragment;
        }
        return result.trim();
    } catch (err) {
        logError('Rewrite for speech failed', err);
        return undefined;
    }
}
