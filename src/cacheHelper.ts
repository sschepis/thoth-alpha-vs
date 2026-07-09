import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_CACHE_FILES = 200;

interface CacheEntry {
    query: string;
    response: string;
    timestamp: number;
}

function cacheDir(): string | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { return undefined; }
    const dir = path.join(ws, '.thothalpha', 'cache');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function cacheFilePath(query: string): string | undefined {
    const dir = cacheDir();
    if (!dir) { return undefined; }
    const hash = crypto.createHash('sha256').update(query.trim()).digest('hex');
    return path.join(dir, `${hash}.json`);
}

async function evictCacheIfNeeded(): Promise<void> {
    const dir = cacheDir();
    if (!dir) { return; }

    try {
        const files = await fs.promises.readdir(dir);
        const jsonFiles = files.filter(f => f.endsWith('.json'));
        if (jsonFiles.length === 0) { return; }

        const fileStats = await Promise.all(
            jsonFiles.map(async (f) => {
                const fp = path.join(dir, f);
                const stat = await fs.promises.stat(fp);
                return { file: f, mtime: stat.mtimeMs, size: stat.size };
            })
        );
        fileStats.sort((a, b) => a.mtime - b.mtime);

        const totalSize = fileStats.reduce((sum, f) => sum + f.size, 0);
        const overCount = jsonFiles.length - MAX_CACHE_FILES;
        const overSize = totalSize - MAX_CACHE_SIZE_BYTES;
        if (overCount <= 0 && overSize <= 0) { return; }

        let remainingCount = jsonFiles.length;
        let remainingSize = totalSize;
        const countTarget = MAX_CACHE_FILES * 0.75;
        const sizeTarget = MAX_CACHE_SIZE_BYTES * 0.75;
        const toRemove: string[] = [];

        for (const entry of fileStats) {
            if (remainingCount <= countTarget && remainingSize <= sizeTarget) { break; }
            toRemove.push(entry.file);
            remainingCount--;
            remainingSize -= entry.size;
        }

        await Promise.all(
            toRemove.map(f => fs.promises.unlink(path.join(dir, f)).catch(() => {}))
        );
    } catch {
        // Eviction is best-effort
    }
}

export async function getCachePath(query: string): Promise<string | undefined> {
    return cacheFilePath(query);
}

export async function getCachedResponse(query: string): Promise<string | undefined> {
    const filePath = cacheFilePath(query);
    if (!filePath) { return undefined; }

    try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const entry: CacheEntry = JSON.parse(raw);
        const age = Date.now() - entry.timestamp;
        if (age > DEFAULT_TTL_MS) {
            await fs.promises.unlink(filePath).catch(() => {});
            return undefined;
        }
        return entry.response;
    } catch {
        return undefined;
    }
}

export async function saveCachedResponse(query: string, response: string): Promise<void> {
    const filePath = cacheFilePath(query);
    if (!filePath) { return; }

    try {
        const entry: CacheEntry = { query: query.trim(), response, timestamp: Date.now() };
        await fs.promises.writeFile(filePath, JSON.stringify(entry), 'utf8');
        await evictCacheIfNeeded();
    } catch {
        // Best-effort caching
    }
}

export async function clearCache(): Promise<void> {
    const dir = cacheDir();
    if (dir) {
        try {
            const files = await fs.promises.readdir(dir);
            await Promise.all(
                files.filter(f => f.endsWith('.json'))
                    .map(f => fs.promises.unlink(path.join(dir, f)).catch(() => {}))
            );
        } catch {
            // Best-effort
        }
    }

    // Also clean up orphaned old-format cache files from .thothalpha/ root
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
        const oldDir = path.join(ws, '.thothalpha');
        try {
            const oldFiles = await fs.promises.readdir(oldDir);
            for (const f of oldFiles) {
                if (!f.endsWith('.json')) { continue; }
                const fp = path.join(oldDir, f);
                try {
                    const raw = await fs.promises.readFile(fp, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (typeof parsed === 'string' || (parsed && typeof parsed.response === 'string' && !parsed.timestamp)) {
                        await fs.promises.unlink(fp).catch(() => {});
                    }
                } catch {
                    // Skip unparseable files or non-cache files
                }
            }
        } catch {
            // Best-effort
        }
    }
}
