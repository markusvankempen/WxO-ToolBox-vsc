/**
 * WxO Scripts Panel — Run WxO Importer/Export/Comparer/Validator scripts.
 * Standalone; no dependency on wxo-builder.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 27 Feb 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import { getEffectiveEnv } from '../utils/wxoEnv.js';
import { getCredentialsService } from '../services/credentialsContext.js';
import { WxOSystemsConfigService } from '../services/WxOSystemsConfigService.js';
import { WxOSystemEditorPanel } from './WxOSystemEditorPanel.js';
import { WxOTraceDetailPanel } from './WxOTraceDetailPanel.js';

const INSTALL_URL = 'https://developer.watson-orchestrate.ibm.com/getting_started/installing';
const TRACES_URL = 'https://developer.watson-orchestrate.ibm.com/traces/overview';

/** Returns the first workspace folder path, or process.cwd() if none. */
function getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
    return process.cwd();
}

/** Path to folder containing wxo_exporter_importer.sh, or null if not found.
 * Checks: (1) bundled extension scripts, (2) scriptsPath config, (3) workspace candidates. */
function getScriptsDir(extensionPath?: string): string | null {
    if (extensionPath) {
        const bundled = path.join(extensionPath, 'scripts');
        if (fs.existsSync(path.join(bundled, 'wxo_exporter_importer.sh'))) return bundled;
    }
    const cfg = vscode.workspace.getConfiguration('wxo-toolkit-vsc');
    const custom = cfg.get<string>('scriptsPath')?.trim();
    if (custom) {
        const p = path.isAbsolute(custom) ? custom : path.join(getWorkspaceRoot(), custom);
        if (fs.existsSync(path.join(p, 'wxo_exporter_importer.sh'))) return p;
        return null;
    }
    const ws = getWorkspaceRoot();
    const candidates = [
        ws, // workspace root = WxOImporterAndExporter
        path.join(ws, 'internal', 'WxOImporterAndExporter'),
        path.join(ws, 'WxOImporterAndExporter'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(path.join(p, 'wxo_exporter_importer.sh'))) return p;
    }
    return null;
}

/** Escape HTML entities for safe insertion into HTML. */
function escapeHtml(s: string): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Extract display label for a tool. Prefer info.title/x-ibm-skill-name (OpenAPI), then display_name from ADK 2.5+. */
function extractToolDisplayLabel(x: Record<string, unknown>): string | undefined {
    if (!x || typeof x !== 'object') return undefined;
    const spec = x.spec as Record<string, unknown> | undefined;
    const binding = x.binding as Record<string, unknown> | undefined;
    const oa = binding?.openapi as Record<string, unknown> | undefined;
    const oaSpec = oa?.spec as Record<string, unknown> | undefined;
    const info = (spec?.info ?? x.info ?? oaSpec?.info ?? oa?.info) as Record<string, unknown> | undefined;
    if (info && typeof info === 'object') {
        const title = typeof info.title === 'string' ? info.title.trim() : undefined;
        if (title) return title;
        const skillName = typeof info['x-ibm-skill-name'] === 'string' ? String(info['x-ibm-skill-name']).trim() : undefined;
        if (skillName) return skillName;
    }
    const label = (x.display_name ?? x.displayName ?? x.title) as string | undefined;
    return label && String(label).trim() ? String(label).trim() : undefined;
}

/**
 * Generate the HTML for the object-picker section that appears in Export/Import/Replicate tabs.
 * `prefix` is 'export' | 'import' | 'rep'. `loadBtnLabel` is the text on the load button.
 */
function pickerHtml(prefix: string, loadBtnLabel: string): string {
    const p = prefix;
    return `
      <div class="obj-picker-toggle">
        <label>
          <input type="checkbox" id="${p}UseSpecific">
          &nbsp;Pick specific objects by name
        </label>
      </div>
      <div id="${p}PickerBody" class="obj-picker-body" style="display:none;">
        <div class="obj-load-row">
          <button class="btn btn-secondary" id="btn${capitalize(p)}LoadList" style="padding:3px 10px;font-size:11px;">📋 ${loadBtnLabel}</button>
          <span id="${p}LoadStatus" class="obj-load-status"></span>
        </div>
        <!-- Agents -->
        <div class="obj-group">
          <div class="obj-group-hdr">
            <input type="checkbox" id="${p}AgentsAll" title="Select all agents">
            <span>Agents <span id="${p}AgentCount" class="obj-count-badge"></span></span>
            <div class="obj-group-btns">
              <button class="btn-xs" id="${p}AgentBtnAll">All</button>
              <button class="btn-xs" id="${p}AgentBtnNone">None</button>
            </div>
          </div>
          <div id="${p}AgentChecks" class="obj-checks"></div>
          <input type="text" id="${p}AgentNames" class="obj-text-input" placeholder="Or type agent names: agent1, agent2, …" />
        </div>
        <!-- Tools & Flows -->
        <div class="obj-group">
          <div class="obj-group-hdr">
            <input type="checkbox" id="${p}ToolsAll" title="Select all tools">
            <span>Tools &amp; Flows <span id="${p}ToolCount" class="obj-count-badge"></span></span>
            <div class="obj-group-btns">
              <button class="btn-xs" id="${p}ToolBtnAll">All</button>
              <button class="btn-xs" id="${p}ToolBtnNone">None</button>
            </div>
          </div>
          <div id="${p}ToolChecks" class="obj-checks"></div>
          <input type="text" id="${p}ToolNames" class="obj-text-input" placeholder="Or type tool names: tool1, tool2, …" />
        </div>
        <!-- Connections (incl. replicate: uses source env's secret mapping for target) -->
        <div class="obj-group">
          <div class="obj-group-hdr">
            <input type="checkbox" id="${p}ConnsAll" title="Select all connections">
            <span>Connections <span id="${p}ConnCount" class="obj-count-badge"></span></span>
            <div class="obj-group-btns">
              <button class="btn-xs" id="${p}ConnBtnAll">All</button>
              <button class="btn-xs" id="${p}ConnBtnNone">None</button>
            </div>
          </div>
          <div id="${p}ConnChecks" class="obj-checks"></div>
          <input type="text" id="${p}ConnNames" class="obj-text-input" placeholder="Or type connection app_ids: conn1, conn2, …" />
        </div>
      </div>`;
}

/** Capitalise first letter. */
function capitalize(s: string): string {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Root folder for WxO Exports, Imports, Systems. From config or default WxO/. */
function getWxORoot(): string {
    const cfg = vscode.workspace.getConfiguration('wxo-toolkit-vsc');
    const custom = cfg.get<string>('wxoRoot')?.trim();
    if (custom) {
        return path.isAbsolute(custom) ? custom : path.join(getWorkspaceRoot(), custom);
    }
    return path.join(getWorkspaceRoot(), 'WxO');
}

/** Output channel for debug logs. */
let _outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
    if (!_outputChannel) _outputChannel = vscode.window.createOutputChannel('WxO ToolBox');
    return _outputChannel;
}

/** Main webview panel for Export, Import, Compare, Replicate, Validate, Systems, Secrets, Dependencies. */
export class WxOScriptsPanel {
    static currentPanel: WxOScriptsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        const html = this._getHtml();

        // ── Always write debug HTML + scan for illegal </script> ───────────────
        const chan = getOutputChannel();
        const ws = getWorkspaceRoot();
        const debugPath = path.join(ws, '.vscode', 'wxo-panel-debug.html');
        try {
            fs.mkdirSync(path.dirname(debugPath), { recursive: true });
            fs.writeFileSync(debugPath, html, 'utf8');
            chan.appendLine(`[WxO Debug] Panel HTML written → ${debugPath}`);
        } catch (e) {
            chan.appendLine(`[WxO Debug] Could not write debug file: ${e}`);
        }

        // Scan generated HTML for </script> occurrences INSIDE the <script> block
        const scriptStart = html.indexOf('<script>');
        const scriptEnd = html.lastIndexOf('</script>');
        if (scriptStart !== -1 && scriptEnd !== -1) {
            const body = html.slice(scriptStart + 8, scriptEnd); // content between <script> and final </script>
            let pos = 0;
            let count = 0;
            while (true) {
                const idx = body.indexOf('</script>', pos);
                if (idx === -1) { break; }
                count++;
                const snippet = body.slice(Math.max(0, idx - 60), idx + 20).replace(/\n/g, '↵');
                chan.appendLine(`[WxO Debug] ⚠ Found </script> inside script block at offset ${idx}: …${snippet}…`);
                pos = idx + 1;
            }
            if (count === 0) {
                chan.appendLine('[WxO Debug] ✓ No </script> found inside script block.');
            }
        } else {
            chan.appendLine('[WxO Debug] Could not locate <script> or </script> in generated HTML.');
        }
        chan.show();

