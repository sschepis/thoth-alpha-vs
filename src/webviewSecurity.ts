import * as vscode from 'vscode';

export const DEFAULT_CSP = (webview: vscode.Webview, extraScriptSrc?: string, allowInline?: boolean): string => {
    const scriptSrcParts = [webview.cspSource];
    if (extraScriptSrc) { scriptSrcParts.push(extraScriptSrc); }
    if (allowInline) { scriptSrcParts.push("'unsafe-inline'"); }
    const scriptSrc = scriptSrcParts.join(' ');
    return [
        "default-src 'none'",
        `script-src ${scriptSrc}`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `img-src ${webview.cspSource} data:`,
        `font-src ${webview.cspSource} data:`,
        "connect-src 'self' https:",
        "media-src 'self' data:",
    ].join('; ');
};

export function setWebviewSecurity(webview: vscode.Webview, extraScriptSrc?: string, allowInline?: boolean): void {
    const opts = webview.options;
    (opts as any).enableCommandUris = false;
    (opts as any).enableFindWidget = false;
    if (!(opts as any).contentSecurityPolicy) {
        (opts as any).contentSecurityPolicy = DEFAULT_CSP(webview, extraScriptSrc, allowInline);
    }
    webview.options = opts;
}

export function isSensitiveFile(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    const basename = normalized.split('/').pop() || '';

    const sensitiveBasenames = new Set([
        '.env', '.git-credentials', '.npmrc', '.dockercfg',
        'id_rsa', 'id_ed25519', 'id_ecdsa', 'kubeconfig',
        'credentials', 'secrets.json', 'secrets.yml',
    ]);
    if (sensitiveBasenames.has(basename)) { return true; }

    if (basename.endsWith('.pem') || basename.endsWith('.key')) { return true; }
    if (/^\.env\./.test(basename)) { return true; }
    if (/\.token$/i.test(basename)) { return true; }
    if (/secret/i.test(basename)) { return true; }
    if (/credential/i.test(basename)) { return true; }

    if (normalized.includes('/.ssh/')) { return true; }
    if (normalized.includes('/.aws/')) { return true; }
    if (normalized.includes('/.gcloud/')) { return true; }
    if (/kubeconfig/i.test(normalized)) { return true; }

    return false;
}
