/**
 * WxO Plugin Editor Panel — WebView form to view and edit Python plugins.
 * Exports the plugin via `orchestrate tools export`, shows code/requirements,
 * and re-imports on save via a VS Code terminal using `orchestrate tools import`.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 27 Feb 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getEffectiveEnv } from '../utils/wxoEnv.js';
import { WxOImporterExporterViewProvider } from '../views/WxOImporterExporterView.js';
import { pluginKind } from '../services/WxOEnvironmentService.js';

export class WxOPluginEditorPanel {
    private static readonly _panels = new Map<string, WxOPluginEditorPanel>();

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _provider: WxOImporterExporterViewProvider;
    private readonly _pluginName: string;
    private readonly _disposables: vscode.Disposable[] = [];
    private _editDir: string | undefined;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        provider: WxOImporterExporterViewProvider,
        pluginName: string,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._provider = provider;
        this._pluginName = pluginName;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getLoadingHtml();

        this._panel.webview.onDidReceiveMessage(
            async (msg: Record<string, unknown>) => {
                try {
                    const cmd = msg.command as string;
                    if (cmd === 'savePlugin') {
                        await this._handleSavePlugin(msg);
                    } else if (cmd === 'openInEditor') {
                        await this._handleOpenInEditor(msg);
                    } else if (cmd === 'close') {
                        this.dispose();
                    }
                } catch (e) {
                    const err = e instanceof Error ? e : new Error(String(e));
                    vscode.window.showErrorMessage(`WxO Plugin Editor: ${err.message}`);
                }
            },
            undefined,
            this._disposables,
        );

        this._loadPluginData();
    }

    public static render(
        extensionUri: vscode.Uri,
        provider: WxOImporterExporterViewProvider,
        pluginName: string,
    ): void {
        const existing = WxOPluginEditorPanel._panels.get(pluginName);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'wxoPluginEditor',
            `Plugin: ${pluginName}`,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        const instance = new WxOPluginEditorPanel(panel, extensionUri, provider, pluginName);
        WxOPluginEditorPanel._panels.set(pluginName, instance);
    }

    public dispose(): void {
        WxOPluginEditorPanel._panels.delete(this._pluginName);
        this._panel.dispose();
        this._disposables.forEach((d) => d.dispose());
    }

    private async _loadPluginData(): Promise<void> {
        try {
            const json = await this._provider.service.fetchResourceJson('plugins', this._pluginName);
            const obj = json as Record<string, unknown>;
            const displayName = (obj.display_name ?? obj.displayName ?? this._pluginName) as string;
            const description = (obj.description ?? '') as string;
            const py = (obj.binding as Record<string, unknown>)?.python as Record<string, unknown> ?? {};
            const kind = pluginKind(obj);
            const fnReference = (py.function ?? '') as string;

            let pyCode = '';
            let requirements = 'ibm-watsonx-orchestrate\n';
            let pyFile = `${this._pluginName}.py`;
            let toolSpecJson = '{}';
            let exportError = '';
            let editDirDisplay = '';

            try {
                // Export to WxO/Edits/{name}/ so files are persistent and visible in the project tree
                const editDir = await this._provider.service.exportToEditDir(this._pluginName);
                this._editDir = editDir;
                editDirDisplay = editDir;

                const allFiles = this._readdirFlat(editDir);
                const pyFiles = allFiles.filter(f => f.endsWith('.py'));
                if (pyFiles.length > 0) {
                    pyFile = path.basename(pyFiles[0]);
                    pyCode = fs.readFileSync(pyFiles[0], 'utf8');
                }
                const reqFile = allFiles.find(f => path.basename(f) === 'requirements.txt');
                if (reqFile) {
                    requirements = fs.readFileSync(reqFile, 'utf8');
                }
                const toolSpecFile = allFiles.find(f => path.basename(f) === 'tool-spec.json');
                if (toolSpecFile) {
                    try {
                        const raw = fs.readFileSync(toolSpecFile, 'utf8');
                        toolSpecJson = JSON.stringify(JSON.parse(raw), null, 2);
                    } catch { /* keep {} */ }
                }
            } catch (exportErr) {
                exportError = exportErr instanceof Error ? exportErr.message : String(exportErr);
            }

            this._panel.webview.html = this._getHtml({
                name: this._pluginName,
                displayName,
                description,
                kind,
                pyFile,
                pyCode,
                requirements,
                fnReference,
                exportError,
                editDirDisplay,
                toolSpecJson,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this._panel.webview.html = this._getErrorHtml(msg);
        }
    }

    /** List all files (non-recursive) in a directory, skipping zip files. */
    private _readdirFlat(dir: string): string[] {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isFile() && !e.name.endsWith('.zip'))
            .map(e => path.join(dir, e.name));
    }

    private async _handleSavePlugin(msg: Record<string, unknown>): Promise<void> {
        const pyCode = (msg.pyCode as string) ?? '';
        const requirements = (msg.requirements as string) ?? 'ibm-watsonx-orchestrate\n';
        const pyFile = (msg.pyFile as string) ?? `${this._pluginName}.py`;

        // Write back to WxO/Edits/{name}/ so the project dir always reflects latest code
        const saveDir = this._editDir ?? this._provider.service.getEditDir(this._pluginName);
        fs.mkdirSync(saveDir, { recursive: true });
        fs.writeFileSync(path.join(saveDir, pyFile), pyCode, 'utf8');
        fs.writeFileSync(path.join(saveDir, 'requirements.txt'), requirements, 'utf8');

        const lines = [
            `echo "=== WxO Update Plugin: ${this._pluginName} ==="`,
            `echo "Source: ${saveDir}"`,
            `(cd "${saveDir}" && orchestrate tools import -k python -p . -f "${pyFile}" -r requirements.txt 2>&1)`,
            `echo ""`,
            `echo "=== Plugin update complete ==="`,
        ];

        const term = vscode.window.createTerminal({
            name: `WxO Plugin: ${this._pluginName}`,
            env: getEffectiveEnv(),
        });
        term.show();
        term.sendText(lines.join('\n'));
        vscode.window.showInformationMessage(
            `WxO: Updating plugin "${this._pluginName}" — check the terminal.`,
        );
        vscode.commands.executeCommand('wxo-toolkit-vsc.refreshView');
    }

    private async _handleOpenInEditor(msg: Record<string, unknown>): Promise<void> {
        const pyCode = (msg.pyCode as string) ?? '';
        const pyFile = (msg.pyFile as string) ?? `${this._pluginName}.py`;
        const saveDir = this._editDir ?? this._provider.service.getEditDir(this._pluginName);
        fs.mkdirSync(saveDir, { recursive: true });
        const filePath = path.join(saveDir, pyFile);
        fs.writeFileSync(filePath, pyCode, 'utf8');
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }

    // ── HTML rendering ────────────────────────────────────────────────────────

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background);"><p>Loading plugin data for <strong>${esc(this._pluginName)}</strong>…</p></body></html>`;
    }

    private _getErrorHtml(msg: string): string {
        return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background);"><h3>Error loading plugin</h3><p style="color:var(--vscode-errorForeground);">${esc(msg)}</p></body></html>`;
    }

    private _getHtml(data: {
        name: string;
        displayName: string;
        description: string;
        kind: 'pre-invoke' | 'post-invoke';
        pyFile: string;
        pyCode: string;
        requirements: string;
        fnReference: string;
        exportError: string;
        editDirDisplay?: string;
        toolSpecJson?: string;
    }): string {
        const { name, displayName, description, kind, pyFile, pyCode, requirements, fnReference, exportError, editDirDisplay, toolSpecJson = '{}' } = data;
        const kindLabel = kind === 'pre-invoke' ? 'Pre-invoke Plugin' : 'Post-invoke Plugin';
        const kindColor = kind === 'pre-invoke' ? '#0066cc' : '#cc6600';

        const codeSection = exportError
            ? `<div style="padding:10px 14px; background:var(--vscode-inputValidation-warningBackground); border:1px solid var(--vscode-inputValidation-warningBorder); border-radius:4px; margin-bottom:10px;">
  <strong>Note:</strong> Could not export plugin source (<code>${esc(exportError)}</code>).
  You can still view metadata and manually paste updated code below to re-import.
</div>
<fieldset>
  <legend>Python Code</legend>
  <div class="form-group">
    <label>Python File <span class="hint">(filename used for import)</span></label>
    <input type="text" id="pyFile" value="${esc(pyFile)}" placeholder="plugin.py" />
  </div>
  <div class="form-group">
    <label>Code</label>
    <textarea id="pyCode" class="code-editor" rows="18" spellcheck="false">${esc(pyCode)}</textarea>
  </div>
</fieldset>
<fieldset>
  <legend>requirements.txt</legend>
  <textarea id="requirements" class="code-editor" rows="4" spellcheck="false" placeholder="ibm-watsonx-orchestrate">${esc(requirements)}</textarea>
</fieldset>`
            : `<fieldset>
  <legend>Python Code</legend>
  <div class="form-group">
    <label>Python File <span class="hint">(filename used for import)</span></label>
    <input type="text" id="pyFile" value="${esc(pyFile)}" placeholder="plugin.py" />
  </div>
  <div class="form-group" style="display:flex; justify-content:flex-end; margin-bottom:6px;">
    <button type="button" class="secondary" id="btnOpenInEditor" style="padding:4px 12px; font-size:11px;">Open in Editor</button>
  </div>
  <div class="form-group">
    <label>Code</label>
    <textarea id="pyCode" class="code-editor" rows="18" spellcheck="false">${esc(pyCode)}</textarea>
  </div>
</fieldset>
<fieldset>
  <legend>requirements.txt</legend>
  <textarea id="requirements" class="code-editor" rows="4" spellcheck="false" placeholder="ibm-watsonx-orchestrate">${esc(requirements)}</textarea>
</fieldset>
<fieldset>
  <legend>tool-spec.json <span class="hint">(read-only, from export)</span></legend>
  <textarea id="toolSpecJson" class="code-editor" rows="10" spellcheck="false" readonly style="opacity:0.9;">${esc(toolSpecJson)}</textarea>
</fieldset>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edit Plugin: ${esc(name)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 12px 16px 16px 16px;
    }
    h2 { margin: 0 0 4px 0; font-size: 15px; font-weight: bold; }
    .badge {
      display: inline-block;
      background: ${kindColor}22;
      color: ${kindColor};
      border: 1px solid ${kindColor}88;
      border-radius: 3px;
      padding: 1px 8px;
      font-size: 11px;
      font-weight: bold;
      vertical-align: middle;
      margin-left: 8px;
    }
    label { display: block; margin-bottom: 4px; font-weight: bold; font-size: 12px; }
    .hint { font-weight: normal; opacity: 0.6; font-size: 0.9em; }
    input[type=text], textarea {
      display: block; width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 6px 8px; font-size: 12px;
      font-family: var(--vscode-font-family);
      border-radius: 2px;
    }
    textarea { resize: vertical; }
    textarea.code-editor {
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      font-size: 12px;
    }
    fieldset {
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      padding: 10px 14px 12px 14px;
      margin-bottom: 10px;
    }
    fieldset legend { font-weight: bold; font-size: 0.9em; padding: 0 6px; }
    .form-group { margin-bottom: 10px; }
    .form-group:last-child { margin-bottom: 0; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; padding: 6px 14px;
      cursor: pointer; border-radius: 2px; font-size: 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .readonly-field {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 2px;
      padding: 5px 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .toolbar {
      display: flex; justify-content: space-between; align-items: center;
      border-top: 1px solid var(--vscode-widget-border);
      padding-top: 9px; margin-top: 8px;
    }
    #statusMsg { font-size: 12px; flex: 1; }
    #statusMsg.ok { color: var(--vscode-terminal-ansiGreen, #73c991); }
    #statusMsg.err { color: var(--vscode-errorForeground, #f48771); }
    code { background: var(--vscode-editor-inactiveSelectionBackground); padding: 1px 4px; border-radius: 3px; font-family: monospace; font-size: 0.9em; }
  </style>
</head>
<body>

  <h2>
    Edit Plugin: <span id="titleName">${esc(displayName || name)}</span>
    <span class="badge">${esc(kindLabel)}</span>
  </h2>
  <p style="opacity:0.65; font-size:11px; margin:2px 0 4px 0;">
    Internal name: <code>${esc(name)}</code>
  </p>
  ${editDirDisplay ? `<p style="opacity:0.55; font-size:10px; margin:0 0 10px 0;">
    Edit files: <code>${esc(editDirDisplay)}</code>
  </p>` : ''}

  <fieldset>
    <legend>Info</legend>
    <div class="grid-2">
      <div class="form-group">
        <label>Display Name</label>
        <input type="text" id="displayName" value="${esc(displayName)}" placeholder="${esc(name)}" />
      </div>
      <div class="form-group">
        <label>Kind <span class="hint">(read-only)</span></label>
        <div class="readonly-field">${esc(kindLabel)}</div>
      </div>
    </div>
    <div class="form-group">
      <label>Description</label>
      <textarea id="description" rows="2">${esc(description)}</textarea>
    </div>
    ${fnReference ? `<div class="form-group">
      <label>Function Reference <span class="hint">(read-only)</span></label>
      <div class="readonly-field">${esc(fnReference)}</div>
    </div>` : ''}
  </fieldset>

  ${codeSection}

  <div class="toolbar">
    <div id="statusMsg"></div>
    <div style="display:flex; gap:8px;">
      <button type="button" class="secondary" id="btnClose">Close</button>
      <button type="button" id="btnSave">▶ Save &amp; Re-import</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function setStatus(msg, isError) {
      var el = document.getElementById('statusMsg');
      el.textContent = msg || '';
      el.className = isError ? 'err' : (msg ? 'ok' : '');
    }

    var btnOpenEditor = document.getElementById('btnOpenInEditor');
    if (btnOpenEditor) {
      btnOpenEditor.onclick = function() {
        vscode.postMessage({
          command: 'openInEditor',
          pyFile: document.getElementById('pyFile').value.trim() || '${esc(pyFile)}',
          pyCode: document.getElementById('pyCode').value,
        });
      };
    }

    document.getElementById('btnSave').onclick = function() {
      var pyCode = document.getElementById('pyCode') ? document.getElementById('pyCode').value : '';
      var req = document.getElementById('requirements') ? document.getElementById('requirements').value : '';
      var pf = document.getElementById('pyFile') ? document.getElementById('pyFile').value.trim() : '${esc(pyFile)}';
      if (!pyCode.trim()) {
        setStatus('Python code is empty — nothing to import.', true);
        return;
      }
      setStatus('Starting re-import…');
      vscode.postMessage({
        command: 'savePlugin',
        displayName: document.getElementById('displayName').value.trim(),
        description: document.getElementById('description').value.trim(),
        pyFile: pf || '${esc(pyFile)}',
        pyCode: pyCode,
        requirements: req,
      });
      setStatus('Re-import started — check the terminal.', false);
    };

    document.getElementById('btnClose').onclick = function() {
      vscode.postMessage({ command: 'close' });
    };
  </script>
</body>
</html>`;
    }
}

function esc(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