        this._panel.webview.html = html;
        this._panel.webview.onDidReceiveMessage(
            async (msg: { command: string; content?: Record<string, unknown> }) => {
                try {
                    if (msg.command === 'runExport') await this._handleRunExport(msg.content);
                    else if (msg.command === 'runImport') await this._handleRunImport(msg.content);
                    else if (msg.command === 'runCompare') await this._handleRunCompare(msg.content);
                    else if (msg.command === 'runReplicate') await this._handleRunReplicate(msg.content);
                    else if (msg.command === 'loadObjectList') await this._handleLoadObjectList(msg.content);
                    else if (msg.command === 'runInteractive') await this._handleRunInteractive();
                    else if (msg.command === 'checkDeps') await this._handleCheckDeps();
                    else if (msg.command === 'loadSystems') await this._handleLoadSystems();
                    else if (msg.command === 'openAddSystem') await this._handleOpenAddSystem();
                    else if (msg.command === 'addSystem') await this._handleAddSystem(msg.content);
                    else if (msg.command === 'activateSystem') await this._handleActivateSystem(msg.content);
                    else if (msg.command === 'editSystem') await this._handleEditSystem(msg.content);
                    else if (msg.command === 'editSystemCredentials') await this._handleEditSystemCredentials(msg.content);
                    else if (msg.command === 'removeSystem') await this._handleRemoveSystem(msg.content);
                    else if (msg.command === 'copyCredentialsToEnv') await this._handleCopyCredentialsToEnv();
                    else if (msg.command === 'loadSecrets') await this._handleLoadSecrets(msg.content);
                    else if (msg.command === 'saveSecrets') await this._handleSaveSecrets(msg.content);
                    else if (msg.command === 'tracesSearch') await this._handleTracesSearch(msg.content);
                    else if (msg.command === 'tracesExport') await this._handleTracesExport(msg.content);
                    else if (msg.command === 'exportTraceById') await this._handleExportTraceById(msg.content);
                    else if (msg.command === 'openInstallDocs') {
                        await vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
                    }                     else if (msg.command === 'openObservabilityDocs') {
                        await vscode.env.openExternal(vscode.Uri.parse(TRACES_URL));
                    } else if (msg.command === 'viewTraceDetail') {
                        const p = (msg as Record<string, unknown>).path as string | undefined;
                        if (p && typeof p === 'string' && fs.existsSync(p)) {
                            WxOTraceDetailPanel.show(this._extensionUri, p);
                        } else {
                            vscode.window.showWarningMessage('WxO: Trace file not found.');
                        }
                    }                     else if (msg.command === 'pickFolder') {
                        await this._handlePickFolder();
                    } else if (msg.command === 'openExtension') {
                        await vscode.commands.executeCommand(
                            'workbench.extensions.action.showExtensionsWithIds',
                            ['markusvankempen.wxo-toolkit-vsc'],
                        );
                    } else if (msg.command === 'openUserGuide') {
                        await vscode.commands.executeCommand('wxo-toolkit-vsc.openUserGuide');
                    } else if (msg.command === 'getLatestExportReport') {
                        const p = this._findLatestExportReport();
                        this._panel.webview.postMessage({ command: 'latestExportReport', path: p ?? undefined });
                    } else if (msg.command === 'getLatestImportReport') {
                        const p = this._findLatestImportReport();
                        this._panel.webview.postMessage({ command: 'latestImportReport', path: p ?? undefined });
                    } else if (msg.command === 'getLatestCompareReport') {
                        const p = this._findLatestCompareReport();
                        this._panel.webview.postMessage({ command: 'latestCompareReport', path: p ?? undefined });
                    } else if (msg.command === 'getLatestReplicateReport') {
                        const p = this._findLatestReplicateReport();
                        this._panel.webview.postMessage({ command: 'latestReplicateReport', path: p ?? undefined });
                    } else if (msg.command === 'openReport') {
                        const p = (msg as Record<string, unknown>).path as string | undefined;
                        if (p && typeof p === 'string' && fs.existsSync(p)) {
                            const uri = vscode.Uri.file(p);
                            const doc = await vscode.workspace.openTextDocument(uri);
                            await vscode.window.showTextDocument(doc, { preview: false });
                        } else {
                            vscode.window.showWarningMessage('WxO: Report file not found.');
                        }
                    } else if (msg.command === 'debugLog') {
                        const m = msg as Record<string, unknown>;
                        getOutputChannel().appendLine(`[Panel] ${String(m.message ?? m.msg ?? '')}`);
                    } else if (msg.command === 'panelError') {
                        const m = msg as Record<string, unknown>;
                        const chan = getOutputChannel();
                        chan.show();
                        chan.appendLine(`[Panel ERROR] ${String(m.message ?? m.msg ?? '')}`);
                        if (m.stack) chan.appendLine(String(m.stack));
                    }
                } catch (e) {
                    const err = e instanceof Error ? e : new Error(String(e));
                    vscode.window.showErrorMessage(`WxO Scripts: ${err.message}`);
                    this._panel.webview.postMessage({ command: 'operationStatus', message: `Error: ${err.message}`, isError: true });
                }
            },
            undefined,
            this._disposables,
        );
    }

    public static render(extensionUri: vscode.Uri) {
        if (WxOScriptsPanel.currentPanel) {
            WxOScriptsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'wxoImporterExporter',
            'WxO Toolkit',
            vscode.ViewColumn.One,
            { enableScripts: true },
        );
        WxOScriptsPanel.currentPanel = new WxOScriptsPanel(panel, extensionUri);
    }

    public dispose() {
        WxOScriptsPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach((d) => d.dispose());
    }

    private _ensureScriptsDir(): string {
        const dir = getScriptsDir(this._extensionUri.fsPath);
        if (!dir) {
            throw new Error(
                'Scripts not found. The extension bundles scripts—reinstall the extension, or set `wxo-toolkit-vsc.scriptsPath` to a folder containing wxo-toolkit-cli scripts (wxo_exporter_importer.sh).',
            );
        }
        return dir;
    }

    private _runInTerminal(cmd: string, name: string) {
        const ws = getWorkspaceRoot();
        const wxoRoot = getWxORoot();
        const baseEnv = getEffectiveEnv();
        const exports = `export ENV_FILE="${path.join(ws, '.env')}"; export WXO_ROOT="${wxoRoot}"; `;
        const term = vscode.window.createTerminal({ name, env: baseEnv });
        term.show();
        term.sendText(exports + cmd);
        this._panel.webview.postMessage({ command: 'operationStatus', message: `Command sent to terminal: ${name}` });
    }

    /** Strip ANSI escape sequences so they don't appear as raw codes in the panel. */
    private _stripAnsi(s: string): string {
        // eslint-disable-next-line no-control-regex
        return s.replace(/\x1b\[[0-9;]*[mGKHFABCDJnsuhl]/g, '');
    }

    /** Find latest timestamped subdir (YYYYMMDD_HHMMSS) and return path to report file, or null. */
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

    /** Find the most recent export report across all envs (Exports/Env/DateTime/Report/export_report.txt). */
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

    /** Find the most recent import report (Imports/Env/DateTime/Report/import_report.txt). */
    private _findLatestImportReport(): string | null {
        const wxoroot = getWxORoot();
        const importsDir = path.join(wxoroot, 'Imports');
        if (!fs.existsSync(importsDir)) return null;
        let bestPath: string | null = null;
        let bestTime = '';
        try {
            const envDirs = fs.readdirSync(importsDir, { withFileTypes: true })
                .filter((e) => e.isDirectory()).map((e) => e.name);
            for (const env of envDirs) {
                const p = this._findLatestReport(path.join(importsDir, env), 'Report/import_report.txt');
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

    /** Find the most recent compare report (Compare/Env1->Env2/DateTime/compare_report.txt). */
    private _findLatestCompareReport(): string | null {
        const wxoroot = getWxORoot();
        const compareDir = path.join(wxoroot, 'Compare');
        if (!fs.existsSync(compareDir)) return null;
        let bestPath: string | null = null;
        let bestTime = '';
        try {
            const pairDirs = fs.readdirSync(compareDir, { withFileTypes: true })
                .filter((e) => e.isDirectory()).map((e) => e.name);
            for (const pair of pairDirs) {
                const p = this._findLatestReport(path.join(compareDir, pair), 'compare_report.txt');
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

    /** Find the most recent replicate report (Replicate/Source_to_Target/DateTime/Report/export_report.txt). */
    private _findLatestReplicateReport(): string | null {
        const wxoroot = getWxORoot();
        const replicateDir = path.join(wxoroot, 'Replicate');
        if (!fs.existsSync(replicateDir)) return null;
        let bestPath: string | null = null;
        let bestTime = '';
        try {
            const pairDirs = fs.readdirSync(replicateDir, { withFileTypes: true })
                .filter((e) => e.isDirectory()).map((e) => e.name);
            for (const pair of pairDirs) {
                const p = this._findLatestReport(path.join(replicateDir, pair), 'Report/export_report.txt');
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

    /**
     * Run a bash command and stream stdout/stderr lines to the panel's output area
     * via `scriptOutput` messages.  The terminal is NOT opened.
     * @param getReportPath - Optional; called on completion to resolve report path for "Open Report" link.
     * @param operation - Optional; passed with reportPath so tabs can show "latest report" link.
     * @param envNames - Optional; envs used by the script. When provided, merges credentials from SecretStorage + .env into a temp ENV_FILE.
     */
    private async _runScript(
        cmd: string,
        label: string,
        getReportPath?: () => string | null,
        operation?: 'export' | 'import' | 'compare' | 'replicate' | 'observability',
        envNames?: string[],
        onComplete?: (reportPath: string | null) => void,
    ): Promise<void> {
        const ws = getWorkspaceRoot();
        const wxoRoot = getWxORoot();
        const baseEnv = getEffectiveEnv();
        let envFilePath = path.join(ws, '.env');
        let tmpEnvPath: string | undefined;

        const creds = getCredentialsService();
        if (creds && envNames && envNames.length > 0) {
            tmpEnvPath = await creds.buildEnvFileForScripts(envNames);
            envFilePath = tmpEnvPath;
        }

        const env: NodeJS.ProcessEnv = {
            ...baseEnv,
            ENV_FILE: envFilePath,
            WXO_ROOT: wxoRoot,
        };

        this._panel.webview.postMessage({ command: 'scriptOutput', clear: true, label });
        this._panel.webview.postMessage({ command: 'operationStatus', message: `Running: ${label}…` });

        const child = spawn('bash', ['-c', cmd], { env });
        const stripAnsi = this._stripAnsi.bind(this);

        const sendLines = (data: Buffer, isError: boolean) => {
            const text = stripAnsi(data.toString());
            for (const line of text.split('\n')) {
                this._panel.webview.postMessage({ command: 'scriptOutput', line, isError });
            }
        };

        child.stdout.on('data', (d: Buffer) => sendLines(d, false));
        child.stderr.on('data', (d: Buffer) => sendLines(d, true));

        child.on('close', (code: number | null) => {
            if (tmpEnvPath) {
                try { fs.unlinkSync(tmpEnvPath); } catch { /* ignore */ }
            }
            const exitCode = code ?? -1;
            let reportPath: string | null = null;
            if (getReportPath) {
                try {
                    reportPath = getReportPath();
                    if (reportPath && !fs.existsSync(reportPath)) reportPath = null;
                } catch {
                    reportPath = null;
                }
            }
            this._panel.webview.postMessage({
                command: 'scriptOutput',
                done: true,
                exitCode,
                reportPath: reportPath ?? undefined,
                operation,
            });
            this._panel.webview.postMessage({
                command: 'operationStatus',
                message: `${label} finished (exit ${exitCode})`,
                isError: exitCode !== 0,
            });
            if (onComplete) onComplete(reportPath);
        });

        child.on('error', (err: Error) => {
            if (tmpEnvPath) {
                try { fs.unlinkSync(tmpEnvPath); } catch { /* ignore */ }
            }
            this._panel.webview.postMessage({ command: 'scriptOutput', line: `[ERROR] ${err.message}`, isError: true });
            this._panel.webview.postMessage({ command: 'scriptOutput', done: true, exitCode: 1 });
        });
    }

    private async _handleRunExport(content?: Record<string, unknown>) {
        const dir = this._ensureScriptsDir();
        const env = (content?.env as string) || 'TZ1';
        const what = (content?.what as string) || 'all';
        const wxoroot = getWxORoot();

        // Specific object filters (comma-separated names, optional)
        const specificAgents = ((content?.agents as string) ?? '').trim();
        const specificTools  = ((content?.tools  as string) ?? '').trim();
        const specificConns  = ((content?.connections as string) ?? '').trim();
        const hasSpecific = specificAgents || specificTools || specificConns;

        let args = `-o "${wxoroot}" --env-name "${env}"`;

        if (hasSpecific) {
            // Specific mode: pass individual name filters, let the script decide what to do
            if (specificAgents)  args += ` --agent "${specificAgents}"`;
            if (specificTools)   args += ` --tool "${specificTools}"`;
            if (specificConns)   args += ` --connection "${specificConns}" --connections-only`;
            // If only connections, skip agents/tools
            if (!specificAgents && !specificTools && specificConns) args += ' --agents-only'.replace('--agents-only', '') ;
        } else {
            switch (what) {
                case 'agents':      args += ' --agents-only'; break;
                case 'tools':       args += ' --tools-only'; break;
                case 'flows':       args += ' --flows-only'; break;
                case 'plugins':     args += ' --plugins-only'; break;
                case 'connections': args += ' --connections-only'; break;
            }
        }

        this._runScript(
            `cd "${dir}" && ./export_from_wxo.sh ${args}`,
            'WxO Export',
            () => this._findLatestReport(path.join(wxoroot, 'Exports', env), 'Report/export_report.txt'),
            'export',
            [env],
        );
    }

    private async _handleRunImport(content?: Record<string, unknown>) {
        const dir = this._ensureScriptsDir();
        const baseDir = (content?.baseDir as string)?.trim();
        const env = (content?.env as string) || 'TZ2';
        const what = (content?.what as string) || 'all';
        const ifExists = (content?.ifExists as string) || 'override';
        const wxoroot = getWxORoot();
        // Default: latest export from Exports/TZ1/ (or first found env)
        const folder = baseDir || this._getDefaultImportFolder(wxoroot);
        const connSourceExplicit = (content?.connSource as string)?.trim();

        // Connection credential source: explicit selection, else auto-detect from path (Exports/<env>/)
        let envConnSource = connSourceExplicit;
        if (!envConnSource) {
            const exportsMatch = folder.match(/[/\\]Exports[/\\]([^/\\]+)(?:[/\\]|$)/);
            if (exportsMatch) {
                envConnSource = exportsMatch[1];
            }
        }

        const specificAgents = ((content?.agents as string) ?? '').trim();
        const specificTools  = ((content?.tools  as string) ?? '').trim();
        const specificConns  = ((content?.connections as string) ?? '').trim();
        const hasSpecific = specificAgents || specificTools || specificConns;

        const envVars = [`WXO_ROOT="${wxoroot}"`];
        if (envConnSource) envVars.push(`ENV_CONN_SOURCE="${envConnSource}"`);
        const envPrefix = envVars.length ? `export ${envVars.join(' ')}; ` : '';
        let args = `--base-dir "${folder}" --env "${env}" --no-credential-prompt --if-exists ${ifExists}`;

        if (hasSpecific) {
            if (specificAgents) args += ` --agent "${specificAgents}"`;
            if (specificTools)  args += ` --tool "${specificTools}"`;
            if (specificConns)  args += ` --connection "${specificConns}" --connections-only`;
        } else {
            switch (what) {
                case 'agents':      args += ' --agents-only'; break;
                case 'tools':       args += ' --tools-only'; break;
                case 'flows':       args += ' --flows-only'; break;
                case 'plugins':     args += ' --plugins-only'; break;
                case 'connections': args += ' --connections-only'; break;
                default:            args += ' --all'; break;
            }
        }

        const now = new Date();
        const dt =
            `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
            `_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        const reportDir = path.join(wxoroot, 'Imports', env, dt);

        this._runScript(
            `${envPrefix}cd "${dir}" && ./import_to_wxo.sh ${args} --report-dir "${reportDir}"`,
            'WxO Import',
            () => {
                const p = path.join(reportDir, 'Report', 'import_report.txt');
                return fs.existsSync(p) ? p : null;
            },
            'import',
            [env],
        );
    }

    private async _handleRunCompare(content?: Record<string, unknown>) {
        const dir = this._ensureScriptsDir();
        const env1 = (content?.env1 as string) || 'TZ1';
        const env2 = (content?.env2 as string) || 'TZ2';
        const what = (content?.what as string) || 'all';
        const specificAgents = ((content?.agents as string) ?? '').trim();
        const specificTools  = ((content?.tools  as string) ?? '').trim();
        const specificConns  = ((content?.connections as string) ?? '').trim();
        const hasSpecific = specificAgents || specificTools || specificConns;

        let args = `"${env1}" "${env2}"`;
        if (hasSpecific) {
            if (specificAgents) args += ` --agent "${specificAgents}"`;
            if (specificTools)  args += ` --tool "${specificTools}"`;
            if (specificConns)  args += ` --connection "${specificConns}"`;
        } else if (what !== 'all') {
            switch (what) {
                case 'agents':      args += ' --agents-only'; break;
                case 'tools':       args += ' --tools-only'; break;
                case 'flows':       args += ' --flows-only'; break;
                case 'plugins':     args += ' --plugins-only'; break;
                case 'connections': args += ' --connections-only'; break;
            }
        }

        const wxoroot = getWxORoot();
        const compareBase = path.join(wxoroot, 'Compare', `${env1}->${env2}`);

        this._runScript(
            `cd "${dir}" && ./compare_wxo_systems.sh ${args}`,
            'WxO Compare',
            () => this._findLatestReport(compareBase, 'compare_report.txt'),
            'compare',
            [env1, env2],
        );
    }

    private async _handleRunReplicate(content?: Record<string, unknown>) {
        const dir = this._ensureScriptsDir();
        const source = (content?.source as string) || 'TZ1';
        const target = (content?.target as string) || 'TZ2';
        const what = (content?.what as string) || 'all';
        const ifExists = (content?.ifExists as string) || 'override';
        const connSourceExplicit = (content?.connSource as string)?.trim();
        // Connection credential source: explicit selection, else same as source
        const envConnSource = connSourceExplicit || source;
        const wxoroot = getWxORoot();

        const specificAgents = ((content?.agents as string) ?? '').trim();
        const specificTools  = ((content?.tools  as string) ?? '').trim();
        const specificConns  = ((content?.connections as string) ?? '').trim();
        const hasSpecific = specificAgents || specificTools || specificConns;

        let exportArgs = `-o "${wxoroot}" --env-name "${source}_to_${target}" --replicate`;
        if (hasSpecific) {
            if (specificAgents) exportArgs += ` --agent "${specificAgents}"`;
            if (specificTools)  exportArgs += ` --tool "${specificTools}"`;
            if (specificConns)  exportArgs += ` --connection "${specificConns}" --connections-only`;
        } else {
            if (what === 'agents') exportArgs += ' --agents-only';
            else if (what === 'tools') exportArgs += ' --tools-only';
            else if (what === 'flows') exportArgs += ' --flows-only';
            else if (what === 'plugins') exportArgs += ' --plugins-only';
            else if (what === 'connections') exportArgs += ' --connections-only';
        }

        // Build import args (step 2): uses source env's .env_connection for credential mapping
        let importOpts = '';
        if (hasSpecific) {
            if (specificAgents) importOpts += ` --agent "${specificAgents}"`;
            if (specificTools)  importOpts += ` --tool "${specificTools}"`;
            if (specificConns)  importOpts += ` --connection "${specificConns}" --connections-only`;
        } else {
            switch (what) {
                case 'agents': importOpts += ' --agents-only'; break;
                case 'tools': importOpts += ' --tools-only'; break;
                case 'flows': importOpts += ' --flows-only'; break;
                case 'plugins': importOpts += ' --plugins-only'; break;
                case 'connections': importOpts += ' --connections-only'; break;
                default: importOpts += ' --all'; break; // all: agents + tools + flows + connections
            }
        }

        const replicateBase = path.join(wxoroot, 'Replicate', `${source}_to_${target}`);
        const replicateBaseEsc = replicateBase.replace(/"/g, '\\"');
        // Export → find latest dir → import with ENV_CONN_SOURCE (conn credential source)
        const fullCmd = [
            `cd "${dir}" && ./export_from_wxo.sh ${exportArgs}`,
            `REP_DIR=$(ls -1t "${replicateBaseEsc}" 2>/dev/null | head -1)`,
            `if [ -n "$REP_DIR" ]; then ENV_CONN_SOURCE="${envConnSource}" WXO_ROOT="${wxoroot}" ./import_to_wxo.sh --base-dir "${replicateBaseEsc}/$REP_DIR" --env "${target}" --no-credential-prompt --if-exists ${ifExists} ${importOpts} --report-dir "${replicateBaseEsc}/$REP_DIR"; else echo "[ERROR] No replicate folder found"; exit 1; fi`,
        ].join(' && ');
        this._runScript(
            fullCmd,
            'WxO Replicate',
            () => this._findLatestReport(replicateBase, 'Report/export_report.txt'),
            'replicate',
            [source, target],
        );
    }

    /**
     * Load the list of agents, tools, and connections from the specified environment
     * and return them to the webview for rendering as checkboxes.
     */
    private async _handleLoadObjectList(content?: Record<string, unknown>): Promise<void> {
        const env  = ((content?.env  as string) ?? '').trim();
        const tab  = ((content?.tab  as string) ?? 'export');
        const eff  = getEffectiveEnv();
        const opts = { env: { ...process.env, ...eff }, encoding: 'utf8' as const, timeout: 30_000 };

        const tryExec = (cmd: string): unknown => {
            try {
                const out = execSync(cmd, opts) as string;
                const lines = out.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const t = lines[i].trim();
                    if (t.startsWith('[') || t.startsWith('{')) {
                        return JSON.parse(lines.slice(i).join('\n'));
                    }
                }
                return JSON.parse(out);
            } catch { return null; }
        };

        this._panel.webview.postMessage({ command: 'objectListLoading', tab });

        try {
            if (env) {
                try { execSync(`orchestrate env activate "${env}" 2>/dev/null`, opts); } catch { /* ignore */ }
            }

            const agData = tryExec('orchestrate agents list -v 2>/dev/null');
            const tlData = tryExec('orchestrate tools list -v 2>/dev/null');
            const cnData = tryExec('orchestrate connections list -v 2>/dev/null');

            const toNames = (d: unknown, ...extras: string[]): string[] => {
                let arr: unknown[];
                if (Array.isArray(d)) { arr = d; }
                else {
                    const o = d as Record<string, unknown>;
                    arr = (o?.tools ?? o?.native ?? o?.agents ?? o?.data ?? o?.items ?? o?.live ?? o?.draft ?? o?.connections ?? []) as unknown[];
                    if (!Array.isArray(arr)) arr = [];
                }
                const r = (arr as Array<Record<string, unknown>>)
                    .map(x => (x?.name ?? x?.app_id ?? x?.appId ?? x?.id ?? '') as string)
                    .filter(Boolean);
                return [...new Set([...r, ...extras.filter(Boolean)])].sort((a, b) => a.localeCompare(b));
            };

            const toAgentsWithLabels = (d: unknown): Array<{ name: string; label: string }> => {
                const names = toNames(d);
                let arr: unknown[];
                if (Array.isArray(d)) { arr = d; }
                else {
                    const o = d as Record<string, unknown>;
                    arr = (o?.native ?? o?.agents ?? o?.data ?? o?.items ?? o?.tools ?? []) as unknown[];
                    if (!Array.isArray(arr)) arr = [];
                }
                const byName = new Map<string, string>();
                (arr as Array<Record<string, unknown>>).forEach((x: Record<string, unknown>) => {
                    const name = (x?.name ?? x?.id ?? '') as string;
                    const label = (x?.display_name ?? x?.displayName ?? name) as string;
                    if (name) byName.set(name, label || name);
                });
                return names.map(n => ({ name: n, label: byName.get(n) ?? n })).sort((a, b) => a.label.localeCompare(b.label));
            };

            const toToolsWithLabels = (d: unknown): Array<{ name: string; label: string }> => {
                const names = toNames(d);
                let arr: unknown[];
                if (Array.isArray(d)) { arr = d; }
                else {
                    const o = d as Record<string, unknown>;
                    arr = (o?.tools ?? o?.native ?? o?.data ?? o?.items ?? []) as unknown[];
                    if (!Array.isArray(arr)) arr = [];
                }
                const byName = new Map<string, string>();
                (arr as Array<Record<string, unknown>>).forEach((x: Record<string, unknown>) => {
                    const name = (x?.name ?? x?.id ?? '') as string;
                    const title = extractToolDisplayLabel(x);
                    if (name) byName.set(name, title || name);
                });
                return names.map(n => ({ name: n, label: byName.get(n) ?? n })).sort((a, b) => a.label.localeCompare(b.label));
            };

            this._panel.webview.postMessage({
                command: 'objectListLoaded',
                tab,
                agents:      toAgentsWithLabels(agData),
                tools:       toToolsWithLabels(tlData),
                connections: toNames(cnData),
            });
        } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            this._panel.webview.postMessage({ command: 'objectListError', tab, message: m });
        }
    }

    private async _handleRunDangerDelete(content?: Record<string, unknown>) {
        const resourceType = (content?.resourceType as string) ?? 'agents';
        const names = ((content?.names as string) ?? '')
            .split('\n')
            .map(n => n.trim())
            .filter(Boolean);
        const withDeps = !!(content?.withDeps);

        if (names.length === 0) {
            vscode.window.showWarningMessage('Danger Zone: enter at least one resource name.');
            return;
        }

        // Native VS Code confirmation — must type "DELETE"
        const typed = await vscode.window.showInputBox({
            title: `⚠ Danger Zone — Delete ${names.length} ${resourceType}`,
            prompt: `This will permanently delete: ${names.join(', ')}.\nType exactly DELETE to confirm.`,
            placeHolder: 'DELETE',
            validateInput: v => (v && v !== 'DELETE') ? 'Type exactly: DELETE' : null,
        });
        if (typed !== 'DELETE') {
            this._panel.webview.postMessage({ command: 'operationStatus', message: 'Delete cancelled.', isError: false });
            return;
        }

        const lines: string[] = [
            `echo "=== ⚠ Danger Zone: deleting ${names.length} ${resourceType} ==="`,
        ];

        for (const name of names) {
            lines.push(`echo "" && echo "→ Deleting ${resourceType}: ${name}"`);

            if (resourceType === 'agents') {
                // Try all three agent kinds in sequence
                lines.push(
                    `( orchestrate agents remove -n "${name}" -k native 2>&1 && echo "  ✓ removed (native)" ) || ` +
                    `( orchestrate agents remove -n "${name}" -k external 2>&1 && echo "  ✓ removed (external)" ) || ` +
                    `( orchestrate agents remove -n "${name}" -k assistant 2>&1 && echo "  ✓ removed (assistant)" ) || ` +
                    `echo "  ✗ failed to remove agent: ${name}"`,
                );
                if (withDeps) {
                    // Export first to find tool deps, then remove them
                    lines.push(
                        `_TMPDIR=$(mktemp -d) && ` +
                        `orchestrate agents export -n "${name}" -k native -o "$_TMPDIR/agent.zip" 2>/dev/null && ` +
                        `unzip -o -q "$_TMPDIR/agent.zip" -d "$_TMPDIR" 2>/dev/null || true && ` +
                        `for _t in "$_TMPDIR"/*/tools/*/; do [ -d "$_t" ] && orchestrate tools remove -n "$(basename "$_t")" 2>&1 && echo "  ✓ removed dep tool: $(basename "$_t")"; done; ` +
                        `rm -rf "$_TMPDIR"`,
                    );
                }
            } else if (resourceType === 'tools' || resourceType === 'flows') {
                lines.push(
                    `orchestrate tools remove -n "${name}" 2>&1 && echo "  ✓ removed" || echo "  ✗ failed: ${name}"`,
                );
            } else if (resourceType === 'connections') {
                lines.push(
                    `orchestrate connections remove -a "${name}" 2>&1 && echo "  ✓ removed" || echo "  ✗ failed: ${name}"`,
                );
            }
        }

        lines.push(`echo "" && echo "=== Delete complete ==="`);
        this._runInTerminal(lines.join('\n'), '⚠ WxO Danger Zone');
        this._panel.webview.postMessage({
            command: 'operationStatus',
            message: `Danger Zone: deleting ${names.length} ${resourceType} — check the terminal for results.`,
            isError: false,
        });
    }

    private async _handleRunInteractive() {
        const dir = this._ensureScriptsDir();
        this._runInTerminal(`cd "${dir}" && ./wxo_exporter_importer.sh`, 'WxO Interactive Menu');
    }

    private async _handleCheckDeps() {
        const checks: { name: string; ok: boolean; msg: string }[] = [];
        const env = getEffectiveEnv();

        try {
            execSync('orchestrate --version', { encoding: 'utf8', env });
            checks.push({ name: 'orchestrate', ok: true, msg: 'Installed' });
        } catch {
            checks.push({
                name: 'orchestrate',
                ok: false,
                msg: `pip install --upgrade ibm-watsonx-orchestrate | ${INSTALL_URL}`,
            });
        }

        try {
            execSync('jq --version', { encoding: 'utf8', env });
            checks.push({ name: 'jq', ok: true, msg: 'Installed' });
        } catch {
            checks.push({ name: 'jq', ok: false, msg: 'brew install jq (macOS) or apt-get install jq (Linux)' });
        }

        try {
            execSync('unzip -v', { encoding: 'utf8', env });
            checks.push({ name: 'unzip', ok: true, msg: 'Installed' });
        } catch {
            checks.push({ name: 'unzip', ok: false, msg: 'Usually preinstalled (macOS); apt-get install unzip (Linux)' });
        }

        this._panel.webview.postMessage({ command: 'depCheckResult', checks });
    }

    /** Default import folder: latest Exports/<env>/<DateTime>/, or Exports/TZ1 if none. */
    private _getDefaultImportFolder(wxoroot: string): string {
        const exportsBase = path.join(wxoroot, 'Exports');
        if (!fs.existsSync(exportsBase)) return path.join(wxoroot, 'Exports', 'TZ1');
        const envDirs = fs.readdirSync(exportsBase, { withFileTypes: true })
            .filter((e) => e.isDirectory()).map((e) => e.name);
        for (const env of ['TZ1', 'TZ2', ...envDirs.filter((e) => !['TZ1', 'TZ2'].includes(e))]) {
            const envPath = path.join(exportsBase, env);
            if (!fs.existsSync(envPath)) continue;
            const timestamps = fs.readdirSync(envPath, { withFileTypes: true })
                .filter((e) => e.isDirectory() && /^\d{8}_\d{6}$/.test(e.name))
                .map((e) => e.name)
                .sort()
                .reverse();
            if (timestamps.length > 0) {
                return path.join(envPath, timestamps[0]);
            }
        }
        return path.join(wxoroot, 'Exports', 'TZ1');
    }

    private async _handlePickFolder() {
        const wxoroot = getWxORoot();
        const base = path.join(wxoroot, 'Exports');
        const uri = await vscode.window.showOpenDialog({
            defaultUri: fs.existsSync(base) ? vscode.Uri.file(base) : vscode.Uri.file(wxoroot),
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select export or replicate folder',
        });
        if (uri?.[0]) {
            this._panel.webview.postMessage({ command: 'folderPicked', path: uri[0].fsPath });
        }
    }

    // ── Systems handlers ──────────────────────────────────────────────────────

    private _systemsConfig = new WxOSystemsConfigService(getWxORoot);

    private async _handleLoadSystems() {
        const env = getEffectiveEnv();
        const wxoroot = getWxORoot();
        try {
            const out = execSync('orchestrate env list 2>/dev/null', {
                shell: '/bin/zsh',
                encoding: 'utf8',
                env,
            }) as string;
            const parsed = this._parseEnvList(out);
            this._systemsConfig.ensureBootstrap(parsed);
            const envs = this._systemsConfig.mergeWithOrchestrateList(parsed);
            const defaultFolder = this._getDefaultImportFolder(wxoroot);
            const defaultConnSource = (defaultFolder.match(/[/\\]Exports[/\\]([^/\\]+)(?:[/\\]|$)/) ?? [])[1] ?? undefined;
            this._panel.webview.postMessage({
                command: 'systemsLoaded',
                envs,
                defaultConnSource: defaultConnSource || undefined,
            });
        } catch (err: unknown) {
            this._panel.webview.postMessage({
                command: 'systemsLoaded',
                envs: [],
                error: `Could not load environments: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }

    private _parseEnvList(out: string): Array<{ name: string; url: string; active: boolean }> {
        return out
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !/^[─═]+/.test(l) && !/^Name\b/i.test(l))
            .map(l => {
                const active = l.includes('(active)');
                const clean = l.replace(/\(active\)/g, '').trim();
                const parts = clean.split(/\s{2,}/);
                return { name: parts[0] ?? '', url: (parts[1] ?? '').trim(), active };
            })
            .filter(e => !!e.name);
    }

    private async _handleOpenAddSystem() {
        WxOSystemEditorPanel.render(this._extensionUri, null, () => this._handleLoadSystems());
    }

    private async _handleAddSystem(content?: Record<string, unknown>) {
        const name = (content?.name as string)?.trim();
        const url = (content?.url as string)?.trim();
        const type = (content?.type as string)?.trim();
        const apiKey = (content?.apiKey as string)?.trim();

        if (!name) { throw new Error('Environment name is required.'); }
        if (!url)  { throw new Error('Environment URL is required.'); }

        this._systemsConfig.saveSystem(name, url);
        if (apiKey) {
            const creds = getCredentialsService();
            if (creds) await creds.setApiKey(name, apiKey);
        }

        let cmd = `orchestrate env add -n "${name}" -u "${url}"`;
        if (type && type !== 'auto') { cmd += ` --type ${type}`; }
        execSync(cmd, { shell: '/bin/zsh', encoding: 'utf8', env: getEffectiveEnv() });

        if (apiKey) {
            execSync(`orchestrate env activate "${name}" --api-key "${apiKey}" 2>/dev/null`, {
                shell: '/bin/zsh', encoding: 'utf8', env: getEffectiveEnv(),
            });
        }

        this._panel.webview.postMessage({ command: 'operationStatus', message: `Environment "${name}" added.${apiKey ? ' Credentials stored securely.' : ''}` });
        await this._handleLoadSystems();
    }

    private async _handleActivateSystem(content?: Record<string, unknown>) {
        const name = (content?.name as string)?.trim();
        if (!name) { return; }
        execSync(`orchestrate env activate "${name}" 2>/dev/null`, { shell: '/bin/zsh', encoding: 'utf8', env: getEffectiveEnv() });
        this._panel.webview.postMessage({ command: 'operationStatus', message: `Environment "${name}" activated.` });
        await this._handleLoadSystems();
    }

    private async _handleEditSystem(content?: Record<string, unknown>) {
        const name = (content?.name as string)?.trim();
        if (!name) { return; }
        const entry = this._systemsConfig.getSystem(name);
        const creds = getCredentialsService();
        const hasApiKey = creds ? await creds.hasStoredKey(name) : false;
        WxOSystemEditorPanel.render(
            this._extensionUri,
            { name, url: entry?.url ?? '', hasApiKey },
            () => this._handleLoadSystems(),
        );
    }

    private async _handleEditSystemCredentials(content?: Record<string, unknown>) {
        const name = (content?.name as string)?.trim();
        if (!name) { return; }
        const envPath = this._getSecretsPath(name);
        const dir = path.dirname(envPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const { WxOEnvFileEditorPanel } = await import('./WxOEnvFileEditorPanel.js');
        WxOEnvFileEditorPanel.render(this._extensionUri, envPath);
    }

    private async _handleRemoveSystem(content?: Record<string, unknown>) {
        const name = (content?.name as string)?.trim();
        if (!name) { return; }

        const choice = await vscode.window.showWarningMessage(
            `Remove environment "${name}"?\nRemoves from extension config and orchestrate CLI. Exported data is kept.`,
            { modal: true },
            'Remove',
        );
        if (choice !== 'Remove') { return; }

        this._systemsConfig.removeSystem(name);
        const creds = getCredentialsService();
        if (creds) await creds.deleteApiKey(name);

        execSync(`orchestrate env remove -n "${name}" 2>/dev/null`, { shell: '/bin/zsh', encoding: 'utf8', env: getEffectiveEnv() });
        this._panel.webview.postMessage({ command: 'operationStatus', message: `Environment "${name}" removed.` });
        await this._handleLoadSystems();
    }

    private async _handleCopyCredentialsToEnv(): Promise<void> {
        const creds = getCredentialsService();
        if (!creds) {
            this._panel.webview.postMessage({ command: 'operationStatus', message: 'Credentials service not available.', isError: true });
            return;
        }
        try {
            const filePath = await creds.copyToWorkspaceEnv();
            this._panel.webview.postMessage({ command: 'operationStatus', message: `Credentials copied to ${filePath}` });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._panel.webview.postMessage({ command: 'operationStatus', message: `Copy failed: ${msg}`, isError: true });
        }
    }

    // ── Secrets handlers ──────────────────────────────────────────────────────

    private _getSecretsPath(envName: string): string {
        return path.join(getWxORoot(), 'Systems', envName, 'Connections', `.env_connection_${envName}`);
    }

    private async _handleLoadSecrets(content?: Record<string, unknown>) {
        const envName = (content?.envName as string)?.trim();
        if (!envName) {
            this._panel.webview.postMessage({ command: 'secretsLoaded', entries: [], envName: '' });
            return;
        }

        const filePath = this._getSecretsPath(envName);
        const entries: Array<{ key: string; value: string; isComment: boolean; text?: string }> = [];

        if (fs.existsSync(filePath)) {
            for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('#')) {
                    entries.push({ key: '', value: '', isComment: true, text: trimmed });
                } else if (trimmed) {
                    const eq = trimmed.indexOf('=');
                    entries.push({
                        key: eq >= 0 ? trimmed.slice(0, eq).trim() : trimmed,
                        value: eq >= 0 ? trimmed.slice(eq + 1).trim() : '',
                        isComment: false,
                    });
                }
            }
        }

        this._panel.webview.postMessage({ command: 'secretsLoaded', entries, envName, filePath });
    }

    private async _handleSaveSecrets(content?: Record<string, unknown>) {
        const envName = (content?.envName as string)?.trim();
        const entries = content?.entries as Array<{ key: string; value: string; isComment?: boolean; text?: string }>;

        if (!envName) { throw new Error('No environment selected.'); }
        if (!Array.isArray(entries)) { throw new Error('Invalid secrets payload.'); }

        const filePath = this._getSecretsPath(envName);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

        const lines: string[] = [];
        for (const e of entries) {
            if (e.isComment) {
                lines.push(e.text ?? '');
            } else if (e.key.trim()) {
                lines.push(`${e.key.trim()}=${e.value}`);
            }
        }
        lines.push('');
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        this._panel.webview.postMessage({
            command: 'operationStatus',
            message: `Secrets saved → ${filePath}`,
        });
    }

    // ── Observability handlers ────────────────────────────────────────────────

    private async _handleTracesSearch(content?: Record<string, unknown>) {
        const env = ((content?.env as string) ?? 'TZ1').trim();
        let startTime = ((content?.startTime as string) ?? '').trim();
        let endTime = ((content?.endTime as string) ?? '').trim();
        const agentName = ((content?.agentName as string) ?? '').trim();
        const limit = Math.min(1000, Math.max(1, parseInt(String(content?.limit ?? 50), 10) || 50));

        if (!startTime || !endTime) {
            const now = new Date();
            endTime = now.toISOString();
            startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        }

        // CLI expects YYYY-MM-DDTHH:mm:ss (no Z, no milliseconds)
        const toCliTime = (iso: string) => iso.replace(/\.\d{3}Z?$/, '').replace(/Z$/, '').slice(0, 19);

        const startCli = toCliTime(startTime);
        const endCli = toCliTime(endTime);

        const startMs = new Date(startTime).getTime();
        const endMs = new Date(endTime).getTime();
        const rangeDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
        if (rangeDays > 30) {
            this._panel.webview.postMessage({
                command: 'operationStatus',
                message: `Time range cannot exceed 30 days (you have ${Math.round(rangeDays)} days). Narrow the range and try again.`,
                isError: true,
            });
            return;
        }

        this._panel.webview.postMessage({ command: 'operationStatus', message: 'Searching traces…' });

        try {
            const ws = getWorkspaceRoot();
            const wxoRoot = getWxORoot();
            const baseEnv = getEffectiveEnv();
            let envFilePath = path.join(ws, '.env');
            let tmpEnvPath: string | undefined;

            const creds = getCredentialsService();
            if (creds && env) {
                tmpEnvPath = await creds.buildEnvFileForScripts([env]);
                envFilePath = tmpEnvPath;
            }

            const execEnv: NodeJS.ProcessEnv = {
                ...process.env,
                ...baseEnv,
                ENV_FILE: envFilePath,
                WXO_ROOT: wxoRoot,
            };

            // Use Python API for full column data; CLI truncates output
            const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
            const pyScript = `
import json
orchestrate_env='${esc(env)}'
start_time='${esc(startTime)}'
end_time='${esc(endTime)}'
agent_name='${esc(agentName)}'
limit=${limit}
import subprocess
subprocess.run(["orchestrate","env","activate",orchestrate_env],capture_output=True,timeout=5)
from ibm_watsonx_orchestrate.cli.commands.observability.traces.traces_controller import TracesController
from ibm_watsonx_orchestrate.client.observability.traces import TraceFilters
kwargs={"start_time":start_time,"end_time":end_time}
if agent_name.strip(): kwargs["agent_names"]=[agent_name.strip()]
filters=TraceFilters(**kwargs)
controller=TracesController()
resp=controller.search_traces(filters=filters,page_size=min(limit,100))
out=[]
for t in (resp.traceSummaries or []):
  out.append({
    "traceId":getattr(t,"traceId",getattr(t,"trace_id","")) or "",
    "startTime":str(getattr(t,"startTime",getattr(t,"start_time",""))) if (hasattr(t,"startTime") or hasattr(t,"start_time")) else "",
    "duration":str(round(getattr(t,"durationMs",getattr(t,"duration_ms",0)) or 0)),
    "spans":str(getattr(t,"spanCount",getattr(t,"span_count",0)) or 0),
    "agentName":((getattr(t,"agentNames",None) or getattr(t,"agent_names",[])) or [""])[0],
    "userId":((getattr(t,"userIds",None) or getattr(t,"user_ids",[])) or [""])[0]
  })
print(json.dumps(out))
`;
            const q = (s: string) => `"${String(s).replace(/"/g, '\\"')}"`;
            const cliArgs = ['--start-time', q(startCli), '--end-time', q(endCli), '--limit', String(limit)];
            if (agentName) cliArgs.push('--agent-name', q(agentName));
            const cliCmd = `orchestrate env activate "${env}" 2>/dev/null && orchestrate observability traces search ${cliArgs.join(' ')} 2>&1`;

            let raw: string;
            const pyPath = path.join(os.tmpdir(), `wxo-trace-search-${Date.now()}.py`);
            fs.writeFileSync(pyPath, pyScript, 'utf8');
            const pyCmd = `orchestrate env activate "${env}" 2>/dev/null && python3 "${pyPath}" 2>/dev/null`;
            try {
                raw = execSync(pyCmd, { encoding: 'utf8', env: execEnv, timeout: 60_000 }) as string;
            } catch {
                raw = execSync(cliCmd, { encoding: 'utf8', env: execEnv, timeout: 60_000 }) as string;
            } finally {
                try { fs.unlinkSync(pyPath); } catch { /* ignore */ }
            }
            if (tmpEnvPath) {
                try { fs.unlinkSync(tmpEnvPath); } catch { /* ignore */ }
            }

            let traces: Array<{ traceId: string; startTime?: string; duration?: string; spans?: string; agentName?: string; agentId?: string; userId?: string }>;
            const jsonLine = raw.split('\n').find((l) => l.trim().startsWith('['));
            try {
                traces = jsonLine ? JSON.parse(jsonLine) : this._parseTraceSearchOutput(this._stripAnsi(raw));
            } catch {
                traces = this._parseTraceSearchOutput(this._stripAnsi(raw));
            }
            this._panel.webview.postMessage({
                command: 'traceSearchResults',
                traces,
                env,
                summary: traces.length === 0 ? 'No traces found' : `Found ${traces.length} trace(s)`,
                raw: raw,
            });
            this._panel.webview.postMessage({
                command: 'operationStatus',
                message: traces.length === 0 ? 'No traces found' : `Found ${traces.length} trace(s)`,
            });
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            const errExt = err as { stderr?: string; stdout?: string };
            const msg = errExt.stderr ?? errExt.stdout ?? err.message ?? String(e);
            const text = typeof msg === 'string' ? this._stripAnsi(msg) : String(msg);
            this._panel.webview.postMessage({
                command: 'traceSearchResults',
                traces: [],
                env: ((content?.env as string) ?? 'TZ1').trim(),
                summary: 'Search failed',
                raw: text,
            });
            this._panel.webview.postMessage({
                command: 'operationStatus',
                message: `Search failed: ${err.message}`,
                isError: true,
            });
        }
    }

    /** Parse orchestrate observability traces search output; extract trace rows. */
    private _parseTraceSearchOutput(text: string): Array<{ traceId: string; startTime?: string; duration?: string; spans?: string; agentName?: string; agentId?: string; userId?: string }> {
        const traces: Array<{ traceId: string; startTime?: string; duration?: string; spans?: string; agentName?: string; agentId?: string; userId?: string }> = [];
        const traceIdRe = /[a-fA-F0-9]{32}/;
        for (const line of text.split('\n')) {
            if (line.includes('Trace ID') || line.includes('━━') || /^[┃┡└]/.test(line.trim())) continue;
            const cells = line.split('│').map((c) => c.trim()).filter(Boolean);
            if (cells.length < 2) continue;
            const traceIdMatch = line.match(traceIdRe);
            const traceId = traceIdMatch ? traceIdMatch[0] : cells[0];
            if (traceId.length === 32 && /^[a-fA-F0-9]+$/.test(traceId)) {
                traces.push({
                    traceId,
                    startTime: cells[1],
                    duration: cells[2],
                    spans: cells[3],
                    agentName: cells[4],
                    agentId: cells[5],
                    userId: cells[6],
                });
            }
        }
        return traces;
    }

    /** Build trace filename: {tracePrefix}_{datetime}_{agent}.json */
    private _traceFileName(traceId: string, agentName?: string): string {
        const prefix = traceId.slice(0, 4);
        const now = new Date();
        const dt =
            `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` +
            `_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        const agent = (agentName ?? '')
            .trim()
            .replace(/[^a-zA-Z0-9-_]/g, '_')
            .slice(0, 25) || 'unknown';
        return `${prefix}_${dt}_${agent}.json`;
    }

    private async _handleTracesExport(content?: Record<string, unknown>) {
        const env = ((content?.env as string) ?? 'TZ1').trim();
        const traceId = ((content?.traceId as string) ?? '').trim().replace(/[^a-fA-F0-9]/g, '');
        const outputFile = ((content?.outputFile as string) ?? '').trim();

        if (!traceId || traceId.length !== 32) {
            this._panel.webview.postMessage({
                command: 'operationStatus',
                message: 'Trace ID must be 32 hexadecimal characters.',
                isError: true,
            });
            return;
        }

        const wxoroot = getWxORoot();
        const outPath = outputFile
            ? path.isAbsolute(outputFile)
                ? outputFile
                : path.join(getWorkspaceRoot(), outputFile)
            : path.join(
                wxoroot,
                'Observability',
                env,
                this._traceFileName(traceId, content?.agentName as string | undefined),
            );

        const dir = path.dirname(outPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const cmd = `orchestrate env activate "${env}" 2>/dev/null && orchestrate observability traces export --trace-id "${traceId}" -o "${outPath}" --pretty`;
        this._runScript(
            cmd,
            'Trace Export',
            () => (fs.existsSync(outPath) ? outPath : null),
            'observability',
            [env],
        );
    }

    private async _handleExportTraceById(content?: Record<string, unknown>) {
        const env = ((content?.env as string) ?? 'TZ1').trim();
        const traceId = ((content?.traceId as string) ?? '').trim().replace(/[^a-fA-F0-9]/g, '');
        const agentName = (content?.agentName as string) ?? undefined;

        if (!traceId || traceId.length !== 32) {
            this._panel.webview.postMessage({
                command: 'operationStatus',
                message: 'Invalid trace ID.',
                isError: true,
            });
            return;
        }

        const wxoroot = getWxORoot();
        const outPath = path.join(wxoroot, 'Observability', env, this._traceFileName(traceId, agentName));
        const dir = path.dirname(outPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const cmd = `orchestrate env activate "${env}" 2>/dev/null && orchestrate observability traces export --trace-id "${traceId}" -o "${outPath}" --pretty`;
        this._runScript(
            cmd,
            'Download Trace',
            () => (fs.existsSync(outPath) ? outPath : null),
            'observability',
            [env],
            (reportPath) => {
                if (reportPath) {
                    WxOTraceDetailPanel.show(this._extensionUri, reportPath);
                }
            },
        );
    }

    private _getHtml(): string {
        const scriptsDir = getScriptsDir(this._extensionUri.fsPath);
        const ok = !!scriptsDir;
        const scriptsPath = escapeHtml(scriptsDir || '(not found)');
        const d = ok ? '' : 'disabled';

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WxO ToolBox</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── App header ── */
    .app-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: var(--vscode-titleBar-activeBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .app-header-icon { font-size: 1.4em; }
    .app-header-title {
      font-weight: 600;
      font-size: 1em;
      color: var(--vscode-titleBar-activeForeground);
    }
    .app-header-version {
      font-size: 0.75em;
      opacity: 0.6;
      margin-left: 2px;
    }
    .app-header-spacer { flex: 1; }
    .ext-link {
      font-size: 0.78em;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
      border: 1px solid var(--vscode-textLink-foreground);
      border-radius: 10px;
      padding: 2px 9px;
      white-space: nowrap;
      opacity: 0.85;
    }
    .ext-link:hover { opacity: 1; text-decoration: underline; }
    .trace-id-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
    }
    .trace-id-link:hover { text-decoration: underline; }

    /* ── Tab bar ── */
    .tab-bar {
      display: flex;
      background: var(--vscode-tab-inactiveBackground, var(--vscode-editorGroupHeader-tabsBackground));
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      overflow-x: auto;
    }
    .tab-bar::-webkit-scrollbar { height: 2px; }
    .tab-btn {
      padding: 8px 16px;
      border: none;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--vscode-tab-inactiveForeground);
      cursor: pointer;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      white-space: nowrap;
      transition: color 0.1s;
    }
    .tab-btn:hover { color: var(--vscode-tab-activeForeground); background: var(--vscode-tab-hoverBackground); }
    .tab-btn.active {
      color: var(--vscode-tab-activeForeground);
      border-bottom-color: var(--vscode-tab-activeBorderTop, var(--vscode-focusBorder));
      background: var(--vscode-tab-activeBackground);
    }

    /* ── Tab content ── */
    .tab-body { flex: 1; overflow-y: auto; padding: 16px; }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }

    /* ── Forms ── */
    .field { margin-bottom: 12px; }
    label { display: block; margin-bottom: 4px; font-size: 12px; opacity: 0.8; }
    input[type="text"], select, textarea {
      width: 100%;
      max-width: 340px;
      padding: 5px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px;
      font-size: 13px;
      font-family: var(--vscode-font-family);
    }
    textarea { max-width: 480px; resize: vertical; font-family: monospace; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }

    /* ── Buttons ── */
    .btn {
      padding: 6px 14px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      white-space: nowrap;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }

    /* ── Status bar ── */
    .status-bar {
      padding: 5px 16px;
      font-size: 11px;
      font-family: monospace;
      min-height: 24px;
      background: var(--vscode-statusBar-background, var(--vscode-input-background));
      color: var(--vscode-statusBar-foreground, var(--vscode-foreground));
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-bar.error { color: var(--vscode-errorForeground); }

    /* ── Misc ── */
    .hint { font-size: 11px; opacity: 0.65; margin-bottom: 10px; }
    .sep { height: 1px; background: var(--vscode-panel-border); margin: 14px 0; }
    .ok  { color: var(--vscode-testing-iconPassed); }
    .err { color: var(--vscode-errorForeground); }
    .params-list { margin-bottom: 8px; }
    .params-list .row { display: flex; gap: 8px; align-items: flex-end; margin-bottom: 6px; flex-wrap: wrap; }
    .create-form .field { margin-bottom: 12px; }

    /* ── Object picker ── */
    .obj-picker-toggle { display:flex; align-items:center; gap:8px; margin-top:8px; }
    .obj-picker-toggle label { font-size:12px; cursor:pointer; display:flex; align-items:center; gap:5px; }
    .obj-picker-body { margin-top:10px; padding:10px; background:var(--vscode-editor-inactiveSelectionBackground); border-radius:4px; border:1px solid var(--vscode-widget-border); }
    .obj-group { margin-bottom:10px; }
    .obj-group:last-child { margin-bottom:0; }
    .obj-group-hdr { display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:12px; font-weight:bold; }
    .obj-group-hdr .obj-group-btns { margin-left:auto; display:flex; gap:4px; }
    .btn-xs { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); border:none; padding:1px 7px; font-size:10px; border-radius:2px; cursor:pointer; }
    .btn-xs:hover { background:var(--vscode-button-secondaryHoverBackground); }
    .obj-checks { display:flex; flex-wrap:wrap; gap:5px; min-height:22px; margin-bottom:5px; }
    .obj-chip { display:inline-flex; align-items:center; gap:3px; padding:2px 8px; border-radius:10px; font-size:11px; cursor:pointer; user-select:none; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); border:1px solid transparent; }
    .obj-chip input[type=checkbox] { margin:0; cursor:pointer; }
    .obj-chip:has(input:checked) { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
    .obj-text-input { width:100%; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); padding:4px 8px; font-size:11px; border-radius:2px; font-family:var(--vscode-editor-font-family, monospace); }
    .obj-count-badge { font-size:10px; opacity:0.6; font-weight:normal; }
    .obj-load-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
    .obj-load-status { font-size:11px; opacity:0.65; }

    .warn-box {
      padding: 8px 10px;
      background: var(--vscode-inputValidation-warningBackground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      border-radius: 3px;
      margin-bottom: 12px;
      font-size: 12px;
    }
    code { font-family: monospace; font-size: 0.92em; }

    /* ── Output panel ── */
    .output-panel {
      display: none;
      flex-direction: column;
      flex-shrink: 0;
      border-top: 2px solid var(--vscode-focusBorder, var(--vscode-panel-border));
      background: var(--vscode-terminal-background, var(--vscode-editor-background));
      overflow: hidden;
    }
    .output-panel.visible { display: flex; }
    .output-resize-handle {
      height: 5px;
      cursor: ns-resize;
      background: var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .output-resize-handle:hover { background: var(--vscode-focusBorder); }
    .output-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 10px;
      background: var(--vscode-tab-inactiveBackground, var(--vscode-editorGroupHeader-tabsBackground));
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      font-size: 11px;
    }
    .output-label { font-weight: 600; flex: 1; color: var(--vscode-foreground); }
    .output-spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-focusBorder);
      border-top-color: transparent;
      border-radius: 50%;
      animation: wxo-spin 0.7s linear infinite;
      visibility: hidden;
    }
    .output-spinner.running { visibility: visible; }
    @keyframes wxo-spin { to { transform: rotate(360deg); } }
    .output-body {
      flex: 1;
      overflow-y: auto;
      padding: 6px 12px;
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      font-size: 12px;
      line-height: 1.5;
    }
    .output-line {
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--vscode-terminal-foreground, var(--vscode-foreground));
    }
    .output-line.ok  { color: var(--vscode-testing-iconPassed, #4ec94e); }
    .output-line.err { color: var(--vscode-errorForeground, #f44336); }
    .output-line.sep { opacity: 0.45; }
    .output-line.hdr { font-weight: 600; }
    .output-exit-ok  { color: var(--vscode-testing-iconPassed, #4ec94e); font-weight: 600; margin-top: 4px; }
    .output-exit-err { color: var(--vscode-errorForeground, #f44336); font-weight: 600; margin-top: 4px; }
    .output-report-link { margin-top: 6px; }
    .output-report-link a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .output-report-link a:hover { text-decoration: underline; }
  </style>
</head>
<body>

  <!-- App header -->
  <div class="app-header">
    <span class="app-header-icon">↔</span>
    <span class="app-header-title">WxO ToolBox</span>
    <span class="app-header-version">v1.0.0</span>
    <span class="app-header-spacer"></span>
    <a class="ext-link" id="btnExtLink" title="Open extension in VS Code Marketplace">⚡ Extension</a>
  </div>

  <!-- Tab bar -->
    <div class="tab-bar">
    <button class="tab-btn active" data-tab="export">↑ Export</button>
    <button class="tab-btn" data-tab="import">↓ Import</button>
    <button class="tab-btn" data-tab="compare">⇄ Compare</button>
    <button class="tab-btn" data-tab="replicate">⇉ Replicate</button>
    <button class="tab-btn" data-tab="systems">⊕ Systems</button>
    <button class="tab-btn" data-tab="observability">📊 Observability</button>
    <button class="tab-btn" data-tab="secrets">🔑 Secrets</button>
    <button class="tab-btn" data-tab="deps">⚙ Deps</button>
    <button class="tab-btn" data-tab="help">📖 Help</button>
  </div>

  <!-- Tab content -->
  <div class="tab-body">

    ${!ok ? `<div class="warn-box">⚠ Scripts not found at <code>${scriptsPath}</code>. Open the <code>wxo-toolkit-cli</code> folder as workspace, or set <code>wxo-toolkit-vsc.scriptsPath</code> to the wxo-toolkit-cli folder.</div>` : ''}

    <!-- Export -->
    <div id="pane-export" class="tab-pane active">
      <p class="hint">Pull agents, tools, flows, or connections from Watson Orchestrate to local storage.</p>
      <div class="row">
        <div class="field">
          <label>Environment</label>
          <input type="text" id="exportEnv" value="TZ1" placeholder="e.g. TZ1" style="max-width:160px;" />
        </div>
        <div class="field" id="exportWhatField">
          <label>What to export</label>
          <select id="exportWhat">
            <option value="all">All (agents + tools + flows)</option>
            <option value="agents">Agents only</option>
            <option value="tools">Tools only</option>
            <option value="flows">Flows only</option>
            <option value="plugins">Plugins only</option>
            <option value="connections">Connections only (live)</option>
          </select>
        </div>
      </div>
      ${pickerHtml('export', 'Export from env')}
      <div class="btn-row">
        <button class="btn" id="btnExport" ${d}>▶ Run Export</button>
        <button class="btn btn-secondary" id="btnInteractive" ${d}>⚡ Open full interactive menu</button>
      </div>
      <div class="report-section" style="margin-top:12px;padding:8px;background:var(--vscode-input-background, #222);border-radius:4px;">
        <span class="hint">Latest export report: </span>
        <span id="exportReportLink">—</span>
        <button class="btn btn-secondary" id="btnRefreshExportReport" style="margin-left:8px;padding:2px 8px;font-size:11px;">Refresh</button>
      </div>
    </div>

    <!-- Import -->
    <div id="pane-import" class="tab-pane">
      <p class="hint">Push agents, tools, flows, or connections from a local export folder into Watson Orchestrate.</p>
      <div class="row">
        <div class="field" style="flex:1;min-width:200px;">
          <label>Export folder</label>
          <input type="text" id="importFolder" placeholder="Click Pick to browse…" style="max-width:400px;" />
        </div>
        <div class="field">
          <button class="btn btn-secondary" id="btnPickFolder" style="margin-top:18px;">📂 Pick folder</button>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>Target environment</label>
          <input type="text" id="importEnv" value="TZ2" style="max-width:160px;" />
        </div>
        <div class="field">
          <label>Import what</label>
          <select id="importWhat" style="max-width:200px;">
            <option value="all">All (agents + tools + flows + connections)</option>
            <option value="agents">Agents only</option>
            <option value="tools">Tools only</option>
            <option value="flows">Flows only</option>
            <option value="plugins">Plugins only</option>
            <option value="connections">Connections only</option>
          </select>
        </div>
        <div class="field">
          <label>If exists</label>
          <select id="importIfExists" style="max-width:160px;">
            <option value="override">Override</option>
            <option value="skip">Skip</option>
          </select>
        </div>
        <div class="field">
          <label>Connection credential source</label>
          <select id="importConnSource" style="max-width:180px;" title="Which env's .env_connection to use for CONN_* when importing connections. Auto = from export path (e.g. Exports/TZ1/... → TZ1).">
            <option value="">auto (from path)</option>
          </select>
        </div>
      </div>
      ${pickerHtml('import', 'Load from export folder')}
      <div class="btn-row">
        <button class="btn" id="btnImport" ${d}>▶ Run Import</button>
      </div>
      <div class="report-section" style="margin-top:12px;padding:8px;background:var(--vscode-input-background, #222);border-radius:4px;">
        <span class="hint">Latest import report: </span>
        <span id="importReportLink">—</span>
        <button class="btn btn-secondary" id="btnRefreshImportReport" style="margin-left:8px;padding:2px 8px;font-size:11px;">Refresh</button>
      </div>
    </div>

    <!-- Compare -->
    <div id="pane-compare" class="tab-pane">
      <p class="hint">Compare agents, tools, flows, connections, or plugins between two environments. Report saved to <code>WxO/Compare/</code>.</p>
      <div class="row">
        <div class="field">
          <label>Source environment</label>
          <input type="text" id="compareEnv1" value="TZ1" style="max-width:160px;" />
        </div>
        <div class="field">
          <label>Target environment</label>
          <input type="text" id="compareEnv2" value="TZ2" style="max-width:160px;" />
        </div>
        <div class="field">
          <label>What to compare</label>
          <select id="compareWhat" style="max-width:200px;">
            <option value="all">All (agents, tools, flows, connections, plugins)</option>
            <option value="agents">Agents only</option>
            <option value="tools">Tools only</option>
            <option value="flows">Flows only</option>
            <option value="plugins">Plugins only</option>
            <option value="connections">Connections only</option>
          </select>
        </div>
      </div>
      ${pickerHtml('compare', 'Load from source env')}
      <div class="btn-row">
        <button class="btn" id="btnCompare" ${d}>▶ Run Compare</button>
      </div>
      <div class="report-section" style="margin-top:12px;padding:8px;background:var(--vscode-input-background, #222);border-radius:4px;">
        <span class="hint">Latest compare report: </span>
        <span id="compareReportLink">—</span>
        <button class="btn btn-secondary" id="btnRefreshCompareReport" style="margin-left:8px;padding:2px 8px;font-size:11px;">Refresh</button>
      </div>
    </div>

    <!-- Replicate -->
    <div id="pane-replicate" class="tab-pane">
      <p class="hint">Copy resources from source → Replicate folder → target environment. <strong>Connections</strong>: uses source system's secret mapping (<code>.env_connection_&lt;source&gt;</code>) for credentials in target.</p>
      <div class="row">
        <div class="field">
          <label>Source environment</label>
          <input type="text" id="repSource" value="TZ1" style="max-width:160px;" />
        </div>
        <div class="field">
          <label>Target environment</label>
          <input type="text" id="repTarget" value="TZ2" style="max-width:160px;" />
        </div>
        <div class="field">
          <label>Connection credential source</label>
          <select id="repConnSource" style="max-width:180px;" title="Which env's .env_connection to use for CONN_* when replicating connections. Default = source.">
            <option value="">same as source</option>
          </select>
        </div>
        <div class="field">
          <label>What to replicate</label>
          <select id="repWhat">
            <option value="all">All (agents + tools + flows)</option>
            <option value="agents">Agents only</option>
            <option value="tools">Tools only</option>
            <option value="flows">Flows only</option>
            <option value="plugins">Plugins only</option>
            <option value="connections">Connections only (uses source secret mapping)</option>
          </select>
        </div>
        <div class="field">
          <label>If exists</label>
          <select id="repIfExists" style="max-width:160px;">
            <option value="override">Override</option>
            <option value="skip">Skip</option>
          </select>
        </div>
      </div>
      ${pickerHtml('rep', 'Load from source env')}
      <div class="btn-row">
        <button class="btn" id="btnReplicate" ${d}>▶ Run Replicate</button>
      </div>
      <div class="report-section" style="margin-top:12px;padding:8px;background:var(--vscode-input-background, #222);border-radius:4px;">
        <span class="hint">Latest replicate report: </span>
        <span id="replicateReportLink">—</span>
        <button class="btn btn-secondary" id="btnRefreshReplicateReport" style="margin-left:8px;padding:2px 8px;font-size:11px;">Refresh</button>
      </div>
    </div>

    <!-- Systems -->
    <div id="pane-systems" class="tab-pane">
      <p class="hint">Extension is the source of truth. System config (name, URL, API key) stored in <code>WxO/Systems/systems.json</code>; API keys in SecretStorage. Synced to orchestrate CLI.</p>

      <div id="systemsTable" style="margin-bottom:14px;">
        <p class="hint" style="font-style:italic;">Loading environments…</p>
      </div>

      <div class="btn-row">
        <button class="btn" id="btnAddSystem">+ Add System</button>
        <button class="btn btn-secondary" id="btnRefreshSystems">↺ Refresh</button>
        <button class="btn btn-secondary" id="btnCopyToEnv" title="Copy stored credentials to workspace .env">📋 Copy to .env</button>
      </div>
    </div>

    <!-- Observability -->
    <div id="pane-observability" class="tab-pane">
      <p class="hint">Search and export traces from Watson Orchestrate. Requires watsonx Orchestrate SaaS or Developer Edition with <code>--with-ibm-telemetry</code>. <a href="#" id="linkObservabilityDocs">Docs</a></p>

      <div class="row" style="margin-bottom:12px;">
        <div class="field">
          <label>Environment</label>
          <input type="text" id="obsEnv" value="TZ1" placeholder="e.g. TZ1" style="max-width:120px;" />
        </div>
      </div>

      <h4 style="font-size:13px;margin:16px 0 8px 0;">Search traces</h4>
      <p class="hint" style="margin-bottom:8px;">Time range cannot exceed 30 days. Default: last 30 minutes.</p>
      <div class="row" style="flex-wrap:wrap;gap:10px;margin-bottom:10px;">
        <div class="field">
          <label>Start time</label>
          <input type="datetime-local" id="obsStartTime" style="max-width:200px;font-family:monospace;font-size:12px;" />
        </div>
        <div class="field">
          <label>End time</label>
          <input type="datetime-local" id="obsEndTime" style="max-width:200px;font-family:monospace;font-size:12px;" />
        </div>
        <div class="field">
          <label>Agent name</label>
          <input type="text" id="obsAgentName" placeholder="optional" style="max-width:140px;" />
        </div>
        <div class="field">
          <label>Limit (1–1000)</label>
          <input type="number" id="obsLimit" value="50" min="1" max="1000" style="max-width:80px;" />
        </div>
      </div>
      <div class="btn-row" style="margin-bottom:16px;">
        <button class="btn" id="btnObsSearch">🔍 Search traces</button>
        <button class="btn btn-secondary" id="btnObsResetTimes" title="Set start = now −30 min, end = now">↺ Last 30 min</button>
      </div>

      <div id="obsResultsSection" style="margin-top:16px;display:none;">
        <h4 style="font-size:13px;margin:0 0 8px 0;">Search results</h4>
        <p id="obsResultsSummary" class="hint" style="margin-bottom:8px;"></p>
        <pre id="obsResultsRaw" style="display:none;font-size:11px;margin:8px 0;padding:8px;background:var(--vscode-input-background,#222);border-radius:4px;overflow-x:auto;white-space:pre-wrap;max-height:120px;"></pre>
        <div id="obsResultsTableWrap" style="overflow-x:auto;margin-bottom:12px;">
          <table id="obsResultsTable" style="width:100%;min-width:700px;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr>
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);">Trace ID</th>
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);">Start</th>
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);">Duration</th>
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);">Spans</th>
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);">Agent</th>
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);">User</th>
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);width:80px;"></th>
              </tr>
            </thead>
            <tbody id="obsResultsBody"></tbody>
          </table>
        </div>
      </div>

      <h4 style="font-size:13px;margin:16px 0 8px 0;">Export trace</h4>
      <p class="hint" style="margin-bottom:8px;">Export spans for a trace ID (32-char hex) as JSON. Paste a trace ID from search results or the UI.</p>
      <div class="row" style="flex-wrap:wrap;gap:10px;margin-bottom:10px;">
        <div class="field" style="flex:1;min-width:200px;">
          <label>Trace ID</label>
          <input type="text" id="obsTraceId" placeholder="1234567890abcdef1234567890abcdef" style="font-family:monospace;font-size:12px;" />
          <input type="hidden" id="obsAgentName" value="" />
        </div>
        <div class="field" style="flex:1;min-width:200px;">
          <label>Output file (optional)</label>
          <input type="text" id="obsOutputFile" placeholder="Leave empty for WxO/Observability/{env}/" style="font-family:monospace;font-size:12px;" />
        </div>
      </div>
      <div class="btn-row">
        <button class="btn" id="btnObsExport">📥 Export trace</button>
      </div>
      <div class="report-section" style="margin-top:12px;padding:8px;background:var(--vscode-input-background, #222);border-radius:4px;">
        <span class="hint">Last export: </span>
        <span id="obsExportLink">—</span>
      </div>
    </div>

    <!-- Secrets -->
    <div id="pane-secrets" class="tab-pane">
      <p class="hint">Edit <strong>connection credentials</strong> (CONN_*) per system — for tools that use connections. Not system-level secrets (WXO_API_KEY, etc.). Stored in <code>WxO/Systems/{env}/Connections/.env_connection_{env}</code></p>

      <div class="row" style="align-items:flex-end;gap:10px;margin-bottom:12px;">
        <div class="field">
          <label>Environment</label>
          <select id="secretsEnvSelect" style="max-width:200px;">
            <option value="">— select environment —</option>
          </select>
        </div>
        <div class="field">
          <button class="btn btn-secondary" id="btnReloadSecrets" style="margin-top:18px;">↺ Reload</button>
        </div>
      </div>

      <p id="secretsFilePath" class="hint" style="font-family:monospace;opacity:0.6;margin-bottom:8px;"></p>

      <div id="secretsTableWrap" style="display:none;">
        <table id="secretsTable" style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:10px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--vscode-panel-border);width:38%;">Key</th>
              <th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--vscode-panel-border);">Value</th>
              <th style="width:36px;border-bottom:1px solid var(--vscode-panel-border);"></th>
            </tr>
          </thead>
          <tbody id="secretsRows"></tbody>
        </table>
        <div class="btn-row">
          <button class="btn btn-secondary" id="btnAddSecret">+ Add entry</button>
          <button class="btn" id="btnSaveSecrets">💾 Save to file</button>
        </div>
      </div>

      <p id="secretsEmpty" class="hint" style="font-style:italic;display:none;">
        No secrets file found for this environment — press <strong>Save</strong> to create it.
      </p>
    </div>

    <!-- Help -->
    <div id="pane-help" class="tab-pane">
      <h3 style="margin-bottom:12px;">WxO ToolBox — User Guide</h3>
      <p class="hint" style="margin-bottom:16px;">Export, import, compare, replicate, and manage IBM Watson Orchestrate resources from VS Code.</p>

      <div style="margin-bottom:16px;">
        <h4 style="font-size:13px;margin-bottom:8px;">Getting Started</h4>
        <ul style="margin:0 0 12px 20px;line-height:1.7;font-size:12px;">
          <li><strong>Select Environment</strong> — Choose a Watson Orchestrate instance in the Activity Bar</li>
          <li><strong>Browse resources</strong> — Expand Agents, Tools, Flows, Connections in the tree</li>
          <li><strong>Inline actions</strong> — View JSON, Export, Copy, Edit, Compare, Delete on each resource</li>
        </ul>
      </div>

      <div style="margin-bottom:16px;">
        <h4 style="font-size:13px;margin-bottom:8px;">Panel Tabs</h4>
        <ul style="margin:0 0 12px 20px;line-height:1.7;font-size:12px;">
          <li><strong>Export / Import / Compare / Replicate</strong> — Bulk operations via orchestrate CLI scripts</li>
          <li><strong>Create Tool</strong> — Separate panel to create/edit Python or OpenAPI tools (Activity Bar → Create Tool)</li>
          <li><strong>Systems</strong> — Add, activate, or remove orchestrate environments</li>
          <li><strong>Observability</strong> — Search and export traces (ADK 2.5.0+; SaaS or Developer Edition with telemetry)</li>
          <li><strong>Secrets</strong> — Edit connection credentials per environment (<code>.env_connection_*</code>)</li>
          <li><strong>Dependencies</strong> — Check orchestrate, jq, unzip installation</li>
        </ul>
      </div>

      <div style="margin-bottom:16px;">
        <h4 style="font-size:13px;margin-bottom:8px;">Prerequisites</h4>
        <p style="font-size:12px;margin:0 0 8px 0;">Requires <a href="#" id="linkInstall">orchestrate CLI</a>, jq, and unzip. Add environments in the Systems tab (API keys stored securely).</p>
        <p style="font-size:12px;margin:8px 0 0 0;"><strong>Python venv?</strong> If orchestrate is installed in a virtual environment, set <code>wxo-toolkit-vsc.orchestrateVenvPath</code> (Settings → search "venv") to your venv folder (e.g. <code>.venv</code>).</p>
      </div>

      <div class="btn-row" style="margin-top:20px;">
        <button class="btn" id="btnOpenUserGuide">📖 Open Full User Guide</button>
        <button class="btn btn-secondary" id="btnOpenInstall">📖 Install orchestrate CLI</button>
      </div>
    </div>

    <!-- Dependencies -->
    <div id="pane-deps" class="tab-pane">
      <p class="hint">Check that all required CLI tools are installed and in PATH.</p>
      <p class="hint" style="margin-top:8px;">Using orchestrate in a Python venv? Set <code>wxo-toolkit-vsc.orchestrateVenvPath</code> in Settings to your venv folder (e.g. <code>.venv</code>).</p>
      <div class="btn-row" style="margin-bottom:12px;">
        <button class="btn" id="btnCheckDeps">🔍 Check dependencies</button>
        <button class="btn btn-secondary" id="btnOpenDocs">📖 Install docs</button>
      </div>
      <div id="depResults" style="font-size:12px;line-height:1.7;"></div>
      <div class="sep"></div>
      <p class="hint">Scripts path: <code>${scriptsPath}</code></p>
    </div>

  </div><!-- /tab-body -->

  <!-- Live output panel (shown when a script runs) -->
  <div class="output-panel" id="outputPanel">
    <div class="output-resize-handle" id="outputResizeHandle" title="Drag to resize"></div>
    <div class="output-header">
      <div class="output-spinner" id="outputSpinner"></div>
      <span class="output-label" id="outputLabel">Output</span>
      <button class="btn btn-secondary" id="btnClearOutput" style="padding:2px 8px;font-size:11px;">Clear</button>
      <button class="btn btn-secondary" id="btnCloseOutput" style="padding:2px 8px;font-size:11px;">✕ Close</button>
    </div>
    <div class="output-body" id="outputBody"></div>
  </div>

  <!-- Status bar -->
  <div class="status-bar" id="statusBar"></div>

  <script>
    console.log('[WxO Panel] Script block started');
    const vscode = acquireVsCodeApi();
    var _debug = typeof vscode.postMessage === 'function';
    console.log('[WxO Panel] vscode API acquired, _debug:', _debug);
    function updateReportLink(elId, p) {
      var el = document.getElementById(elId);
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
    function updateExportReportLink(p) { updateReportLink('exportReportLink', p); }
    function updateImportReportLink(p) { updateReportLink('importReportLink', p); }
    function updateCompareReportLink(p) { updateReportLink('compareReportLink', p); }
    function updateReplicateReportLink(p) { updateReportLink('replicateReportLink', p); }
    function updateObsExportLink(p) {
      var el = document.getElementById('obsExportLink');
      if (!el) return;
      if (p) {
        el.innerHTML = '<a href="#" class="obs-export-open">📄 Open JSON</a> <a href="#" class="obs-export-parsed">📊 View parsed</a>';
        el.querySelector('.obs-export-open').onclick = function(ev) { ev.preventDefault(); vscode.postMessage({ command: 'openReport', path: p }); };
        el.querySelector('.obs-export-parsed').onclick = function(ev) { ev.preventDefault(); vscode.postMessage({ command: 'viewTraceDetail', path: p }); };
      } else {
        el.textContent = '—';
      }
    }
    if (_debug) vscode.postMessage({ command: 'debugLog', message: '[Panel] Script loaded successfully' });
    window.onerror = function(msg, url, line, col, err) {
      console.error('[WxO Panel] Runtime error:', msg, 'at', line, ':', col);
      if (_debug && vscode.postMessage) {
        vscode.postMessage({ command: 'panelError', message: msg, url: url || '', line: line || 0, col: col || 0, stack: err && err.stack ? err.stack : '' });
      }
      return false;
    };
    console.log('[WxO Panel] Error handler registered');

    // ── Tabs ──────────────────────────────────────────────────────────────────
    console.log('[WxO Panel] Setting up tabs');
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.tab;
        console.log('[WxO Panel] Tab clicked:', id);
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('pane-' + id).classList.add('active');
      });
    });
    console.log('[WxO Panel] Tabs initialized');

    // ── Status ────────────────────────────────────────────────────────────────
    console.log('[WxO Panel] Setting up status');
    function setStatus(msg, isError) {
      const el = document.getElementById('statusBar');
      el.textContent = msg;
      el.className = 'status-bar' + (isError ? ' error' : '');
      console.log('[WxO Panel] Status set:', msg, 'error:', isError);
    }
    console.log('[WxO Panel] Status function ready');

    // ── Extension link ────────────────────────────────────────────────────────
    console.log('[WxO Panel] Setting up extension link');
    document.getElementById('btnExtLink').addEventListener('click', () => {
      vscode.postMessage({ command: 'openExtension' });
    });

    // ── Object picker helpers ─────────────────────────────────────────────────
    function onPickerToggle(prefix) {
      var body = document.getElementById(prefix + 'PickerBody');
      var cb   = document.getElementById(prefix + 'UseSpecific');
      var wf   = document.getElementById(prefix + 'WhatField');
      if (!body || !cb) return;
      body.style.display = cb.checked ? '' : 'none';
      if (wf) wf.style.opacity = cb.checked ? '0.4' : '1';
    }

    function selectGroupAll(prefix, resource, checked) {
      var cssClass = prefix + '-' + resource + '-chk';
      document.querySelectorAll('.' + cssClass).forEach(function(c) { c.checked = checked; });
      var hdrCb = document.getElementById(prefix + capitalize2(resource === 'conn' ? 'Conns' : resource + 's') + 'All');
      if (hdrCb) hdrCb.checked = checked;
    }

    function capitalize2(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

    function getCheckedNames(prefix, resource) {
      var cssClass = prefix + '-' + resource + '-chk';
      var checks = document.querySelectorAll('.' + cssClass + ':checked');
      var fromChecks = Array.from(checks).map(function(c) { return c.value; });
      var resKey = resource === 'conn' ? 'Conn' : capitalize2(resource);
      var textEl = document.getElementById(prefix + resKey + 'Names');
      var fromText = textEl ? textEl.value.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
      var combined = fromChecks.concat(fromText.filter(function(n) { return fromChecks.indexOf(n) < 0; }));
      return combined.join(',');
    }

    function getPickerContent(prefix) {
      if (!document.getElementById(prefix + 'UseSpecific').checked) return {};
      return {
        agents:      getCheckedNames(prefix, 'agent'),
        tools:       getCheckedNames(prefix, 'tool'),
        connections: getCheckedNames(prefix, 'conn'),
      };
    }

    function renderChecks(containerId, cssClass, items) {
      var el = document.getElementById(containerId);
      if (!el) return;
      var list = items || [];
      el.innerHTML = list.map(function(item) {
        var name, label;
        if (typeof item === 'object' && item !== null && 'name' in item) {
          name = item.name;
          label = (item.label != null && item.label !== '') ? item.label : name;
        } else {
          name = String(item);
          label = name;
        }
        var safeName = name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        var safeLabel = label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        return '<label class="obj-chip" title="' + safeName + '"><input type="checkbox" class="' + cssClass + '" value="' + safeName + '" checked> ' + safeLabel + '</label>';
      }).join('');
    }

    function wirePickerLoadBtn(prefix, getEnvFn) {
      var btn = document.getElementById('btn' + capitalize2(prefix) + 'LoadList');
      if (!btn) return;
      btn.addEventListener('click', function() {
        var statusEl = document.getElementById(prefix + 'LoadStatus');
        if (statusEl) statusEl.textContent = 'Loading…';
        vscode.postMessage({ command: 'loadObjectList', content: {
          env: getEnvFn(),
          tab: prefix,
        }});
      });
    }

    // Wire all picker checkboxes / All-None buttons for a given prefix
    // (replaces inline onclick/onchange which are blocked by VS Code webview CSP)
    function wirePicker(prefix) {
      var useCb = document.getElementById(prefix + 'UseSpecific');
      if (useCb) useCb.addEventListener('change', function() { onPickerToggle(prefix); });

      var resources = ['agent', 'tool', 'conn'];
      resources.forEach(function(res) {
        var cap = res === 'conn' ? 'Conns' : capitalize2(res) + 's';
        var hdrCb = document.getElementById(prefix + cap + 'All');
        if (hdrCb) hdrCb.addEventListener('change', function() { selectGroupAll(prefix, res, this.checked); });
        var btnAll  = document.getElementById(prefix + capitalize2(res) + 'BtnAll');
        var btnNone = document.getElementById(prefix + capitalize2(res) + 'BtnNone');
        if (btnAll)  btnAll.addEventListener('click',  function() { selectGroupAll(prefix, res, true); });
        if (btnNone) btnNone.addEventListener('click', function() { selectGroupAll(prefix, res, false); });
      });
    }

    wirePicker('export');
    wirePicker('import');
    wirePicker('rep');
    wirePicker('compare');

    wirePickerLoadBtn('export', function() { return document.getElementById('exportEnv').value; });
    wirePickerLoadBtn('import', function() { return document.getElementById('importEnv').value; });
    wirePickerLoadBtn('rep',    function() { return document.getElementById('repSource').value; });
    wirePickerLoadBtn('compare', function() { return document.getElementById('compareEnv1').value; });

    // ── Export ────────────────────────────────────────────────────────────────
    document.getElementById('btnExport').addEventListener('click', function() {
      vscode.postMessage({ command: 'runExport', content: Object.assign({
        env:  document.getElementById('exportEnv').value,
        what: document.getElementById('exportWhat').value,
      }, getPickerContent('export'))});
    });

    var btnRefreshExport = document.getElementById('btnRefreshExportReport');
    if (btnRefreshExport) btnRefreshExport.addEventListener('click', function() { vscode.postMessage({ command: 'getLatestExportReport' }); });
    var btnRefreshImport = document.getElementById('btnRefreshImportReport');
    if (btnRefreshImport) btnRefreshImport.addEventListener('click', function() { vscode.postMessage({ command: 'getLatestImportReport' }); });
    var btnRefreshCompare = document.getElementById('btnRefreshCompareReport');
    if (btnRefreshCompare) btnRefreshCompare.addEventListener('click', function() { vscode.postMessage({ command: 'getLatestCompareReport' }); });
    var btnRefreshReplicate = document.getElementById('btnRefreshReplicateReport');
    if (btnRefreshReplicate) btnRefreshReplicate.addEventListener('click', function() { vscode.postMessage({ command: 'getLatestReplicateReport' }); });

    vscode.postMessage({ command: 'getLatestExportReport' });
    vscode.postMessage({ command: 'getLatestImportReport' });
    vscode.postMessage({ command: 'getLatestCompareReport' });
    vscode.postMessage({ command: 'getLatestReplicateReport' });

    document.getElementById('btnInteractive').addEventListener('click', () =>
      vscode.postMessage({ command: 'runInteractive' }));

    // ── Import ────────────────────────────────────────────────────────────────
    document.getElementById('btnPickFolder').addEventListener('click', () =>
      vscode.postMessage({ command: 'pickFolder' }));

    document.getElementById('btnImport').addEventListener('click', function() {
      vscode.postMessage({ command: 'runImport', content: Object.assign({
        baseDir:   document.getElementById('importFolder').value.trim(),
        env:       document.getElementById('importEnv').value,
        what:      document.getElementById('importWhat').value,
        ifExists:  document.getElementById('importIfExists').value,
        connSource: (document.getElementById('importConnSource') || {}).value || '',
      }, getPickerContent('import'))});
    });

    // ── Compare ───────────────────────────────────────────────────────────────
    document.getElementById('btnCompare').addEventListener('click', function() {
      vscode.postMessage({ command: 'runCompare', content: Object.assign({
        env1: document.getElementById('compareEnv1').value,
        env2: document.getElementById('compareEnv2').value,
        what: document.getElementById('compareWhat').value,
      }, getPickerContent('compare'))});
    });

    // ── Replicate ─────────────────────────────────────────────────────────────
    document.getElementById('btnReplicate').addEventListener('click', function() {
      vscode.postMessage({ command: 'runReplicate', content: Object.assign({
        source: document.getElementById('repSource').value,
        target: document.getElementById('repTarget').value,
        what:   document.getElementById('repWhat').value,
        ifExists: (document.getElementById('repIfExists') || {}).value || 'override',
        connSource: (document.getElementById('repConnSource') || {}).value || '',
      }, getPickerContent('rep'))});
    });

    // ── Observability ────────────────────────────────────────────────────────
    function obsToISO(val) {
      if (!val || !val.trim()) return '';
      var d = new Date(val);
      return isNaN(d.getTime()) ? '' : d.toISOString();
    }
    function obsSetDefaultTimes() {
      var pad = function(n) { return String(n).padStart(2, '0'); };
      var now = new Date();
      var start = new Date(now.getTime() - 30 * 60 * 1000);
      document.getElementById('obsStartTime').value =
        start.getFullYear() + '-' + pad(start.getMonth() + 1) + '-' + pad(start.getDate()) +
        'T' + pad(start.getHours()) + ':' + pad(start.getMinutes());
      document.getElementById('obsEndTime').value =
        now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
        'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    }
    obsSetDefaultTimes();
    document.getElementById('btnObsSearch').addEventListener('click', function() {
      vscode.postMessage({ command: 'tracesSearch', content: {
        env:       document.getElementById('obsEnv').value.trim(),
        startTime: obsToISO(document.getElementById('obsStartTime').value),
        endTime:   obsToISO(document.getElementById('obsEndTime').value),
        agentName: document.getElementById('obsAgentName').value.trim(),
        limit:     parseInt(document.getElementById('obsLimit').value, 10) || 50,
      }});
    });
    document.getElementById('btnObsResetTimes').addEventListener('click', obsSetDefaultTimes);
    document.getElementById('btnObsExport').addEventListener('click', function() {
      vscode.postMessage({ command: 'tracesExport', content: {
        env:       document.getElementById('obsEnv').value.trim(),
        traceId:   document.getElementById('obsTraceId').value.trim(),
        outputFile: document.getElementById('obsOutputFile').value.trim(),
        agentName: document.getElementById('obsAgentName').value.trim() || undefined,
      }});
    });
    document.getElementById('linkObservabilityDocs').addEventListener('click', function(e) {
      e.preventDefault();
      vscode.postMessage({ command: 'openObservabilityDocs' });
    });

    // ── Dependencies ──────────────────────────────────────────────────────────
    document.getElementById('btnCheckDeps').addEventListener('click', () =>
      vscode.postMessage({ command: 'checkDeps' }));

    document.getElementById('btnOpenDocs').addEventListener('click', () =>
      vscode.postMessage({ command: 'openInstallDocs' }));

    // ── Help tab ──────────────────────────────────────────────────────────────
    document.getElementById('btnOpenUserGuide').addEventListener('click', () =>
      vscode.postMessage({ command: 'openUserGuide' }));
    document.getElementById('btnOpenInstall').addEventListener('click', () =>
      vscode.postMessage({ command: 'openInstallDocs' }));
    document.getElementById('linkInstall').addEventListener('click', function(e) {
      e.preventDefault();
      vscode.postMessage({ command: 'openInstallDocs' });
    });

    // ── Systems ───────────────────────────────────────────────────────────────
    console.log('[WxO Panel] Defining renderSystemsTable');
    function renderSystemsTable(envs, errorMsg, defaultConnSource) {
      console.log('[WxO Panel] renderSystemsTable called, envs:', envs ? envs.length : 'null', 'error:', errorMsg);
      var wrap = document.getElementById('systemsTable');
      if (errorMsg) {
        wrap.innerHTML = '<p class="err" style="font-size:12px;">' + esc(errorMsg) + '</p>';
        return;
      }
      if (!envs || envs.length === 0) {
        wrap.innerHTML = '<p class="hint" style="font-style:italic;">No systems found. Click <strong>Add System</strong> to add one.</p>';
        return;
      }
      var rows = envs.map(function(e) {
        var badge = e.active
          ? '<span style="background:var(--vscode-testing-iconPassed);color:#fff;border-radius:10px;padding:1px 8px;font-size:11px;margin-left:6px;">active</span>'
          : '';
        return '<tr style="border-bottom:1px solid var(--vscode-panel-border);">' +
          '<td style="padding:6px 8px;font-weight:600;white-space:nowrap;">' + esc(e.name) + badge + '</td>' +
          '<td style="padding:6px 8px;font-family:monospace;font-size:11px;opacity:0.75;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(e.url) + '">' + esc(e.url) + '</td>' +
          '<td style="padding:6px 8px;white-space:nowrap;">' +
            (e.active ? '' : '<button class="btn btn-secondary" style="padding:3px 10px;font-size:11px;" onclick="activateSystem(&#39;' + esc(e.name) + '&#39;)">Activate</button> ') +
            '<button class="btn btn-secondary" style="padding:3px 10px;font-size:11px;" onclick="editSystem(&#39;' + esc(e.name) + '&#39;)" title="Edit system (name, URL, API key)">Edit</button> ' +
            '<button class="btn btn-secondary" style="padding:3px 10px;font-size:11px;" onclick="editSystemCredentials(&#39;' + esc(e.name) + '&#39;)" title="Edit connection credentials (CONN_*)">Credentials</button> ' +
            '<button class="btn" style="padding:3px 10px;font-size:11px;background:var(--vscode-errorForeground);color:#fff;" onclick="removeSystem(&#39;' + esc(e.name) + '&#39;)">Remove</button>' +
          '</td></tr>';
      }).join('');
      wrap.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr>' +
          '<th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);">Name</th>' +
          '<th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);">URL</th>' +
          '<th style="padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);"></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
      // Populate secrets env selector too
      var sel = document.getElementById('secretsEnvSelect');
      var prev = sel.value;
      sel.innerHTML = '<option value="">— select environment —</option>' +
        envs.map(function(e) {
          return '<option value="' + esc(e.name) + '"' + (e.name === prev ? ' selected' : '') + '>' + esc(e.name) + '</option>';
        }).join('');
      // Populate Connection credential source selects (Import + Replicate)
      var importConn = document.getElementById('importConnSource');
      var repConn = document.getElementById('repConnSource');
      var defaultConn = (defaultConnSource || '').trim();
      if (importConn) {
        var prevImp = importConn.value || defaultConn;
        importConn.innerHTML = '<option value="">auto (from path)</option>' +
          envs.map(function(e) {
            return '<option value="' + esc(e.name) + '"' + (e.name === prevImp ? ' selected' : '') + '>' + esc(e.name) + '</option>';
          }).join('');
        if (!prevImp && defaultConn && envs.some(function(e){ return e.name === defaultConn; })) {
          importConn.value = defaultConn;
        }
      }
      if (repConn) {
        var prevRep = repConn.value;
        repConn.innerHTML = '<option value="">same as source</option>' +
          envs.map(function(e) {
            return '<option value="' + esc(e.name) + '"' + (e.name === prevRep ? ' selected' : '') + '>' + esc(e.name) + '</option>';
          }).join('');
      }
    }

    function activateSystem(name) {
      vscode.postMessage({ command: 'activateSystem', content: { name: name } });
    }
    function editSystem(name) {
      vscode.postMessage({ command: 'editSystem', content: { name: name } });
    }
    function editSystemCredentials(name) {
      vscode.postMessage({ command: 'editSystemCredentials', content: { name: name } });
    }
    function removeSystem(name) {
      vscode.postMessage({ command: 'removeSystem', content: { name: name } });
    }

    document.getElementById('btnAddSystem').addEventListener('click', function() {
      vscode.postMessage({ command: 'openAddSystem' });
    });

    document.getElementById('btnRefreshSystems').addEventListener('click', function() {
      vscode.postMessage({ command: 'loadSystems' });
    });
    document.getElementById('btnCopyToEnv').addEventListener('click', function() {
      vscode.postMessage({ command: 'copyCredentialsToEnv' });
    });

    // ── Secrets ───────────────────────────────────────────────────────────────
    console.log('[WxO Panel] Setting up secrets');
    var _secretsEnvName = '';

    function esc(s) {
      console.log('[WxO Panel] esc() called with:', typeof s, s && s.length > 50 ? s.substring(0,50)+'...' : s);
      var t = String(s || '');
      return t.replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/\x3e/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function secretRow(key, value, isComment, commentText, idx) {
      if (isComment) {
        return '<tr data-idx="' + idx + '" data-comment="1">' +
          '<td colspan="2" style="padding:3px 4px;">' +
            '<input type="text" value="' + esc(commentText || '') + '" ' +
              'style="width:100%;background:transparent;border:none;color:var(--vscode-descriptionForeground);font-family:monospace;font-size:11px;" ' +
              'onchange="updateSecretRow(' + idx + ',this)" />' +
          '</td>' +
          '<td><button style="background:none;border:none;cursor:pointer;color:var(--vscode-errorForeground);font-size:14px;" onclick="removeSecretRow(' + idx + ')">×</button></td>' +
          '</tr>';
      }
      return '<tr data-idx="' + idx + '">' +
        '<td style="padding:3px 4px;">' +
          '<input type="text" value="' + esc(key) + '" placeholder="KEY" ' +
            'style="width:100%;padding:3px 5px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;font-family:monospace;font-size:12px;" ' +
            'onchange="updateSecretKey(' + idx + ',this)" />' +
        '</td>' +
        '<td style="padding:3px 4px;">' +
          '<input type="text" value="' + esc(value) + '" placeholder="value" ' +
            'style="width:100%;padding:3px 5px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;font-family:monospace;font-size:12px;" ' +
            'onchange="updateSecretValue(' + idx + ',this)" />' +
        '</td>' +
        '<td><button style="background:none;border:none;cursor:pointer;color:var(--vscode-errorForeground);font-size:14px;" onclick="removeSecretRow(' + idx + ')">×</button></td>' +
        '</tr>';
    }

    var _secretEntries = [];

    function renderSecrets() {
      var tbody = document.getElementById('secretsRows');
      tbody.innerHTML = _secretEntries.map(function(e, i) {
        return secretRow(e.key, e.value, e.isComment, e.text, i);
      }).join('');
    }

    function updateSecretKey(idx, input) {
      if (_secretEntries[idx]) { _secretEntries[idx].key = input.value; }
    }
    function updateSecretValue(idx, input) {
      if (_secretEntries[idx]) { _secretEntries[idx].value = input.value; }
    }
    function updateSecretRow(idx, input) {
      if (_secretEntries[idx]) { _secretEntries[idx].text = input.value; }
    }
    function removeSecretRow(idx) {
      _secretEntries.splice(idx, 1);
      renderSecrets();
    }

    document.getElementById('secretsEnvSelect').addEventListener('change', function() {
      _secretsEnvName = this.value;
      if (_secretsEnvName) {
        vscode.postMessage({ command: 'loadSecrets', content: { envName: _secretsEnvName } });
      } else {
        document.getElementById('secretsTableWrap').style.display = 'none';
        document.getElementById('secretsEmpty').style.display = 'none';
        document.getElementById('secretsFilePath').textContent = '';
      }
    });

    document.getElementById('btnReloadSecrets').addEventListener('click', function() {
      if (_secretsEnvName) {
        vscode.postMessage({ command: 'loadSecrets', content: { envName: _secretsEnvName } });
      }
    });

    document.getElementById('btnAddSecret').addEventListener('click', function() {
      _secretEntries.push({ key: '', value: '', isComment: false });
      renderSecrets();
    });

    document.getElementById('btnSaveSecrets').addEventListener('click', function() {
      if (!_secretsEnvName) { setStatus('Select an environment first.', true); return; }
      // Sync current input values before saving
      var rows = document.querySelectorAll('#secretsRows tr');
      rows.forEach(function(row) {
        var idx = parseInt(row.dataset.idx);
        var inputs = row.querySelectorAll('input');
        if (!isNaN(idx) && _secretEntries[idx]) {
          if (row.dataset.comment === '1') {
            _secretEntries[idx].text = inputs[0] ? inputs[0].value : _secretEntries[idx].text;
          } else {
            if (inputs[0]) { _secretEntries[idx].key = inputs[0].value; }
            if (inputs[1]) { _secretEntries[idx].value = inputs[1].value; }
          }
        }
      });
      vscode.postMessage({ command: 'saveSecrets', content: { envName: _secretsEnvName, entries: _secretEntries } });
    });

    // Auto-load systems when Systems, Import, or Replicate tab is first shown (for env dropdowns)
    var _systemsLoaded = false;
    document.querySelectorAll('.tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var t = btn.dataset.tab || '';
        if ((t === 'systems' || t === 'import' || t === 'replicate') && !_systemsLoaded) {
          _systemsLoaded = true;
          vscode.postMessage({ command: 'loadSystems' });
        }
      });
    });

    // ── Output panel ──────────────────────────────────────────────────────────
    (function() {
      var panel  = document.getElementById('outputPanel');
      var body   = document.getElementById('outputBody');
      var label  = document.getElementById('outputLabel');
      var spinner = document.getElementById('outputSpinner');

      document.getElementById('btnClearOutput').addEventListener('click', function() {
        body.innerHTML = '';
      });
      document.getElementById('btnCloseOutput').addEventListener('click', function() {
        panel.classList.remove('visible');
      });

      // Drag-to-resize: drag the top handle up/down to change panel height
      var resizeHandle = document.getElementById('outputResizeHandle');
      var startY = 0, startH = 0;
      resizeHandle.addEventListener('mousedown', function(e) {
        startY = e.clientY;
        startH = panel.offsetHeight;
        var onMove = function(ev) {
          var delta = startY - ev.clientY;  // drag up = bigger
          var newH = Math.max(60, Math.min(startH + delta, window.innerHeight * 0.7));
          panel.style.height = newH + 'px';
        };
        var onUp = function() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      });

      // Classify a line of text for styling
      function classifyLine(text, isError) {
        if (isError || /\b(error|err|fail|failed|fatal)\b/i.test(text)) return 'err';
        if (/[✓✔]|\b(ok|done|success|passed|imported|exported)\b/i.test(text)) return 'ok';
        if (/[═─]{3,}/.test(text)) return 'sep';
        if (/^[A-Z ]{4,}$/.test(text.trim())) return 'hdr';
        return '';
      }

      // Expose handler so the message listener below can call it
      window._handleScriptOutput = function(m) {
        if (m.clear) {
          body.innerHTML = '';
          label.textContent = m.label || 'Output';
          spinner.classList.add('running');
          panel.classList.add('visible');
          if (!panel.style.height) panel.style.height = '220px';
        }
        if (m.line !== undefined) {
          var div = document.createElement('div');
          div.className = 'output-line ' + classifyLine(m.line, !!m.isError);
          div.textContent = m.line;
          body.appendChild(div);
          body.scrollTop = body.scrollHeight;
        }
        if (m.done) {
          spinner.classList.remove('running');
          var exitDiv = document.createElement('div');
          exitDiv.className = m.exitCode === 0 ? 'output-exit-ok' : 'output-exit-err';
          exitDiv.textContent = m.exitCode === 0
            ? '✓ Completed successfully (exit 0)'
            : '✗ Finished with errors (exit ' + m.exitCode + ')';
          body.appendChild(exitDiv);
          if (m.reportPath) {
            var linkDiv = document.createElement('div');
            linkDiv.className = 'output-report-link';
            var a = document.createElement('a');
            a.href = '#';
            a.textContent = '📄 Open Report';
            a.onclick = function(ev) {
              ev.preventDefault();
              if (typeof vscode !== 'undefined') vscode.postMessage({ command: 'openReport', path: m.reportPath });
            };
            linkDiv.appendChild(a);
            body.appendChild(linkDiv);
            if (m.operation === 'export') updateExportReportLink(m.reportPath);
            else if (m.operation === 'import') updateImportReportLink(m.reportPath);
            else if (m.operation === 'compare') updateCompareReportLink(m.reportPath);
            else if (m.operation === 'replicate') updateReplicateReportLink(m.reportPath);
            else if (m.operation === 'observability') updateObsExportLink(m.reportPath);
          }
          body.scrollTop = body.scrollHeight;
        }
      };
    })();

    // ── Messages from extension ───────────────────────────────────────────────
    console.log('[WxO Panel] Registering message listener');
    if (_debug) vscode.postMessage({ command: 'debugLog', message: '[Panel] Message listener registered' });
    window.addEventListener('message', e => {
      const m = e.data;
      console.log('[WxO Panel] Message received:', m.command);
      if (m.command === 'scriptOutput') {
        if (typeof window._handleScriptOutput === 'function') window._handleScriptOutput(m);
      } else if (m.command === 'operationStatus') {
        setStatus(m.message || '', !!m.isError);
      } else if (m.command === 'depCheckResult') {
        document.getElementById('depResults').innerHTML =
          (m.checks || []).map(c =>
            '<div class="' + (c.ok ? 'ok' : 'err') + '">' +
            (c.ok ? '✓' : '✗') + ' <strong>' + esc(c.name) + '</strong>: ' + esc(c.msg) +
            '</div>'
          ).join('');
      } else if (m.command === 'latestExportReport') {
        updateExportReportLink(m.path);
      } else if (m.command === 'latestImportReport') {
        updateImportReportLink(m.path);
      } else if (m.command === 'latestCompareReport') {
        updateCompareReportLink(m.path);
      } else if (m.command === 'latestReplicateReport') {
        updateReplicateReportLink(m.path);
      } else if (m.command === 'folderPicked') {
        var p = m.path || '';
        document.getElementById('importFolder').value = p;
        var importConnEl = document.getElementById('importConnSource');
        if (importConnEl && p) {
          var pathSep = '[\\\\/]';
          var exMatch = p.match(new RegExp(pathSep + 'Exports' + pathSep + '([^\\\\/]+)(?:' + pathSep + '|$)'));
          var repMatch = p.match(new RegExp(pathSep + 'Replicate' + pathSep + '([^\\\\/]+)_to_[^\\\\/]+(?:' + pathSep + '|$)'));
          var sys = (exMatch && exMatch[1]) || (repMatch && repMatch[1]) || null;
          if (sys && Array.from(importConnEl.options).some(function(o){ return o.value === sys; })) {
            importConnEl.value = sys;
          }
        }
      } else if (m.command === 'systemsLoaded') {
        _systemsLoaded = true;
        renderSystemsTable(m.envs, m.error, m.defaultConnSource);
      } else if (m.command === 'objectListLoading') {
        var st = document.getElementById(m.tab + 'LoadStatus');
        if (st) st.textContent = 'Loading…';
      } else if (m.command === 'objectListError') {
        var st2 = document.getElementById(m.tab + 'LoadStatus');
        if (st2) st2.textContent = '⚠ ' + (m.message || 'Error loading objects');
      } else if (m.command === 'objectListLoaded') {
        var p2 = m.tab;
        var agents2  = m.agents  || [];
        var tools2   = m.tools   || [];
        var conns2   = m.connections || [];
        // Render chips
        renderChecks(p2 + 'AgentChecks', p2 + '-agent-chk', agents2);
        renderChecks(p2 + 'ToolChecks',  p2 + '-tool-chk',  tools2);
        renderChecks(p2 + 'ConnChecks',  p2 + '-conn-chk',  conns2);
        // Update count badges
        var ac = document.getElementById(p2 + 'AgentCount'); if (ac) ac.textContent = agents2.length ? '(' + agents2.length + ')' : '';
        var tc = document.getElementById(p2 + 'ToolCount');  if (tc) tc.textContent = tools2.length  ? '(' + tools2.length  + ')' : '';
        var cc = document.getElementById(p2 + 'ConnCount');  if (cc) cc.textContent = conns2.length  ? '(' + conns2.length  + ')' : '';
        // Status
        var st3 = document.getElementById(p2 + 'LoadStatus');
        var total = agents2.length + tools2.length + conns2.length;
        if (st3) st3.textContent = total ? '✓ Loaded ' + total + ' objects' : 'No objects found';
      } else if (m.command === 'traceSearchResults') {
        var section = document.getElementById('obsResultsSection');
        var summary = document.getElementById('obsResultsSummary');
        var body = document.getElementById('obsResultsBody');
        var rawEl = document.getElementById('obsResultsRaw');
        var tableWrap = document.getElementById('obsResultsTableWrap');
        var obsSearchEnv = m.env || 'TZ1';
        if (section && summary && body) {
          section.style.display = '';
          summary.textContent = m.summary || '';
          var traces = m.traces || [];
          if (rawEl) {
            rawEl.style.display = (traces.length === 0 && m.raw) ? '' : 'none';
            rawEl.textContent = m.raw || '';
          }
          if (tableWrap) tableWrap.style.display = traces.length > 0 ? '' : 'none';
          body.innerHTML = traces.map(function(t) {
            var tid = t.traceId || '';
            var tidEsc = tid.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
            var start = esc(t.startTime || '—');
            var dur = esc(t.duration || '—');
            var spans = esc(t.spans || '—');
            var agent = esc(t.agentName || '—');
            var user = esc(t.userId || '—');
            return '<tr style="border-bottom:1px solid var(--vscode-panel-border);">' +
              '<td style="padding:6px 8px;font-family:monospace;font-size:11px;">' +
              '<a href="#" class="trace-id-link" data-trace-id="' + tidEsc + '" data-env="' + esc(obsSearchEnv) + '" data-agent="' + esc(t.agentName || '') + '" title="Download trace">' + tidEsc + '</a>' +
              '</td>' +
              '<td style="padding:6px 8px;">' + start + '</td>' +
              '<td style="padding:6px 8px;">' + dur + '</td>' +
              '<td style="padding:6px 8px;">' + spans + '</td>' +
              '<td style="padding:6px 8px;">' + agent + '</td>' +
              '<td style="padding:6px 8px;max-width:120px;overflow:hidden;text-overflow:ellipsis;" title="' + esc(t.userId || '') + '">' + user + '</td>' +
              '<td style="padding:6px 8px;"><button class="btn btn-secondary" style="padding:2px 8px;font-size:11px;" data-trace-id="' + tidEsc + '">Export</button></td>' +
              '</tr>';
          }).join('');
          body.querySelectorAll('button[data-trace-id]').forEach(function(btn) {
            btn.addEventListener('click', function() {
              var row = this.closest('tr');
              var id = btn.getAttribute('data-trace-id');
              var agentCell = row ? row.cells[4] : null;
              var agent = (agentCell ? agentCell.textContent || '' : '').trim();
              if (agent === '—') agent = '';
              if (id) {
                document.getElementById('obsTraceId').value = id;
                document.getElementById('obsAgentName').value = agent;
                document.getElementById('obsTraceId').focus();
              }
            });
          });
          body.querySelectorAll('a.trace-id-link').forEach(function(a) {
            a.addEventListener('click', function(ev) {
              ev.preventDefault();
              var id = this.getAttribute('data-trace-id');
              var env = this.getAttribute('data-env');
              var agent = this.getAttribute('data-agent') || '';
              if (id && env && typeof vscode !== 'undefined') {
                vscode.postMessage({ command: 'exportTraceById', content: { traceId: id, env: env, agentName: agent } });
              }
            });
          });
        }
      } else if (m.command === 'secretsLoaded') {
        _secretsEnvName = m.envName || '';
        _secretEntries = (m.entries || []).map(function(e) {
          return { key: e.key || '', value: e.value || '', isComment: !!e.isComment, text: e.text || '' };
        });
        var pathEl = document.getElementById('secretsFilePath');
        pathEl.textContent = m.filePath ? m.filePath : '';
        var wrap = document.getElementById('secretsTableWrap');
        var empty = document.getElementById('secretsEmpty');
        if (_secretEntries.length > 0) {
          wrap.style.display = '';
          empty.style.display = 'none';
        } else {
          wrap.style.display = '';
          empty.style.display = '';
        }
        renderSecrets();
      }
    });
    console.log('[WxO Panel] All event listeners registered. Script complete.');
  </script>
</body>
</html>`;
    }
}
