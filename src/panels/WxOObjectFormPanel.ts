/**
 * WxO Object Form Panel — Create / Edit form for Agents, Flows, and Connections.
 *
 * Provides:
 *   - Form View  : type-specific fields (name, description, model, instructions, tools, etc.)
 *   - YAML/JSON Editor tab : raw editor, always synced with form
 *   - Load from File  : opens a file-picker, loads content into both tabs
 *   - Export to File  : saves current editor content to a user-chosen file
 *   - Open in Editor  : writes to WxO/Edits/{name}/ and opens in VS Code text editor
 *   - Save & Import   : writes to WxO/Edits/{name}/ and runs CLI import in terminal
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

export type ObjectFormType = 'agents' | 'flows' | 'connections';

export class WxOObjectFormPanel {
    private static readonly _panels = new Map<string, WxOObjectFormPanel>();

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _provider: WxOImporterExporterViewProvider;
    private readonly _type: ObjectFormType;
    private readonly _editName: string | undefined;
    private readonly _disposables: vscode.Disposable[] = [];

    // ── Factory ───────────────────────────────────────────────────────────────

    public static render(
        extensionUri: vscode.Uri,
        provider: WxOImporterExporterViewProvider,
        type: ObjectFormType,
        editName?: string,
    ): void {
        const key = `${type}:${editName ?? '__new__'}`;
        const existing = WxOObjectFormPanel._panels.get(key);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const label = typeLabel(type);
        const panel = vscode.window.createWebviewPanel(
            'wxoObjectForm',
            editName ? `Edit ${label}: ${editName}` : `Create ${label}`,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        const instance = new WxOObjectFormPanel(panel, extensionUri, provider, type, editName);
        WxOObjectFormPanel._panels.set(key, instance);
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        provider: WxOImporterExporterViewProvider,
        type: ObjectFormType,
        editName?: string,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._provider = provider;
        this._type = type;
        this._editName = editName;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._loadingHtml();
        this._initialize();

        this._panel.webview.onDidReceiveMessage(
            async (msg: Record<string, unknown>) => {
                try {
                    switch (msg.command as string) {
                        case 'save':          await this._handleSave(msg); break;
                        case 'loadFromFile':  await this._handleLoadFromFile(); break;
                        case 'exportToFile':  await this._handleExportToFile(msg); break;
                        case 'openInEditor':  await this._handleOpenInEditor(msg); break;
                        case 'loadToolsList':  await this._handleLoadToolsList(); break;
                        case 'loadPluginsList': await this._handleLoadPluginsList(); break;
                        case 'close':         this.dispose(); break;
                        case 'webviewError':
                            // JavaScript error from webview — show for debugging
                            const errMsg = (msg.message as string) ?? String(msg);
                            const errStack = (msg.stack as string) ?? '';
                            const errSource = (msg.source as string) ?? '';
                            const errLine = (msg.line as number) ?? 0;
                            const full = `[WxO ${typeLabel(this._type)}] ${errMsg}${errSource ? ` at ${errSource}:${errLine}` : ''}${errStack ? '\n' + errStack : ''}`;
                            vscode.window.showErrorMessage(`WxO ${typeLabel(this._type)}: JS error — ${errMsg}`);
                            vscode.env.clipboard.writeText(full);
                            console.error(`[WxO ${typeLabel(this._type)}] Webview JS error:`, full);
                            this._panel.webview.postMessage({
                                command: 'status',
                                message: `Error: ${errMsg} (full details copied to clipboard; use "Developer: Open Webview Developer Tools" for more)`,
                                isError: true,
                            });
                            break;
                    }
                } catch (e) {
                    const m = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(`WxO ${typeLabel(this._type)}: ${m}`);
                    this._panel.webview.postMessage({ command: 'status', message: m, isError: true });
                }
            },
            undefined,
            this._disposables,
        );
    }

    public dispose(): void {
        WxOObjectFormPanel._panels.delete(`${this._type}:${this._editName ?? '__new__'}`);
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
    }

    // ── Initialization ────────────────────────────────────────────────────────

    private async _initialize(): Promise<void> {
        let availableTools: Array<{ name: string; display_name?: string }> = [];
        let availablePlugins: Array<{ name: string; display_name?: string }> = [];
        if (this._type === 'agents') {
            try {
                const [tools, flows, toolkits, plugins] = await Promise.all([
                    this._provider.service.listTools(),
                    this._provider.service.listFlows(),
                    this._provider.service.listToolkits(),
                    this._provider.service.listPlugins(),
                ]);
                const toolkitTools = toolkits.flatMap(tk =>
                    tk.tools.map(t => ({
                        name: t.fullName,
                        display_name: `${t.name} (${tk.name})`,
                    })),
                );
                availableTools = [...tools, ...flows]
                    .map(t => ({ name: t.name, display_name: t.display_name }))
                    .concat(toolkitTools);
                availablePlugins = plugins.map(p => ({ name: p.name, display_name: p.display_name }));
            } catch (_) { /* keep empty if env not active */ }
        }

        let html: string;
        if (!this._editName) {
            html = this._getHtml(undefined, undefined, undefined, availableTools, undefined, availablePlugins);
        } else if (this._type === 'agents') {
            try {
                const yaml = await this._provider.service.fetchAgentYaml(this._editName);
                html = this._getHtml(this._editName, undefined, undefined, availableTools, yaml, availablePlugins);
            } catch (err) {
                try {
                    const json = await this._provider.service.fetchResourceJson(this._type, this._editName);
                    html = this._getHtml(this._editName, json, undefined, availableTools, undefined, availablePlugins);
                } catch (err2) {
                    const msg = err instanceof Error ? err.message : String(err);
                    html = this._getHtml(this._editName, undefined, msg, availableTools, undefined, availablePlugins);
                }
            }
        } else {
            try {
                const json = await this._provider.service.fetchResourceJson(this._type, this._editName);
                html = this._getHtml(this._editName, json, undefined, availableTools, undefined, availablePlugins);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                html = this._getHtml(this._editName, undefined, msg, availableTools, undefined, availablePlugins);
            }
        }

        this._debugWriteHtml(html);
        this._panel.webview.html = html;
    }

    private _debugWriteHtml(html: string): void {
        try {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!ws) return;
            const debugDir = path.join(ws, '.vscode');
            if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
            const debugPath = path.join(debugDir, `wxo-form-${this._type}-debug.html`);
            fs.writeFileSync(debugPath, html, 'utf8');
            console.log(`[WxO Debug] Form HTML written → ${debugPath}`);

            const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
            if (scriptMatch) {
                const scriptContent = scriptMatch[1];
                const closeScriptInside = (scriptContent.match(/<\/script/gi) || []).length;
                if (closeScriptInside > 0) {
                    console.error(`[WxO Debug] ⚠ Found ${closeScriptInside} </script> inside script block — this will cause JS errors!`);
                } else {
                    console.log('[WxO Debug] ✓ No </script> found inside script block.');
                }
            }
        } catch (e) {
            console.error('[WxO Debug] Could not write debug HTML:', e);
        }
    }

    private async _handleLoadToolsList(): Promise<void> {
        if (this._type !== 'agents') return;
        try {
            const [tools, flows, toolkits] = await Promise.all([
                this._provider.service.listTools(),
                this._provider.service.listFlows(),
                this._provider.service.listToolkits(),
            ]);
            const toolkitTools = toolkits.flatMap(tk =>
                tk.tools.map(t => ({
                    name: t.fullName,
                    display_name: `${t.name} (${tk.name})`,
                })),
            );
            const list = [...tools, ...flows]
                .map(t => ({ name: t.name, display_name: t.display_name }))
                .concat(toolkitTools);
            this._panel.webview.postMessage({ command: 'toolsListLoaded', tools: list });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this._panel.webview.postMessage({ command: 'toolsListError', message: msg });
        }
    }

    private async _handleLoadPluginsList(): Promise<void> {
        if (this._type !== 'agents') return;
        try {
            const plugins = await this._provider.service.listPlugins();
            const list = plugins.map(p => p.name);
            this._panel.webview.postMessage({ command: 'pluginsListLoaded', plugins: list });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this._panel.webview.postMessage({ command: 'pluginsListError', message: msg });
        }
    }

    // ── Message handlers ──────────────────────────────────────────────────────

    private async _handleSave(msg: Record<string, unknown>): Promise<void> {
        const name = (msg.name as string)?.trim();
        if (!name) {
            this._panel.webview.postMessage({ command: 'status', message: 'Name / App ID is required.', isError: true });
            return;
        }

        const editDir = this._provider.service.getEditDir(name);
        fs.mkdirSync(editDir, { recursive: true });

        const kind = ((msg.kind as string) ?? 'native').trim();
        let filePath: string;
        let importCmd: string;

        if (this._type === 'agents') {
            const useEditor = (msg.useEditor as boolean);
            const yaml = useEditor
                ? ((msg.editorContent as string) ?? '')
                : this._agentToYaml(msg);
            filePath = path.join(editDir, `${name}.yaml`);
            fs.writeFileSync(filePath, yaml, 'utf8');
            importCmd = `orchestrate agents import -f "${filePath}" 2>&1`;

        } else if (this._type === 'flows') {
            const content = (msg.editorContent as string) ?? '{}';
            filePath = path.join(editDir, `${name}.json`);
            fs.writeFileSync(filePath, content, 'utf8');
            importCmd = `orchestrate tools import -k flow -f "${filePath}" 2>&1`;

        } else {
            // connections — full format with environments + optional set-credentials
            const useEditor = (msg.useEditor as boolean);
            const yaml = useEditor
                ? ((msg.editorContent as string) ?? '')
                : this._connectionToYaml(msg);
            filePath = path.join(editDir, `${name}.yaml`);
            fs.writeFileSync(filePath, yaml, 'utf8');
            importCmd = `orchestrate connections import -f "${filePath}" 2>&1`;
        }

        const label = typeLabel(this._type);
        const verb = this._editName ? 'Update' : 'Create';
        const lines: string[] = [
            `echo "=== WxO ${verb} ${label}: ${name} ==="`,
            `echo "Source: ${editDir}"`,
            importCmd,
        ];

        // For connections: optionally set credentials to make them active
        if (this._type === 'connections') {
            const authKind  = ((msg.authKind as string) ?? 'api_key').trim();
            const applyTo   = ((msg.applyTo as string) ?? 'both').trim();
            const credFlags = this._buildCredFlags(authKind, msg);

            if (credFlags) {
                lines.push(`echo ""`);
                lines.push(`echo "--- Setting credentials (${authKind}) ---"`);
                const envs = applyTo === 'draft' ? ['draft'] : applyTo === 'live' ? ['live'] : ['draft', 'live'];
                for (const env of envs) {
                    lines.push(`orchestrate connections set-credentials -a "${name}" --env ${env} ${credFlags} 2>&1 && echo "  ✓ credentials set (${env})" || echo "  ✗ set-credentials failed (${env})"`);
                }
            }
        }

        lines.push(`echo ""`, `echo "=== Done ==="`);

        const term = vscode.window.createTerminal({ name: `WxO ${label}: ${name}`, env: getEffectiveEnv() });
        term.show();
        term.sendText(lines.join('\n'));
        vscode.window.showInformationMessage(`WxO: ${verb.toLowerCase()}ing ${label} "${name}" — check the terminal.`);
        vscode.commands.executeCommand('WxO-ToolBox-vsc.refreshView');
    }

    private async _handleLoadFromFile(): Promise<void> {
        const isFlow = this._type === 'flows';
        const uri = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
            title: `Load ${typeLabel(this._type)} definition from file`,
            filters: isFlow
                ? { 'JSON': ['json'], 'All': ['*'] }
                : { 'YAML': ['yaml', 'yml'], 'JSON': ['json'], 'All': ['*'] },
        });
        if (!uri?.[0]) { return; }
        const content = fs.readFileSync(uri[0].fsPath, 'utf8');
        this._panel.webview.postMessage({ command: 'fileLoaded', content, filePath: uri[0].fsPath });
    }

    private async _handleExportToFile(msg: Record<string, unknown>): Promise<void> {
        const content = (msg.content as string) ?? '';
        const name = ((msg.name as string) ?? 'export').trim() || 'export';
        const ext = this._type === 'flows' ? 'json' : 'yaml';
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${name}.${ext}`),
            filters: this._type === 'flows'
                ? { 'JSON': ['json'], 'All': ['*'] }
                : { 'YAML': ['yaml', 'yml'], 'All': ['*'] },
        });
        if (!uri) { return; }
        fs.writeFileSync(uri.fsPath, content, 'utf8');
        this._panel.webview.postMessage({ command: 'status', message: `Exported to ${uri.fsPath}` });
    }

    private async _handleOpenInEditor(msg: Record<string, unknown>): Promise<void> {
        const content = (msg.content as string) ?? '';
        const name = ((msg.name as string) ?? 'draft').trim() || 'draft';
        const ext = this._type === 'flows' ? 'json' : 'yaml';
        const editDir = this._provider.service.getEditDir(name);
        fs.mkdirSync(editDir, { recursive: true });
        const filePath = path.join(editDir, `${name}.${ext}`);
        fs.writeFileSync(filePath, content, 'utf8');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }

    // ── YAML builders ─────────────────────────────────────────────────────────

    private _agentToYaml(msg: Record<string, unknown>): string {
        const name       = ((msg.name as string) ?? '').trim();
        const display    = ((msg.displayName as string) ?? '').trim();
        const desc       = ((msg.description as string) ?? '').trim();
        const kind       = ((msg.kind as string) ?? 'native').trim();
        const model      = ((msg.modelName as string) ?? 'ibm/granite-3-8b-instruct').trim();
        const instruct   = (msg.instructions as string) ?? '';
        const toolsRaw   = (msg.tools as string) ?? '';
        const tools      = toolsRaw.split('\n').map(t => t.trim()).filter(Boolean);
        const pluginsPreRaw  = (msg.pluginsPreInvoke as string) ?? '';
        const pluginsPostRaw = (msg.pluginsPostInvoke as string) ?? '';
        const pluginsPre     = pluginsPreRaw.split('\n').map(p => p.trim()).filter(Boolean);
        const pluginsPost    = pluginsPostRaw.split('\n').map(p => p.trim()).filter(Boolean);
        const temp       = parseFloat((msg.temperature as string) ?? '0');
        const maxTok     = parseInt((msg.maxTokens as string) ?? '1024', 10);
        const contextAccess = !!(msg.contextAccess as boolean);
        const restrictions  = ((msg.restrictions as string) ?? 'editable').trim();
        const style         = ((msg.style as string) ?? 'default').trim();
        const hideReasoning = !!(msg.hideReasoning as boolean);
        const welcomeMsg    = ((msg.welcomeMessage as string) ?? '').trim();
        const welcomeDesc   = ((msg.welcomeDescription as string) ?? '').trim();

        const lines: string[] = [`kind: ${kind}`, `name: ${name}`];
        if (display) lines.push(`display_name: "${yamlStr(display)}"`);
        if (desc) lines.push(`description: "${yamlStr(desc)}"`);
        lines.push(`context_access_enabled: ${contextAccess}`);
        lines.push('context_variables: []');
        if (restrictions) lines.push(`restrictions: ${restrictions}`);
        lines.push(`llm: ${model}`);
        lines.push(`style: ${style || 'default'}`);
        lines.push(`hide_reasoning: ${hideReasoning}`);
        if (instruct) {
            lines.push('instructions: |');
            instruct.split('\n').forEach(l => lines.push(`  ${l || ' '}`));
        } else {
            lines.push('instructions: ""');
        }
        lines.push('guidelines: []');
        lines.push('collaborators: []');
        if (tools.length > 0) {
            lines.push('tools:');
            tools.forEach(t => lines.push(`- ${t}`));
        } else {
            lines.push('tools: []');
        }
        lines.push('toolkits: []');
        lines.push('plugins:');
        if (pluginsPre.length > 0) {
            lines.push('  agent_pre_invoke:');
            pluginsPre.forEach(p => lines.push(`- ${p}`));
        } else {
            lines.push('  agent_pre_invoke: []');
        }
        if (pluginsPost.length > 0) {
            lines.push('  agent_post_invoke:');
            pluginsPost.forEach(p => lines.push(`- ${p}`));
        } else {
            lines.push('  agent_post_invoke: []');
        }
        lines.push('knowledge_base: []');
        lines.push('chat_with_docs:');
        lines.push('  enabled: false');
        lines.push('  supports_full_document: true');
        lines.push('welcome_content:');
        lines.push(`  welcome_message: "${yamlStr(welcomeMsg || 'Hello, welcome to watsonx Orchestrate')}"`);
        lines.push(`  description: "${yamlStr(welcomeDesc || 'Accuracy of generated answers may vary.')}"`);
        lines.push('  is_default_message: false');
        lines.push('spec_version: v1');
        return lines.join('\n') + '\n';
    }

    private _connectionToYaml(msg: Record<string, unknown>): string {
        const appId     = ((msg.name as string) ?? '').trim();
        const display   = ((msg.displayName as string) ?? '').trim();
        const serverUrl = ((msg.serverUrl as string) ?? '').trim();
        const authKind  = ((msg.authKind as string) ?? 'api_key').trim();
        const connType  = ((msg.connType as string) ?? 'team').trim();
        const applyTo   = ((msg.applyTo as string) ?? 'both').trim();

        const lines: string[] = [
            `app_id: ${appId}`,
            `spec_version: v1`,
            `kind: connection`,
        ];
        if (display) lines.push(`display_name: "${yamlStr(display)}"`);
        lines.push('environments:');

        const envBlock = (envName: string) => {
            const b = [`  ${envName}:`];
            if (serverUrl) b.push(`    server_url: ${serverUrl}`);
            b.push(`    kind: ${authKind}`);
            b.push(`    type: ${connType}`);
            return b;
        };
        if (applyTo === 'draft' || applyTo === 'both') lines.push(...envBlock('draft'));
        if (applyTo === 'live'  || applyTo === 'both') lines.push(...envBlock('live'));

        return lines.join('\n') + '\n';
    }

    /** Build CLI flags for orchestrate connections set-credentials based on auth kind and form data. */
    private _buildCredFlags(authKind: string, msg: Record<string, unknown>): string {
        const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '\\"')}"`;
        switch (authKind) {
            case 'api_key':
                return msg.apiKey ? `--api-key ${q(msg.apiKey)}` : '';
            case 'bearer':
                return msg.token ? `--token ${q(msg.token)}` : '';
            case 'basic': {
                const parts: string[] = [];
                if (msg.username) parts.push(`--username ${q(msg.username)}`);
                if (msg.password) parts.push(`--password ${q(msg.password)}`);
                return parts.join(' ');
            }
            case 'oauth_auth_client_credentials_flow':
            case 'oauth_auth_on_behalf_of_flow':
            case 'oauth_auth_token_exchange_flow': {
                const parts: string[] = [];
                if (msg.clientId)     parts.push(`--client-id ${q(msg.clientId)}`);
                if (msg.clientSecret) parts.push(`--client-secret ${q(msg.clientSecret)}`);
                if (msg.tokenUrl)     parts.push(`--token-url ${q(msg.tokenUrl)}`);
                return parts.join(' ');
            }
            case 'oauth_auth_password_flow': {
                const parts: string[] = [];
                if (msg.username)     parts.push(`--username ${q(msg.username)}`);
                if (msg.password)     parts.push(`--password ${q(msg.password)}`);
                if (msg.clientId)     parts.push(`--client-id ${q(msg.clientId)}`);
                if (msg.clientSecret) parts.push(`--client-secret ${q(msg.clientSecret)}`);
                if (msg.tokenUrl)     parts.push(`--token-url ${q(msg.tokenUrl)}`);
                return parts.join(' ');
            }
            case 'oauth_auth_code_flow': {
                const parts: string[] = [];
                if (msg.clientId)     parts.push(`--client-id ${q(msg.clientId)}`);
                if (msg.clientSecret) parts.push(`--client-secret ${q(msg.clientSecret)}`);
                if (msg.authUrl)      parts.push(`--auth-url ${q(msg.authUrl)}`);
                if (msg.tokenUrl)     parts.push(`--token-url ${q(msg.tokenUrl)}`);
                return parts.join(' ');
            }
            default:
                return '';
        }
    }

    // ── HTML ──────────────────────────────────────────────────────────────────

    private _loadingHtml(): string {
        return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background);">Loading ${typeLabel(this._type)} data…</body></html>`;
    }

    private _getHtml(
        editName?: string,
        data?: unknown,
        loadError?: string,
        availableTools: Array<{ name: string; display_name?: string }> = [],
        editorContentOverride?: string,
        availablePlugins: Array<{ name: string; display_name?: string }> = [],
    ): string {
        const obj      = (data ?? {}) as Record<string, unknown>;
        const spec     = (obj.spec  ?? {}) as Record<string, unknown>;
        const model    = (spec.model ?? {}) as Record<string, unknown>;
        const llm      = (spec.llm_params ?? spec.llmParams ?? {}) as Record<string, unknown>;
        const plugins  = (obj.plugins ?? {}) as Record<string, unknown>;
        const toolsArr = ((spec.tools ?? obj.tools ?? []) as Array<Record<string, unknown>>)
            .map(t => (t.name ?? t.tool_id ?? t ?? '') as string).filter((s): s is string => typeof s === 'string' && !!s);
        const toStrArr = (a: unknown): string[] =>
            Array.isArray(a) ? (a as Array<unknown>).map(x => {
                if (typeof x === 'object' && x) {
                    const o = x as Record<string, unknown>;
                    return ((o.plugin_name ?? o.name) as string) || String(x);
                }
                return String(x);
            }).filter(Boolean) : [];
        const pluginsPreArr  = toStrArr(plugins.agent_pre_invoke ?? []);
        const pluginsPostArr = toStrArr(plugins.agent_post_invoke ?? []);

        const editMode = !!editName;
        const label    = typeLabel(this._type);
        const btnText  = editMode ? 'Update &amp; Import' : 'Create &amp; Import';
        const edLabel  = this._type === 'flows' ? 'JSON Editor' : 'YAML Editor';

        // Field defaults
        const name        = editName ?? (obj.name as string) ?? '';
        const displayName = ((obj.display_name ?? obj.displayName ?? name) as string);
        const description = (obj.description ?? '') as string;
        const kind        = (obj.kind ?? 'native') as string;
        const modelName   = (model.name ?? 'ibm/granite-3-8b-instruct') as string;
        const instructions= (spec.instructions ?? '') as string;
        const temperature = String((llm.temperature ?? 0) as number);
        const maxTokens   = String((llm.max_tokens ?? llm.maxTokens ?? 1024) as number);
        const appId       = (obj.app_id ?? obj.appId ?? name) as string;
        // Parse nested environments block for connection auth kind and server_url
        const envs        = (obj.environments ?? {}) as Record<string, Record<string, unknown>>;
        const envData     = envs.live ?? envs.draft ?? {};
        const connType    = (envData.kind ?? obj.kind ?? 'api_key') as string; // auth kind
        const serverUrl   = (envData.server_url ?? '') as string;

        // Initial editor content
        let editorContent: string;
        if (editorContentOverride) {
            editorContent = editorContentOverride;
        } else if (data) {
            editorContent = JSON.stringify(data, null, 2);
        } else if (this._type === 'agents') {
            editorContent = 'kind: native\nname: my_agent\ndescription: ""\nspec:\n  instructions: |\n    You are a helpful assistant.\n  model:\n    name: ibm/granite-3-8b-instruct\n  tools: []\n  llm_params:\n    temperature: 0\n    max_tokens: 1024\n';
        } else if (this._type === 'flows') {
            editorContent = '{\n  "name": "my_flow",\n  "display_name": "My Flow",\n  "description": ""\n}\n';
        } else {
            editorContent = 'app_id: my_connection\nspec_version: v1\nkind: connection\nenvironments:\n  draft:\n    server_url: https://api.example.com\n    kind: api_key\n    type: team\n  live:\n    server_url: https://api.example.com\n    kind: api_key\n    type: team\n';
        }

        // Form section depends on type
        const formHtml = this._type === 'agents' ? `
    <fieldset>
      <legend>Info</legend>
      <div class="grid-2">
        <div class="form-group">
          <label>Name <span class="hint">(identifier, snake_case)</span></label>
          <input type="text" id="fName" value="${esc(name)}" placeholder="my_agent"${editMode ? ' readonly' : ''} />
        </div>
        <div class="form-group">
          <label>Display Name</label>
          <input type="text" id="fDisplayName" value="${esc(displayName)}" placeholder="My Agent" />
        </div>
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="fDescription" rows="2">${esc(escForTextarea(description))}</textarea>
      </div>
    </fieldset>
    <fieldset>
      <legend>Configuration</legend>
      <div class="grid-2">
        <div class="form-group">
          <label>Kind</label>
          <select id="fKind">
            <option value="native"${kind === 'native' ? ' selected' : ''}>native</option>
            <option value="external"${kind === 'external' ? ' selected' : ''}>external</option>
            <option value="assistant"${kind === 'assistant' ? ' selected' : ''}>assistant</option>
          </select>
        </div>
        <div class="form-group">
          <label>LLM / Model <span class="hint">(e.g. groq/openai/gpt-oss-120b)</span></label>
          <input type="text" id="fModelName" value="${esc(modelName)}" placeholder="ibm/granite-3-8b-instruct" />
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label>Style</label>
          <input type="text" id="fStyle" value="default" placeholder="default" />
        </div>
        <div class="form-group">
          <label>Restrictions</label>
          <input type="text" id="fRestrictions" value="" placeholder="editable" />
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label>Temperature <span class="hint">(0 – 1)</span></label>
          <input type="number" id="fTemperature" value="${esc(temperature)}" min="0" max="1" step="0.05" />
        </div>
        <div class="form-group">
          <label>Max Tokens</label>
          <input type="number" id="fMaxTokens" value="${esc(maxTokens)}" min="1" max="8192" />
        </div>
      </div>
      <div class="grid-2" style="align-items:center; gap:8px;">
        <label style="display:flex; align-items:center; gap:6px;"><input type="checkbox" id="fContextAccess" /> Context access enabled</label>
        <label style="display:flex; align-items:center; gap:6px;"><input type="checkbox" id="fHideReasoning" /> Hide reasoning</label>
      </div>
    </fieldset>
    <fieldset style="flex:1; display:flex; flex-direction:column;">
      <legend>Instructions <span style="font-weight:normal; font-size:0.85em; opacity:0.7;">(system prompt)</span></legend>
      <textarea id="fInstructions" style="flex:1; min-height:80px; resize:vertical;">${esc(escForTextarea(instructions))}</textarea>
    </fieldset>
    <fieldset>
      <legend>Welcome Content</legend>
      <div class="form-group">
        <label>Welcome message</label>
        <input type="text" id="fWelcomeMessage" placeholder="Hello, welcome to watsonx Orchestrate" />
      </div>
      <div class="form-group">
        <label>Welcome description</label>
        <textarea id="fWelcomeDesc" rows="2" placeholder="Accuracy of generated answers may vary."></textarea>
      </div>
    </fieldset>
    <fieldset>
      <legend>Tools <span style="font-weight:normal; font-size:0.85em; opacity:0.7;">(drag to add or remove)</span></legend>
      <input type="hidden" id="fTools" value="${esc(toolsArr.join('\n'))}" />
      <div class="tools-dnd-row">
        <div class="tools-dnd-col">
          <div class="tools-dnd-label">Assigned</div>
          <div id="toolsAssigned" class="tools-dnd-list" data-role="assigned"></div>
        </div>
        <div class="tools-dnd-col">
          <div class="tools-dnd-label">
            Available
            <input type="search" id="toolsSearch" class="tools-search-input" placeholder="Search tools / toolkits…" />
            <button type="button" class="btn-xs" id="btnLoadTools" title="Load from active environment">↺ Load</button>
          </div>
          <div id="toolsAvailable" class="tools-dnd-list" data-role="available"></div>
        </div>
      </div>
    </fieldset>
    <fieldset>
      <legend>Plugins <span style="font-weight:normal; font-size:0.85em; opacity:0.7;">(pre/post-invoke, drag to add or remove)</span></legend>
      <input type="hidden" id="fPluginsPre" value="${esc(pluginsPreArr.join('\n'))}" />
      <input type="hidden" id="fPluginsPost" value="${esc(pluginsPostArr.join('\n'))}" />
      <div class="tools-dnd-row">
        <div class="tools-dnd-col">
          <div class="tools-dnd-label">Pre-invoke (Assigned)</div>
          <div id="pluginsPreAssigned" class="tools-dnd-list" data-role="assigned"></div>
        </div>
        <div class="tools-dnd-col">
          <div class="tools-dnd-label">
            Pre-invoke (Available)
            <button type="button" class="btn-xs" id="btnLoadPlugins" title="Load from active environment">↺ Load</button>
          </div>
          <div id="pluginsPreAvailable" class="tools-dnd-list" data-role="available"></div>
        </div>
      </div>
      <div class="tools-dnd-row" style="margin-top:12px;">
        <div class="tools-dnd-col">
          <div class="tools-dnd-label">Post-invoke (Assigned)</div>
          <div id="pluginsPostAssigned" class="tools-dnd-list" data-role="assigned"></div>
        </div>
        <div class="tools-dnd-col">
          <div class="tools-dnd-label">Post-invoke (Available)</div>
          <div id="pluginsPostAvailable" class="tools-dnd-list" data-role="available"></div>
        </div>
      </div>
    </fieldset>`
        : this._type === 'flows' ? `
    <fieldset>
      <legend>Info</legend>
      <div class="grid-2">
        <div class="form-group">
          <label>Name</label>
          <input type="text" id="fName" value="${esc(name)}" placeholder="my_flow"${editMode ? ' readonly' : ''} />
        </div>
        <div class="form-group">
          <label>Display Name</label>
          <input type="text" id="fDisplayName" value="${esc(displayName)}" placeholder="My Flow" />
        </div>
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="fDescription" rows="2">${esc(escForTextarea(description))}</textarea>
      </div>
      <p style="font-size:11px; opacity:0.65; margin:6px 0 0 0;">
        Switch to the <strong>JSON Editor</strong> tab to edit the full flow definition.
        Use <strong>Load from File</strong> to import an existing flow JSON.
      </p>
    </fieldset>`
        : `
    <fieldset>
      <legend>Connection Info</legend>
      <div class="grid-2">
        <div class="form-group">
          <label>App ID <span class="hint">(identifier, no spaces)</span></label>
          <input type="text" id="fName" value="${esc(appId)}" placeholder="MyConnection"${editMode ? ' readonly' : ''} />
        </div>
        <div class="form-group">
          <label>Display Name</label>
          <input type="text" id="fDisplayName" value="${esc(displayName)}" placeholder="My Connection" />
        </div>
      </div>
        <div class="form-group">
        <label>Server / Base URL</label>
        <input type="text" id="fServerUrl" value="${esc(serverUrl)}" placeholder="https://api.example.com" />
      </div>
    </fieldset>
    <fieldset>
      <legend>Auth Configuration</legend>
      <div class="grid-3">
        <div class="form-group">
          <label>Auth Kind</label>
          <select id="fAuthKind">
            <option value="api_key"${connType === 'api_key' ? ' selected' : ''}>API Key</option>
            <option value="bearer"${connType === 'bearer' ? ' selected' : ''}>Bearer Token</option>
            <option value="basic"${connType === 'basic' ? ' selected' : ''}>Basic Auth (user/pass)</option>
            <option value="oauth_auth_client_credentials_flow"${connType === 'oauth_auth_client_credentials_flow' ? ' selected' : ''}>OAuth2 Client Credentials</option>
            <option value="oauth_auth_password_flow"${connType === 'oauth_auth_password_flow' ? ' selected' : ''}>OAuth2 Password Flow</option>
            <option value="oauth_auth_code_flow"${connType === 'oauth_auth_code_flow' ? ' selected' : ''}>OAuth2 Auth Code Flow</option>
            <option value="oauth_auth_on_behalf_of_flow"${connType === 'oauth_auth_on_behalf_of_flow' ? ' selected' : ''}>OAuth2 On-Behalf-Of</option>
            <option value="no_auth"${connType === 'no_auth' ? ' selected' : ''}>No Auth</option>
          </select>
        </div>
        <div class="form-group">
          <label>Connection Type</label>
          <select id="fConnType">
            <option value="team" selected>team</option>
            <option value="personal">personal</option>
          </select>
        </div>
        <div class="form-group">
          <label>Apply to Env</label>
          <select id="fApplyTo">
            <option value="both" selected>Both (draft + live)</option>
            <option value="draft">Draft only</option>
            <option value="live">Live only</option>
          </select>
        </div>
      </div>
    </fieldset>
    <!-- Credential fields — shown/hidden per auth kind -->
    <fieldset id="credSection">
      <legend>Credentials <span style="font-weight:normal; font-size:0.85em; opacity:0.7;">(used to activate the connection)</span></legend>
      <!-- API Key -->
      <div id="cred-api_key" class="cred-block">
        <div class="form-group">
          <label>API Key</label>
          <input type="password" id="fApiKey" placeholder="Enter API Key" autocomplete="new-password"/>
        </div>
      </div>
      <!-- Bearer -->
      <div id="cred-bearer" class="cred-block" style="display:none;">
        <div class="form-group">
          <label>Bearer Token</label>
          <input type="password" id="fToken" placeholder="Enter token" autocomplete="new-password"/>
        </div>
      </div>
      <!-- Basic -->
      <div id="cred-basic" class="cred-block" style="display:none;">
        <div class="grid-2">
          <div class="form-group"><label>Username</label><input type="text" id="fUsername" placeholder="username" autocomplete="off"/></div>
          <div class="form-group"><label>Password</label><input type="password" id="fPassword" placeholder="password" autocomplete="new-password"/></div>
        </div>
      </div>
      <!-- OAuth Client Credentials / On-Behalf-Of / Token Exchange -->
      <div id="cred-oauth_cc" class="cred-block" style="display:none;">
        <div class="grid-2">
          <div class="form-group"><label>Client ID</label><input type="text" id="fClientId" placeholder="client_id" autocomplete="off"/></div>
          <div class="form-group"><label>Client Secret</label><input type="password" id="fClientSecret" placeholder="client_secret" autocomplete="new-password"/></div>
        </div>
        <div class="form-group"><label>Token URL</label><input type="text" id="fTokenUrl" placeholder="https://auth.example.com/token"/></div>
      </div>
      <!-- OAuth Password Flow -->
      <div id="cred-oauth_pw" class="cred-block" style="display:none;">
        <div class="grid-2">
          <div class="form-group"><label>Username</label><input type="text" id="fUsername2" placeholder="username" autocomplete="off"/></div>
          <div class="form-group"><label>Password</label><input type="password" id="fPassword2" placeholder="password" autocomplete="new-password"/></div>
        </div>
        <div class="grid-2">
          <div class="form-group"><label>Client ID</label><input type="text" id="fClientId2" placeholder="client_id" autocomplete="off"/></div>
          <div class="form-group"><label>Client Secret</label><input type="password" id="fClientSecret2" placeholder="client_secret" autocomplete="new-password"/></div>
        </div>
        <div class="form-group"><label>Token URL</label><input type="text" id="fTokenUrl2" placeholder="https://auth.example.com/token"/></div>
      </div>
      <!-- OAuth Auth Code Flow -->
      <div id="cred-oauth_code" class="cred-block" style="display:none;">
        <div class="grid-2">
          <div class="form-group"><label>Client ID</label><input type="text" id="fClientId3" placeholder="client_id" autocomplete="off"/></div>
          <div class="form-group"><label>Client Secret</label><input type="password" id="fClientSecret3" placeholder="client_secret" autocomplete="new-password"/></div>
        </div>
        <div class="grid-2">
          <div class="form-group"><label>Auth URL</label><input type="text" id="fAuthUrl" placeholder="https://auth.example.com/authorize"/></div>
          <div class="form-group"><label>Token URL</label><input type="text" id="fTokenUrl3" placeholder="https://auth.example.com/token"/></div>
        </div>
      </div>
      <!-- No auth -->
      <div id="cred-no_auth" class="cred-block" style="display:none;">
        <p style="opacity:0.6; font-size:12px; margin:4px 0;">No credentials required for this connection type.</p>
      </div>
      <p style="font-size:11px; opacity:0.55; margin:8px 0 0 0;">
        Leave blank to skip <code>set-credentials</code> (connection will be imported but not activated).
        Credentials are passed to <code>orchestrate connections set-credentials</code>.
      </p>
    </fieldset>`;

        const loadErrorBanner = loadError ? `
  <div style="padding:8px 12px; background:var(--vscode-inputValidation-warningBackground); border:1px solid var(--vscode-inputValidation-warningBorder); border-radius:4px; margin-bottom:10px; font-size:11px; flex-shrink:0;">
    <strong>Note:</strong> Could not load current data: <code>${esc(loadError)}</code>. Showing defaults.
  </div>` : '';

        const activeEnv = this._provider.activeEnvironment ?? 'TZ1';

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(editMode ? `Edit ${label}` : `Create ${label}`)}</title>
  <style>
    :root { --tab-border: 1px solid var(--vscode-widget-border); }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family); font-size: 13px;
      color: var(--vscode-foreground); background: var(--vscode-editor-background);
      margin: 0; padding: 12px 16px 10px; height: 100vh;
      display: flex; flex-direction: column; overflow: hidden;
    }
    h2 { margin: 0; font-size: 15px; font-weight: bold; }
    .header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-shrink: 0; flex-wrap: wrap; }
    .header-btns { display: flex; gap: 5px; margin-left: auto; flex-wrap: wrap; }
    .tabs { display: flex; border-bottom: var(--tab-border); flex-shrink: 0; }
    .tab { padding: 7px 15px; cursor: pointer; border: var(--tab-border); border-bottom: none;
      background: var(--vscode-editor-inactiveSelectionBackground); margin-right: 3px;
      border-radius: 4px 4px 0 0; opacity: 0.72; font-size: 12px; user-select: none; }
    .tab:hover { opacity: 0.9; }
    .tab.active { background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-editor-background); margin-bottom: -1px;
      opacity: 1; font-weight: bold; }
    .sep { border: none; border-top: var(--tab-border); margin: 0 0 10px 0; flex-shrink: 0; }
    .tab-content { display: none; flex: 1; flex-direction: column; min-height: 0; overflow-y: auto; padding-right: 2px; }
    .tab-content.active { display: flex; }
    .form-group { margin-bottom: 10px; }
    .form-group:last-child { margin-bottom: 0; }
    label { display: block; margin-bottom: 4px; font-weight: bold; font-size: 12px; }
    .hint { font-weight: normal; opacity: 0.6; font-size: 0.9em; }
    input, select, textarea {
      display: block; width: 100%;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 6px 8px; font-size: 12px; font-family: var(--vscode-font-family); border-radius: 2px;
    }
    input[readonly] { opacity: 0.65; }
    textarea { resize: vertical; }
    .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    fieldset { border: 1px solid var(--vscode-widget-border); border-radius: 4px; padding: 10px 14px 12px; margin-bottom: 10px; flex-shrink: 0; }
    fieldset legend { font-weight: bold; font-size: 0.9em; padding: 0 6px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 5px 12px; cursor: pointer; border-radius: 2px; font-size: 12px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .toolbar { display: flex; justify-content: space-between; align-items: center;
      border-top: var(--tab-border); padding-top: 9px; margin-top: 8px; flex-shrink: 0; }
    .actions-right { display: flex; gap: 8px; }
    #statusMsg { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 10px; }
    #statusMsg.ok  { color: var(--vscode-terminal-ansiGreen, #73c991); }
    #statusMsg.err { color: var(--vscode-errorForeground, #f48771); }
    .main-content { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    code { background: var(--vscode-editor-inactiveSelectionBackground); padding: 1px 4px; border-radius: 3px; font-family: monospace; font-size: 0.9em; }
    .editor-bar { display: flex; gap: 6px; margin-bottom: 6px; flex-shrink: 0; align-items: center; }
    .env-badge { font-size: 11px; opacity: 0.6; margin-left: auto; }
    .tools-dnd-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; min-height: 120px; }
    .tools-dnd-col { display: flex; flex-direction: column; }
    .tools-dnd-label { font-size: 11px; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
    .tools-dnd-list { min-height: 100px; border: 1px dashed var(--vscode-widget-border); border-radius: 4px; padding: 6px;
      display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; }
    .tools-dnd-list.drag-over { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
    .tools-dnd-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; font-size: 11px; font-family: monospace;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 4px; cursor: grab;
      border: 1px solid var(--vscode-widget-border); }
    .tools-dnd-chip:hover { opacity: 0.9; }
    .tools-dnd-chip.dragging { opacity: 0.5; cursor: grabbing; }
    .tools-dnd-chip .chip-remove { cursor: pointer; padding: 0 2px; font-weight: bold; opacity: 0.8; }
    .btn-xs { padding: 2px 8px; font-size: 11px; }
    .tools-search-input {
      flex: 1;
      min-width: 0;
      font-size: 11px;
      padding: 3px 6px;
    }
  </style>
</head>
<body>

  <div class="header-row">
    <h2>${esc(editMode ? `Edit ${label}` : `Create ${label}`)}${editMode ? `: <span style="font-weight:normal">${esc(editName ?? '')}</span>` : ''}</h2>
    <div class="header-btns">
      <button class="secondary" id="btnLoad">📂 Load from File</button>
      <button class="secondary" id="btnExport">⬇ Export to File</button>
      <button class="secondary" id="btnOpenEditor">Open in Editor</button>
    </div>
  </div>

  ${loadErrorBanner}

  <div class="tabs">
    <div class="tab ${editorContentOverride ? '' : 'active'}" id="tabForm">Form View</div>
    <div class="tab ${editorContentOverride ? 'active' : ''}" id="tabEditor">${esc(edLabel)}</div>
  </div>
  <hr class="sep">

  <div class="main-content">

    <!-- ── Form tab ── -->
    <div id="tab-form" class="tab-content ${editorContentOverride ? '' : 'active'}">
      ${formHtml}
    </div>

    <!-- ── YAML / JSON editor tab ── -->
    <div id="tab-editor" class="tab-content ${editorContentOverride ? 'active' : ''}" style="flex-direction:column;">
      <div class="editor-bar">
        <button class="secondary" id="btnFormat">Format</button>
        <button class="secondary" id="btnSyncToForm">↑ Sync to Form</button>
        <span class="env-badge">env: ${esc(activeEnv)}</span>
      </div>
      <textarea id="editorContent" class="mono" style="flex:1; min-height:200px; resize:none;"
        spellcheck="false">${esc(escForTextarea(editorContent))}</textarea>
    </div>

  </div>

  <div class="toolbar">
    <div id="statusMsg"></div>
    <div class="actions-right">
      <button class="secondary" id="btnClose">Close</button>
      <button id="btnSave">▶ ${btnText}</button>
    </div>
  </div>

  <script>
    (function() {
    var vscode = null;
    try {
      vscode = acquireVsCodeApi();
    } catch (e) {
      console.error('[WxO] acquireVsCodeApi failed:', e);
      document.body.innerHTML = '<div style="padding:20px;color:var(--vscode-errorForeground);">' +
        'Create Agent: acquireVsCodeApi() failed. ' + (e && e.message ? e.message : String(e)) + '\\x3c/div>';
      return;
    }
    console.log('[WxO Form] Script init', 'objType=${this._type}', 'editMode=${editMode}');
    function wxoReportError(msg, stack, source, line) {
      try {
        vscode.postMessage({ command: 'webviewError', message: msg, stack: stack || '', source: source || '', line: line || 0 });
      } catch (_) {}
    }
    window.onerror = function(message, source, lineno, colno, error) {
      var msg = (error && error.message) || message;
      var stack = (error && error.stack) || '';
      console.error('[WxO Form] window.onerror:', msg, 'at', source, lineno, stack);
      wxoReportError(msg, stack, source, lineno);
      var stEl = document.getElementById('statusMsg');
      if (stEl) {
        stEl.textContent = 'JS Error: ' + msg + ' (line ' + lineno + ')';
        stEl.className = 'err';
      }
      return false;
    };
    window.addEventListener('unhandledrejection', function(e) {
      var msg = (e.reason && (e.reason.message || e.reason)) || String(e.reason);
      console.error('[WxO Form] unhandledrejection:', msg, e.reason && e.reason.stack);
      wxoReportError(msg, (e.reason && e.reason.stack) || '', '', 0);
    });
    var activeTab = ${editorContentOverride ? "'editor'" : "'form'"};
    var objType = '${this._type}';
    var editMode = ${editMode};
    var syncFromEditorOnLoad = ${!!editorContentOverride};
    var initialAssignedTools = ${this._type === 'agents' ? escScriptJson(toolsArr) : '[]'};
    var initialAvailableTools = ${this._type === 'agents' ? escScriptJson(availableTools.filter(t => !toolsArr.includes(t.name))) : '[]'};
    var allAvailableTools = initialAvailableTools.slice();
    var toolsSearchTerm = '';
    var initialAssignedPluginsPre  = ${this._type === 'agents' ? escScriptJson(pluginsPreArr) : '[]'};
    var initialAssignedPluginsPost = ${this._type === 'agents' ? escScriptJson(pluginsPostArr) : '[]'};
    var initialAvailablePluginsPre  = ${this._type === 'agents' ? escScriptJson(availablePlugins.filter(p => !pluginsPreArr.includes(p.name))) : '[]'};
    var initialAvailablePluginsPost = ${this._type === 'agents' ? escScriptJson(availablePlugins.filter(p => !pluginsPostArr.includes(p.name))) : '[]'};

    function setStatus(msg, isError) {
      var el = document.getElementById('statusMsg');
      if (!el) { console.warn('[WxO Form] statusMsg element not found'); return; }
      el.textContent = msg || '';
      el.className = isError ? 'err' : (msg ? 'ok' : '');
    }

    function switchTab(tab) {
      activeTab = tab;
      ['Form','Editor'].forEach(function(t) {
        var id = 'tab' + t;
        var el = document.getElementById(id);
        if (el) el.classList.toggle('active', id === 'tab' + tab.charAt(0).toUpperCase() + tab.slice(1));
      });
      var tabFormEl = document.getElementById('tab-form');
      var tabEditorEl = document.getElementById('tab-editor');
      if (tabFormEl) tabFormEl.classList.toggle('active', tab === 'form');
      if (tabEditorEl) tabEditorEl.classList.toggle('active', tab === 'editor');
      if (tab === 'editor' && !syncFromEditorOnLoad) syncFormToEditor();
    }

    function val(id) {
      var el = document.getElementById(id);
      return el ? el.value : '';
    }

    function unesc(s) { return (s || '').replace(new RegExp('<\\u200b/', 'g'), '\\x3c/'); }

    function filterAvailableTools(term) {
      toolsSearchTerm = (term || '').toLowerCase();
      var base = allAvailableTools || [];
      var filtered = toolsSearchTerm
        ? base.filter(function(t){
            var n = (t && t.name ? String(t.name) : '').toLowerCase();
            var d = (t && t.display_name ? String(t.display_name) : '').toLowerCase();
            return n.indexOf(toolsSearchTerm) >= 0 || d.indexOf(toolsSearchTerm) >= 0;
          })
        : base.slice();
      var assigned = (val('fTools') || '').split('\\n').map(function(t){return t.trim();}).filter(Boolean);
      renderToolsLists(assigned, filtered);
    }
    function collectForm() {
      var d = {
        name:         val('fName').trim(),
        displayName:  val('fDisplayName').trim(),
        description:  unesc(val('fDescription')).trim(),
        editorContent: unesc(val('editorContent')),
        useEditor:    activeTab === 'editor',
      };
      if (objType === 'agents') {
        d.kind         = val('fKind');
        d.modelName    = val('fModelName').trim() || 'ibm/granite-3-8b-instruct';
        d.temperature  = val('fTemperature') || '0';
        d.maxTokens    = val('fMaxTokens') || '1024';
        d.instructions = unesc(val('fInstructions'));
        d.tools        = val('fTools');
        d.pluginsPreInvoke  = val('fPluginsPre');
        d.pluginsPostInvoke = val('fPluginsPost');
        var caeEl = document.getElementById('fContextAccess');
        d.contextAccess = caeEl ? caeEl.checked : false;
        d.restrictions  = val('fRestrictions').trim() || 'editable';
        d.style         = val('fStyle').trim() || 'default';
        var hrEl = document.getElementById('fHideReasoning');
        d.hideReasoning = hrEl ? hrEl.checked : false;
        d.welcomeMessage = unesc(val('fWelcomeMessage')).trim();
        d.welcomeDescription = unesc(val('fWelcomeDesc')).trim();
      } else if (objType === 'connections') {
        console.log('[WxO Form] collectForm connections');
        var authKind = val('fAuthKind') || 'api_key';
        d.authKind   = authKind;
        d.serverUrl  = val('fServerUrl').trim();
        d.connType   = val('fConnType') || 'team';
        d.applyTo    = val('fApplyTo') || 'both';
        // credential fields by kind
        d.apiKey       = val('fApiKey');
        d.token        = val('fToken');
        d.username     = authKind === 'oauth_auth_password_flow' ? val('fUsername2') : val('fUsername');
        d.password     = authKind === 'oauth_auth_password_flow' ? val('fPassword2') : val('fPassword');
        d.clientId     = authKind === 'oauth_auth_password_flow' ? val('fClientId2') :
                         authKind === 'oauth_auth_code_flow' ? val('fClientId3') : val('fClientId');
        d.clientSecret = authKind === 'oauth_auth_password_flow' ? val('fClientSecret2') :
                         authKind === 'oauth_auth_code_flow' ? val('fClientSecret3') : val('fClientSecret');
        d.tokenUrl     = authKind === 'oauth_auth_password_flow' ? val('fTokenUrl2') :
                         authKind === 'oauth_auth_code_flow' ? val('fTokenUrl3') : val('fTokenUrl');
        d.authUrl      = val('fAuthUrl');
      }
      return d;
    }

    // Sync form into editor: rebuild YAML/JSON from form fields
    // When we loaded full export YAML (syncFromEditorOnLoad), do not overwrite — editor is source of truth
    function syncFormToEditor() {
      if (syncFromEditorOnLoad) return;
      if (objType === 'agents') {
        var n = val('fName').trim() || 'my_agent';
        var dn = val('fDisplayName').trim();
        var desc = unesc(val('fDescription')).trim();
        var k = val('fKind') || 'native';
        var model = val('fModelName').trim() || 'ibm/granite-3-8b-instruct';
        var instr = unesc(val('fInstructions'));
        var toolsStr = val('fTools');
        var tools = toolsStr.split('\\n').map(function(t){return t.trim();}).filter(Boolean);
        var pluginsPreStr  = val('fPluginsPre');
        var pluginsPostStr = val('fPluginsPost');
        var pluginsPre  = pluginsPreStr.split('\\n').map(function(p){return p.trim();}).filter(Boolean);
        var pluginsPost = pluginsPostStr.split('\\n').map(function(p){return p.trim();}).filter(Boolean);
        var restr = val('fRestrictions').trim() || 'editable';
        var sty = val('fStyle').trim() || 'default';
        var caeEl = document.getElementById('fContextAccess');
        var contextAccess = caeEl ? caeEl.checked : false;
        var hrEl = document.getElementById('fHideReasoning');
        var hideReasoning = hrEl ? hrEl.checked : false;
        var wMsg = unesc(val('fWelcomeMessage')).trim() || 'Hello, welcome to watsonx Orchestrate';
        var wDesc = unesc(val('fWelcomeDesc')).trim() || 'Accuracy of generated answers may vary.';
        var lines = ['kind: ' + k, 'name: ' + n];
        if (dn) lines.push('display_name: "' + dn.replace(/"/g, '\\\\"') + '"');
        if (desc) lines.push('description: "' + desc.replace(/"/g, '\\\\"') + '"');
        lines.push('context_access_enabled: ' + contextAccess);
        lines.push('context_variables: []');
        lines.push('restrictions: ' + restr);
        lines.push('llm: ' + model);
        lines.push('style: ' + sty);
        lines.push('hide_reasoning: ' + hideReasoning);
        if (instr) {
          lines.push('instructions: |');
          (instr || '').split('\\n').forEach(function(l){ lines.push('  ' + (l || ' ')); });
        } else { lines.push('instructions: ""'); }
        lines.push('guidelines: []');
        lines.push('collaborators: []');
        if (tools.length > 0) {
          lines.push('tools:');
          tools.forEach(function(t){ lines.push('- ' + t); });
        } else { lines.push('tools: []'); }
        lines.push('toolkits: []');
        lines.push('plugins:');
        if (pluginsPre.length > 0) {
          lines.push('  agent_pre_invoke:');
          pluginsPre.forEach(function(p){ lines.push('- ' + p); });
        } else { lines.push('  agent_pre_invoke: []'); }
        if (pluginsPost.length > 0) {
          lines.push('  agent_post_invoke:');
          pluginsPost.forEach(function(p){ lines.push('- ' + p); });
        } else { lines.push('  agent_post_invoke: []'); }
        lines.push('knowledge_base: []');
        lines.push('chat_with_docs:');
        lines.push('  enabled: false');
        lines.push('  supports_full_document: true');
        lines.push('welcome_content:');
        lines.push('  welcome_message: "' + wMsg.replace(/"/g, '\\\\"') + '"');
        lines.push('  description: "' + wDesc.replace(/"/g, '\\\\"') + '"');
        lines.push('  is_default_message: false');
        lines.push('spec_version: v1');
        var edEl1 = document.getElementById('editorContent');
        if (edEl1) edEl1.value = lines.join('\\n') + '\\n';
      } else if (objType === 'flows') {
        var raw = unesc(val('editorContent')).trim();
        if (!raw) return;
        try {
          var obj2 = JSON.parse(raw);
          var n = val('fName').trim(), dn = val('fDisplayName').trim(), desc = unesc(val('fDescription')).trim();
          if (n)    obj2.name         = n;
          if (dn)   obj2.display_name = dn;
          if (desc) obj2.description  = desc;
          var edEl2 = document.getElementById('editorContent');
          if (edEl2) edEl2.value = JSON.stringify(obj2, null, 2);
        } catch(_) {}
      } else if (objType === 'connections') {
        console.log('[WxO Form] syncFormToEditor connections');
        var appId  = val('fName').trim() || 'my_connection';
        var disp   = val('fDisplayName').trim();
        var sUrl   = val('fServerUrl').trim();
        var aKind  = val('fAuthKind') || 'api_key';
        var cType  = val('fConnType') || 'team';
        var applyT = val('fApplyTo') || 'both';
        var lines2 = ['app_id: ' + appId, 'spec_version: v1', 'kind: connection'];
        if (disp) lines2.push('display_name: "' + disp.replace(/"/g, '\\"') + '"');
        lines2.push('environments:');
        function envBlock(envName) {
          var b = ['  ' + envName + ':'];
          if (sUrl) b.push('    server_url: ' + sUrl);
          b.push('    kind: ' + aKind);
          b.push('    type: ' + cType);
          return b;
        }
        if (applyT === 'draft' || applyT === 'both') lines2 = lines2.concat(envBlock('draft'));
        if (applyT === 'live'  || applyT === 'both') lines2 = lines2.concat(envBlock('live'));
        var edEl3 = document.getElementById('editorContent');
        if (edEl3) edEl3.value = lines2.join('\\n') + '\\n';
      }
    }

    // Pull name / display_name / description / tools from editor back into form
    function syncEditorToForm() {
      var raw = unesc(val('editorContent')).trim();
      if (!raw) { setStatus('Editor is empty.', true); return; }
      if (objType === 'agents') {
        var toolsParsed = [], pluginsPreParsed = [], pluginsPostParsed = [], obj = null;
        if (raw.charAt(0) === '{') {
          try {
            obj = JSON.parse(raw);
            var spec = obj.spec || {};
            var arr = spec.tools || [];
            toolsParsed = arr.map(function(t){ return (t.name || t.tool_id || '').trim(); }).filter(Boolean);
            var plugs = obj.plugins || {};
            var preArr = plugs.agent_pre_invoke || [];
            var postArr = plugs.agent_post_invoke || [];
            pluginsPreParsed = (Array.isArray(preArr) ? preArr : []).map(function(p){ return (typeof p === 'object' && p && (p.plugin_name || p.name)) ? (p.plugin_name || p.name) : String(p); }).filter(Boolean);
            pluginsPostParsed = (Array.isArray(postArr) ? postArr : []).map(function(p){ return (typeof p === 'object' && p && (p.plugin_name || p.name)) ? (p.plugin_name || p.name) : String(p); }).filter(Boolean);
          } catch(_) {}
        } else {
          var inSpec = false, inTools = false, inModel = false, inLlmParams = false, inWelcomeContent = false;
          var inPluginsPre = false, inPluginsPost = false;
          raw.split('\\n').forEach(function(line){
            var m = line.match(new RegExp('^(\\\\w+):\\\\s*(.*)$'));
            var m2 = !m && new RegExp('^\\\\s{2,4}').test(line) ? line.match(new RegExp('^\\\\s{2,4}(\\\\w+):\\\\s*(.*)$')) : null;
            m = m || m2;
            if (inWelcomeContent && m) {
              var wk = m[1], wv = m[2].replace(/^["']|["']$/g, '').trim();
              if (wk === 'welcome_message') { var wm = document.getElementById('fWelcomeMessage'); if(wm) wm.value = wv; }
              if (wk === 'description') { var wd = document.getElementById('fWelcomeDesc'); if(wd) wd.value = wv; }
              if (/^\\w+\\s*:/.test(line.trim()) && line.match(/^\\s{0,2}/)) inWelcomeContent = false;
            } else if (m && !inSpec && !inLlmParams && !inWelcomeContent) {
              var k = m[1], v = m[2].replace(/^["']|["']$/g, '').trim();
              if (k === 'name' && !editMode) { var e0 = document.getElementById('fName'); if(e0) e0.value = v; }
              if (k === 'display_name') { var e1 = document.getElementById('fDisplayName'); if(e1) e1.value = v; }
              if (k === 'description') { var e2 = document.getElementById('fDescription'); if(e2) e2.value = v; }
              if (k === 'kind') { var sk = document.getElementById('fKind'); if(sk) { for(var i=0;i<sk.options.length;i++) { if(sk.options[i].value===v){sk.selectedIndex=i;break;} } } }
              if (k === 'llm' && v) { var em = document.getElementById('fModelName'); if(em) em.value = v; }
              if (k === 'context_access_enabled') { var cae = document.getElementById('fContextAccess'); if(cae) cae.checked = (v === 'true' || v === '1'); }
              if (k === 'restrictions') { var re = document.getElementById('fRestrictions'); if(re) re.value = v; }
              if (k === 'style') { var sty = document.getElementById('fStyle'); if(sty) sty.value = v; }
              if (k === 'hide_reasoning') { var hr = document.getElementById('fHideReasoning'); if(hr) hr.checked = (v === 'true' || v === '1'); }
            }
            if (new RegExp('^\\\\s*plugins\\\\s*:').test(line)) { inPluginsPre = false; inPluginsPost = false; return; }
            if (new RegExp('^\\\\s*agent_pre_invoke\\\\s*:').test(line)) {
              inPluginsPre = true; inPluginsPost = false;
              var v = line.replace(/^[^:]+:\\s*/, '').trim();
              if (v === '[]' || v === '') return;
              var bracket = v.match(/^\\\\[(.+)\\\\]$/);
              if (bracket) { pluginsPreParsed = bracket[1].split(',').map(function(x){ return x.replace(/^["']|["']$/g, '').trim(); }).filter(Boolean); inPluginsPre = false; }
              return;
            }
            if (new RegExp('^\\\\s*agent_post_invoke\\\\s*:').test(line)) {
              inPluginsPost = true; inPluginsPre = false;
              var v = line.replace(/^[^:]+:\\s*/, '').trim();
              if (v === '[]' || v === '') return;
              var bracket = v.match(/^\\\\[(.+)\\\\]$/);
              if (bracket) { pluginsPostParsed = bracket[1].split(',').map(function(x){ return x.replace(/^["']|["']$/g, '').trim(); }).filter(Boolean); inPluginsPost = false; }
              return;
            }
            if (inPluginsPre) {
              var pp = line.match(new RegExp('^\\\\s*-\\\\s+(.+)$'));
              if (pp) {
                var pn = pp[1].replace(/^["']|["']$/g, '').trim();
                if (pn.indexOf('plugin_name') >= 0) {
                  var pm = pn.match(/plugin_name\\\\s*:\\\\s*(.+)$/);
                  if (pm) pn = pm[1].replace(/^["']|["']$/g, '').trim();
                } else if (pn.indexOf(':') >= 0) { pn = ''; }
                if (pn) pluginsPreParsed.push(pn);
              } else if (new RegExp('^\\\\s{0,4}\\\\w+\\\\s*:').test(line)) inPluginsPre = false;
              return;
            }
            if (inPluginsPost) {
              var pp = line.match(new RegExp('^\\\\s*-\\\\s+(.+)$'));
              if (pp) {
                var pn = pp[1].replace(/^["']|["']$/g, '').trim();
                if (pn.indexOf('plugin_name') >= 0) {
                  var pm = pn.match(/plugin_name\\\\s*:\\\\s*(.+)$/);
                  if (pm) pn = pm[1].replace(/^["']|["']$/g, '').trim();
                } else if (pn.indexOf(':') >= 0) { pn = ''; }
                if (pn) pluginsPostParsed.push(pn);
              } else if (new RegExp('^\\\\s{0,4}\\\\w+\\\\s*:').test(line)) inPluginsPost = false;
              return;
            }
            if (new RegExp('^\\\\s*welcome_content\\\\s*:').test(line)) { inWelcomeContent = true; inSpec = false; inTools = false; inModel = false; inLlmParams = false; return; }
            if (new RegExp('^\\\\s*spec\\\\s*:').test(line)) { inSpec = true; inWelcomeContent = false; return; }
            if (inSpec && new RegExp('^\\\\s*model\\\\s*:').test(line)) { inModel = true; inTools = false; inLlmParams = false; return; }
            if (inSpec && new RegExp('^\\\\s*tools\\\\s*:').test(line)) { inTools = true; inModel = false; inLlmParams = false; return; }
            if (new RegExp('^\\\\s*tools\\\\s*:').test(line) && !inSpec) { inTools = true; inModel = false; inLlmParams = false; return; }
            if (inSpec && new RegExp('^\\\\s*llm_params\\\\s*:').test(line)) { inTools = false; inModel = false; inLlmParams = true; return; }
            if (new RegExp('^\\\\s*llm\\\\s*:').test(line)) { inTools = false; inModel = true; inLlmParams = false; return; }
            if (inTools && new RegExp('^\\\\s{0,2}\\\\w+\\\\s*:').test(line) && !new RegExp('^\\\\s*-\\\\s').test(line)) { inTools = false; }
            if (inTools) {
              var mm = line.match(new RegExp('-?\\\\s*name\\\\s*:\\\\s*(.+)$'));
              if (mm) { toolsParsed.push(mm[1].replace(/^["']|["']$/g, '').trim()); }
              else { var mm2 = line.match(new RegExp('^\\\\s*-\\\\s+(.+)$')); if (mm2) { var tn = mm2[1].replace(/^["']|["']$/g, '').trim(); if (tn && tn.indexOf(':') < 0) toolsParsed.push(tn); } }
            }
            if (inModel) { var mx = line.match(new RegExp('^\\\\s{2,8}(\\\\w+):\\\\s*(.*)$')); if (mx && mx[1]==='name') { var em = document.getElementById('fModelName'); if(em) em.value = (mx[2]||'').replace(/^["']|["']$/g,'').trim(); } }
            if (inLlmParams) {
              var mx = line.match(new RegExp('^\\\\s{2,8}(\\\\w+):\\\\s*(.*)$'));
              if (mx) {
                if (mx[1] === 'temperature') { var et = document.getElementById('fTemperature'); if(et) et.value = mx[2] || '0'; }
                if (mx[1] === 'max_tokens') { var ex = document.getElementById('fMaxTokens'); if(ex) ex.value = mx[2] || '1024'; }
              }
            }
          });
          var instr = '';
          var idx = raw.indexOf('instructions:');
          if (idx >= 0) {
            var rest = raw.slice(idx + 12).replace(/^\\s+/, '');
            if (rest.indexOf('|') === 0) {
              var content = rest.slice(1).replace(/^\\s*\\n?/, '');
              var blines = content.split('\\n');
              var out = [];
              for (var bi = 0; bi < blines.length; bi++) {
                var bl = blines[bi];
                if (/^\\s{2,}/.test(bl)) out.push(bl.replace(/^\\s{2,4}/, ''));
                else if (/^\\w+\\s*:/.test(bl) && out.length > 0) break;
                else if (bl.trim()) out.push(bl.trim());
              }
              instr = out.join('\\n').trim();
            } else {
              var lineList = raw.split('\\n');
              var instrLines = [];
              for (var j = 0; j < lineList.length; j++) {
                var ln = lineList[j];
                if (/^instructions\\s*:/.test(ln)) {
                  var v = ln.replace(/^instructions\\s*:\\s*/, '').replace(/^["']|["']$/g, '').trim();
                  if (v) instrLines.push(v);
                  for (j = j + 1; j < lineList.length; j++) {
                    var cont = lineList[j];
                    if (/^\\s{2,}\\S/.test(cont)) instrLines.push(cont.replace(/^\\s+/, '').trim());
                    else if (/^\\w+\\s*:/.test(cont.trim()) && cont.search(/^\\s/) < 0) { j--; break; }
                    else if (cont.trim() === '' && instrLines.length > 0) { j--; break; }
                  }
                  break;
                }
              }
              instr = instrLines.join('\\n').trim();
            }
            var ei = document.getElementById('fInstructions');
            if (ei) ei.value = instr;
          }
        }
        if (obj && raw.charAt(0) === '{') {
          var sp = obj.spec || {};
          var mdl = sp.model || {};
          var llm = sp.llm_params || sp.llmParams || {};
          var e = document.getElementById('fName'); if (e && !editMode && obj.name) e.value = obj.name;
          var e = document.getElementById('fDisplayName'); if (e && obj.display_name) e.value = obj.display_name;
          var e = document.getElementById('fDescription'); if (e && obj.description) e.value = obj.description;
          var e = document.getElementById('fKind'); if (e && obj.kind) { for(var i=0;i<e.options.length;i++) { if(e.options[i].value===obj.kind){e.selectedIndex=i;break;} } }
          var e = document.getElementById('fModelName'); if (e && mdl.name) e.value = mdl.name;
          var e = document.getElementById('fInstructions'); if (e && sp.instructions) e.value = sp.instructions;
          var e = document.getElementById('fTemperature'); if (e) e.value = String(llm.temperature != null ? llm.temperature : 0);
          var e = document.getElementById('fMaxTokens'); if (e) e.value = String(llm.max_tokens != null ? llm.max_tokens : 1024);
        }
        var fToolsEl = document.getElementById('fTools');
        if (fToolsEl) fToolsEl.value = toolsParsed.join('\\n');
        if (typeof renderToolsLists === 'function') renderToolsLists(toolsParsed, initialAvailableTools);
        var fPluginsPreEl = document.getElementById('fPluginsPre');
        var fPluginsPostEl = document.getElementById('fPluginsPost');
        if (fPluginsPreEl) fPluginsPreEl.value = pluginsPreParsed.join('\\n');
        if (fPluginsPostEl) fPluginsPostEl.value = pluginsPostParsed.join('\\n');
        var allPlugins = [].concat(pluginsPreParsed, pluginsPostParsed, initialAvailablePluginsPre, initialAssignedPluginsPre, initialAvailablePluginsPost, initialAssignedPluginsPost);
      var uniqPlugins = allPlugins.filter(function(x,i,a){ return a.indexOf(x)===i; });
      var availPre = uniqPlugins.filter(function(x){ return pluginsPreParsed.indexOf(x)<0; });
      var availPost = uniqPlugins.filter(function(x){ return pluginsPostParsed.indexOf(x)<0; });
      if (typeof renderPluginsLists === 'function') renderPluginsLists(pluginsPreParsed, pluginsPostParsed, availPre, availPost);
        setStatus('Synced from editor.');
      } else if (objType === 'flows') {
        try {
          var obj = JSON.parse(raw);
          var n  = document.getElementById('fName');
          var dn = document.getElementById('fDisplayName');
          var d  = document.getElementById('fDescription');
          if (n  && obj.name         && !editMode) n.value  = obj.name;
          if (dn && obj.display_name)              dn.value = obj.display_name;
          if (d  && obj.description)               d.value  = obj.description;
          setStatus('Synced from JSON.');
        } catch(e) { setStatus('Invalid JSON: ' + e.message, true); return; }
      } else if (objType === 'connections') {
        // YAML: simple key: value parse for connections
        console.log('[WxO Form] syncEditorToForm connections YAML parse');
        try {
        var inLiveEnv = false, inDraftEnv = false, inEnvBlock = false;
        raw.split('\\n').forEach(function(line) {
          // Track environments blocks
          if (new RegExp('^\\\\s*live:').test(line))  { inLiveEnv = true; inDraftEnv = false; inEnvBlock = true; return; }
          if (new RegExp('^\\\\s*draft:').test(line)) { inDraftEnv = true; inLiveEnv = false; inEnvBlock = true; return; }
          if (new RegExp('^\\\\S').test(line) && inEnvBlock) { inEnvBlock = false; inLiveEnv = false; inDraftEnv = false; }

          var m = line.match(new RegExp('^(\\\\w+):\\\\s*(.*)$'));
          if (!m) {
            m = line.match(new RegExp('^\\\\s{2,4}(\\\\w+):\\\\s*(.*)$'));
          }
          if (!m) return;
          var k = m[1], v = m[2].replace(/^["']|["']$/g, '').trim();

          if (!inEnvBlock) {
            if ((k === 'name' || k === 'app_id') && !editMode) {
              var el0 = document.getElementById('fName'); if (el0) el0.value = v;
            }
            if (k === 'display_name') { var el2b = document.getElementById('fDisplayName'); if(el2b) el2b.value = v; }
            if (k === 'description')  { var el3b = document.getElementById('fDescription');  if(el3b) el3b.value = v; }
            if (k === 'kind' && objType === 'agents') {
              var selK = document.getElementById('fKind');
              if (selK) { for(var i=0;i<selK.options.length;i++) { if(selK.options[i].value===v){selK.selectedIndex=i;break;} } }
            }
          } else if (inLiveEnv || inDraftEnv) {
            // Parse environment block for connections
            if (k === 'server_url' && objType === 'connections') {
              var su = document.getElementById('fServerUrl'); if(su) su.value = v;
            }
            if (k === 'kind' && objType === 'connections') {
              var selAK = document.getElementById('fAuthKind');
              if (selAK) { for(var j=0;j<selAK.options.length;j++) { if(selAK.options[j].value===v){selAK.selectedIndex=j;break;} } }
              onAuthKindChange();
            }
            if (k === 'type' && objType === 'connections') {
              var selCT = document.getElementById('fConnType');
              if (selCT) { for(var jj=0;jj<selCT.options.length;jj++) { if(selCT.options[jj].value===v){selCT.selectedIndex=jj;break;} } }
            }
          }
        });
        setStatus('Synced from YAML.');
        } catch (syncErr) {
          console.error('[WxO Form] syncEditorToForm connections error:', syncErr);
          setStatus('Error syncing YAML: ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)), true);
        }
      }
    }

    // ── Tab switching (addEventListener — inline onclick blocked by CSP) ──
    console.log('[WxO Form] Wiring tab buttons');
    var tabFormBtn = document.getElementById('tabForm');
    var tabEditorBtn = document.getElementById('tabEditor');
    if (tabFormBtn) tabFormBtn.addEventListener('click', function() { switchTab('form'); });
    if (tabEditorBtn) tabEditorBtn.addEventListener('click', function() { switchTab('editor'); });

    // ── Auth kind switcher (connections only) ──
    function onAuthKindChange() {
      if (objType !== 'connections') return;
      var kind = val('fAuthKind');
      console.log('[WxO Form] onAuthKindChange', kind);
      var blocks = document.querySelectorAll('.cred-block');
      Array.prototype.forEach.call(blocks, function(b) { b.style.display = 'none'; });
      var map = {
        'api_key': 'cred-api_key',
        'bearer':  'cred-bearer',
        'basic':   'cred-basic',
        'oauth_auth_client_credentials_flow': 'cred-oauth_cc',
        'oauth_auth_on_behalf_of_flow': 'cred-oauth_cc',
        'oauth_auth_token_exchange_flow': 'cred-oauth_cc',
        'oauth_auth_password_flow': 'cred-oauth_pw',
        'oauth_auth_code_flow': 'cred-oauth_code',
        'no_auth': 'cred-no_auth',
      };
      var target = map[kind] || 'cred-api_key';
      var el = document.getElementById(target);
      if (el) el.style.display = '';
      // Rebuild YAML editor content to reflect new kind
      if (activeTab === 'editor') syncFormToEditor();
    }
    // Wire auth kind select (addEventListener — inline onchange blocked by CSP)
    var fAuthKindEl = document.getElementById('fAuthKind');
    if (fAuthKindEl) { fAuthKindEl.addEventListener('change', onAuthKindChange); }
    // Init on load (connections: show correct cred block)
    if (objType === 'connections') {
      console.log('[WxO Form] connections init: calling onAuthKindChange');
      onAuthKindChange();
    }

    // ── Tools drag-drop (agents only) ──
    function syncToolsToHiddenInput() {
      var el = document.getElementById('fTools');
      if (!el) return;
      var chips = [].map.call(document.querySelectorAll('#toolsAssigned .tools-dnd-chip'), function(c){ return c.getAttribute('data-tool'); });
      el.value = chips.filter(Boolean).join('\\n');
      if (activeTab === 'editor') syncFormToEditor();
    }
    function makeChip(name, role) {
      var label = name;
      var chip = document.createElement('span');
      chip.className = 'tools-dnd-chip';
      chip.draggable = true;
      chip.setAttribute('data-tool', name);
      chip.setAttribute('data-role', role);
      chip.textContent = label;
      if (role === 'assigned') {
        var rm = document.createElement('span');
        rm.className = 'chip-remove';
        rm.textContent = ' ×';
        rm.title = 'Remove';
        rm.addEventListener('click', function(ev){ ev.stopPropagation(); chip.remove(); syncToolsToHiddenInput(); });
        chip.appendChild(rm);
      }
      chip.addEventListener('dragstart', function(ev){
        ev.dataTransfer.setData('text/plain', name);
        ev.dataTransfer.effectAllowed = 'move';
        chip.classList.add('dragging');
      });
      chip.addEventListener('dragend', function(){ chip.classList.remove('dragging'); });
      return chip;
    }
    function renderToolsLists(assigned, available) {
      var aEl = document.getElementById('toolsAssigned');
      var bEl = document.getElementById('toolsAvailable');
      if (!aEl || !bEl) return;
      aEl.innerHTML = '';
      bEl.innerHTML = '';
      var assignedSet = {};
      assigned.forEach(function(n){ assignedSet[n] = true; });
      assigned.forEach(function(n){
        aEl.appendChild(makeChip(n, 'assigned'));
      });
      available.filter(function(t){ return !assignedSet[t.name]; }).forEach(function(t){
        bEl.appendChild(makeChip(t.name, 'available'));
      });
      syncToolsToHiddenInput();
    }
    function wireToolsDnD() {
      var aEl = document.getElementById('toolsAssigned');
      var bEl = document.getElementById('toolsAvailable');
      var btnLoad = document.getElementById('btnLoadTools');
      var searchEl = document.getElementById('toolsSearch');
      if (!aEl || !bEl) return;
      [aEl, bEl].forEach(function(list){
        list.addEventListener('dragover', function(ev){ ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; list.classList.add('drag-over'); });
        list.addEventListener('dragleave', function(){ list.classList.remove('drag-over'); });
        list.addEventListener('drop', function(ev){
          ev.preventDefault();
          list.classList.remove('drag-over');
          var name = ev.dataTransfer.getData('text/plain');
          if (!name) return;
          var from = null;
          document.querySelectorAll('.tools-dnd-chip').forEach(function(c){ if (c.getAttribute('data-tool') === name) from = c; });
          if (from && from.parentNode) {
            from.remove();
            var role = list.getAttribute('data-role');
            list.appendChild(makeChip(name, role));
            syncToolsToHiddenInput();
          }
        });
      });
      if (btnLoad) btnLoad.addEventListener('click', function(){ vscode.postMessage({ command: 'loadToolsList' }); });
      if (searchEl) {
        searchEl.addEventListener('input', function(){
          filterAvailableTools(searchEl.value || '');
        });
      }
      renderToolsLists(initialAssignedTools, initialAvailableTools);
    }
    function syncPluginsToHiddenInput() {
      var preEl = document.getElementById('fPluginsPre');
      var postEl = document.getElementById('fPluginsPost');
      if (!preEl || !postEl) return;
      var preChips = [].map.call(document.querySelectorAll('#pluginsPreAssigned .tools-dnd-chip'), function(c){ return c.getAttribute('data-tool'); });
      var postChips = [].map.call(document.querySelectorAll('#pluginsPostAssigned .tools-dnd-chip'), function(c){ return c.getAttribute('data-tool'); });
      preEl.value = preChips.filter(Boolean).join('\\n');
      postEl.value = postChips.filter(Boolean).join('\\n');
      if (activeTab === 'editor') syncFormToEditor();
    }
    function makePluginChip(name, role, listId) {
      var chip = document.createElement('span');
      chip.className = 'tools-dnd-chip';
      chip.draggable = true;
      chip.setAttribute('data-tool', name);
      chip.setAttribute('data-role', role);
      chip.setAttribute('data-list', listId);
      chip.textContent = name;
      if (role === 'assigned') {
        var rm = document.createElement('span');
        rm.className = 'chip-remove';
        rm.textContent = ' ×';
        rm.title = 'Remove';
        rm.addEventListener('click', function(ev){ ev.stopPropagation(); chip.remove(); syncPluginsToHiddenInput(); });
        chip.appendChild(rm);
      }
      chip.addEventListener('dragstart', function(ev){
        ev.dataTransfer.setData('text/plain', name);
        ev.dataTransfer.setData('application/json', JSON.stringify({name:name,listId:listId}));
        ev.dataTransfer.effectAllowed = 'move';
        chip.classList.add('dragging');
      });
      chip.addEventListener('dragend', function(){ chip.classList.remove('dragging'); });
      return chip;
    }
    function renderPluginsLists(assignedPre, assignedPost, availablePre, availablePost) {
      var preA = document.getElementById('pluginsPreAssigned');
      var preB = document.getElementById('pluginsPreAvailable');
      var postA = document.getElementById('pluginsPostAssigned');
      var postB = document.getElementById('pluginsPostAvailable');
      if (!preA || !preB || !postA || !postB) return;
      preA.innerHTML = ''; preB.innerHTML = ''; postA.innerHTML = ''; postB.innerHTML = '';
      var preSet = {}; assignedPre.forEach(function(n){ preSet[n]=true; });
      var postSet = {}; assignedPost.forEach(function(n){ postSet[n]=true; });
      assignedPre.forEach(function(n){ preA.appendChild(makePluginChip(n, 'assigned', 'pre')); });
      assignedPost.forEach(function(n){ postA.appendChild(makePluginChip(n, 'assigned', 'post')); });
      (availablePre || []).filter(function(n){ return !preSet[n]; }).forEach(function(n){ preB.appendChild(makePluginChip(n, 'available', 'pre')); });
      (availablePost || []).filter(function(n){ return !postSet[n]; }).forEach(function(n){ postB.appendChild(makePluginChip(n, 'available', 'post')); });
      syncPluginsToHiddenInput();
    }
    function wirePluginsDnD() {
      var lists = [
        { a: 'pluginsPreAssigned', b: 'pluginsPreAvailable', listId: 'pre' },
        { a: 'pluginsPostAssigned', b: 'pluginsPostAvailable', listId: 'post' }
      ];
      lists.forEach(function(pair){
        var aEl = document.getElementById(pair.a);
        var bEl = document.getElementById(pair.b);
        if (!aEl || !bEl) return;
        [aEl, bEl].forEach(function(list){
          list.addEventListener('dragover', function(ev){ ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; list.classList.add('drag-over'); });
          list.addEventListener('dragleave', function(){ list.classList.remove('drag-over'); });
          list.addEventListener('drop', function(ev){
            ev.preventDefault();
            list.classList.remove('drag-over');
            var name = ev.dataTransfer.getData('text/plain');
            if (!name) return;
            var from = null;
            document.querySelectorAll('#pluginsPreAssigned .tools-dnd-chip, #pluginsPreAvailable .tools-dnd-chip, #pluginsPostAssigned .tools-dnd-chip, #pluginsPostAvailable .tools-dnd-chip').forEach(function(c){ if (c.getAttribute('data-tool') === name) from = c; });
            if (from && from.parentNode) {
              from.remove();
              var role = list.getAttribute('data-role');
              list.appendChild(makePluginChip(name, role, pair.listId));
              syncPluginsToHiddenInput();
            }
          });
        });
      });
      var btnLoadPlugins = document.getElementById('btnLoadPlugins');
      if (btnLoadPlugins) btnLoadPlugins.addEventListener('click', function(){ vscode.postMessage({ command: 'loadPluginsList' }); });
      renderPluginsLists(initialAssignedPluginsPre, initialAssignedPluginsPost, initialAvailablePluginsPre, initialAvailablePluginsPost);
    }
    if (objType === 'agents') { wireToolsDnD(); wirePluginsDnD(); }

    // ── Button wiring ──
    console.log('[WxO Form] Wiring buttons');
    function wireBtn(id, fn) {
      var el = document.getElementById(id);
      if (el) { el.onclick = fn; }
      else { console.warn('[WxO Form] Button not found:', id); }
    }
    wireBtn('btnLoad', function() { vscode.postMessage({ command: 'loadFromFile' }); });
    wireBtn('btnClose', function() { vscode.postMessage({ command: 'close' }); });
    wireBtn('btnSyncToForm', syncEditorToForm);

    wireBtn('btnExport', function() {
      var d = collectForm();
      if (activeTab === 'editor') syncFormToEditor();
      vscode.postMessage({ command: 'exportToFile', content: val('editorContent'), name: d.name });
    });

    wireBtn('btnOpenEditor', function() {
      var d = collectForm();
      syncFormToEditor();
      vscode.postMessage({ command: 'openInEditor', content: val('editorContent'), name: d.name });
    });

    wireBtn('btnFormat', function() {
      var el = document.getElementById('editorContent');
      if (!el) return;
      if (objType === 'flows') {
        try { el.value = JSON.stringify(JSON.parse(el.value), null, 2); }
        catch(e) { setStatus('Invalid JSON: ' + e.message, true); }
      } else {
        setStatus('Use Open in Editor for YAML formatting.', false);
      }
    });

    wireBtn('btnSave', function() {
      setStatus('');
      console.log('[WxO Form] btnSave click', objType);
      var d = collectForm();
      if (!d.name) { setStatus('Name / App ID is required.', true); return; }
      if (activeTab === 'editor') { syncFormToEditor(); d.useEditor = true; }
      setStatus('Starting import…');
      vscode.postMessage(Object.assign({ command: 'save' }, d));
      setTimeout(function() { setStatus('Import started — check the terminal.'); }, 200);
    });

    console.log('[WxO Form] All buttons wired successfully');

    // ── Messages from extension ──
    window.addEventListener('message', function(e) {
      var m = e.data;
      if (m.command === 'fileLoaded') {
        console.log('[WxO Form] fileLoaded', objType);
        var edEl = document.getElementById('editorContent');
        if (edEl) edEl.value = m.content || '';
        syncEditorToForm();
        setStatus('Loaded: ' + (m.filePath || ''));
        switchTab('editor');
      } else if (m.command === 'toolsListLoaded' && objType === 'agents') {
        initialAvailableTools = m.tools || [];
        allAvailableTools = initialAvailableTools.slice();
        filterAvailableTools(toolsSearchTerm || '');
        setStatus('Tools loaded.', false);
      } else if (m.command === 'pluginsListLoaded' && objType === 'agents') {
        var loadedPlugins = m.plugins || [];
        var assignedPre = (val('fPluginsPre') || '').split('\\n').map(function(p){return p.trim();}).filter(Boolean);
        var assignedPost = (val('fPluginsPost') || '').split('\\n').map(function(p){return p.trim();}).filter(Boolean);
        var allPlugins = loadedPlugins.concat(assignedPre, assignedPost).filter(function(x,i,a){ return a.indexOf(x)===i; });
        var availPre = allPlugins.filter(function(x){ return assignedPre.indexOf(x)<0; });
        var availPost = allPlugins.filter(function(x){ return assignedPost.indexOf(x)<0; });
        renderPluginsLists(assignedPre, assignedPost, availPre, availPost);
        setStatus('Plugins loaded.', false);
      } else if (m.command === 'pluginsListError') {
        setStatus('Could not load plugins: ' + (m.message || ''), true);
      } else if (m.command === 'toolsListError') {
        setStatus('Could not load tools: ' + (m.message || ''), true);
      } else if (m.command === 'status') {
        setStatus(m.message, !!m.isError);
      }
    });
    if (syncFromEditorOnLoad && objType === 'agents' && typeof syncEditorToForm === 'function') {
      syncEditorToForm();
    }
    console.log('[WxO Form] Script initialization complete — form is ready');
    })();
  </script>
</body>
</html>`;
    }
}

// ── Module helpers ────────────────────────────────────────────────────────────

function typeLabel(t: ObjectFormType): string {
    return t === 'agents' ? 'Agent' : t === 'flows' ? 'Flow' : 'Connection';
}

function esc(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape JSON for safe embedding inside <script> – prevents </script> from closing the tag. */
function escScriptJson(obj: unknown): string {
    const raw = JSON.stringify(obj);
    return raw.replace(/<\/(script)/gi, '<\\/$1');
}

/** Escape content for <textarea> – prevents </textarea> from closing the tag. Uses ZWSP to break sequence. */
function escForTextarea(s: string): string {
    return s.replace(/<\//g, '<\u200b/');
}

function yamlStr(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
