/**
 * WxO Importer/Exporter — Environment Service
 * Wraps orchestrate CLI commands for env listing, activation, and resource listing.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 27 Feb 2026
 * @license Apache-2.0
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getEffectiveEnv } from '../utils/wxoEnv.js';
import { getCredentialsService } from './credentialsContext.js';

const execAsync = promisify(exec);

/** Resource metadata from orchestrate list (name, optional display_name, kind). */
export interface WxOResource {
    name: string;
    /** Human-readable label; prefer over name for display when available. */
    display_name?: string;
    kind?: string;
}

/** Connection status for grouping (live, draft, inactive). */
export type ConnectionStatus = 'active-live' | 'active-draft' | 'inactive';

/** Connection metadata from orchestrate connections list. */
export interface WxOConnection {
    name: string;
    status: ConnectionStatus;
    environment: string;
    credentialsEntered: boolean;
}

/** Connections grouped by status (active-live, active-draft, inactive). */
export interface WxOConnectionGroups {
    activeLive: WxOConnection[];
    activeDraft: WxOConnection[];
    inactive: WxOConnection[];
}

/** Toolkit (MCP server) with nested tools. */
export interface WxOToolkit {
    name: string;
    description?: string;
    tools: { name: string; fullName: string }[];
}

/** Service wrapping orchestrate CLI for environments, agents, tools, flows, connections. */
export class WxOEnvironmentService {

    /** Root folder for WxO (Exports, Replicate, Compare, Systems, Tools). */
    getWxORoot(): string {
        const cfg = vscode.workspace.getConfiguration('WxO-ToolBox-vsc');
        const custom = cfg.get<string>('wxoRoot')?.trim();
        const ws = (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) ?? process.cwd();
        if (custom) {
            return path.isAbsolute(custom) ? custom : path.join(ws, custom);
        }
        return path.join(ws, 'WxO');
    }

    /** Execute a shell command and return stdout. Uses getEffectiveEnv() so orchestrate in a Python venv is found. */
    private async run(cmd: string): Promise<string> {
        const opts = {
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh',
            env: getEffectiveEnv(),
            timeout: 30_000,
        };
        const { stdout } = await execAsync(cmd, opts);
        return stdout;
    }

