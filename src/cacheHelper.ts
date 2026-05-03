import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

export async function getCachePath(query: string): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined; // Not in a workspace, don't cache
    }
    const cacheDir = path.join(workspaceFolders[0].uri.fsPath, '.thothalpha');
    try {
        await fs.promises.access(cacheDir);
    } catch {
        await fs.promises.mkdir(cacheDir, { recursive: true });
    }
    const hash = crypto.createHash('md5').update(query.trim()).digest('hex');
    return path.join(cacheDir, `${hash}.json`);
}

export async function getCachedResponse(query: string): Promise<string | undefined> {
    const cacheFilePath = await getCachePath(query);
    if (cacheFilePath) {
        try {
            return await fs.promises.readFile(cacheFilePath, 'utf8');
        } catch (e) {
            // Error reading file or doesn't exist
        }
    }
    return undefined;
}

export async function saveCachedResponse(query: string, response: string): Promise<void> {
    const cacheFilePath = await getCachePath(query);
    if (cacheFilePath) {
        try {
            await fs.promises.writeFile(cacheFilePath, response, 'utf8');
        } catch (e) {
            // Error writing file
        }
    }
}
