/**
 * WxO Create Tool Panel — WebView form to create or edit Python/OpenAPI tools.
 * Separate panel with Load from filesystem, Form/JSON edit, and Create & Import.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 27 Feb 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getEffectiveEnv } from '../utils/wxoEnv.js';
import { getCredentialsService } from '../services/credentialsContext.js';
import { WxOImporterExporterViewProvider } from '../views/WxOImporterExporterView.js';
import { getOpenApiTemplate } from '../openapi-templates.js';
import { openApiFromUrlAsync } from '../openapi-from-url.js';

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

/** Default output path for Create Tool: WxO/Exports/{env}/{datetime}/tools/{name} — matches Export structure. */
function getCreateToolDefaultDir(wxoroot: string, env: string, toolName: string): string {
    const now = new Date();
    const dt =
        `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
        `_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    return path.join(wxoroot, 'Exports', env, dt, 'tools', toolName);
}

export type CreateToolPanelOptions = {
    editMode?: boolean;
    initialLoad?: Record<string, unknown>;
};

export class WxOCreateToolPanel {
    static currentPanel: WxOCreateToolPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _provider: WxOImporterExporterViewProvider;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _editMode: boolean;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        provider: WxOImporterExporterViewProvider,
        options?: CreateToolPanelOptions,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._provider = provider;
        this._editMode = !!options?.editMode;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        const html = this._getHtml();
        this._panel.webview.html = html;
        if (options?.initialLoad) {
            setImmediate(() => {
                this._panel.webview.postMessage({ command: 'toolLoaded', data: options!.initialLoad });
            });
        }

        const debugPanel = vscode.workspace.getConfiguration('WxO-ToolBox-vsc').get<boolean>('debugPanel');
        if (debugPanel) {
            try {
                const ws = getWorkspaceRoot();
                const debugPath = path.join(ws, '.vscode', 'wxo-create-tool-debug.html');
                fs.mkdirSync(path.dirname(debugPath), { recursive: true });
                fs.writeFileSync(debugPath, html, 'utf8');
                vscode.window.showInformationMessage(`[WxO Create Tool] Debug HTML written to ${debugPath}`);
            } catch (e) {
                vscode.window.showWarningMessage(`[WxO Create Tool] Could not write debug file: ${e}`);
            }
        }

