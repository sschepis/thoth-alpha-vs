import * as vscode from 'vscode';
import { ThothPanel } from './ThothPanel';

export class ThothStatusBar implements vscode.Disposable {
    private readonly _item: vscode.StatusBarItem;
    private _disposables: vscode.Disposable[] = [];

    constructor() {
        this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this._item.command = 'thothAlpha.openSearch';
        this._setIdle();
        this._item.show();

        this._disposables.push(
            ThothPanel.onSearchStateChanged(searching => {
                if (searching) {
                    this._setSearching();
                } else {
                    this._setIdle();
                }
            })
        );
    }

    private _setIdle() {
        this._item.text = '$(beaker) Thoth Alpha';
        this._item.tooltip = 'Open Thoth Alpha Search';
    }

    private _setSearching() {
        this._item.text = '$(sync~spin) Thoth: Searching...';
        this._item.tooltip = 'Thoth Alpha search in progress';
    }

    dispose() {
        this._item.dispose();
        this._disposables.forEach(d => d.dispose());
    }
}