    /** List environment names from `orchestrate env list`. */
    async listEnvironments(): Promise<string[]> {
        const out = await this.run('orchestrate env list 2>/dev/null');
        return out
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !/^[-=]+$/.test(l) && !/^Name\b/i.test(l))
            .map(l => l.split(/\s+/)[0])
            .filter(n => !!n);
    }

    /** Activate an environment. Uses SecretStorage first, then WXO_API_KEY_<ENV> from .env. */
    async activateEnvironment(envName: string): Promise<void> {
        const creds = getCredentialsService();
        let apiKey: string | undefined = creds ? await creds.getApiKey(envName) : undefined;

        if (!apiKey) {
            const envFile = this.findEnvFile();
            if (envFile) apiKey = this.parseEnvFile(envFile)[`WXO_API_KEY_${envName}`];
        }

        if (apiKey) {
            await this.run(
                `orchestrate env activate "${envName}" --api-key "${apiKey}" 2>/dev/null`,
            );
        } else {
            await this.run(`orchestrate env activate "${envName}" 2>/dev/null`);
        }
    }

    async listAgents(): Promise<WxOResource[]> {
        const out = await this.run('orchestrate agents list -v 2>/dev/null');
        const data = this.parseJson(out);
        const arr: unknown[] = Array.isArray(data)
            ? data
            : ((data as any)?.native ?? (data as any)?.agents ?? (data as any)?.data ?? (data as any)?.items ?? []);
        return arr.filter(isObj).map((x: any) => ({
            name: x.name ?? x.id ?? '?',
            display_name: x.display_name ?? x.displayName ?? undefined,
        }));
    }

    async listTools(): Promise<WxOResource[]> {
        const out = await this.run('orchestrate tools list -v 2>/dev/null');
        const data = this.parseJson(out);
        const arr: unknown[] = toArray(data);
        // Exclude flows, plugins, and toolkit tools — those appear in their own categories
        return arr.filter(isObj).filter(x => !isFlow(x) && !isPlugin(x) && !isToolkitTool(x)).map((x: any) => ({
            name: x.name ?? x.id ?? '?',
            display_name: extractOpenApiInfoTitle(x) ?? x.title ?? x.display_name ?? x.displayName ?? undefined,
            kind: toolKind(x),
        }));
    }

    /** List toolkits (MCP servers) with nested tools. Uses orchestrate toolkits list -v and tools list -v. */
    async listToolkits(): Promise<WxOToolkit[]> {
        const [toolkitsOut, toolsOut] = await Promise.all([
            this.run('orchestrate toolkits list -v 2>/dev/null'),
            this.run('orchestrate tools list -v 2>/dev/null'),
        ]);
        const toolkitsData = this.parseJson(toolkitsOut);
        const toolsData = this.parseJson(toolsOut);
        const toolkitsArr: unknown[] = Array.isArray(toolkitsData) ? toolkitsData : [];
        const toolsArr: unknown[] = toArray(toolsData);
        const toolsById = new Map<string, any>();
        for (const t of toolsArr.filter(isObj)) {
            const id = (t as any).id ?? (t as any).name;
            if (id) toolsById.set(id, t);
        }
        const result: WxOToolkit[] = [];
        for (const tk of toolkitsArr.filter(isObj)) {
            const name = (tk as any).name ?? (tk as any).id ?? '?';
            const description = (tk as any).description;
            const toolIds: string[] = (tk as any).tools ?? [];
            const tools: { name: string; fullName: string }[] = [];
            for (const id of toolIds) {
                const t = toolsById.get(id);
                if (!t) continue;
                const fullName = t.name ?? t.id ?? '';
                if (typeof fullName !== 'string' || !fullName.includes(':')) continue;
                const shortName = fullName.split(':').slice(1).join(':');
                tools.push({ name: shortName, fullName });
            }
            result.push({ name, description, tools });
        }
        return result;
    }

    /** List plugin tools (binding.python.type = agent_pre_invoke / agent_post_invoke). */
    async listPlugins(): Promise<WxOResource[]> {
        const out = await this.run('orchestrate tools list -v 2>/dev/null');
        const data = this.parseJson(out);
        const arr: unknown[] = toArray(data);
        return arr.filter(isObj).filter(isPlugin).map((x: any) => ({
            name: x.name ?? x.id ?? '?',
            display_name: x.title ?? x.display_name ?? x.displayName ?? undefined,
            kind: pluginKind(x),
        }));
    }

    async listFlows(): Promise<WxOResource[]> {
        const out = await this.run('orchestrate tools list -v 2>/dev/null');
        const data = this.parseJson(out);
        const arr: unknown[] = toArray(data);
        return arr.filter(isObj).filter(isFlow).map((x: any) => ({
            name: x.name ?? x.id ?? '?',
            display_name: x.title ?? x.display_name ?? x.displayName ?? undefined,
            kind: 'flow',
        }));
    }

    async listConnections(): Promise<WxOResource[]> {
        const groups = await this.listConnectionsGrouped();
        return [
            ...groups.activeLive,
            ...groups.activeDraft,
            ...groups.inactive,
        ].map(c => ({ name: c.name }));
    }

    /**
     * Fetch all connections and group them by status:
     *   Active / Live    — credentials_entered=true  AND environment="live"
     *   Active / Draft   — credentials_entered=true  AND environment≠"live"
     *   Not Active       — credentials_entered=false (any environment)
     *
     * Tries `orchestrate connections list -v` (all envs), falls back to
     * `--env live` + `--env draft` individually if the first returns nothing.
     */
    async listConnectionsGrouped(): Promise<WxOConnectionGroups> {
        const raw = await this._fetchAllConnections();
        const groups: WxOConnectionGroups = { activeLive: [], activeDraft: [], inactive: [] };

        for (const x of raw) {
            const name = (x as any).app_id ?? (x as any).appId ?? (x as any).id ?? (x as any).name ?? '?';
            const env: string = ((x as any).environment ?? '').toLowerCase();
            const creds: boolean = !!(x as any).credentials_entered;

            const conn: WxOConnection = {
                name,
                environment: env || 'unknown',
                credentialsEntered: creds,
                status: !creds ? 'inactive' : env === 'live' ? 'active-live' : 'active-draft',
            };

            if (conn.status === 'active-live') { groups.activeLive.push(conn); }
            else if (conn.status === 'active-draft') { groups.activeDraft.push(conn); }
            else { groups.inactive.push(conn); }
        }

        return groups;
    }

    private async _fetchAllConnections(): Promise<unknown[]> {
        // Try without env filter first to get all connections
        try {
            const out = await this.run('orchestrate connections list -v 2>/dev/null');
            const data = this.parseJson(out);
            const arr = toConnArray(data);
            if (arr.length > 0) { return arr; }
        } catch { /* fall through */ }

        // Fall back: fetch live + draft separately and merge
        const results: unknown[] = [];
        for (const envFlag of ['--env live', '--env draft']) {
            try {
                const out = await this.run(`orchestrate connections list -v ${envFlag} 2>/dev/null`);
                const data = this.parseJson(out);
                results.push(...toConnArray(data));
            } catch { /* skip */ }
        }
        return results;
    }

    /**
     * Export agent to YAML and return the file contents.
     * Tries native → external → assistant until one succeeds.
     * Returns full YAML with tools as names (not UUIDs), suitable for the edit form.
     */
    async fetchAgentYaml(name: string): Promise<string> {
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `wxo-agent-${Date.now()}-${name.replace(/\W/g, '_')}.yaml`);
        for (const kind of ['native', 'external', 'assistant']) {
            try {
                await this.run(
                    `orchestrate agents export -n "${name}" -k ${kind} --agent-only -o "${tmpFile}" 2>/dev/null`,
                );
                if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) {
                    const yaml = fs.readFileSync(tmpFile, 'utf8');
                    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
                    return yaml;
                }
            } catch { /* try next kind */ }
        }
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        throw new Error(`Could not export agent "${name}" as native, external, or assistant.`);
    }

    /**
     * Fetch the full JSON definition of a single resource.
     * Runs the appropriate `list -v` command and extracts the matching object.
     */
    async fetchResourceJson(
        resourceType: 'agents' | 'tools' | 'flows' | 'connections' | 'plugins',
        name: string,
    ): Promise<unknown> {
        let raw: string;
        let arr: unknown[];

        if (resourceType === 'agents') {
            raw = await this.run('orchestrate agents list -v 2>/dev/null');
            const data = this.parseJson(raw);
            arr = Array.isArray(data)
                ? data
                : ((data as any)?.native ?? (data as any)?.agents ?? (data as any)?.data ?? []);
            const match = arr.find((x: any) => (x?.name ?? x?.id) === name);
            if (match) { return match; }

        } else if (resourceType === 'tools' || resourceType === 'flows' || resourceType === 'plugins') {
            raw = await this.run('orchestrate tools list -v 2>/dev/null');
            const data = this.parseJson(raw);
            arr = toArray(data);
            const match = arr.find((x: any) => (x?.name ?? x?.id) === name);
            if (match) { return match; }

        } else if (resourceType === 'connections') {
            // Try without env filter first, then with --env live / --env draft
            for (const flag of ['', '--env live', '--env draft']) {
                try {
                    raw = await this.run(`orchestrate connections list -v ${flag} 2>/dev/null`.trim());
                    const data = this.parseJson(raw);
                    arr = toConnArray(data);
                    const match = arr.find((x: any) =>
                        (x?.app_id ?? x?.appId ?? x?.id ?? x?.name) === name,
                    );
                    if (match) { return match; }
                } catch { /* continue */ }
            }
        }

        throw new Error(`Definition for "${name}" not found.`);
    }

    /**
     * Delete a single resource from the active environment.
     * Agents: tries native → external → assistant kinds.
     * Tools/Flows/Plugins: orchestrate tools remove.
     * Connections: orchestrate connections remove.
     */
    async deleteResource(
        resourceType: 'agents' | 'tools' | 'flows' | 'connections' | 'plugins',
        name: string,
    ): Promise<void> {
        if (resourceType === 'agents') {
            for (const kind of ['native', 'external', 'assistant']) {
                try {
                    await this.run(`orchestrate agents remove -n "${name}" -k ${kind} 2>/dev/null`);
                    return;
                } catch { /* try next kind */ }
            }
            throw new Error(`Could not remove agent "${name}" as native, external, or assistant.`);
        } else if (resourceType === 'tools' || resourceType === 'flows' || resourceType === 'plugins') {
            await this.run(`orchestrate tools remove -n "${name}" 2>/dev/null`);
        } else if (resourceType === 'connections') {
            await this.run(`orchestrate connections remove -a "${name}" 2>/dev/null`);
        }
    }

    /**
     * Temporarily activate another environment, fetch a resource's JSON,
     * then re-activate the original environment.
     */
    /**
     * Update a resource from edited JSON.
     * Supports flow tools/flows: writes JSON to temp file and runs
     * `orchestrate tools import -k flow -f <file>` (updates if tool exists).
     * Agents and connections require YAML/source files—use the Import panel.
     */
    async updateResourceFromJson(
        resourceType: 'agents' | 'tools' | 'flows' | 'connections',
        name: string,
        json: unknown,
    ): Promise<void> {
        const obj = json as Record<string, unknown>;
        const binding = obj?.binding as Record<string, unknown> | undefined;
        const spec = obj?.spec as Record<string, unknown> | undefined;
        const isFlowDef = !!(binding?.flow || binding?.langflow ||
            spec?.kind === 'flow' || obj?.kind === 'flow');

        if ((resourceType === 'tools' || resourceType === 'flows') && isFlowDef) {
            const tmpDir = os.tmpdir();
            const tmpFile = path.join(tmpDir, `wxo-flow-${Date.now()}.json`);
            try {
                fs.writeFileSync(tmpFile, JSON.stringify(json), 'utf8');
                await this.run(
                    `orchestrate tools import -k flow -f "${tmpFile}" 2>&1`,
                );
            } finally {
                try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
            }
            return;
        }

        throw new Error(
            'Update from JSON is supported for flow tools only. ' +
            'For Python/OpenAPI tools, agents, or connections, use the Import panel with the source files.',
        );
    }

    /**
     * Detect tool type and build import command for a folder.
     * Returns { kind, name, cmd } or null if folder is not a valid tool.
     */
    detectToolInFolder(folderPath: string): { kind: 'python' | 'openapi' | 'flow'; name: string; cmd: string } | null {
        const name = path.basename(folderPath);
        const pyFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.py'));
        const hasReq = fs.existsSync(path.join(folderPath, 'requirements.txt'));
        if (pyFiles.length > 0 && hasReq) {
            const pyFile = pyFiles[0];
            return {
                kind: 'python',
                name,
                cmd: `(cd "${folderPath}" && orchestrate tools import -k python -p . -f "${pyFile}" -r requirements.txt 2>&1)`,
            };
        }
        for (const spec of ['skill_v2.json', 'openapi.json']) {
            const specPath = path.join(folderPath, spec);
            if (fs.existsSync(specPath)) {
                return {
                    kind: 'openapi',
                    name,
                    cmd: `(cd "${folderPath}" && orchestrate tools import -k openapi -f "${spec}" 2>&1)`,
                };
            }
        }
        const jsonFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.json') && f !== 'tool-spec.json');
        for (const jf of jsonFiles) {
            try {
                const content = fs.readFileSync(path.join(folderPath, jf), 'utf8');
                const data = JSON.parse(content);
                if ((data?.spec?.kind === 'flow') || (data?.kind === 'flow')) {
                    return {
                        kind: 'flow',
                        name,
                        cmd: `(cd "${folderPath}" && orchestrate tools import -k flow -f "${jf}" 2>&1)`,
                    };
                }
            } catch { /* skip */ }
        }
        return null;
    }

    /** Returns the persistent edit directory for a named resource: {wxoRoot}/Edits/{name}/ */
    getEditDir(name: string): string {
        return path.join(this.getWxORoot(), 'Edits', name);
    }

    /**
     * Export a tool/plugin to {wxoRoot}/Edits/{name}/ using orchestrate tools export.
     * Files remain on disk after editing (visible in the WxO Project Dir tree).
     * Returns the folder that contains the source files (.py, requirements.txt, etc.).
     */
    async exportToEditDir(name: string): Promise<string> {
        const editDir = this.getEditDir(name);
        fs.mkdirSync(editDir, { recursive: true });
        const zipPath = path.join(editDir, `${name}.zip`);

        // Capture stderr for a useful error message
        const exportOut = await this.run(`orchestrate tools export -n "${name}" -o "${zipPath}" 2>&1`);
        if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
            const hint = exportOut?.trim() ?? '';
            throw new Error(`Export produced no file for "${name}".${hint ? ` CLI output: ${hint}` : ''}`);
        }

        // unzip exit code 1 = warnings (stripped absolute paths) — still extracts fine
        try { await this.run(`unzip -o -q "${zipPath}" -d "${editDir}"`); } catch { /* warnings ok */ }

        // If the zip unpacked into a single named subdirectory, prefer that
        const entries = fs.readdirSync(editDir, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory()) {
                const sub = path.join(editDir, e.name);
                if (this.loadToolFromFolder(sub)) return sub;
            }
        }
        return editDir;
    }

    /** @deprecated Use exportToEditDir — kept for compatibility */
    async exportToolToTempFolder(toolName: string): Promise<string> {
        return this.exportToEditDir(toolName);
    }

    /**
     * Load tool data from a folder for the Create Tool form.
     * Returns parsed Python or OpenAPI tool data, or null if not a valid tool folder.
     */
    loadToolFromFolder(folderPath: string):
        | { kind: 'python'; folderPath: string; name: string; displayName: string; description: string; params: Array<{ name: string; type: string; description: string }>; pyContent: string; pyFilePath: string; toolSpec: Record<string, unknown>; requirements?: string }
        | { kind: 'openapi'; folderPath: string; name: string; displayName: string; spec: Record<string, unknown> }
        | null {
        const name = path.basename(folderPath);
        const pyFiles = fs.readdirSync(folderPath).filter((f: string) => f.endsWith('.py'));
        const reqPath = path.join(folderPath, 'requirements.txt');
        const hasReq = fs.existsSync(reqPath);
        const toolSpecPath = path.join(folderPath, 'tool-spec.json');

        if (pyFiles.length > 0 && hasReq) {
            const pyFile = pyFiles[0];
            const pyFilePath = path.join(folderPath, pyFile);
            const pyContent = fs.readFileSync(pyFilePath, 'utf8');
            const requirements = fs.readFileSync(reqPath, 'utf8');
            let toolSpec: Record<string, unknown> = {};
            let displayName = name;
            let description = '';
            const params: Array<{ name: string; type: string; description: string }> = [];

            if (fs.existsSync(toolSpecPath)) {
                toolSpec = JSON.parse(fs.readFileSync(toolSpecPath, 'utf8')) as Record<string, unknown>;
                displayName = (toolSpec.display_name as string) ?? name;
                description = (toolSpec.description as string) ?? '';
                const props = (toolSpec.input_schema as Record<string, unknown>)?.properties as Record<string, { type?: string; description?: string }> | undefined;
                if (props) {
                    for (const [pName, pDef] of Object.entries(props)) {
                        params.push({
                            name: pName,
                            type: (pDef?.type as string) ?? 'string',
                            description: (pDef?.description as string) ?? pName,
                        });
                    }
                }
            }
            if (params.length === 0) {
                params.push({ name: 'input_text', type: 'string', description: 'Input string' });
            }
            return {
                kind: 'python',
                folderPath,
                name,
                displayName,
                description,
                params,
                pyContent,
                pyFilePath,
                toolSpec,
                requirements,
            };
        }

        for (const spec of ['skill_v2.json', 'openapi.json']) {
            const specPath = path.join(folderPath, spec);
            if (fs.existsSync(specPath)) {
                const specObj = JSON.parse(fs.readFileSync(specPath, 'utf8')) as Record<string, unknown>;
                const info = (specObj.info as Record<string, unknown>) ?? {};
                const displayName = (info['x-ibm-skill-name'] as string) ?? (info.title as string) ?? name;
                return {
                    kind: 'openapi',
                    folderPath,
                    name,
                    displayName,
                    spec: specObj,
                };
            }
        }
        return null;
    }

    async fetchResourceJsonFromEnv(
        compareEnv: string,
        originalEnv: string,
        resourceType: 'agents' | 'tools' | 'flows' | 'connections' | 'plugins',
        name: string,
    ): Promise<unknown> {
        await this.activateEnvironment(compareEnv);
        try {
            return await this.fetchResourceJson(resourceType, name);
        } finally {
            // Always restore the original environment
            try { await this.activateEnvironment(originalEnv); } catch { /* best-effort */ }
        }
    }

    /** Find .env file in workspace folders. */
    findEnvFile(): string | undefined {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const candidates = folders.flatMap(f => [
            path.join(f.uri.fsPath, '.env'),
            path.join(f.uri.fsPath, 'internal', 'WxOImporterAndExporter', '.env'),
        ]);
        return candidates.find(p => fs.existsSync(p));
    }

    parseEnvFile(filePath: string): Record<string, string> {
        const vars: Record<string, string> = {};
        for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#')) { continue; }
            const eq = t.indexOf('=');
            if (eq < 0) { continue; }
            vars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
        }
        return vars;
    }

    private parseJson(text: string): unknown {
        // Strip leading non-JSON lines (e.g. "[INFO] ..." from the CLI)
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].trim();
            if (t.startsWith('[') || t.startsWith('{')) {
                return JSON.parse(lines.slice(i).join('\n'));
            }
        }
        return JSON.parse(text);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isObj(x: unknown): boolean {
    return !!x && typeof x === 'object' && !Array.isArray(x);
}

