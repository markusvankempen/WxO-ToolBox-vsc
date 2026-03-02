/**
 * WxO Create Plugin Panel — WebView form to create Pre-invoke or Post-invoke plugins.
 * Similar to Create Tool but plugin-specific: Python only, templates, tool-spec view.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 2 Mar 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getEffectiveEnv } from '../utils/wxoEnv.js';
import { WxOImporterExporterViewProvider } from '../views/WxOImporterExporterView.js';
import {
    getPluginTemplate,
    type PluginTemplateId,
} from '../plugin-templates.js';

function getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
    return process.cwd();
}

function getWxORoot(): string {
    const cfg = vscode.workspace.getConfiguration('WxO-ToolBox-vsc');
    const custom = cfg.get<string>('wxoRoot')?.trim();
    const ws = getWorkspaceRoot();
    if (custom) {
        return path.isAbsolute(custom) ? custom : path.join(ws, custom);
    }
    return path.join(ws, 'WxO');
}

function getCreatePluginDefaultDir(wxoroot: string, env: string, pluginName: string): string {
    const now = new Date();
    const dt =
        `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
        `_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    return path.join(wxoroot, 'Exports', env, dt, 'plugins', pluginName);
}

function esc(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export class WxOCreatePluginPanel {
    static currentPanel: WxOCreatePluginPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _provider: WxOImporterExporterViewProvider;
    private readonly _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        provider: WxOImporterExporterViewProvider,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._provider = provider;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(
            async (msg: Record<string, unknown>) => {
                try {
                    const cmd = msg.command as string;
                    if (cmd === 'loadFromFilesystem') await this._handleLoadFromFilesystem();
                    else if (cmd === 'loadTemplate') await this._handleLoadTemplate((msg.templateId as PluginTemplateId) ?? 'dad_joke');
                    else if (cmd === 'createPlugin') await this._handleCreatePlugin(msg.content as Record<string, unknown>);
                    else if (cmd === 'openInEditor') await this._handleOpenInEditor(msg.content as Record<string, unknown>);
                } catch (e) {
                    const err = e instanceof Error ? e : new Error(String(e));
                    vscode.window.showErrorMessage(`WxO Create Plugin: ${err.message}`);
                }
            },
            undefined,
            this._disposables,
        );
    }

    public static render(
        extensionUri: vscode.Uri,
        provider: WxOImporterExporterViewProvider,
    ): void {
        if (WxOCreatePluginPanel.currentPanel) {
            WxOCreatePluginPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'wxoCreatePlugin',
            'WxO Create Plugin',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        WxOCreatePluginPanel.currentPanel = new WxOCreatePluginPanel(panel, extensionUri, provider);
    }

    public dispose(): void {
        WxOCreatePluginPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach((d) => d.dispose());
    }

    private async _handleLoadFromFilesystem(): Promise<void> {
        const wxoroot = getWxORoot();
        const base = path.join(wxoroot, 'Exports');
        const uri = await vscode.window.showOpenDialog({
            defaultUri: fs.existsSync(base) ? vscode.Uri.file(base) : vscode.Uri.file(wxoroot),
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Load plugin from folder (Python with requirements.txt)',
        });
        if (!uri?.[0]) return;
        const folderPath = uri[0].fsPath;
        const data = this._provider.service.loadToolFromFolder(folderPath);
        if (!data || data.kind !== 'python') {
            vscode.window.showErrorMessage('Not a valid plugin folder. Expected Python (.py + requirements.txt).');
            return;
        }
        const toolSpecJson = JSON.stringify((data as { toolSpec?: Record<string, unknown> }).toolSpec ?? {}, null, 2);
        const pyFile = path.basename((data as { pyFilePath?: string }).pyFilePath ?? `${data.name}.py`);
        this._panel.webview.postMessage({
            command: 'pluginLoaded',
            data: {
                ...data,
                toolSpecJson,
                pyFile,
            },
        });
    }

    private async _handleLoadTemplate(templateId: PluginTemplateId): Promise<void> {
        const t = getPluginTemplate(templateId);
        const toolSpecJson = JSON.stringify(t.toolSpecTemplate, null, 2);
        this._panel.webview.postMessage({
            command: 'pluginTemplateLoaded',
            name: t.name,
            kind: t.kind,
            description: t.description,
            pyContent: t.pyContent,
            requirements: t.requirements,
            toolSpecJson,
        });
    }

    private async _handleCreatePlugin(content?: Record<string, unknown>): Promise<void> {
        const name = ((content?.name as string) ?? 'my_plugin').trim().replace(/[^a-zA-Z0-9_]/g, '_') || 'my_plugin';
        const pyContent = (content?.pyContent as string) ?? '';
        const requirements = (content?.requirements as string) ?? 'ibm-watsonx-orchestrate>=2.5.0';
        const pyFile = ((content?.pyFile as string) ?? `${name}.py`).trim() || `${name}.py`;
        const env = ((content?.env as string) ?? this._provider.activeEnvironment ?? 'TZ1').trim() || 'TZ1';
        const customFolder = ((content?.folder as string) ?? '').trim();
        const toolSpecJson = (content?.toolSpecJson as string) ?? '';

        if (!pyContent.trim()) {
            vscode.window.showErrorMessage('Python code is required.');
            return;
        }

        const wxoroot = getWxORoot();
        const pluginDir = customFolder
            ? (path.isAbsolute(customFolder) ? customFolder : path.join(getWorkspaceRoot(), customFolder))
            : getCreatePluginDefaultDir(wxoroot, env, name);

        try {
            fs.mkdirSync(pluginDir, { recursive: true });
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            throw new Error(`Cannot create folder: ${err.message}`);
        }

        const pyPath = path.join(pluginDir, pyFile.endsWith('.py') ? pyFile : `${pyFile}.py`);
        fs.writeFileSync(pyPath, pyContent, 'utf8');
        fs.writeFileSync(path.join(pluginDir, 'requirements.txt'), requirements, 'utf8');

        if (toolSpecJson) {
            try {
                JSON.parse(toolSpecJson);
                fs.writeFileSync(path.join(pluginDir, 'tool-spec.json'), toolSpecJson, 'utf8');
            } catch {
                // Invalid JSON - skip writing tool-spec
            }
        }

        const lines = [
            `echo "=== WxO Create Plugin: ${name} ==="`,
            `(cd "${pluginDir}" && orchestrate tools import -k python -p . -f "${path.basename(pyPath)}" -r requirements.txt 2>&1)`,
            `echo "" && echo "=== Plugin created at: ${pluginDir} ==="`,
        ];

        const term = vscode.window.createTerminal({
            name: `WxO Create Plugin: ${name}`,
            env: getEffectiveEnv(),
        });
        term.show();
        term.sendText(lines.join('\n'));

        vscode.window.showInformationMessage(`WxO: Creating plugin "${name}" — check the terminal.`);
        this._panel.webview.postMessage({
            command: 'status',
            message: `Plugin "${name}" created at ${pluginDir}. Import running in terminal.`,
        });
        vscode.commands.executeCommand('WxO-ToolBox-vsc.refreshView');
    }

    private async _handleOpenInEditor(content?: Record<string, unknown>): Promise<void> {
        const pyContent = (content?.pyContent as string) ?? '';
        const pyFile = ((content?.pyFile as string) ?? 'plugin.py').trim() || 'plugin.py';
        const name = ((content?.name as string) ?? 'my_plugin').trim().replace(/[^a-zA-Z0-9_]/g, '_') || 'my_plugin';
        const env = (content?.env as string) ?? this._provider.activeEnvironment ?? 'TZ1';
        const wxoroot = getWxORoot();
        const pluginDir = path.join(wxoroot, 'Exports', env, 'editing', 'plugins', name);
        fs.mkdirSync(pluginDir, { recursive: true });
        const pyPath = path.join(pluginDir, pyFile.endsWith('.py') ? pyFile : `${pyFile}.py`);
        fs.writeFileSync(pyPath, pyContent || '# @tool(kind=PythonToolKind.AGENTPREINVOKE) ...\n', 'utf8');
        const uri = vscode.Uri.file(pyPath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }

    private _getHtml(): string {
        const activeEnv = this._provider.activeEnvironment || 'TZ1';
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WxO Create Plugin</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px 16px; }
    h2 { margin: 0 0 8px 0; font-size: 15px; font-weight: bold; }
    .badge-pre { background: #0066cc22; color: #0066cc; border: 1px solid #0066cc88; border-radius: 3px; padding: 1px 8px; font-size: 11px; font-weight: bold; }
    .badge-post { background: #cc660022; color: #cc6600; border: 1px solid #cc660088; border-radius: 3px; padding: 1px 8px; font-size: 11px; font-weight: bold; }
    label { display: block; margin-bottom: 4px; font-weight: bold; font-size: 12px; }
    .hint { font-weight: normal; opacity: 0.6; font-size: 0.9em; }
    input, textarea { display: block; width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px 8px; font-size: 12px; font-family: inherit; border-radius: 2px; }
    textarea { resize: vertical; }
    textarea.code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    fieldset { border: 1px solid var(--vscode-widget-border); border-radius: 4px; padding: 10px 14px; margin-bottom: 10px; }
    fieldset legend { font-weight: bold; font-size: 0.9em; padding: 0 6px; }
    .form-group { margin-bottom: 10px; }
    .form-group:last-child { margin-bottom: 0; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; cursor: pointer; border-radius: 2px; font-size: 12px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
    .collapsible summary { cursor: pointer; font-weight: bold; padding: 4px 0; }
    #statusMsg { font-size: 12px; color: var(--vscode-foreground); }
    #statusMsg.ok { color: var(--vscode-terminal-ansiGreen, #73c991); }
    #statusMsg.err { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <h2>Create Plugin</h2>
  <p style="margin: 0 0 12px 0; opacity: 0.8; font-size: 12px;">
    Create a Pre-invoke or Post-invoke plugin for Watson Orchestrate. Plugins are Python tools with <code>@tool(kind=PythonToolKind.AGENTPREINVOKE)</code> or <code>AGENTPOSTINVOKE</code>.
  </p>

  <fieldset>
    <legend>Plugin Type &amp; Name</legend>
    <div class="form-group">
      <label>Type</label>
      <div class="toolbar">
        <label style="display:inline; margin:0;"><input type="radio" name="pluginKind" value="pre-invoke" checked /> Pre-invoke</label>
        <label style="display:inline; margin:0;"><input type="radio" name="pluginKind" value="post-invoke" /> Post-invoke</label>
      </div>
    </div>
    <div class="grid-2">
      <div class="form-group">
        <label>Name <span class="hint">(identifier, snake_case)</span></label>
        <input type="text" id="pluginName" value="my_plugin" placeholder="dad_joke_plugin" />
      </div>
      <div class="form-group">
        <label>Python File</label>
        <input type="text" id="pyFile" value="my_plugin.py" placeholder="plugin.py" />
      </div>
    </div>
  </fieldset>

  <fieldset>
    <legend>Templates &amp; Load</legend>
    <div class="toolbar">
      <button type="button" class="secondary" id="btnLoadTemplateDadJoke">Load Dad Joke (Pre-invoke)</button>
      <button type="button" class="secondary" id="btnLoadTemplateResponseSuffix">Load Response Suffix (Post-invoke)</button>
      <button type="button" class="secondary" id="btnLoadFromFolder">Load from Folder</button>
    </div>
  </fieldset>

  <fieldset>
    <legend>Python Code</legend>
    <div class="form-group" style="margin-bottom: 6px;">
      <button type="button" class="secondary" id="btnOpenInEditor" style="font-size: 11px;">Open in Editor</button>
    </div>
    <textarea id="pyCode" class="code" rows="16" spellcheck="false" placeholder="# @tool(kind=PythonToolKind.AGENTPREINVOKE) ..."></textarea>
  </fieldset>

  <fieldset>
    <legend>requirements.txt</legend>
    <textarea id="requirements" class="code" rows="3" spellcheck="false">ibm-watsonx-orchestrate>=2.5.0</textarea>
  </fieldset>

  <fieldset>
    <legend>
      <details class="collapsible">
        <summary>tool-spec.json <span class="hint">(reference; platform generates on import)</span></summary>
      </details>
    </legend>
    <div id="toolSpecContainer" style="display:none;">
      <textarea id="toolSpecJson" class="code" rows="12" spellcheck="false" placeholder="{}"></textarea>
    </div>
    <button type="button" class="secondary" id="btnToggleToolSpec" style="margin-top: 4px;">Show tool-spec.json</button>
  </fieldset>

  <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--vscode-widget-border);">
    <span id="statusMsg"></span>
    <button type="button" id="btnCreate">Create &amp; Import</button>
  </div>

  <script>
    (function() {
      var vscode = null;
      try { vscode = acquireVsCodeApi(); } catch(e) { return; }

      function setStatus(msg, isErr) {
        var el = document.getElementById('statusMsg');
        if (el) { el.textContent = msg || ''; el.className = isErr ? 'err' : (msg ? 'ok' : ''); }
      }

      function collectForm() {
        var kindEl = document.querySelector('input[name="pluginKind"]:checked');
        return {
          name: document.getElementById('pluginName').value.trim().replace(/[^a-zA-Z0-9_]/g, '_') || 'my_plugin',
          kind: kindEl ? kindEl.value : 'pre-invoke',
          pyFile: document.getElementById('pyFile').value.trim() || 'plugin.py',
          pyContent: document.getElementById('pyCode').value,
          requirements: document.getElementById('requirements').value.trim() || 'ibm-watsonx-orchestrate>=2.5.0',
          toolSpecJson: document.getElementById('toolSpecJson').value.trim(),
        };
      }

      document.getElementById('btnLoadTemplateDadJoke').addEventListener('click', function() {
        vscode.postMessage({ command: 'loadTemplate', templateId: 'dad_joke' });
      });
      document.getElementById('btnLoadTemplateResponseSuffix').addEventListener('click', function() {
        vscode.postMessage({ command: 'loadTemplate', templateId: 'response_suffix' });
      });
      document.getElementById('btnLoadFromFolder').addEventListener('click', function() {
        vscode.postMessage({ command: 'loadFromFilesystem' });
      });

      document.getElementById('btnOpenInEditor').addEventListener('click', function() {
        var d = collectForm();
        vscode.postMessage({ command: 'openInEditor', content: { pyContent: d.pyContent, pyFile: d.pyFile, name: d.name } });
      });

      document.getElementById('btnToggleToolSpec').addEventListener('click', function() {
        var cont = document.getElementById('toolSpecContainer');
        var btn = document.getElementById('btnToggleToolSpec');
        if (cont.style.display === 'none') {
          cont.style.display = 'block';
          btn.textContent = 'Hide tool-spec.json';
        } else {
          cont.style.display = 'none';
          btn.textContent = 'Show tool-spec.json';
        }
      });

      document.getElementById('btnCreate').addEventListener('click', function() {
        var d = collectForm();
        if (!d.pyContent.trim()) { setStatus('Python code is required.', true); return; }
        setStatus('Creating…');
        vscode.postMessage({ command: 'createPlugin', content: d });
      });

      window.addEventListener('message', function(e) {
        var m = e.data;
        if (m.command === 'pluginLoaded') {
          var d = m.data;
          document.getElementById('pluginName').value = d.name || 'my_plugin';
          document.getElementById('pyFile').value = d.pyFile || (d.pyFilePath && d.pyFilePath.split(/[/\\\\]/).pop()) || d.name + '.py';
          document.getElementById('pyCode').value = d.pyContent || '';
          document.getElementById('requirements').value = d.requirements || 'ibm-watsonx-orchestrate';
          document.getElementById('toolSpecJson').value = m.data.toolSpecJson || '{}';
          document.getElementById('toolSpecContainer').style.display = 'block';
          document.getElementById('btnToggleToolSpec').textContent = 'Hide tool-spec.json';
          setStatus('Loaded from folder.', false);
        } else if (m.command === 'pluginTemplateLoaded') {
          document.getElementById('pluginName').value = m.name || 'my_plugin';
          document.getElementById('pyFile').value = m.name + '.py';
          document.querySelector('input[name="pluginKind"][value="' + m.kind + '"]').checked = true;
          document.getElementById('pyCode').value = m.pyContent || '';
          document.getElementById('requirements').value = m.requirements || 'ibm-watsonx-orchestrate>=2.5.0';
          document.getElementById('toolSpecJson').value = m.toolSpecJson || '{}';
          document.getElementById('toolSpecContainer').style.display = 'block';
          document.getElementById('btnToggleToolSpec').textContent = 'Hide tool-spec.json';
          setStatus('Template loaded: ' + m.name, false);
        } else if (m.command === 'status') {
          setStatus(m.message, !!m.isError);
        }
      });
    })();
  </script>
</body>
</html>`;
    }
}