        this._panel.webview.onDidReceiveMessage(
            async (msg: { command: string; content?: Record<string, unknown>; templateId?: string }) => {
                try {
                    if (msg.command === 'debugLog') {
                        const chan = vscode.window.createOutputChannel('WxO ToolBox');
                        chan.appendLine(`[Create Tool] ${String((msg as Record<string, unknown>).message ?? '')}`);
                    } else if (msg.command === 'panelError') {
                        const m = msg as Record<string, unknown>;
                        const chan = vscode.window.createOutputChannel('WxO ToolBox');
                        chan.show();
                        chan.appendLine(`[Create Tool ERROR] ${String(m.message ?? m.msg ?? '')}`);
                        if (m.stack) chan.appendLine(String(m.stack));
                    } else if (msg.command === 'loadFromFilesystem') await this._handleLoadFromFilesystem();
                    else if (msg.command === 'createPythonTool') await this._handleCreatePythonTool(msg.content);
                    else if (msg.command === 'createOpenApiTool') await this._handleCreateOpenApiTool(msg.content);
                    else if (msg.command === 'openPythonInEditor') await this._handleOpenPythonInEditor(msg.content);
                    else if (msg.command === 'pickOpenApiSpec') await this._handlePickOpenApiSpec();
                    else if (msg.command === 'loadTemplate') await this._handleLoadTemplate(msg.templateId ?? 'blank');
                    else if (msg.command === 'generateFromUrl') await this._handleGenerateFromUrl(msg.content);
                    else if (msg.command === 'invokeOpenApi') await this._handleInvokeOpenApi(msg.content);
                    else if (msg.command === 'loadActiveConnections') await this._handleLoadActiveConnections();
                    else if (msg.command === 'openJsonInEditor') await this._handleOpenJsonInEditor(msg.content);
                    else if (msg.command === 'exportOpenAPI') await this._handleExportOpenAPI(msg.content);
                    else if (msg.command === 'requestLoadPythonSample') await this._handleLoadPythonSample();
                    else if (msg.command === 'getLatestExportReport') {
                        const p = this._findLatestExportReport();
                        this._panel.webview.postMessage({ command: 'latestExportReport', path: p ?? undefined });
                    } else if (msg.command === 'openReport') {
                        const p = (msg as Record<string, unknown>).path as string | undefined;
                        if (p && typeof p === 'string' && fs.existsSync(p)) {
                            const uri = vscode.Uri.file(p);
                            vscode.workspace.openTextDocument(uri).then((doc) =>
                                vscode.window.showTextDocument(doc, { preview: false }));
                        } else {
                            vscode.window.showWarningMessage('WxO: Report file not found.');
                        }
                    } else if (msg.command === 'close') this.dispose();
                } catch (e) {
                    const err = e instanceof Error ? e : new Error(String(e));
                    vscode.window.showErrorMessage(`WxO Create Tool: ${err.message}`);
                    this._panel.webview.postMessage({ command: 'status', message: err.message, isError: true });
                }
            },
            undefined,
            this._disposables,
        );
    }

    public static render(extensionUri: vscode.Uri, provider: WxOImporterExporterViewProvider, options?: CreateToolPanelOptions) {
        const editMode = !!options?.editMode;
        if (WxOCreateToolPanel.currentPanel && !options?.initialLoad) {
            WxOCreateToolPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'wxoCreateTool',
            editMode ? 'WxO Edit Tool' : 'WxO Create Tool',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        WxOCreateToolPanel.currentPanel = new WxOCreateToolPanel(panel, extensionUri, provider, options);
    }

    public dispose() {
        WxOCreateToolPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach((d) => d.dispose());
    }

    private async _runInTerminal(cmd: string, name: string, envName?: string) {
        const ws = getWorkspaceRoot();
        const wxoRoot = getWxORoot();
        let envFilePath = path.join(ws, '.env');
        const creds = getCredentialsService();
        if (creds && envName) {
            const tmpPath = await creds.buildEnvFileForScripts([envName]);
            envFilePath = tmpPath;
        }
        const envPrefix = `ENV_FILE="${envFilePath}" WXO_ROOT="${wxoRoot}" `;
        const term = vscode.window.createTerminal({ name, env: getEffectiveEnv() });
        term.show();
        term.sendText(envPrefix + cmd);
    }

    private _findLatestReport(baseDir: string, reportFileName: string): string | null {
        try {
            if (!fs.existsSync(baseDir)) return null;
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            const subdirs = entries
                .filter((e) => e.isDirectory() && /^\d{8}_\d{6}$/.test(e.name))
                .map((e) => e.name)
                .sort();
            const latest = subdirs[subdirs.length - 1];
            if (!latest) return null;
            const reportPath = path.join(baseDir, latest, reportFileName);
            return fs.existsSync(reportPath) ? reportPath : null;
        } catch {
            return null;
        }
    }

    private _findLatestExportReport(): string | null {
        const wxoroot = getWxORoot();
        const exportsDir = path.join(wxoroot, 'Exports');
        if (!fs.existsSync(exportsDir)) return null;
        let bestPath: string | null = null;
        let bestTime = '';
        try {
            const envDirs = fs.readdirSync(exportsDir, { withFileTypes: true })
                .filter((e) => e.isDirectory()).map((e) => e.name);
            for (const env of envDirs) {
                const p = this._findLatestReport(path.join(exportsDir, env), 'Report/export_report.txt');
                if (p) {
                    const parts = p.split(path.sep);
                    const dtIdx = parts.findIndex((x) => /^\d{8}_\d{6}$/.test(x));
                    const dt = dtIdx >= 0 ? parts[dtIdx] : '';
                    if (dt > bestTime) {
                        bestTime = dt;
                        bestPath = p;
                    }
                }
            }
            return bestPath;
        } catch {
            return null;
        }
    }

    private async _handleLoadFromFilesystem() {
        const wxoroot = getWxORoot();
        const base = path.join(wxoroot, 'Exports');
        const uri = await vscode.window.showOpenDialog({
            defaultUri: fs.existsSync(base) ? vscode.Uri.file(base) : vscode.Uri.file(wxoroot),
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Load tool from folder (Python or OpenAPI)',
        });
        if (!uri?.[0]) { return; }
        const folderPath = uri[0].fsPath;
        const data = this._provider.service.loadToolFromFolder(folderPath);
        if (!data) {
            vscode.window.showErrorMessage('Not a valid tool folder. Expected Python (.py + requirements.txt) or OpenAPI (skill_v2.json).');
            return;
        }
        this._panel.webview.postMessage({ command: 'toolLoaded', data });
    }

    private async _handlePickOpenApiSpec() {
        const uri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: 'Select OpenAPI spec file',
            filters: { 'JSON': ['json'], 'All': ['*'] },
        });
        if (!uri?.[0]) { return; }
        const filePath = uri[0].fsPath;
        let content = '';
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch {
            this._panel.webview.postMessage({ command: 'openApiSpecPicked', path: filePath });
            return;
        }
        this._panel.webview.postMessage({ command: 'openApiSpecPicked', path: filePath, content });
    }

    private async _handleLoadTemplate(templateId: string) {
        const template = getOpenApiTemplate(templateId as import('../openapi-templates.js').TemplateId);
        if (!template) {
            this._panel.webview.postMessage({ command: 'status', message: 'Template not found.', isError: true });
            return;
        }
        const info = template.info as Record<string, unknown>;
        const displayName = (info?.title as string) ?? (info?.['x-ibm-skill-name'] as string) ?? 'template';
        const name = (info?.['x-ibm-skill-id'] as string)?.replace(/-/g, '_') ?? 'my_api_tool';
        this._panel.webview.postMessage({
            command: 'openApiTemplateLoaded',
            spec: template,
            name,
            displayName,
        });
    }

    private async _handleGenerateFromUrl(content?: Record<string, unknown>) {
        const url = ((content?.url as string) ?? '').trim();
        const toolName = (content?.toolName as string)?.trim();
        if (!url) {
            this._panel.webview.postMessage({ command: 'status', message: 'Enter a URL.', isError: true });
            return;
        }
        try {
            this._panel.webview.postMessage({ command: 'status', message: 'Generating… fetching description from docs.', isError: false });
            const result = await openApiFromUrlAsync(url, toolName, { fetchDescription: true });
            this._panel.webview.postMessage({
                command: 'openApiFromUrlLoaded',
                spec: result.spec,
                name: result.toolName,
                displayName: result.displayName,
                apiKeyParamName: result.apiKeyParamName,
            });
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            this._panel.webview.postMessage({ command: 'status', message: err.message, isError: true });
        }
    }

    private async _handleInvokeOpenApi(content?: Record<string, unknown>) {
        let url = (content?.url as string) ?? '';
        const method = ((content?.method as string) ?? 'GET').toUpperCase();
        const headers = (content?.headers as Record<string, string>) ?? {};
        const connectionAppId = (content?.connectionAppId as string)?.trim();
        const apiKeyParamName = (content?.apiKeyParamName as string)?.trim();
        if (!url) {
            this._panel.webview.postMessage({ command: 'invokeResult', error: 'No URL provided.', status: 0 });
            return;
        }
        if (connectionAppId && apiKeyParamName) {
            const env = (content?.env as string) ?? this._provider.activeEnvironment ?? 'TZ1';
            const wxoroot = getWxORoot();
            const envPath = path.join(wxoroot, 'Systems', env, 'Connections', `.env_connection_${env}`);
            try {
                if (fs.existsSync(envPath)) {
                    const txt = fs.readFileSync(envPath, 'utf8');
                    const appSafe = connectionAppId.replace(/\./g, '_');
                    const re = new RegExp(`^CONN_${appSafe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_API_KEY=(.+)$`, 'm');
                    const m = txt.match(re);
                    if (m && m[1]) {
                        const key = m[1].trim().replace(/^["']|["']$/g, '');
                        const sep = url.includes('?') ? '&' : '?';
                        url += `${sep}${encodeURIComponent(apiKeyParamName)}=${encodeURIComponent(key)}`;
                    }
                }
            } catch { /* ignore */ }
        }
        try {
            const res = await fetch(url, {
                method,
                headers: { Accept: 'application/json', ...headers },
                signal: AbortSignal.timeout(15000),
            });
            const body = await res.text();
            this._panel.webview.postMessage({
                command: 'invokeResult',
                status: res.status,
                body,
                error: res.status >= 400 ? body : undefined,
            });
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            this._panel.webview.postMessage({
                command: 'invokeResult',
                error: err.message,
                status: 0,
            });
        }
    }

    private async _handleLoadActiveConnections() {
        try {
            const groups = await this._provider.service.listConnectionsGrouped();
            const active = [...groups.activeLive, ...groups.activeDraft].map((c) => ({ name: c.name }));
            this._panel.webview.postMessage({ command: 'activeConnectionsLoaded', connections: active });
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            this._panel.webview.postMessage({ command: 'activeConnectionsLoaded', connections: [], error: err.message });
        }
    }

    private async _handleOpenJsonInEditor(content?: Record<string, unknown>) {
        const specStr = (content?.spec as string) ?? '';
        const toolDir = (content?.toolDir as string) ?? '';
        const env = (content?.env as string) ?? this._provider.activeEnvironment ?? 'TZ1';
        const name = ((content?.name as string) ?? 'my_api_tool').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'my_api_tool';
        const wxoroot = getWxORoot();
        const dir = toolDir || path.join(wxoroot, 'Exports', env, 'editing', 'tools', name);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch { /* ignore */ }
        const filePath = path.join(dir, 'skill_v2.json');
        try {
            const spec = specStr ? JSON.parse(specStr) : {};
            fs.writeFileSync(filePath, JSON.stringify(spec, null, 2), 'utf8');
        } catch {
            fs.writeFileSync(filePath, specStr || '{}', 'utf8');
        }
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        this._panel.webview.postMessage({
            command: 'openJsonInEditorResult',
            path: filePath,
            toolDir: dir,
        });
    }

    private async _handleExportOpenAPI(content?: Record<string, unknown>) {
        if (!content || typeof content !== 'object') {
            this._panel.webview.postMessage({ command: 'status', message: 'No OpenAPI spec to export.', isError: true });
            return;
        }
        const defaultName =
            ((content?.info as Record<string, unknown>)?.title as string || 'openapi').replace(/[^a-zA-Z0-9_-]/g, '_') +
            '.json';
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultName),
            filters: { 'OpenAPI JSON': ['json'], 'All files': ['*'] },
        });
        if (!uri) { return; }
        await vscode.workspace.fs.writeFile(
            uri,
            Buffer.from(JSON.stringify(content, null, 2), 'utf8'),
        );
        this._panel.webview.postMessage({ command: 'status', message: `Exported to ${uri.fsPath}` });
    }

    private async _handleLoadPythonSample() {
        const pythonCode = `from datetime import datetime
import pytz
from ibm_watsonx_orchestrate.agent_builder.tools import tool

@tool()
def get_asia_time(timezone: str = "Asia/Tokyo") -> dict:
    """Get current time in an Asian timezone."""
    try:
        tz = pytz.timezone(timezone)
        now = datetime.now(tz)
        return {"timezone": timezone, "time": now.strftime("%Y-%m-%d %H:%M:%S %Z"), "status": "success"}
    except Exception as e:
        return {"timezone": timezone, "time": None, "status": f"error: {str(e)}"}
`;
        const requirements = 'pytz\nibm-watsonx-orchestrate';
        const inputSchema = {
            type: 'object',
            properties: {
                timezone: { type: 'string', description: 'IANA timezone (e.g. Asia/Tokyo, Asia/Singapore)' },
            },
            required: [],
        };
        const outputSchema = { type: 'object' };
        this._panel.webview.postMessage({
            command: 'loadPythonSample',
            name: 'get_asia_time',
            displayName: 'Asia Time Tool',
            description: 'Get current time in an Asian timezone (default: Tokyo).',
            function: 'tool:get_asia_time',
            filename: 'tool.py',
            content: pythonCode,
            requirements,
            input_schema: inputSchema,
            output_schema: outputSchema,
        });
    }

    private async _handleOpenPythonInEditor(content?: Record<string, unknown>) {
        const pyFilePath = (content?.pyFilePath as string)?.trim();
        if (pyFilePath && fs.existsSync(pyFilePath)) {
            await vscode.workspace.openTextDocument(pyFilePath);
            vscode.window.showTextDocument(vscode.Uri.file(pyFilePath), { viewColumn: vscode.ViewColumn.Beside });
            return;
        }
        const pyContent = (content?.pyContent as string) ?? '';
        const requirements = (content?.requirements as string) ?? 'ibm-watsonx-orchestrate';
        const name = ((content?.name as string) ?? 'my_tool').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'my_tool';
        const pyFile = ((content?.pyFile as string) ?? 'tool.py').trim() || 'tool.py';
        const env = (content?.env as string) ?? this._provider.activeEnvironment ?? 'TZ1';
        const wxoroot = getWxORoot();
        const dir = path.join(wxoroot, 'Exports', env, 'editing', 'tools', name);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch { /* ignore */ }
        const pyPath = path.join(dir, pyFile.endsWith('.py') ? pyFile : `${pyFile}.py`);
        fs.writeFileSync(pyPath, pyContent || '# Your @tool() decorated function here\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'requirements.txt'), requirements, 'utf8');
        const uri = vscode.Uri.file(pyPath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        this._panel.webview.postMessage({
            command: 'openPythonInEditorResult',
            path: pyPath,
            toolDir: dir,
        });
    }

    private async _handleCreatePythonTool(content?: Record<string, unknown>) {
        const name = ((content?.name as string) ?? 'my_tool').trim().replace(/[^a-zA-Z0-9_]/g, '_') || 'my_tool';
        const displayName = ((content?.displayName as string) ?? '').trim() || name.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
        const description = ((content?.description as string) ?? '').trim() || 'Python tool for Watson Orchestrate.';
        const env = ((content?.env as string) ?? this._provider.activeEnvironment ?? 'TZ1').trim() || 'TZ1';
        const customFolder = ((content?.folder as string) ?? '').trim();
        const params = (content?.params as Array<{ name: string; type: string; description: string }>) ?? [];
        const pyPath = (content?.pyPath as string)?.trim();
        let pyContentOverride = (content?.pyContent as string) ?? '';
        let requirementsOverride = (content?.requirements as string) ?? '';
        if (pyPath && fs.existsSync(pyPath)) {
            pyContentOverride = fs.readFileSync(pyPath, 'utf8');
            const reqPath = path.join(path.dirname(pyPath), 'requirements.txt');
            requirementsOverride = fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf8') : 'ibm-watsonx-orchestrate';
        }
        const toolSpecOverride = (content?.toolSpecJson as string) ?? '';
        const fnName = name;
        const pyFileOverride = (content?.pyFile as string)?.trim();
        const pyFile = pyFileOverride || `${fnName}_tool.py`;

        const wxoroot = getWxORoot();
        const toolDir = customFolder
            ? (path.isAbsolute(customFolder) ? customFolder : path.join(getWorkspaceRoot(), customFolder))
            : getCreateToolDefaultDir(wxoroot, env, name);

        try {
            fs.mkdirSync(toolDir, { recursive: true });
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            throw new Error(`Cannot create folder: ${err.message}`);
        }

        let pyContent: string;
        let toolSpec: Record<string, unknown>;

        if (toolSpecOverride) {
            try {
                toolSpec = JSON.parse(toolSpecOverride) as Record<string, unknown>;
                const specDesc = (toolSpec.description as string) ?? description;
                const props = (toolSpec.input_schema as Record<string, unknown>)?.properties as Record<string, { type?: string; description?: string }> | undefined;
                const paramList = props ? Object.entries(props).map(([pn, pd]) => ({ name: pn, type: (pd?.type as string) ?? 'string', desc: (pd?.description as string) ?? pn })) : [];
                const pyType = (t: string) => t === 'number' ? 'float' : t === 'boolean' ? 'bool' : 'str';
                const paramDefs = paramList.map(p => `    ${p.name}: ${pyType(p.type)} = ${p.type === 'number' ? '0' : p.type === 'boolean' ? 'False' : '""'},`).join('\n') || '    input_text: str = "",';
                const paramDescs = paramList.map(p => `        ${p.name}: ${p.desc}`).join('\n') || '        input_text: Input string';
                const paramLines = paramList.map(p => `    if ${p.name}:\n        parts.append(str(${p.name}).strip())`).join('\n') || '    if input_text:\n        parts.append(input_text.strip())';
                pyContent = pyContentOverride || `"""
${(toolSpec.display_name as string) ?? name} — Python tool for Watson Orchestrate.
${specDesc}
"""
from ibm_watsonx_orchestrate.agent_builder.tools import tool

@tool()
def ${fnName}(
${paramDefs}
) -> str:
    """${specDesc.replace(/"/g, '\\"')}

    Args:
${paramDescs}

    Returns:
        Processed result.
    """
    parts = []
${paramLines}
    return " | ".join(parts) if parts else "No input provided."
`;
            } catch {
                throw new Error('Invalid JSON in tool spec.');
            }
        } else {
            const pyType = (t: string) => t === 'number' ? 'float' : t === 'boolean' ? 'bool' : 'str';
            const defVal = (t: string) => t === 'number' ? '0' : t === 'boolean' ? 'False' : '""';
            const paramDefs = params.length > 0
                ? params.map(p => `    ${p.name}: ${pyType(p.type)} = ${defVal(p.type)},`).join('\n')
                : '    input_text: str = "",';
            const paramDescs = params.length > 0
                ? params.map(p => `        ${p.name}: ${p.description || p.name}`).join('\n')
                : '        input_text: Input string to process.';
            const paramLines = params.length > 0
                ? params.map(p => `    if ${p.name}:\n        parts.append(str(${p.name}).strip())`).join('\n')
                : '    if input_text:\n        parts.append(input_text.strip())';

            pyContent = `"""
${displayName} — Python tool for Watson Orchestrate.
${description}

Author: WxO ToolBox
"""
from ibm_watsonx_orchestrate.agent_builder.tools import tool


@tool()
def ${fnName}(
${paramDefs}
) -> str:
    """${description.replace(/"/g, '\\"')}

    Args:
${paramDescs}

    Returns:
        Processed result.
    """
    parts = []
${paramLines}
    return " | ".join(parts) if parts else "No input provided."
`;

            const inputSchema: Record<string, unknown> = {
                type: 'object',
                properties: params.length > 0
                    ? Object.fromEntries(params.map(p => [p.name, { type: p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string', description: p.description || p.name }]))
                    : { input_text: { type: 'string', description: 'Input string' } },
                required: [],
            };
            toolSpec = {
                name,
                display_name: displayName,
                description,
                permission: 'read_only',
                input_schema: inputSchema,
                output_schema: { type: 'string', description: 'Processed result' },
                binding: {
                    python: {
                        function: `${pyFile.replace('.py', '')}:${fnName}`,
                        requirements: ['ibm-watsonx-orchestrate'],
                        connections: {},
                    },
                },
            };
        }

        let requirementsContent = 'ibm-watsonx-orchestrate\n';
        if (requirementsOverride) {
            requirementsContent = requirementsOverride + (requirementsOverride.endsWith('\n') ? '' : '\n');
        } else if (toolSpec) {
            const reqs = (toolSpec.binding as Record<string, unknown>)?.python as Record<string, unknown> | undefined;
            if (Array.isArray(reqs?.requirements)) {
                requirementsContent = (reqs.requirements as string[]).join('\n') + '\n';
            }
        }

        fs.writeFileSync(path.join(toolDir, pyFile), pyContent, 'utf8');
        fs.writeFileSync(path.join(toolDir, 'requirements.txt'), requirementsContent, 'utf8');
        fs.writeFileSync(path.join(toolDir, 'tool-spec.json'), JSON.stringify(toolSpec, null, 2), 'utf8');

        const keyVar = `WXO_API_KEY_${env}`;
        const lines = [
            `echo "=== WxO Create Python Tool: ${name} ==="`,
            `[ -f "$ENV_FILE" ] && . "$ENV_FILE" 2>/dev/null || true`,
            `if [ -n "$${keyVar}" ]; then orchestrate env activate "${env}" --api-key "$${keyVar}" 2>/dev/null; else orchestrate env activate "${env}" 2>/dev/null; fi`,
            `(cd "${toolDir}" && orchestrate tools import -k python -p . -f "${pyFile}" -r requirements.txt 2>&1)`,
            `echo "" && echo "=== Tool created at: ${toolDir} ==="`,
        ];
        await this._runInTerminal(lines.join('\n'), `WxO Create: ${name}`, env);
        this._panel.webview.postMessage({ command: 'status', message: `Python tool "${name}" created at ${toolDir}. Import running in terminal.` });
        await vscode.workspace.openTextDocument(path.join(toolDir, pyFile));
        vscode.commands.executeCommand('WxO-ToolBox-vsc.refreshView');
    }

    private async _handleCreateOpenApiTool(content?: Record<string, unknown>) {
        const name = ((content?.name as string) ?? 'my_api_tool').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'my_api_tool';
        const displayName = ((content?.displayName as string) ?? '').trim() || name.replace(/_/g, ' ');
        const env = ((content?.env as string) ?? this._provider.activeEnvironment ?? 'TZ1').trim() || 'TZ1';
        const customFolder = ((content?.folder as string) ?? '').trim();
        const specJson = (content?.spec as string) ?? '';
        const specPath = (content?.specPath as string) ?? '';
        const toolSpecJson = (content?.toolSpecJson as string) ?? '';
        const connectionAppId = (content?.connectionAppId as string)?.trim();
        const createConnection = !!(content?.createConnection);
        const connAppId = (content?.connAppId as string)?.trim() || name;
        const connApiKey = (content?.connApiKey as string) ?? '';
        const apiKeyParamName = (content?.apiKeyParamName as string)?.trim() || 'key';

        const wxoroot = getWxORoot();
        const resolvedSpecPath = specPath && fs.existsSync(specPath) ? specPath : '';
        const toolDir = resolvedSpecPath
            ? path.dirname(resolvedSpecPath)
            : customFolder
                ? (path.isAbsolute(customFolder) ? customFolder : path.join(getWorkspaceRoot(), customFolder))
                : getCreateToolDefaultDir(wxoroot, env, name);

        let spec: Record<string, unknown>;
        if (toolSpecJson) {
            try {
                spec = JSON.parse(toolSpecJson) as Record<string, unknown>;
            } catch {
                throw new Error('Invalid OpenAPI JSON in editor.');
            }
        } else if (specPath && fs.existsSync(specPath)) {
            try {
                spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as Record<string, unknown>;
            } catch {
                throw new Error('Could not parse spec file as JSON.');
            }
        } else if (specJson) {
            try {
                spec = JSON.parse(specJson) as Record<string, unknown>;
            } catch {
                throw new Error('Invalid OpenAPI JSON.');
            }
        } else {
            throw new Error('Provide OpenAPI spec (paste JSON, pick file, or edit in JSON view).');
        }

        const info = (spec.info as Record<string, unknown>) ?? {};
        info.title = displayName || (info.title as string) || name;
        info['x-ibm-skill-name'] = displayName || name;
        info['x-ibm-skill-id'] = name.replace(/_/g, '-');
        spec.info = info;

        if (createConnection && apiKeyParamName) {
            const comp = (spec.components as Record<string, unknown>) ?? {};
            let schemes = comp.securitySchemes as Record<string, unknown> | undefined;
            if (!schemes) {
                schemes = {};
                comp.securitySchemes = schemes;
            }
            schemes.ApiKeyAuth = { type: 'apiKey', in: 'query', name: apiKeyParamName };
            spec.components = comp;
            if (!spec.security) spec.security = [{ ApiKeyAuth: [] }];
        }

        try {
            fs.mkdirSync(toolDir, { recursive: true });
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            throw new Error(`Cannot create folder: ${err.message}`);
        }

        fs.writeFileSync(path.join(toolDir, 'skill_v2.json'), JSON.stringify(spec, null, 2), 'utf8');

        const keyVar = `WXO_API_KEY_${env}`;
        const lines: string[] = [
            `echo "=== WxO Create OpenAPI Tool: ${name} ==="`,
            `[ -f "$ENV_FILE" ] && . "$ENV_FILE" 2>/dev/null || true`,
            `if [ -n "$${keyVar}" ]; then orchestrate env activate "${env}" --api-key "$${keyVar}" 2>/dev/null; else orchestrate env activate "${env}" 2>/dev/null; fi`,
        ];

        let connAppIdToUse: string | undefined = createConnection ? undefined : connectionAppId;
        if (createConnection && connAppId && connApiKey) {
            const connDir = path.join(toolDir, 'connections');
            fs.mkdirSync(connDir, { recursive: true });
            const servers = (spec.servers as Array<{ url?: string }>) ?? [];
            const serverUrl = (servers[0]?.url ?? 'https://api.example.com').replace(/\/$/, '');
            const connYaml = [
                `app_id: ${connAppId}`,
                'spec_version: v1',
                'kind: connection',
                'environments:',
                '  draft:',
                `    server_url: ${serverUrl}`,
                '    kind: api_key',
                '    type: team',
                '  live:',
                `    server_url: ${serverUrl}`,
                '    kind: api_key',
                '    type: team',
            ].join('\n') + '\n';
            const connPath = path.join(connDir, `${connAppId}.yaml`);
            fs.writeFileSync(connPath, connYaml, 'utf8');

            const connEnvDir = path.join(wxoroot, 'Systems', env, 'Connections');
            fs.mkdirSync(connEnvDir, { recursive: true });
            const envConnPath = path.join(connEnvDir, `.env_connection_${env}`);
            const appSafe = connAppId.replace(/\./g, '_');
            const entry = `CONN_${appSafe}_API_KEY=${connApiKey}`;
            if (fs.existsSync(envConnPath)) {
                let txt = fs.readFileSync(envConnPath, 'utf8');
                const re = new RegExp(`^CONN_${appSafe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_API_KEY=.*$`, 'm');
                if (re.test(txt)) {
                    txt = txt.replace(re, entry);
                } else {
                    txt += (txt.endsWith('\n') ? '' : '\n') + entry + '\n';
                }
                fs.writeFileSync(envConnPath, txt, 'utf8');
            } else {
                fs.writeFileSync(envConnPath, `# Connection secrets for ${env}\n${entry}\n`, 'utf8');
            }

            const q = (s: string) => `"${String(s).replace(/"/g, '\\"')}"`;
            lines.push(`orchestrate connections import -f ${q(connPath)} 2>&1`);
            lines.push(`orchestrate connections set-credentials -a ${q(connAppId)} --env draft --api-key ${q(connApiKey)} 2>&1`);
            lines.push(`orchestrate connections set-credentials -a ${q(connAppId)} --env live --api-key ${q(connApiKey)} 2>&1`);
            connAppIdToUse = connAppId;
        }

        const importArgs = connAppIdToUse
            ? `(cd "${toolDir}" && orchestrate tools import -k openapi -f skill_v2.json -a "${connAppIdToUse}" 2>&1)`
            : `(cd "${toolDir}" && orchestrate tools import -k openapi -f skill_v2.json 2>&1)`;
        lines.push(importArgs);
        lines.push(`echo "" && echo "=== Tool created at: ${toolDir} ==="`);

        await this._runInTerminal(lines.join('\n'), `WxO Create: ${name}`, env);
        this._panel.webview.postMessage({ command: 'status', message: `OpenAPI tool "${name}" created at ${toolDir}. Import running in terminal.` });
        vscode.commands.executeCommand('WxO-ToolBox-vsc.refreshView');
    }

    private _getHtml(): string {
        const activeEnv = this._provider.activeEnvironment || 'TZ1';
        const _debug = vscode.workspace.getConfiguration('WxO-ToolBox-vsc').get<boolean>('debugPanel') === true;
        const editMode = this._editMode;
        const headerTitle = editMode ? 'Edit Tool' : 'Create Tool';
        const mainButtonText = editMode ? 'Update & Re-import' : 'Create & Import';
        const mainButtonTextEsc = mainButtonText.replace(/&/g, '&amp;');
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WxO Create Tool</title>
  <style>
    :root {
      --tab-border: 1px solid var(--vscode-widget-border);
      --tab-active-bg: var(--vscode-editor-background);
      --tab-inactive-bg: var(--vscode-editor-inactiveSelectionBackground);
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 12px 16px 10px 16px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    h2 { margin: 0; font-size: 15px; font-weight: bold; }

    /* ── Tabs ── */
    .tabs { display: flex; border-bottom: var(--tab-border); margin-bottom: 0; flex-shrink: 0; }
    .tab {
      padding: 7px 15px; cursor: pointer;
      border: var(--tab-border); border-bottom: none;
      background: var(--tab-inactive-bg);
      margin-right: 3px; border-radius: 4px 4px 0 0;
      opacity: 0.72; font-size: 12px; user-select: none;
    }
    .tab:hover { opacity: 0.9; }
    .tab.active {
      background: var(--tab-active-bg);
      border-bottom: 1px solid var(--vscode-editor-background);
      margin-bottom: -1px; opacity: 1; font-weight: bold;
    }
    .tab-content { display: none; flex: 1; flex-direction: column; min-height: 0; overflow-y: auto; padding-right: 2px; }
    .tab-content.active { display: flex; }

    /* ── Forms ── */
    .form-group { margin-bottom: 12px; }
    .form-group:last-child { margin-bottom: 0; }
    label { display: block; margin-bottom: 4px; font-weight: bold; font-size: 12px; }
    label .hint { font-weight: normal; opacity: 0.6; font-size: 0.9em; }
    input[type=text], select, textarea {
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
      font-size: 12px; resize: none;
    }
    fieldset {
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      padding: 10px 14px 12px 14px;
      margin-bottom: 10px;
    }
    fieldset:last-child { margin-bottom: 0; }
    fieldset legend { font-weight: bold; font-size: 0.9em; padding: 0 6px; }

    /* ── Buttons ── */
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; padding: 6px 14px;
      cursor: pointer; border-radius: 2px; font-size: 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

    /* ── Quick-start bar ── */
    .quick-bar {
      display: flex; flex-direction: column; gap: 6px;
      padding: 8px 12px; margin-bottom: 10px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid var(--vscode-widget-border); border-radius: 4px;
      flex-shrink: 0;
    }
    .quick-bar label { margin: 0; font-size: 11px; opacity: 0.8; font-weight: bold; }
    .btn-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

    /* ── 2-column grid ── */
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

    /* ── Param rows ── */
    .param-header { display: grid; grid-template-columns: 1fr 90px 1.5fr 32px; gap: 6px; margin-bottom: 4px; font-size: 11px; opacity: 0.65; padding: 0 2px; }
    .param-row { display: grid; grid-template-columns: 1fr 90px 1.5fr 32px; gap: 6px; margin-bottom: 5px; }
    .param-row input, .param-row select { margin: 0; }
    .oa-param-header { display: grid; grid-template-columns: 1fr 70px 1.5fr 1fr 60px 32px; gap: 6px; margin-bottom: 4px; font-size: 11px; opacity: 0.65; padding: 0 2px; }
    .oa-param-row { display: grid; grid-template-columns: 1fr 70px 1.5fr 1fr 60px 32px; gap: 6px; margin-bottom: 5px; }
    .oa-param-row input, .oa-param-row select { margin: 0; }

    /* ── Validation box ── */
    .val-box { display: none; margin-bottom: 8px; padding: 7px 10px; border-radius: 4px; font-size: 12px; }
    .val-box.err { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
    .val-box.ok { background: var(--vscode-inputValidation-infoBackground, var(--vscode-editor-inactiveSelectionBackground)); border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-widget-border)); }

    /* ── Toolbar ── */
    .toolbar {
      display: flex; justify-content: space-between; align-items: center;
      border-top: 1px solid var(--vscode-widget-border);
      padding-top: 9px; margin-top: 8px; flex-shrink: 0;
    }
    .actions-right { display: flex; gap: 8px; }
    #statusMsg {
      flex: 1; font-size: 12px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; padding-right: 12px;
    }
    #statusMsg.ok { color: var(--vscode-terminal-ansiGreen, #73c991); }
    #statusMsg.err { color: var(--vscode-errorForeground, #f48771); }

    /* ── Layout ── */
    .main-content { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .tool-area { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .sep { border: none; border-top: 1px solid var(--vscode-widget-border); margin: 0 0 10px 0; flex-shrink: 0; }
    code { background: var(--vscode-editor-inactiveSelectionBackground); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
  </style>
</head>
<body>

  <!-- ── Header ── -->
  <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-shrink:0;">
    <h2>${headerTitle}</h2>
    <button class="secondary" id="btnLoad" style="margin-left:auto; padding:5px 12px;">📂 Load from Folder</button>
  </div>

  <!-- ── Tool-type tabs ── -->
  <div class="tabs" id="toolTypeTabs">
    <div class="tab active" id="tabTypeOpenapi">OpenAPI Tool</div>
    <div class="tab" id="tabTypePython">Python Tool</div>
  </div>
  <hr class="sep">

  <div class="main-content">

    <!-- ════════════════════ OPENAPI AREA ════════════════════ -->
    <div id="openapi-area" class="tool-area">

      <!-- Create from URL -->
      <div class="quick-bar" style="margin-bottom:10px;">
        <label>Create from URL</label>
        <div class="btn-row" style="flex-wrap:wrap;">
          <input type="text" id="oaUrlInput" placeholder="https://api.example.com/v1/endpoint?param=value&key=API_KEY" style="flex:1; min-width:200px; max-width:400px;" />
          <button class="secondary" id="btnGenerateFromUrl">Fetch &amp; Generate</button>
        </div>
      </div>
      <!-- Quick-start bar -->
      <div class="quick-bar">
        <label>Quick Start Template</label>
        <div class="btn-row">
          <select id="oaTemplateSelect" style="flex:1; min-width:160px; max-width:340px;">
            <option value="blank">Blank</option>
            <option value="weather">Weather (weatherapi.com)</option>
            <option value="world-time">World Time (timeapi.io)</option>
            <option value="aviation-weather">Aviation Weather METAR</option>
            <option value="dad-jokes">Dad Jokes</option>
            <option value="news-search">News Search</option>
            <option value="news-app">News App (NewsAPI)</option>
            <option value="universities">University Search</option>
            <option value="zip-code">Zip Code Info</option>
            <option value="currency">Currency Exchange</option>
            <option value="finance-yahoo">Yahoo Finance (Stocks)</option>
          </select>
          <button class="secondary" id="btnLoadTemplate">Load Template</button>
          <button class="secondary" id="btnPickOa">Import File</button>
          <button class="secondary" id="btnExportOpenApi">Export File</button>
          <button class="secondary" id="btnOpenJsonEditor">Open in VS Code</button>
        </div>
      </div>

      <!-- Sub-tabs -->
      <div class="tabs">
        <div class="tab active" data-oa-tab="oa-form">Form View</div>
        <div class="tab" data-oa-tab="oa-json">JSON Editor</div>
      </div>
      <hr class="sep" style="margin-bottom:8px;">

      <!-- Form tab -->
      <div id="oa-form" class="tab-content active">
        <fieldset>
          <legend>Info</legend>
          <div class="grid-2">
            <div class="form-group">
              <label>Tool Name <span class="hint">(x-ibm-skill-id, used as folder name)</span></label>
              <input type="text" id="oaName" placeholder="my_api_tool" />
            </div>
            <div class="form-group">
              <label>Title <span class="hint">(display name, info.title)</span></label>
              <input type="text" id="oaDisplayName" placeholder="My API Tool" />
            </div>
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea id="oaDescription" rows="2" placeholder="What does this tool do?"></textarea>
          </div>
          <div class="grid-2">
            <div class="form-group">
              <label>Version</label>
              <input type="text" id="oaVersion" placeholder="1.0.0" value="1.0.0" />
            </div>
            <div class="form-group">
              <label>Skill Name <span class="hint">(x-ibm-skill-name)</span></label>
              <input type="text" id="oaSkillName" placeholder="My API Tool" />
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>OpenAPI Spec</legend>
          <p style="opacity:0.75; font-size:0.9em; margin:0 0 8px 0;">Paste JSON below, load a template above, or use the <strong>JSON Editor</strong> tab for full control.</p>
          <textarea id="oaSpec" class="code-editor" rows="11" placeholder='{"openapi":"3.0.1","info":{"title":"My Tool","version":"1.0.0"},"servers":[{"url":"https://example.com"}],"paths":{}}' spellcheck="false"></textarea>
        </fieldset>

        <fieldset>
          <legend>Try it</legend>
          <p style="opacity:0.75; font-size:0.9em; margin:0 0 8px 0;">Invoke the API with current spec and parameter values.</p>
          <button type="button" class="secondary" id="btnTryIt">▶ Try it</button>
          <div id="oaTryResult" style="display:none; margin-top:10px; padding:10px; background:var(--vscode-editor-background); border:1px solid var(--vscode-panel-border); border-radius:4px; max-height:200px; overflow-y:auto; font-size:11px; font-family:monospace;"></div>
        </fieldset>

        <fieldset id="oaParamsFieldset" style="display:none;">
          <legend>Parameters <span class="hint">(edit descriptions, defaults, required)</span></legend>
          <div class="oa-param-header"><span>Name</span><span>In</span><span>Description</span><span>Default</span><span>Required</span><span></span></div>
          <div id="oaParamsList"></div>
          <button type="button" class="secondary" id="btnAddOaParam" style="padding:4px 12px; margin-top:4px;">+ Add Parameter</button>
        </fieldset>

        <fieldset id="oaConnectionFieldset">
          <legend>Connection</legend>
          <div class="form-group">
            <label>Assign connection <span class="hint">(for API key auth; active connections only)</span></label>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <select id="oaConnectionSelect" style="min-width:180px;">
                <option value="">None</option>
              </select>
              <button type="button" class="secondary" id="btnLoadConnections">↺ Refresh</button>
              <label style="font-weight:normal;"><input type="checkbox" id="oaCreateConnection" /> Create new connection</label>
            </div>
          </div>
          <div id="oaCreateConnBlock" style="display:none; margin-top:12px; padding:12px; background:var(--vscode-input-background); border-radius:6px;">
            <div class="grid-2" style="margin-bottom:8px;">
              <div class="form-group">
                <label>Connection App ID</label>
                <input type="text" id="oaConnAppId" placeholder="e.g. WeatherAPI" />
              </div>
              <div class="form-group">
                <label>API Key param name</label>
                <select id="oaApiKeyParamName">
                  <option value="key">key</option>
                  <option value="apikey">apikey</option>
                  <option value="api_key">api_key</option>
                  <option value="api-key">api-key</option>
                  <option value="_custom">Custom…</option>
                </select>
              </div>
            </div>
            <div id="oaApiKeyParamCustomRow" style="display:none;" class="form-group">
              <label>Custom param name</label>
              <input type="text" id="oaApiKeyParamCustom" placeholder="e.g. auth_key" />
            </div>
            <div class="form-group">
              <label>API Key <span class="hint">(stored in connection)</span></label>
              <input type="password" id="oaConnApiKey" placeholder="Enter API key" autocomplete="new-password" />
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Settings</legend>
          <div class="grid-2">
            <div class="form-group">
              <label>Environment</label>
              <input type="text" id="oaEnv" value="${activeEnv}" />
            </div>
            <div class="form-group">
              <label>Output Folder <span class="hint">(optional)</span></label>
              <input type="text" id="oaFolder" placeholder="WxO/Exports/Env/DateTime/tools/name (default)" />
            </div>
          </div>
          <div id="oaFilePickRow" style="display:none;" class="form-group">
            <label>Spec File Path</label>
            <div style="display:flex; gap:6px;">
              <input type="text" id="oaSpecPath" readonly style="flex:1;" />
              <button type="button" class="secondary" id="btnPickOaFile">Browse…</button>
            </div>
          </div>
        </fieldset>
      </div>

      <!-- JSON Editor tab -->
      <div id="oa-json" class="tab-content" style="flex-direction:column;">
        <div class="btn-row" style="margin-bottom:8px; flex-shrink:0;">
          <button class="secondary" id="btnValidateOa">Validate</button>
          <button class="secondary" id="btnFormatOa">Format JSON</button>
          <button class="secondary" id="btnExportOpenApiJson">Export File</button>
        </div>
        <div id="oaValBox" class="val-box"></div>
        <textarea id="jsonEditor" class="code-editor" style="flex:1; min-height:180px;" spellcheck="false" placeholder='{"openapi":"3.0.1","info":{"title":"..."},...}'></textarea>
      </div>
    </div><!-- /openapi-area -->

    <!-- ════════════════════ PYTHON AREA ════════════════════ -->
    <div id="python-area" class="tool-area" style="display:none;">

      <!-- Quick-start bar -->
      <div class="quick-bar">
        <label>Quick Start</label>
        <div class="btn-row">
          <button class="secondary" id="btnLoadPythonSample">Load Sample (Asia Time)</button>
        </div>
      </div>

      <!-- Sub-tabs -->
      <div class="tabs">
        <div class="tab active" data-py-tab="py-form">Form View</div>
        <div class="tab" data-py-tab="py-code">Code Editor</div>
      </div>
      <hr class="sep" style="margin-bottom:8px;">

      <!-- Form tab -->
      <div id="py-form" class="tab-content active">
        <fieldset>
          <legend>Info</legend>
          <div class="grid-2">
            <div class="form-group">
              <label>Tool Name <span class="hint">(snake_case)</span></label>
              <input type="text" id="pyName" placeholder="my_tool" />
            </div>
            <div class="form-group">
              <label>Title <span class="hint">(display name)</span></label>
              <input type="text" id="pyDisplayName" placeholder="My Tool" />
            </div>
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea id="pyDesc" rows="2" placeholder="What does this tool do?"></textarea>
          </div>
          <div class="grid-2">
            <div class="form-group">
              <label>Function <span class="hint">(module:function)</span></label>
              <input type="text" id="pyFunction" placeholder="tool:my_tool" />
            </div>
            <div class="form-group">
              <label>Python Filename</label>
              <input type="text" id="pyFilename" placeholder="tool.py" value="tool.py" />
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Parameters <span style="font-weight:normal; font-size:0.85em; opacity:0.7;">(inputs the agent passes to the tool)</span></legend>
          <div class="param-header"><span>Name</span><span>Type</span><span>Description</span><span></span></div>
          <div id="pyParams"></div>
          <button type="button" class="secondary" id="btnAddParam" style="padding:4px 12px; margin-top:2px;">+ Add Parameter</button>
        </fieldset>

        <fieldset>
          <legend>Settings</legend>
          <div class="grid-2">
            <div class="form-group">
              <label>Environment</label>
              <input type="text" id="pyEnv" value="${activeEnv}" />
            </div>
            <div class="form-group">
              <label>Output Folder <span class="hint">(optional)</span></label>
              <input type="text" id="pyFolder" placeholder="WxO/Exports/Env/DateTime/tools/name (default)" />
            </div>
          </div>
        </fieldset>
      </div>

      <!-- Code Editor tab -->
      <div id="py-code" class="tab-content" style="flex-direction:column;">
        <fieldset style="flex-shrink:0; flex:1; display:flex; flex-direction:column;">
          <legend>Python Code</legend>
          <p style="opacity:0.75; font-size:0.9em; margin:0 0 8px 0; flex-shrink:0;">Use <code>@tool()</code> from <code>ibm_watsonx_orchestrate.agent_builder.tools</code>. Changes here are saved when you click Create &amp; Import. Use <strong>Open in VS Code</strong> for full editor support.</p>
          <div style="display:flex; gap:8px; margin-bottom:8px; flex-shrink:0;">
            <button type="button" class="secondary" id="btnOpenPyInEditor">Open in VS Code</button>
          </div>
          <textarea id="pyCodeEditor" class="code-editor" style="flex:1; min-height:180px;" rows="14" spellcheck="false" placeholder="# Your @tool() decorated function here"></textarea>
        </fieldset>
        <fieldset style="flex-shrink:0;">
          <legend>requirements.txt</legend>
          <textarea id="pyRequirements" class="code-editor" rows="4" spellcheck="false" placeholder="pytz&#10;ibm-watsonx-orchestrate"></textarea>
        </fieldset>
      </div>
    </div><!-- /python-area -->

  </div><!-- /main-content -->

  <!-- ── Latest report ── -->
  <div style="margin:10px 0; padding:8px; background:var(--vscode-input-background, #222); border-radius:4px; flex-shrink:0;">
    <span style="opacity:0.8; font-size:12px;">Latest export report: </span>
    <span id="createToolReportLink">—</span>
    <button class="secondary" id="btnRefreshCreateToolReport" style="margin-left:8px; padding:2px 8px; font-size:11px;">Refresh</button>
  </div>

  <!-- ── Toolbar ── -->
  <div class="toolbar">
    <div id="statusMsg"></div>
    <div class="actions-right">
      <button class="secondary" id="btnClose">Close</button>
      <button id="btnCreate">▶ ${mainButtonTextEsc}</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    var _debug = ${_debug};
    var currentToolType = 'openapi';
    var loadedPythonSample = null;
    var lastOpenedJsonPath = '';
    var lastOpenedPyPath = '';
    var loadedPyFilePath = '';
    if (_debug) try { vscode.postMessage({ command: 'debugLog', message: '[Create Tool] Script block started' }); } catch(e) {}
    window.onerror = function(msg, url, line, col, err) {
      if (_debug && typeof vscode.postMessage === 'function') {
        try { vscode.postMessage({ command: 'panelError', message: String(msg), url: url||'', line: line||0, col: col||0, stack: (err&&err.stack)||'' }); } catch(e) {}
      }
      return false;
    };

    // ── Status ──
    function setStatus(msg, isError) {
      var el = document.getElementById('statusMsg');
      el.textContent = msg || '';
      el.className = isError ? 'err' : (msg ? 'ok' : '');
    }

    // ── Wire tab buttons via addEventListener (inline onclick blocked by VS Code webview CSP) ──
    document.getElementById('tabTypeOpenapi').addEventListener('click', function() { switchToolType('openapi'); });
    document.getElementById('tabTypePython').addEventListener('click',  function() { switchToolType('python'); });
    document.querySelectorAll('[data-oa-tab]').forEach(function(el) {
      el.addEventListener('click', function() { switchOaTab(el.getAttribute('data-oa-tab')); });
    });
    document.querySelectorAll('[data-py-tab]').forEach(function(el) {
      el.addEventListener('click', function() { switchPyTab(el.getAttribute('data-py-tab')); });
    });

    // ── Tool type switch ──
    function switchToolType(type) {
      currentToolType = type;
      document.getElementById('tabTypeOpenapi').classList.toggle('active', type === 'openapi');
      document.getElementById('tabTypePython').classList.toggle('active', type === 'python');
      document.getElementById('openapi-area').style.display = type === 'openapi' ? 'flex' : 'none';
      document.getElementById('python-area').style.display = type === 'python' ? 'flex' : 'none';
      if (type === 'openapi') vscode.postMessage({ command: 'loadActiveConnections' });
    }

    // ── OpenAPI sub-tab ──
    function switchOaTab(tab) {
      document.querySelectorAll('[data-oa-tab]').forEach(function(t) {
        t.classList.toggle('active', t.getAttribute('data-oa-tab') === tab);
      });
      ['oa-form','oa-json'].forEach(function(id) {
        document.getElementById(id).classList.toggle('active', id === tab);
      });
      if (tab === 'oa-json') {
        var spec = document.getElementById('oaSpec').value.trim();
        var jsonEl = document.getElementById('jsonEditor');
        if (spec && !jsonEl.value.trim()) {
          jsonEl.value = spec;
        } else if (!jsonEl.value.trim() && !spec) {
          var built = buildOasFromForm();
          if (built) jsonEl.value = JSON.stringify(built, null, 2);
        }
      }
    }

    // ── Python sub-tab ──
    function switchPyTab(tab) {
      document.querySelectorAll('[data-py-tab]').forEach(function(t) {
        t.classList.toggle('active', t.getAttribute('data-py-tab') === tab);
      });
      ['py-form','py-code'].forEach(function(id) {
        document.getElementById(id).classList.toggle('active', id === tab);
      });
    }

    // ── Build minimal OAS from form fields ──
    function buildOasFromForm() {
      var name = document.getElementById('oaName').value.trim();
      var displayName = document.getElementById('oaDisplayName').value.trim() || name;
      if (!name && !displayName) return null;
      return {
        openapi: '3.0.1',
        info: {
          title: displayName || name,
          version: document.getElementById('oaVersion').value.trim() || '1.0.0',
          description: document.getElementById('oaDescription').value.trim() || '',
          'x-ibm-skill-name': document.getElementById('oaSkillName').value.trim() || displayName || name,
          'x-ibm-skill-id': (name || (function(s){var o=''; var w=0; for(var i=0;i<s.length;i++){var c=s[i]; var sp=c===' '||c==='\\t'||c==='\\n'||c==='\\r'; if(sp){if(!w)o+='_';w=1;} else{o+=c;w=0;}} return o;})(displayName.toLowerCase())).split('_').join('-')
        },
        servers: [{ url: 'https://example.com' }],
        paths: {}
      };
    }

    // ── Sync form from OAS JSON ──
    function syncFormFromOas(oas) {
      if (!oas || !oas.info) return;
      var info = oas.info || {};
      document.getElementById('oaName').value = ((info['x-ibm-skill-id'] || '').split('-').join('_')) || '';
      document.getElementById('oaDisplayName').value = info.title || '';
      document.getElementById('oaDescription').value = info.description || '';
      document.getElementById('oaVersion').value = info.version || '1.0.0';
      document.getElementById('oaSkillName').value = info['x-ibm-skill-name'] || info.title || '';
      renderOaParamsFromSpec(oas);
    }

    // ── OpenAPI Parameters ──
    function getFirstOpParams(oas) {
      var paths = oas.paths || {};
      for (var p in paths) {
        var pathItem = paths[p];
        for (var meth in pathItem) {
          if (meth === 'get' || meth === 'post' || meth === 'put' || meth === 'delete' || meth === 'patch') {
            var op = pathItem[meth];
            if (op && op.parameters) return { path: p, method: meth, params: op.parameters };
          }
        }
      }
      return { path: '', method: 'get', params: [] };
    }

    function setFirstOpParams(oas, params) {
      var paths = oas.paths || {};
      for (var p in paths) {
        var pathItem = paths[p];
        for (var meth in pathItem) {
          if (meth === 'get' || meth === 'post' || meth === 'put' || meth === 'delete' || meth === 'patch') {
            if (pathItem[meth]) { pathItem[meth].parameters = params; return; }
          }
        }
      }
    }

    function renderOaParamsFromSpec(oas) {
      var r = getFirstOpParams(oas);
      var params = r.params || [];
      var list = document.getElementById('oaParamsList');
      var fieldset = document.getElementById('oaParamsFieldset');
      if (!list || !fieldset) return;
      list.innerHTML = '';
      if (params.length === 0) { fieldset.style.display = 'none'; return; }
      fieldset.style.display = '';
      params.forEach(function(par, idx) {
        var row = document.createElement('div');
        row.className = 'oa-param-row';
        row.innerHTML =
          '<input type="text" data-oa-p="name" value="' + escAttr(par.name||'') + '" placeholder="param" />' +
          '<select data-oa-p="in"><option value="query"' + ((par.in||'query')==='query'?' selected':'') + '>query</option><option value="path"' + (par.in==='path'?' selected':'') + '>path</option><option value="header"' + (par.in==='header'?' selected':'') + '>header</option></select>' +
          '<input type="text" data-oa-p="desc" value="' + escAttr(par.description||'') + '" placeholder="Description" />' +
          '<input type="text" data-oa-p="default" value="' + escAttr((par.schema&&par.schema.default)!==undefined?String(par.schema.default):'') + '" placeholder="Default" />' +
          '<select data-oa-p="required"><option value="0"' + (!par.required?' selected':'') + '>No</option><option value="1"' + (par.required?' selected':'') + '>Yes</option></select>' +
          '<button type="button" class="secondary" data-oa-remove style="padding:4px 8px;">×</button>';
        row.querySelector('[data-oa-remove]').onclick = function() { row.remove(); syncOaParamsToSpec(); };
        ['name','in','desc','default','required'].forEach(function(k) {
          var el = row.querySelector('[data-oa-p="' + k + '"]');
          if (el) el.addEventListener('change', syncOaParamsToSpec);
          if (el && k!=='required') el.addEventListener('input', syncOaParamsToSpec);
        });
        list.appendChild(row);
      });
    }

    function syncOaParamsToSpec() {
      var list = document.getElementById('oaParamsList');
      if (!list) return;
      var params = [];
      list.querySelectorAll('.oa-param-row').forEach(function(row) {
        var nm = row.querySelector('[data-oa-p="name"]').value.trim();
        if (!nm) return;
        var p = {
          name: nm,
          in: row.querySelector('[data-oa-p="in"]').value || 'query',
          required: row.querySelector('[data-oa-p="required"]').value === '1',
          description: row.querySelector('[data-oa-p="desc"]').value.trim(),
          schema: { type: 'string' }
        };
        var def = row.querySelector('[data-oa-p="default"]').value.trim();
        if (def) p.schema.default = def;
        params.push(p);
      });
      var specStr = document.getElementById('oa-json').classList.contains('active') ? document.getElementById('jsonEditor').value : document.getElementById('oaSpec').value;
      if (!specStr) return;
      try {
        var oas = JSON.parse(specStr);
        setFirstOpParams(oas, params);
        var out = JSON.stringify(oas, null, 2);
        document.getElementById('oaSpec').value = out;
        document.getElementById('jsonEditor').value = out;
      } catch(_) {}
    }

    document.getElementById('btnAddOaParam').onclick = function() {
      var list = document.getElementById('oaParamsList');
      var fieldset = document.getElementById('oaParamsFieldset');
      if (!list) return;
      fieldset.style.display = '';
      var row = document.createElement('div');
      row.className = 'oa-param-row';
      row.innerHTML =
        '<input type="text" data-oa-p="name" placeholder="param" />' +
        '<select data-oa-p="in"><option value="query" selected>query</option><option value="path">path</option><option value="header">header</option></select>' +
        '<input type="text" data-oa-p="desc" placeholder="Description" />' +
        '<input type="text" data-oa-p="default" placeholder="Default" />' +
        '<select data-oa-p="required"><option value="0" selected>No</option><option value="1">Yes</option></select>' +
        '<button type="button" class="secondary" data-oa-remove style="padding:4px 8px;">×</button>';
      row.querySelector('[data-oa-remove]').onclick = function() { row.remove(); syncOaParamsToSpec(); };
      ['name','in','desc','default','required'].forEach(function(k) {
        var el = row.querySelector('[data-oa-p="' + k + '"]');
        if (el) el.addEventListener('change', syncOaParamsToSpec);
        if (el && k!=='required') el.addEventListener('input', syncOaParamsToSpec);
      });
      list.appendChild(row);
    };

    // ── Validate OAS ──
    function validateOas(oas) {
      var errors = [];
      if (!oas || typeof oas !== 'object') return ['Content is not a valid object.'];
      if (!oas.openapi) errors.push('Missing required field: openapi (e.g. "3.0.1")');
      if (!oas.info) errors.push('Missing required field: info');
      else if (!oas.info.title) errors.push('info.title is required');
      if (oas.paths !== undefined && (typeof oas.paths !== 'object' || Array.isArray(oas.paths))) errors.push('paths must be an object');
      if (oas.servers !== undefined && !Array.isArray(oas.servers)) errors.push('servers must be an array');
      return errors;
    }

    // ── Add param row ──
    function addParamRow(nm, tp, desc) {
      var row = document.createElement('div');
      row.className = 'param-row';
      row.innerHTML = '<input type="text" data-p="name" value="' + escAttr(nm||'') + '" placeholder="param_name" />' +
        '<select data-p="type">' +
          '<option value="string"' + ((tp||'string')==='string'?' selected':'') + '>string</option>' +
          '<option value="number"' + ((tp||'')==='number'?' selected':'') + '>number</option>' +
          '<option value="boolean"' + ((tp||'')==='boolean'?' selected':'') + '>boolean</option>' +
        '</select>' +
        '<input type="text" data-p="desc" value="' + escAttr(desc||'') + '" placeholder="Description" />' +
        '<button type="button" class="secondary" onclick="this.closest(&#39;.param-row&#39;).remove()" title="Remove" style="padding:4px 8px;">×</button>';
      document.getElementById('pyParams').appendChild(row);
    }

    function escAttr(s) {
      return String(s||'').split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
    }

    // ── Collect params ──
    function collectParams() {
      var params = [];
      document.querySelectorAll('#pyParams .param-row').forEach(function(row) {
        var nm = row.querySelector('[data-p="name"]').value.trim().split('').map(function(c){var n=c.charCodeAt(0); return (n>=48&&n<=57)||(n>=65&&n<=90)||(n>=97&&n<=122)||n===95?c:'_';}).join('');
        if (!nm) return;
        params.push({ name: nm, type: row.querySelector('[data-p="type"]').value, description: row.querySelector('[data-p="desc"]').value.trim() || nm });
      });
      return params;
    }

    // ── Wire buttons ──
    document.getElementById('btnLoad').onclick = function() { vscode.postMessage({ command: 'loadFromFilesystem' }); };
    document.getElementById('btnClose').onclick = function() { vscode.postMessage({ command: 'close' }); };
    document.getElementById('btnAddParam').onclick = function() { addParamRow(); };

    document.getElementById('btnGenerateFromUrl').onclick = function() {
      var url = document.getElementById('oaUrlInput').value.trim();
      var name = document.getElementById('oaName').value.trim();
      if (!url) { setStatus('Enter a URL.', true); return; }
      vscode.postMessage({ command: 'generateFromUrl', content: { url: url, toolName: name || undefined } });
    };
    document.getElementById('btnLoadConnections').onclick = function() { vscode.postMessage({ command: 'loadActiveConnections' }); };
    document.getElementById('oaCreateConnection').onchange = function() {
      document.getElementById('oaCreateConnBlock').style.display = this.checked ? 'block' : 'none';
    };
    document.getElementById('oaApiKeyParamName').onchange = function() {
      document.getElementById('oaApiKeyParamCustomRow').style.display = this.value === '_custom' ? 'block' : 'none';
    };
    document.getElementById('btnTryIt').onclick = function() {
      var specStr = document.getElementById('oa-json').classList.contains('active') ? document.getElementById('jsonEditor').value : document.getElementById('oaSpec').value;
      if (!specStr) { setStatus('No OpenAPI spec.', true); return; }
      try {
        var oas = JSON.parse(specStr);
        var servers = oas.servers || [];
        var base = servers[0] && servers[0].url ? servers[0].url.replace(/\\/$/, '') : '';
        var r = getFirstOpParams(oas);
        if (!r.path) { setStatus('No path in spec.', true); return; }
        var url = base + (r.path.charAt(0)==='/' ? '' : '/') + r.path;
        var params = r.params || [];
        var connAppId = document.getElementById('oaConnectionSelect').value.trim();
        var apiKeyParam = document.getElementById('oaApiKeyParamName').value;
        if (apiKeyParam === '_custom') apiKeyParam = document.getElementById('oaApiKeyParamCustom').value.trim();
        var comp = oas.components || {};
        var sec = comp.securitySchemes || {};
        var secName = Object.keys(sec).find(function(k) { return (sec[k].type==='apiKey' && sec[k].in==='query'); });
        if (secName && sec[secName].name) apiKeyParam = sec[secName].name;
        var search = [];
        params.forEach(function(p) {
          var val = p.schema && p.schema.default !== undefined ? String(p.schema.default) : '';
          if (p.name === apiKeyParam && connAppId) return;
          if (val) search.push(encodeURIComponent(p.name) + '=' + encodeURIComponent(val));
        });
        if (search.length) url += (url.indexOf('?')>=0 ? '&' : '?') + search.join('&');
        setStatus('Invoking…');
        document.getElementById('oaTryResult').style.display = 'none';
        vscode.postMessage({ command: 'invokeOpenApi', content: { url: url, method: 'GET', connectionAppId: connAppId || undefined, apiKeyParamName: apiKeyParam || undefined, env: document.getElementById('oaEnv').value.trim() || 'TZ1' } });
      } catch(e) { setStatus('Error: ' + e.message, true); }
    };
    document.getElementById('btnLoadTemplate').onclick = function() {
      vscode.postMessage({ command: 'loadTemplate', templateId: document.getElementById('oaTemplateSelect').value });
    };
    document.getElementById('btnPickOa').onclick = function() { vscode.postMessage({ command: 'pickOpenApiSpec' }); };
    document.getElementById('btnOpenJsonEditor').onclick = function() {
      var specStr = document.getElementById('oa-json').classList.contains('active') ? document.getElementById('jsonEditor').value : document.getElementById('oaSpec').value;
      var name = document.getElementById('oaName').value.trim() || 'my_api_tool';
      var env = document.getElementById('oaEnv').value.trim() || 'TZ1';
      vscode.postMessage({ command: 'openJsonInEditor', content: { spec: specStr, name: name, env: env } });
    };
    document.getElementById('btnPickOaFile').onclick = function() { vscode.postMessage({ command: 'pickOpenApiSpec' }); };
    document.getElementById('btnLoadPythonSample').onclick = function() { vscode.postMessage({ command: 'requestLoadPythonSample' }); };
    document.getElementById('btnOpenPyInEditor').onclick = function() {
      if (loadedPyFilePath) {
        vscode.postMessage({ command: 'openPythonInEditor', content: { pyFilePath: loadedPyFilePath } });
      } else {
        var name = document.getElementById('pyName').value.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'my_tool';
        var pyFile = document.getElementById('pyFilename').value.trim() || 'tool.py';
        var pyContent = document.getElementById('pyCodeEditor').value;
        var requirements = document.getElementById('pyRequirements').value;
        var env = document.getElementById('pyEnv').value.trim() || 'TZ1';
        vscode.postMessage({ command: 'openPythonInEditor', content: { pyContent: pyContent, requirements: requirements, name: name, pyFile: pyFile, env: env } });
      }
    };

    // Validate button
    document.getElementById('btnValidateOa').onclick = function() {
      var jsonStr = document.getElementById('jsonEditor').value.trim();
      var box = document.getElementById('oaValBox');
      if (!jsonStr) { box.style.display = 'none'; return; }
      try {
        var oas = JSON.parse(jsonStr);
        var errs = validateOas(oas);
        box.style.display = 'block';
        if (errs.length === 0) {
          box.className = 'val-box ok';
          box.innerHTML = '✅ OpenAPI spec is valid.';
        } else {
          box.className = 'val-box err';
          box.innerHTML = '<strong>Validation errors:</strong><ul style="margin:4px 0 0 0;padding-left:18px;">' +
            errs.map(function(e){ return '<li>' + escAttr(e) + '</li>'; }).join('') + '</ul>';
        }
      } catch(e) {
        box.style.display = 'block';
        box.className = 'val-box err';
        box.innerHTML = '❌ Invalid JSON: ' + escAttr(e.message);
      }
    };

    // Format JSON
    document.getElementById('btnFormatOa').onclick = function() {
      var el = document.getElementById('jsonEditor');
      try { el.value = JSON.stringify(JSON.parse(el.value), null, 2); }
      catch(e) { setStatus('Invalid JSON: ' + e.message, true); }
    };

    // Export OpenAPI
    function doExportOpenApi() {
      var specStr = '';
      if (document.getElementById('oa-json').classList.contains('active')) {
        specStr = document.getElementById('jsonEditor').value.trim();
      }
      if (!specStr) specStr = document.getElementById('oaSpec').value.trim();
      if (!specStr) {
        var built = buildOasFromForm();
        if (built) specStr = JSON.stringify(built, null, 2);
      }
      if (!specStr) { setStatus('No OpenAPI spec to export.', true); return; }
      try {
        var content = JSON.parse(specStr);
        if (!content.openapi) { setStatus('Not an OpenAPI spec (missing "openapi" field).', true); return; }
        vscode.postMessage({ command: 'exportOpenAPI', content: content });
      } catch(e) { setStatus('Invalid JSON: ' + e.message, true); }
    }
    document.getElementById('btnExportOpenApi').onclick = doExportOpenApi;
    document.getElementById('btnExportOpenApiJson').onclick = doExportOpenApi;

    // Auto-sync spec textarea ↔ form on blur
    document.getElementById('jsonEditor').addEventListener('blur', function() {
      try {
        var oas = JSON.parse(this.value);
        syncFormFromOas(oas);
        document.getElementById('oaSpec').value = this.value;
      } catch(_) {}
    });
    document.getElementById('oaSpec').addEventListener('blur', function() {
      try {
        var oas = JSON.parse(this.value);
        syncFormFromOas(oas);
        document.getElementById('jsonEditor').value = this.value;
      } catch(_) {}
    });

    // ── Messages from extension ──
    window.addEventListener('message', function(e) {
      var m = e.data;
      if (m.command === 'toolLoaded') {
        loadedPythonSample = null;
        var d = m.data;
        if (d.kind === 'python') {
          lastOpenedPyPath = '';
          loadedPyFilePath = d.pyFilePath || '';
          switchToolType('python');
          document.getElementById('pyName').value = d.name || '';
          document.getElementById('pyDisplayName').value = d.displayName || '';
          document.getElementById('pyDesc').value = d.description || '';
          var fn = d.toolSpec && d.toolSpec.binding && d.toolSpec.binding.python ? d.toolSpec.binding.python.function || '' : '';
          document.getElementById('pyFunction').value = fn;
          document.getElementById('pyFilename').value = d.pyFilePath ? (function(p){var i=Math.max(p.lastIndexOf('/'),p.lastIndexOf('\\\\')); return i>=0?p.slice(i+1):p;})(d.pyFilePath) : 'tool.py';
          document.getElementById('pyParams').innerHTML = '';
          (d.params || []).forEach(function(p) { addParamRow(p.name, p.type, p.description); });
          if (!(d.params||[]).length) addParamRow();
          if (d.pyContent) document.getElementById('pyCodeEditor').value = d.pyContent;
          if (d.requirements) document.getElementById('pyRequirements').value = d.requirements;
          if (d.folderPath) document.getElementById('pyFolder').value = d.folderPath;
        } else {
          lastOpenedJsonPath = '';
          lastOpenedPyPath = '';
          loadedPyFilePath = '';
          switchToolType('openapi');
          var specStr = JSON.stringify(d.spec || {}, null, 2);
          document.getElementById('oaSpec').value = specStr;
          document.getElementById('jsonEditor').value = specStr;
          syncFormFromOas(d.spec || {});
          if (d.folderPath) document.getElementById('oaFolder').value = d.folderPath;
        }
        setStatus('Loaded: ' + (d.folderPath || ''));
      } else if (m.command === 'openApiSpecPicked') {
        lastOpenedJsonPath = '';
        lastOpenedPyPath = '';
        document.getElementById('oaSpecPath').value = m.path || '';
        if (m.content) {
          var specStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
          document.getElementById('oaSpec').value = specStr;
          document.getElementById('jsonEditor').value = specStr;
          try { syncFormFromOas(JSON.parse(specStr)); } catch(_) {}
          setStatus('File imported.');
        }
      } else if (m.command === 'openApiTemplateLoaded') {
        lastOpenedJsonPath = '';
        lastOpenedPyPath = '';
        loadedPyFilePath = '';
        loadedPythonSample = null;
        switchToolType('openapi');
        var specStr = JSON.stringify(m.spec || {}, null, 2);
        document.getElementById('oaSpec').value = specStr;
        document.getElementById('jsonEditor').value = specStr;
        syncFormFromOas(m.spec || {});
        setStatus('Template loaded: ' + (m.displayName || ''));
      } else if (m.command === 'openApiFromUrlLoaded') {
        lastOpenedJsonPath = '';
        lastOpenedPyPath = '';
        loadedPyFilePath = '';
        loadedPythonSample = null;
        switchToolType('openapi');
        var specStr = JSON.stringify(m.spec || {}, null, 2);
        document.getElementById('oaSpec').value = specStr;
        document.getElementById('jsonEditor').value = specStr;
        document.getElementById('oaName').value = m.name || '';
        document.getElementById('oaDisplayName').value = m.displayName || '';
        syncFormFromOas(m.spec || {});
        if (m.apiKeyParamName) {
          var sel = document.getElementById('oaApiKeyParamName');
          var opt = Array.from(sel.options).find(function(o) { return o.value === m.apiKeyParamName; });
          if (opt) sel.value = m.apiKeyParamName;
          else { sel.value = '_custom'; document.getElementById('oaApiKeyParamCustom').value = m.apiKeyParamName; document.getElementById('oaApiKeyParamCustomRow').style.display = ''; }
          document.getElementById('oaCreateConnection').checked = true;
          document.getElementById('oaCreateConnBlock').style.display = 'block';
          document.getElementById('oaConnAppId').value = m.name || '';
        }
        setStatus('Generated from URL: ' + (m.displayName || ''));
      } else if (m.command === 'activeConnectionsLoaded') {
        var sel = document.getElementById('oaConnectionSelect');
        var cur = sel.value;
        sel.innerHTML = '<option value="">None</option>';
        (m.connections || []).forEach(function(c) {
          var o = document.createElement('option');
          o.value = c.name;
          o.textContent = c.name;
          sel.appendChild(o);
        });
        if (cur && sel.querySelector('option[value="' + cur + '"]')) sel.value = cur;
      } else if (m.command === 'invokeResult') {
        var box = document.getElementById('oaTryResult');
        if (!box) return;
        box.style.display = 'block';
        if (m.error) {
          box.innerHTML = '<span style="color:var(--vscode-errorForeground);">Error: ' + escAttr(m.error) + '</span>';
        } else {
          try {
            var j = JSON.parse(m.body || '{}');
            box.innerHTML = '<pre>' + escAttr(JSON.stringify(j, null, 2)) + '</pre>';
          } catch(_) {
            box.innerHTML = '<pre>' + escAttr(m.body || '') + '</pre>';
          }
        }
      } else if (m.command === 'openJsonInEditorResult') {
        lastOpenedJsonPath = m.path || '';
        lastOpenedPyPath = '';
        setStatus('Opened in VS Code. Edit and use Create & Import — spec will be read from: ' + (m.path || ''));
      } else if (m.command === 'openPythonInEditorResult') {
        lastOpenedPyPath = m.path || '';
        lastOpenedJsonPath = '';
        setStatus('Opened in VS Code. Edit and use Create & Import — Python will be read from: ' + (m.path || ''));
      } else if (m.command === 'loadPythonSample') {
        loadedPythonSample = m;
        switchToolType('python');
        document.getElementById('pyName').value = m.name || '';
        document.getElementById('pyDisplayName').value = m.displayName || '';
        document.getElementById('pyDesc').value = m.description || '';
        document.getElementById('pyFunction').value = m.function || '';
        document.getElementById('pyFilename').value = m.filename || 'tool.py';
        document.getElementById('pyCodeEditor').value = m.content || '';
        document.getElementById('pyRequirements').value = m.requirements || '';
        document.getElementById('pyParams').innerHTML = '';
        var props = (m.input_schema && m.input_schema.properties) || {};
        Object.keys(props).forEach(function(n) { addParamRow(n, props[n].type || 'string', props[n].description || ''); });
        if (!Object.keys(props).length) addParamRow();
        switchPyTab('py-form');
        setStatus('Sample loaded: ' + (m.displayName || ''));
      } else if (m.command === 'status') {
        setStatus(m.message, !!m.isError);
      } else if (m.command === 'latestExportReport') {
        updateCreateToolReportLink(m.path);
      }
    });

    function updateCreateToolReportLink(p) {
      var el = document.getElementById('createToolReportLink');
      if (!el) return;
      if (p) {
        el.innerHTML = '<a href="#" style="color:var(--vscode-textLink-foreground);">📄 Open Report</a>';
        el.querySelector('a').onclick = function(ev) {
          ev.preventDefault();
          vscode.postMessage({ command: 'openReport', path: p });
        };
      } else {
        el.textContent = '—';
      }
    }
    var btnRefreshCt = document.getElementById('btnRefreshCreateToolReport');
    if (btnRefreshCt) btnRefreshCt.onclick = function() { vscode.postMessage({ command: 'getLatestExportReport' }); };
    vscode.postMessage({ command: 'getLatestExportReport' });

    // ── Create & Import ──
    document.getElementById('btnCreate').onclick = function() {
      setStatus('');
      if (currentToolType === 'openapi') {
        // Prefer JSON editor (if on that tab), fall back to spec textarea, then build from form
        var specStr = '';
        if (document.getElementById('oa-json').classList.contains('active')) {
          specStr = document.getElementById('jsonEditor').value.trim();
        }
        if (!specStr) specStr = document.getElementById('oaSpec').value.trim();
        if (!specStr) {
          var built = buildOasFromForm();
          if (built) specStr = JSON.stringify(built);
        }
        if (!specStr && !lastOpenedJsonPath) { setStatus('Provide an OpenAPI spec — paste JSON, load a template, or import a file.', true); return; }
        try {
          var oas = lastOpenedJsonPath ? null : JSON.parse(specStr);
          if (!lastOpenedJsonPath) {
            var errs = validateOas(oas);
            if (errs.length > 0) { setStatus('Validation failed: ' + errs.join('; '), true); return; }
          }
          var name = document.getElementById('oaName').value.trim().split('').map(function(c){var n=c.charCodeAt(0); return (n>=48&&n<=57)||(n>=65&&n<=90)||(n>=97&&n<=122)||n===95||n===45?c:'_';}).join('')
            || (oas && oas.info && oas.info['x-ibm-skill-id'] ? oas.info['x-ibm-skill-id'].split('-').join('_') : 'my_api_tool');
          var displayName = document.getElementById('oaDisplayName').value.trim() || (oas && oas.info && oas.info.title) || name;
          var connSel = document.getElementById('oaConnectionSelect').value.trim();
          var createConn = document.getElementById('oaCreateConnection').checked;
          var connAppId = createConn ? (document.getElementById('oaConnAppId').value.trim() || name) : connSel;
          var connApiKey = createConn ? document.getElementById('oaConnApiKey').value : '';
          var apiKeyParam = document.getElementById('oaApiKeyParamName').value;
          if (apiKeyParam === '_custom') apiKeyParam = document.getElementById('oaApiKeyParamCustom').value.trim();
          vscode.postMessage({ command: 'createOpenApiTool', content: {
            name: name, displayName: displayName,
            spec: lastOpenedJsonPath ? undefined : specStr,
            specPath: lastOpenedJsonPath || undefined,
            env: document.getElementById('oaEnv').value.trim() || 'TZ1',
            folder: document.getElementById('oaFolder').value.trim(),
            connectionAppId: connAppId || undefined,
            createConnection: createConn,
            connAppId: createConn ? connAppId : undefined,
            connApiKey: createConn ? connApiKey : undefined,
            apiKeyParamName: apiKeyParam || undefined
          }});
        } catch(e) { setStatus('Invalid JSON: ' + e.message, true); }
      } else {
        // Python
        var name = document.getElementById('pyName').value.trim().split('').map(function(c){var n=c.charCodeAt(0); return (n>=48&&n<=57)||(n>=65&&n<=90)||(n>=97&&n<=122)||n===95?c:'_';}).join('') || 'my_tool';
        var displayName = document.getElementById('pyDisplayName').value.trim();
        var description = document.getElementById('pyDesc').value.trim();
        var fnName = document.getElementById('pyFunction').value.trim();
        var filename = document.getElementById('pyFilename').value.trim() || 'tool.py';
        var pyCode = document.getElementById('pyCodeEditor').value.trim();
        var requirements = document.getElementById('pyRequirements').value.trim();
        var env = document.getElementById('pyEnv').value.trim() || 'TZ1';
        var folder = document.getElementById('pyFolder').value.trim();
        var params = collectParams();

        // Build toolSpec from current form state
        var inputSchema = { type: 'object', properties: {}, required: [] };
        params.forEach(function(p) { inputSchema.properties[p.name] = { type: p.type, description: p.description }; });
        var toolSpec = {
          name: name,
          display_name: displayName || name,
          description: description || (displayName || name) + ' Python tool.',
          permission: 'read_only',
          input_schema: inputSchema,
          output_schema: { type: 'object' },
          binding: { python: {
            function: fnName || ((filename.slice(-3)==='.py'?filename.slice(0,-3):filename) + ':' + name),
            requirements: (requirements || 'ibm-watsonx-orchestrate').split('\\n').map(function(s){return s.split('\\r').join('').trim();}).filter(Boolean),
            connections: {}
          }}
        };
        var pyPathToUse = lastOpenedPyPath || (loadedPyFilePath || '');
        vscode.postMessage({ command: 'createPythonTool', content: {
          toolSpecJson: JSON.stringify(toolSpec),
          pyContent: pyPathToUse ? undefined : (pyCode || undefined),
          pyPath: pyPathToUse || undefined,
          pyFile: filename,
          requirements: pyPathToUse ? undefined : (requirements || undefined),
          name: name, displayName: displayName,
          env: env, folder: folder
        }});
      }
    };

    // ── Init ──
    addParamRow();
    vscode.postMessage({ command: 'loadActiveConnections' });
    if (_debug) try { vscode.postMessage({ command: 'debugLog', message: '[Create Tool] Init complete, switchToolType=' + (typeof switchToolType) }); } catch(e) {}
  </script>
</body>
</html>`;
    }
}

