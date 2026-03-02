/**
 * WxO System Editor Panel
 * Edit system config (name, URL, API key). Extension as source of truth.
 * Syncs to orchestrate CLI on save.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 28 Feb 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';
import { getEffectiveEnv } from '../utils/wxoEnv.js';
import { getCredentialsService } from '../services/credentialsContext.js';
import { WxOSystemsConfigService } from '../services/WxOSystemsConfigService.js';

function getWxORoot(): string {
    const cfg = vscode.workspace.getConfiguration('wxo-toolkit-vsc');
    const custom = cfg.get<string>('wxoRoot')?.trim();
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    if (custom) {
        return path.isAbsolute(custom) ? custom : path.join(ws, custom);
    }
    return path.join(ws, 'WxO');
}

function esc(s: string): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export class WxOSystemEditorPanel {
    private static _panels = new Map<string, WxOSystemEditorPanel>();
    private readonly _panel: vscode.WebviewPanel;
    private readonly _editName: string | undefined;
    private readonly _systemsConfig: WxOSystemsConfigService;
    private readonly _disposables: vscode.Disposable[] = [];
    private _onSaved?: () => void;

    public static render(
        extensionUri: vscode.Uri,
        options: { name: string; url: string; hasApiKey: boolean } | null,
        onSaved?: () => void,
    ): void {
        const key = options?.name ?? '__new__';
        const existing = WxOSystemEditorPanel._panels.get(key);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const title = options ? `Edit System: ${options.name}` : 'Add System';
        const panel = vscode.window.createWebviewPanel(
            'wxoSystemEditor',
            title,
            vscode.ViewColumn.One,
            { enableScripts: true },
        );
        const config = new WxOSystemsConfigService(getWxORoot);
        const instance = new WxOSystemEditorPanel(panel, options, config);
        instance._onSaved = onSaved;
        WxOSystemEditorPanel._panels.set(key, instance);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        options: { name: string; url: string; hasApiKey: boolean } | null,
        systemsConfig: WxOSystemsConfigService,
    ) {
        this._panel = panel;
        this._editName = options?.name;
        this._systemsConfig = systemsConfig;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtml(options);

        this._panel.webview.onDidReceiveMessage(
            async (msg: Record<string, unknown>) => {
                try {
                    if (msg.command === 'save') await this._handleSave(msg);
                    else if (msg.command === 'close') this.dispose();
                } catch (e) {
                    const m = e instanceof Error ? e.message : String(e);
                    this._panel.webview.postMessage({ command: 'status', message: m, isError: true });
                }
            },
            undefined,
            this._disposables,
        );
    }

    private _getHtml(options: { name: string; url: string; hasApiKey: boolean } | null): string {
        const editMode = !!options;
        const name = options?.name ?? '';
        const url = options?.url ?? '';
        const hasApiKey = options?.hasApiKey ?? false;

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${editMode ? 'Edit' : 'Add'} System</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: 13px; padding: 16px; margin: 0; color: var(--vscode-foreground); }
    .form-group { margin-bottom: 14px; }
    label { display: block; margin-bottom: 4px; font-weight: 600; font-size: 12px; }
    .hint { font-size: 11px; opacity: 0.7; margin-top: 4px; }
    input { width: 100%; padding: 6px 10px; font-size: 13px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
    button { padding: 6px 16px; font-size: 13px; cursor: pointer; border-radius: 4px; border: none; margin-right: 8px; }
    .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-row { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--vscode-widget-border); }
    #status { font-size: 12px; margin-top: 10px; }
    #status.err { color: var(--vscode-errorForeground); }
    #status.ok { color: var(--vscode-terminal-ansiGreen); }
  </style>
</head>
<body>
  <h2 style="margin-top:0;">${editMode ? 'Edit System' : 'Add System'}</h2>
  <p class="hint">System config (name, URL, API key) is stored by the extension and synced to the orchestrate CLI. API key is saved securely.</p>

  <div class="form-group">
    <label for="fName">Name <span class="hint">(e.g. TZ1, PROD)</span></label>
    <input type="text" id="fName" value="${esc(name)}" placeholder="TZ1" ${editMode ? 'readonly' : ''} />
  </div>
  <div class="form-group">
    <label for="fUrl">Instance URL</label>
    <input type="text" id="fUrl" value="${esc(url)}" placeholder="https://api.us-south.watson-orchestrate.cloud.ibm.com/instances/..." />
  </div>
  <div class="form-group">
    <label for="fApiKey">API Key <span class="hint">(leave empty to keep existing)</span></label>
    <input type="password" id="fApiKey" placeholder="${hasApiKey ? '•••••••• (enter to replace)' : 'Enter API key'}" autocomplete="new-password" />
  </div>

  <div class="btn-row">
    <button class="primary" id="btnSave">Save</button>
    <button class="secondary" id="btnClose">Cancel</button>
  </div>
  <div id="status"></div>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('btnSave').addEventListener('click', function() {
      var name = document.getElementById('fName').value.trim();
      var url = document.getElementById('fUrl').value.trim();
      var apiKey = document.getElementById('fApiKey').value;
      if (!name) { document.getElementById('status').textContent = 'Name is required.'; document.getElementById('status').className = 'err'; return; }
      if (!url) { document.getElementById('status').textContent = 'URL is required.'; document.getElementById('status').className = 'err'; return; }
      document.getElementById('status').textContent = 'Saving...';
      document.getElementById('status').className = '';
      vscode.postMessage({ command: 'save', name: name, url: url, apiKey: apiKey ? apiKey.trim() : '' });
    });
    document.getElementById('btnClose').addEventListener('click', function() { vscode.postMessage({ command: 'close' }); });
    window.addEventListener('message', function(e) {
      var m = e.data;
      if (m.command === 'status') {
        document.getElementById('status').textContent = m.message || '';
        document.getElementById('status').className = m.isError ? 'err' : 'ok';
      }
    });
  </script>
</body>
</html>`;
    }

    private async _handleSave(msg: Record<string, unknown>): Promise<void> {
        const name = (msg.name as string)?.trim();
        const url = (msg.url as string)?.trim();
        const apiKey = (msg.apiKey as string)?.trim();

        if (!name) throw new Error('Name is required.');
        if (!url) throw new Error('URL is required.');

        const creds = getCredentialsService();
        const env = getEffectiveEnv();

        const nameChanged = this._editName && this._editName !== name;
        const oldEntry = this._editName ? this._systemsConfig.getSystem(this._editName) : undefined;
        const urlChanged = !!oldEntry && oldEntry.url !== url;

        if (this._editName && (nameChanged || urlChanged)) {
            try {
                execSync(`orchestrate env remove -n "${this._editName}" 2>/dev/null`, {
                    shell: '/bin/zsh',
                    encoding: 'utf8',
                    env,
                });
            } catch {
                /* may not exist */
            }
            if (nameChanged && creds) await creds.deleteApiKey(this._editName);
        }

        this._systemsConfig.saveSystem(name, url);
        if (apiKey && creds) {
            await creds.setApiKey(name, apiKey);
        }

        const needAdd = !this._editName || nameChanged || urlChanged;
        if (needAdd) {
            try {
                execSync(`orchestrate env add -n "${name}" -u "${url}" 2>/dev/null`, {
                    shell: '/bin/zsh',
                    encoding: 'utf8',
                    env,
                });
            } catch (e) {
                this._panel.webview.postMessage({
                    command: 'status',
                    message: `Saved to config, but orchestrate env add failed: ${e instanceof Error ? e.message : String(e)}`,
                    isError: true,
                });
                return;
            }
        }

        const keyToUse = apiKey || (creds ? await creds.getApiKey(name) : undefined);
        if (keyToUse) {
            try {
                execSync(`orchestrate env activate "${name}" --api-key "${keyToUse}" 2>/dev/null`, {
                    shell: '/bin/zsh',
                    encoding: 'utf8',
                    env,
                });
            } catch {
                // non-fatal
            }
        }

        this._panel.webview.postMessage({ command: 'status', message: `System "${name}" saved and synced to orchestrate CLI.`, isError: false });
        this._onSaved?.();
        this.dispose();
    }

    public dispose(): void {
        WxOSystemEditorPanel._panels.delete(this._editName ?? '__new__');
        this._panel.dispose();
        this._disposables.forEach((d) => d.dispose());
    }
}
