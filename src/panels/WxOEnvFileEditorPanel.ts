/**
 * WxO Env File Editor Panel
 *
 * Provides a form UI for editing .env_connection_* files (and any KEY=VALUE .env files
 * in the WxO project directory).  Each file row shows:
 *   key  |  value (password toggle)  |  delete button
 *
 * Supports add new row, save back to file, and copy full path.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 27 Feb 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class WxOEnvFileEditorPanel {
    private static readonly _panels = new Map<string, WxOEnvFileEditorPanel>();

    private readonly _panel: vscode.WebviewPanel;
    private readonly _filePath: string;
    private readonly _disposables: vscode.Disposable[] = [];

    // ── Factory ───────────────────────────────────────────────────────────────

    public static render(extensionUri: vscode.Uri, filePath: string): void {
        const existing = WxOEnvFileEditorPanel._panels.get(filePath);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const fileName = path.basename(filePath);
        const panel = vscode.window.createWebviewPanel(
            'wxoEnvFileEditor',
            `Edit: ${fileName}`,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        const instance = new WxOEnvFileEditorPanel(panel, filePath);
        WxOEnvFileEditorPanel._panels.set(filePath, instance);
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    private constructor(panel: vscode.WebviewPanel, filePath: string) {
        this._panel = panel;
        this._filePath = filePath;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(
            async (msg: Record<string, unknown>) => {
                try {
                    switch (msg.command as string) {
                        case 'save':   await this._handleSave(msg); break;
                        case 'reload': this._panel.webview.html = this._getHtml(); break;
                        case 'openInEditor': {
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this._filePath));
                            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                            break;
                        }
                        case 'copyPath': {
                            await vscode.env.clipboard.writeText(this._filePath);
                            vscode.window.showInformationMessage(`Copied: ${this._filePath}`);
                            break;
                        }
                        case 'close': this.dispose(); break;
                    }
                } catch (e) {
                    const m = e instanceof Error ? e.message : String(e);
                    this._panel.webview.postMessage({ command: 'status', message: m, isError: true });
                }
            },
            undefined,
            this._disposables,
        );
    }

    public dispose(): void {
        WxOEnvFileEditorPanel._panels.delete(this._filePath);
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
    }

    // ── Handlers ──────────────────────────────────────────────────────────────

    private async _handleSave(msg: Record<string, unknown>): Promise<void> {
        const pairs = (msg.pairs as Array<{ key: string; value: string }>) ?? [];

        // Rebuild file: preserve comments from existing file, update/add/remove pairs
        let existing = '';
        if (fs.existsSync(this._filePath)) {
            existing = fs.readFileSync(this._filePath, 'utf8');
        }

        // Collect comment lines and blank lines from existing content (preserve header)
        const comments = existing
            .split('\n')
            .filter(l => l.trim().startsWith('#') || l.trim() === '')
            .slice(0, 5)  // only preserve top 5 header lines
            .join('\n');

        const kvLines = pairs
            .filter(p => p.key.trim())
            .map(p => `${p.key.trim()}=${p.value}`);

        const content = [
            comments.trim() ? comments.trim() + '\n' : '',
            kvLines.join('\n'),
            '',
        ].filter(Boolean).join('\n');

        fs.writeFileSync(this._filePath, content, 'utf8');
        this._panel.webview.postMessage({ command: 'status', message: `Saved to ${this._filePath}` });
    }

    // ── HTML ──────────────────────────────────────────────────────────────────

    private _getHtml(): string {
        const fileName = path.basename(this._filePath);
        const dirName  = path.dirname(this._filePath);

        // Parse the file
        const pairs: Array<{ key: string; value: string; isComment: boolean }> = [];
        if (fs.existsSync(this._filePath)) {
            const lines = fs.readFileSync(this._filePath, 'utf8').split('\n');
            for (const raw of lines) {
                const line = raw.trimEnd();
                if (!line || line.startsWith('#')) continue;  // skip comments/blanks
                const eqIdx = line.indexOf('=');
                if (eqIdx > 0) {
                    pairs.push({ key: line.slice(0, eqIdx), value: line.slice(eqIdx + 1), isComment: false });
                } else if (line.trim()) {
                    pairs.push({ key: line, value: '', isComment: false });
                }
            }
        }

        const isEnvConn = fileName.startsWith('.env_connection');
        const headerLabel = isEnvConn ? 'Connection Credentials' : 'Environment Variables';

        const rowsJson = JSON.stringify(pairs.map(p => ({ key: p.key, value: p.value })));

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edit ${esc(fileName)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family); font-size: 13px;
      color: var(--vscode-foreground); background: var(--vscode-editor-background);
      margin: 0; padding: 12px 16px 10px; height: 100vh;
      display: flex; flex-direction: column; overflow: hidden;
    }
    h2 { margin: 0; font-size: 15px; font-weight: bold; }
    .header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-shrink: 0; }
    .file-path {
      font-size: 11px; opacity: 0.55; margin-bottom: 10px; flex-shrink: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .header-btns { display: flex; gap: 5px; margin-left: auto; }
    .main-content { flex: 1; min-height: 0; overflow-y: auto; }
    table { width: 100%; border-collapse: collapse; }
    thead th {
      text-align: left; font-size: 11px; font-weight: bold; opacity: 0.7;
      padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border);
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    td { padding: 4px 6px; vertical-align: middle; }
    td:first-child { width: 35%; }
    td:last-child { width: 36px; text-align: center; }
    input[type=text], input[type=password] {
      display: block; width: 100%;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 4px 7px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace);
      border-radius: 2px;
    }
    .value-cell { position: relative; }
    .value-wrap { display: flex; gap: 4px; align-items: center; }
    .value-wrap input { flex: 1; }
    .btn-icon {
      background: none; border: none; cursor: pointer; padding: 3px 5px;
      color: var(--vscode-foreground); opacity: 0.6; border-radius: 2px; font-size: 13px;
    }
    .btn-icon:hover { opacity: 1; background: var(--vscode-button-secondaryBackground); }
    button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 5px 12px; cursor: pointer; border-radius: 2px; font-size: 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .danger { background: none; border: none; color: var(--vscode-errorForeground, #f48771); cursor: pointer; font-size: 14px; padding: 2px 5px; border-radius: 2px; opacity: 0.7; }
    .danger:hover { opacity: 1; background: var(--vscode-inputValidation-errorBackground); }
    .toolbar {
      display: flex; justify-content: space-between; align-items: center;
      border-top: 1px solid var(--vscode-widget-border);
      padding-top: 9px; margin-top: 8px; flex-shrink: 0;
    }
    .actions-right { display: flex; gap: 8px; }
    #statusMsg { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 10px; }
    #statusMsg.ok  { color: var(--vscode-terminal-ansiGreen, #73c991); }
    #statusMsg.err { color: var(--vscode-errorForeground, #f48771); }
    .add-row-btn { margin-top: 8px; }
    .section-label { font-size: 11px; font-weight: bold; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.05em; margin: 8px 0 4px; }
    .hint-banner {
      font-size: 11px; opacity: 0.65; padding: 6px 10px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px; margin-bottom: 10px; flex-shrink: 0;
    }
    tr.new-row td input { border-color: var(--vscode-inputValidation-infoBorder); }
  </style>
</head>
<body>

  <div class="header-row">
    <h2>${esc(headerLabel)}: <span style="font-weight:normal">${esc(fileName)}</span></h2>
    <div class="header-btns">
      <button class="secondary" id="btnOpenRaw">Open Raw</button>
      <button class="secondary" id="btnCopyPath">Copy Path</button>
    </div>
  </div>
  <div class="file-path">${esc(dirName)}/<strong>${esc(fileName)}</strong></div>

  ${isEnvConn ? `<div class="hint-banner">
    These credentials are used by <code>orchestrate connections set-credentials</code> during import/replicate.
    Format: <code>APPID_KEY=value</code> (e.g. <code>NEWSAPI_API_KEY=abc123</code>).
  </div>` : ''}

  <div class="main-content">
    <table>
      <thead>
        <tr>
          <th>Key</th>
          <th>Value</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="kvBody"></tbody>
    </table>
    <button class="secondary add-row-btn" id="btnAddRow">+ Add Entry</button>
  </div>

  <div class="toolbar">
    <div id="statusMsg"></div>
    <div class="actions-right">
      <button class="secondary" id="btnReload">↺ Reload from File</button>
      <button class="secondary" id="btnClose">Close</button>
      <button id="btnSave">💾 Save</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    var rows = ${rowsJson};

    function setStatus(msg, isError) {
      var el = document.getElementById('statusMsg');
      el.textContent = msg || '';
      el.className = isError ? 'err' : (msg ? 'ok' : '');
    }

    function renderRows() {
      var tbody = document.getElementById('kvBody');
      tbody.innerHTML = '';
      rows.forEach(function(row, idx) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td><input type="text" class="key-input" data-idx="' + idx + '" value="' + escAttr(row.key) + '" placeholder="KEY_NAME" /></td>' +
          '<td class="value-cell"><div class="value-wrap">' +
            '<input type="password" class="val-input" data-idx="' + idx + '" value="' + escAttr(row.value) + '" placeholder="value" autocomplete="new-password" />' +
            '<button class="btn-icon toggle-btn" data-idx="' + idx + '" title="Show/hide">👁</button>' +
          '</div></td>' +
          '<td><button class="danger del-btn" data-idx="' + idx + '" title="Delete row">✕</button></td>';
        tbody.appendChild(tr);
      });

      // Wire events
      tbody.querySelectorAll('.key-input').forEach(function(el) {
        el.addEventListener('input', function() { rows[+this.dataset.idx].key = this.value; });
      });
      tbody.querySelectorAll('.val-input').forEach(function(el) {
        el.addEventListener('input', function() { rows[+this.dataset.idx].value = this.value; });
      });
      tbody.querySelectorAll('.toggle-btn').forEach(function(el) {
        el.addEventListener('click', function() {
          var inp = tbody.querySelector('.val-input[data-idx="' + this.dataset.idx + '"]');
          if (!inp) return;
          inp.type = inp.type === 'password' ? 'text' : 'password';
          this.textContent = inp.type === 'password' ? '👁' : '🙈';
        });
      });
      tbody.querySelectorAll('.del-btn').forEach(function(el) {
        el.addEventListener('click', function() {
          rows.splice(+this.dataset.idx, 1);
          renderRows();
        });
      });
    }

    function escAttr(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    document.getElementById('btnAddRow').onclick = function() {
      rows.push({ key: '', value: '' });
      renderRows();
      // Focus the last key input
      var inputs = document.querySelectorAll('.key-input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    };

    document.getElementById('btnSave').onclick = function() {
      setStatus('Saving…');
      vscode.postMessage({ command: 'save', pairs: rows });
    };

    document.getElementById('btnReload').onclick = function() {
      vscode.postMessage({ command: 'reload' });
    };

    document.getElementById('btnOpenRaw').onclick = function() {
      vscode.postMessage({ command: 'openInEditor' });
    };

    document.getElementById('btnCopyPath').onclick = function() {
      vscode.postMessage({ command: 'copyPath' });
    };

    document.getElementById('btnClose').onclick = function() {
      vscode.postMessage({ command: 'close' });
    };

    window.addEventListener('message', function(e) {
      var m = e.data;
      if (m.command === 'status') { setStatus(m.message, !!m.isError); }
    });

    // Initial render
    renderRows();
  </script>
</body>
</html>`;
    }
}

function esc(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
