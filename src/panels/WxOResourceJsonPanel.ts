/**
 * WxO Resource JSON Viewer
 * Opens beside the editor showing the full JSON definition of a resource
 * (agent, tool, flow, or connection) fetched from the orchestrate CLI.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 27 Feb 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';

/** Callback to update a resource from edited JSON. */
export type WxOResourceUpdateHandler = (
    resourceType: string,
    name: string,
    json: unknown,
) => Promise<void>;

/** Webview panel that displays JSON definitions of WxO resources (agents, tools, flows, connections). */
export class WxOResourceJsonPanel {

    /** Keep one panel per resource name so repeated clicks reveal rather than duplicate. */
    private static readonly _panels = new Map<string, WxOResourceJsonPanel>();

    private readonly _panel: vscode.WebviewPanel;
    private readonly _disposables: vscode.Disposable[] = [];
    private _resourceType = '';
    private _name = '';
    private _onUpdate?: WxOResourceUpdateHandler;

    // ── Static factory ────────────────────────────────────────────────────────

    /** Create or reveal a JSON panel for the given resource. */
    static show(
        extensionUri: vscode.Uri,
        resourceType: string,
        name: string,
        json: unknown,
        onUpdate?: WxOResourceUpdateHandler,
    ): void {
        const key = `${resourceType}::${name}`;
        const existing = WxOResourceJsonPanel._panels.get(key);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.Beside);
            existing._update(resourceType, name, json, onUpdate);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'wxoResourceJson',
            `${typeLabel(resourceType)}: ${name}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true },
        );
        WxOResourceJsonPanel._panels.set(
            key,
            new WxOResourceJsonPanel(panel, key, resourceType, name, json, onUpdate),
        );
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _key: string,
        resourceType: string,
        name: string,
        json: unknown,
        onUpdate?: WxOResourceUpdateHandler,
    ) {
        this._panel = panel;
        this._resourceType = resourceType;
        this._name = name;
        this._onUpdate = onUpdate;
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._update(resourceType, name, json, onUpdate);

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async (msg: { command: string; text?: string; json?: unknown }) => {
                if (msg.command === 'copy' && msg.text) {
                    await vscode.env.clipboard.writeText(msg.text);
                    vscode.window.showInformationMessage('JSON copied to clipboard.');
                } else if (msg.command === 'panelError' && (msg as Record<string, unknown>).message) {
            vscode.window.showErrorMessage(
                `WxO: ${String((msg as Record<string, unknown>).message)}`,
            );
        } else if (msg.command === 'update' && msg.json !== undefined && this._onUpdate) {
                    try {
                        await this._onUpdate(this._resourceType, this._name, msg.json);
                        vscode.window.showInformationMessage(`WxO: "${this._name}" updated.`);
                    } catch (e) {
                        const err = e instanceof Error ? e.message : String(e);
                        vscode.window.showErrorMessage(`WxO: Update failed — ${err}`);
                    }
                }
            },
            undefined,
            this._disposables,
        );
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private _update(
        resourceType: string,
        name: string,
        json: unknown,
        onUpdate?: WxOResourceUpdateHandler,
    ): void {
        this._resourceType = resourceType;
        this._name = name;
        this._onUpdate = onUpdate;
        const pretty = JSON.stringify(json, null, 2);
        const canUpdate = !!(onUpdate && (resourceType === 'tools' || resourceType === 'flows'));
        this._panel.title = `${typeLabel(resourceType)}: ${name}`;
        this._panel.webview.html = buildHtml(resourceType, name, pretty, canUpdate);
    }

    private _dispose(): void {
        WxOResourceJsonPanel._panels.delete(this._key);
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
    }
}

// ── HTML builder ──────────────────────────────────────────────────────────────

/** Human-readable label for resource type (e.g. agents → Agent). */
function typeLabel(t: string): string {
    return t.charAt(0).toUpperCase() + t.slice(1).replace(/s$/, '');
}

/** Build HTML for the JSON viewer webview with editable textarea and optional Update button. */
function buildHtml(resourceType: string, name: string, json: string, canUpdate = false): string {
    const typeIcon: Record<string, string> = {
        agents: '🤖',
        tools: '🔧',
        flows: '🔀',
        connections: '🔌',
    };
    const icon = typeIcon[resourceType] ?? '📄';
    const escaped = escapeHtml(json);

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${typeLabel(resourceType)}: ${name}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: var(--vscode-titleBar-activeBackground, #1e1e1e);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .header-icon { font-size: 1.4em; }
    .header-title {
      flex: 1;
      font-size: 1em;
      font-weight: 600;
      color: var(--vscode-titleBar-activeForeground, #fff);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .header-badge {
      font-size: 0.7em;
      padding: 2px 7px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .btn-copy, .btn-update {
      padding: 5px 12px;
      font-size: 0.8em;
      cursor: pointer;
      border: none;
      border-radius: 4px;
      white-space: nowrap;
    }
    .btn-copy {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-copy:hover { background: var(--vscode-button-hoverBackground); }
    .btn-update {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-update:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-update:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ── JSON editor ── */
    .json-wrap {
      flex: 1;
      overflow: auto;
      padding: 16px;
    }
    #jsonTextarea {
      width: 100%;
      min-height: 400px;
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.6;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 12px;
      resize: vertical;
      tab-size: 2;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="header-icon">${icon}</span>
    <span class="header-title">${escapeHtml(name)}</span>
    <span class="header-badge">${escapeHtml(resourceType)}</span>
    <button class="btn-copy" id="btnCopy">$(copy) Copy</button>
    ${canUpdate ? '<button class="btn-update" id="btnUpdate">$(check) Update Tool</button>' : ''}
  </div>

  <div class="json-wrap">
    <textarea id="jsonTextarea" spellcheck="false">${escaped}</textarea>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const canUpdate = ${canUpdate ? 'true' : 'false'};

    document.getElementById('btnCopy').addEventListener('click', () => {
      const text = document.getElementById('jsonTextarea').value;
      vscode.postMessage({ command: 'copy', text: text });
      const btn = document.getElementById('btnCopy');
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = '$(copy) Copy'; }, 1800);
    });

    if (canUpdate) {
      document.getElementById('btnUpdate').addEventListener('click', () => {
        const ta = document.getElementById('jsonTextarea');
        const text = ta.value;
        let json;
        try {
          json = JSON.parse(text);
        } catch (e) {
          vscode.postMessage({ command: 'panelError', message: 'Invalid JSON: ' + (e && e.message ? e.message : 'parse error') });
          return;
        }
        const btn = document.getElementById('btnUpdate');
        btn.disabled = true;
        btn.textContent = '… Updating';
        vscode.postMessage({ command: 'update', json: json });
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = '$(check) Update Tool';
        }, 3000);
      });
    }
  </script>
</body>
</html>`;
}

/** Escape HTML special characters for safe insertion. */
function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
}