function toArray(data: unknown): unknown[] {
    if (Array.isArray(data)) { return data; }
    if (isObj(data)) {
        const d = data as any;
        return d.tools ?? d.native ?? d.data ?? d.items ?? [];
    }
    return [];
}

function toConnArray(data: unknown): unknown[] {
    if (Array.isArray(data)) { return data; }
    if (isObj(data)) {
        const d = data as any;
        return d.live ?? d.draft ?? d.connections ?? d.data ?? d.items ?? [];
    }
    return [];
}

function isFlow(x: unknown): boolean {
    const o = x as any;
    return !!(o?.binding?.flow || o?.binding?.langflow ||
              o?.spec?.kind === 'flow' || o?.kind === 'flow');
}

/** True if tool name is toolkit:tool format (MCP toolkit tool). */
function isToolkitTool(x: unknown): boolean {
    const name = (x as any)?.name ?? (x as any)?.id;
    return typeof name === 'string' && name.includes(':');
}

export function isPlugin(x: unknown): boolean {
    const py = (x as any)?.binding?.python;
    if (!py) { return false; }
    const type = (py.type || '').toLowerCase();
    if (type === 'agent_pre_invoke' || type === 'agent_post_invoke') { return true; }
    // Fallback: older ADK naming in kind / tool_kind
    const kind = (py.kind || py.tool_kind || '').toLowerCase();
    return kind.includes('agentpreinvoke') || kind.includes('agentpostinvoke');
}

