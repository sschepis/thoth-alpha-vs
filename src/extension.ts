import * as vscode from 'vscode';
import { ThothPanel } from './ThothPanel';
import { ThothEditorProvider } from './ThothEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Thoth Alpha extension is now active!');

    context.subscriptions.push(
        vscode.commands.registerCommand('thothAlpha.openSearch', () => {
            ThothPanel.createOrShow(context.extensionUri);
        })
    );

    context.subscriptions.push(
        ThothEditorProvider.register(context)
    );
}

export function deactivate() {}