/** Returns 'pre-invoke' | 'post-invoke' for a plugin tool. */
export function pluginKind(x: unknown): 'pre-invoke' | 'post-invoke' {
    const py = (x as any)?.binding?.python ?? {};
    const type = (py.type || '').toLowerCase();
    if (type === 'agent_pre_invoke') { return 'pre-invoke'; }
    if (type === 'agent_post_invoke') { return 'post-invoke'; }
    const kind = (py.kind || py.tool_kind || '').toLowerCase();
    if (kind.includes('agentpreinvoke')) { return 'pre-invoke'; }
    return 'post-invoke';
}

function toolKind(x: any): string {
    if (x?.binding?.python) { return 'python'; }
    if (x?.binding?.openapi) { return 'openapi'; }
    if (x?.binding?.langflow) { return 'langflow'; }
    if (x?.binding?.skill) { return 'skill'; }
    return 'other';
}

/** Extract display label from OpenAPI spec (info.title, x-ibm-skill-name) or top-level display_name. */
function extractOpenApiInfoTitle(x: any): string | undefined {
    if (!x || typeof x !== 'object') return undefined;
    const info = x?.spec?.info ?? x?.info ?? x?.binding?.openapi?.spec?.info ?? x?.binding?.openapi?.info;
    if (info && typeof info === 'object') {
        const title = typeof info.title === 'string' ? info.title.trim() : undefined;
        if (title) return title;
        const skillName = typeof info['x-ibm-skill-name'] === 'string' ? String(info['x-ibm-skill-name']).trim() : undefined;
        if (skillName) return skillName;
    }
    const top = (x.display_name ?? x.displayName ?? x.title) as string | undefined;
    return top && String(top).trim() ? String(top).trim() : undefined;
}
