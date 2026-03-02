/**
 * WxO Importer/Exporter — Activity Bar Tree View
 *
 * Tree structure:
 *   [System: TZ1 ▾]      ← click to select environment
 *   [Search] [Filter]    ← search Quick Pick, filter tree by name
 *   ▸ Agents (n)
 *   ▸ Tools (n)
 *   ▸ Toolkits (n)       ← MCP servers: wxo-coingecko-demo → get_global, etc.
 *   ▸ Flows (n)
 *   ▸ Connections (n)
 *   ▸ WxO Project Dir    ← Exports, Replicate, Compare, Systems, Tools
 *   ─────────────────
 *   Open Panel
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 27 Feb 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    WxOEnvironmentService,
    WxOResource,
    WxOConnection,
    WxOToolkit,
    ConnectionStatus,
    isPlugin,
} from '../services/WxOEnvironmentService.js';

// ── Node types ────────────────────────────────────────────────────────────────

type CategoryKind = 'agents' | 'tools' | 'toolkits' | 'flows' | 'connections' | 'plugins';

const CATEGORY_LABEL: Record<CategoryKind, string> = {
    agents: 'Agents',
    tools: 'Tools',
    toolkits: 'Toolkits',
    flows: 'Flows',
    connections: 'Connections',
    plugins: 'Plugins',
};

const CATEGORY_ICON: Record<CategoryKind, string> = {
    agents: 'person',
    tools: 'tools',
    toolkits: 'package',
    flows: 'git-pull-request-create',
    connections: 'plug',
    plugins: 'zap',
};

class EnvSelectorItem extends vscode.TreeItem {
    readonly nodeKind = 'env-selector' as const;
    constructor(envName?: string) {
        super(
            envName ? envName : 'Select Environment…',
            vscode.TreeItemCollapsibleState.None,
        );
        this.iconPath = new vscode.ThemeIcon(envName ? 'server' : 'server-process');
        this.description = envName ? 'active  ▾ switch' : undefined;
        this.tooltip = envName
            ? `Active environment: ${envName}. Click to switch.`
            : 'No environment selected. Click to choose one.';
        this.command = {
            command: 'wxo-toolkit-vsc.selectEnvironment',
            title: 'Select Environment',
        };
        this.contextValue = 'wxo-env-selector';
    }
}

class CategoryItem extends vscode.TreeItem {
    readonly nodeKind = 'category' as const;
    constructor(public readonly category: CategoryKind) {
        super(
            CATEGORY_LABEL[category],
            vscode.TreeItemCollapsibleState.Collapsed,
        );
        this.iconPath = new vscode.ThemeIcon(CATEGORY_ICON[category]);
        this.contextValue = `wxo-category-${category}`;
    }
}

class ResourceItem extends vscode.TreeItem {
    readonly nodeKind = 'resource' as const;
    /** Internal API name (used for fetch/update/delete); may differ from displayed label. */
    readonly resourceName: string;
    constructor(resource: WxOResource, category: CategoryKind) {
        super(resource.display_name ?? resource.name, vscode.TreeItemCollapsibleState.None);
        this.resourceName = resource.name;
        this.description = resource.kind;
        this.iconPath = new vscode.ThemeIcon(resourceIcon(category, resource.kind));
        this.tooltip = resource.kind
            ? `${resource.display_name ?? resource.name} (${resource.kind})`
            : resource.display_name ?? resource.name;
        this.contextValue = `wxo-resource-${category}`;
    }
}

class ToolKindGroupItem extends vscode.TreeItem {
    readonly nodeKind = 'tool-kind-group' as const;
    constructor(
        public readonly kind: string,
        public readonly resources: WxOResource[],
    ) {
        const label =
            kind === 'python' ? 'Python' :
            kind === 'openapi' ? 'OpenAPI' :
            kind === 'skill' ? 'Catalog Skills' :
            'Other';
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = `${resources.length}`;
        this.iconPath = new vscode.ThemeIcon(kind === 'python' ? 'symbol-function' :
                                             kind === 'openapi' ? 'globe' : 'tools');
        this.contextValue = `wxo-tool-kind-${kind}`;
    }
}

class ToolkitItem extends vscode.TreeItem {
    readonly nodeKind = 'toolkit' as const;
    constructor(public readonly toolkit: WxOToolkit) {
        super(toolkit.name, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = toolkit.tools.length > 0 ? `${toolkit.tools.length} tools` : undefined;
        this.iconPath = new vscode.ThemeIcon('package');
        this.tooltip = toolkit.description ?? `${toolkit.name} (MCP toolkit)`;
        this.contextValue = 'wxo-toolkit';
    }
}

class ToolkitToolItem extends vscode.TreeItem {
    readonly nodeKind = 'toolkit-tool' as const;
    /** Full API name (toolkit:tool) used for fetch/update/delete. */
    readonly resourceName: string;
    constructor(toolkitName: string, toolName: string, fullName: string) {
        super(toolName, vscode.TreeItemCollapsibleState.None);
        this.resourceName = fullName;
        this.iconPath = new vscode.ThemeIcon('symbol-method');
        this.tooltip = `${toolkitName}:${toolName}`;
        this.contextValue = 'wxo-resource-tools';
    }
}

class MessageItem extends vscode.TreeItem {
    readonly nodeKind = 'message' as const;
    constructor(label: string, icon = 'info') {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = 'wxo-message';
    }
}

// ── Connection sub-category grouping ─────────────────────────────────────────

const CONN_GROUP_META: Record<ConnectionStatus, { label: string; icon: string; tooltip: string }> = {
    'active-live': {
        label: 'Active / Live',
        icon: 'circle-filled',
        tooltip: 'Credentials entered — live environment',
    },
    'active-draft': {
        label: 'Active / Draft',
        icon: 'circle-outline',
        tooltip: 'Credentials entered — draft environment',
    },
    'inactive': {
        label: 'Not Active / Draft',
        icon: 'circle-slash',
        tooltip: 'No credentials entered',
    },
};

class ConnectionGroupItem extends vscode.TreeItem {
    readonly nodeKind = 'conn-group' as const;
    constructor(
        public readonly status: ConnectionStatus,
        public readonly connections: WxOConnection[],
    ) {
        const { label, icon, tooltip } = CONN_GROUP_META[status];
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${connections.length}`;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.tooltip = `${tooltip} (${connections.length})`;
        this.contextValue = `wxo-conn-group-${status}`;
    }
}

class OpenPanelItem extends vscode.TreeItem {
    readonly nodeKind = 'open-panel' as const;
    constructor() {
        super('Open Panel', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('window');
        this.command = {
            command: 'wxo-toolkit-vsc.openPanel',
            title: 'Open WxO ToolBox Panel',
        };
        this.tooltip = 'Open the Export / Import / Compare / Replicate panel';
        this.contextValue = 'wxo-open-panel';
    }
}

class ImportToolItem extends vscode.TreeItem {
    readonly nodeKind = 'import-tool' as const;
    constructor() {
        super('Import Tool', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('file-directory');
        this.description = 'from filesystem';
        this.command = {
            command: 'wxo-toolkit-vsc.importToolFromFilesystem',
            title: 'Import Tool from Folder',
        };
        this.tooltip = 'Pick a tool folder (Python, OpenAPI, or Flow) and import into the active environment';
        this.contextValue = 'wxo-import-tool';
    }
}

class CreateToolItem extends vscode.TreeItem {
    readonly nodeKind = 'create-tool' as const;
    constructor() {
        super('Create Tool', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('add');
        this.description = 'form';
        this.command = {
            command: 'wxo-toolkit-vsc.createTool',
            title: 'Open Create Tool Form',
        };
        this.tooltip = 'Open Create Tool form — Python or OpenAPI with Load from filesystem, Form/JSON edit';
        this.contextValue = 'wxo-create-tool';
    }
}

class CreatePluginItem extends vscode.TreeItem {
    readonly nodeKind = 'create-plugin' as const;
    constructor() {
        super('Create Plugin', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('add');
        this.description = 'form';
        this.command = {
            command: 'wxo-toolkit-vsc.createPlugin',
            title: 'Open Create Plugin Form',
        };
        this.tooltip = 'Open Create Plugin form — Pre-invoke or Post-invoke with templates';
        this.contextValue = 'wxo-create-plugin';
    }
}

class ExtensionLinkItem extends vscode.TreeItem {
    readonly nodeKind = 'ext-link' as const;
    constructor() {
        super('Extension: WxO ToolBox', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('extensions');
        this.tooltip = 'View this extension in the VS Code Extensions panel';
        this.command = {
            command: 'wxo-toolkit-vsc.showExtension',
            title: 'Show Extension',
        };
        this.contextValue = 'wxo-ext-link';
    }
}

/** WxO directory entry (folder or file) — Exports, Replicate, Compare, Systems, Tools. */
export class WxODirEntryItem extends vscode.TreeItem {
    readonly nodeKind = 'wxo-dir-entry' as const;
    constructor(
        public readonly label: string,
        public readonly fsPath: string,
        public readonly isFile: boolean,
        public readonly depth: number,
    ) {
        super(
            label,
            isFile ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
        );
        this.resourceUri = vscode.Uri.file(fsPath);
        this.tooltip = fsPath;

        // Assign type-specific context values for fine-grained context menu targeting
        if (!isFile) {
            this.contextValue = 'wxo-dir-folder';
            this.iconPath = new vscode.ThemeIcon('folder');
        } else if (/\.env_connection/.test(label) || /^\.env_/.test(label)) {
            this.contextValue = 'wxo-dir-env-file';
            this.iconPath = new vscode.ThemeIcon('key');
        } else if (/\.(yaml|yml)$/i.test(label)) {
            this.contextValue = 'wxo-dir-yaml-file';
            this.iconPath = new vscode.ThemeIcon('file-code');
        } else if (/\.(json)$/i.test(label)) {
            this.contextValue = 'wxo-dir-json-file';
            this.iconPath = new vscode.ThemeIcon('json');
        } else if (/\.(py)$/i.test(label)) {
            this.contextValue = 'wxo-dir-py-file';
            this.iconPath = new vscode.ThemeIcon('symbol-function');
        } else if (/\.(sh|bash)$/i.test(label)) {
            this.contextValue = 'wxo-dir-sh-file';
            this.iconPath = new vscode.ThemeIcon('terminal');
        } else {
            this.contextValue = 'wxo-dir-file';
            this.iconPath = new vscode.ThemeIcon('file');
        }

        if (isFile) {
            this.command = { command: 'wxo-toolkit-vsc.openDirFile', title: 'Open', arguments: [this] };
        }
    }
}

/** Root item for WxO project directory tree. */
export class WxODirRootItem extends vscode.TreeItem {
    readonly nodeKind = 'wxo-dir-root' as const;
    constructor(public readonly wxoRoot: string) {
        super('WxO Project Dir', vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon('folder-opened');
        this.tooltip = `WxO project folder: ${wxoRoot}\nExports, Replicate, Compare, Systems, Tools`;
        this.contextValue = 'wxo-dir-root';
    }
}

type AnyItem =
    | EnvSelectorItem
    | CategoryItem
    | ConnectionGroupItem
    | ResourceItem
    | ToolKindGroupItem
    | ToolkitItem
    | ToolkitToolItem
    | MessageItem
    | OpenPanelItem
    | ImportToolItem
    | CreateToolItem
    | CreatePluginItem
    | WxODirRootItem
    | WxODirEntryItem
    | ExtensionLinkItem;

// ── Provider ─────────────────────────────────────────────────────────────────

/** Searchable item for Quick Pick (resourceType, name, label for display). */
export interface WxOSearchableItem {
    resourceType: 'agents' | 'tools' | 'flows' | 'connections' | 'plugins';
    name: string;
    label: string;
    description?: string;
}

/** Tree data provider for the WxO Activity Bar view (agents, tools, flows, connections). */
export class WxOImporterExporterViewProvider
    implements vscode.TreeDataProvider<AnyItem> {

    private readonly _onChange = new vscode.EventEmitter<AnyItem | undefined | null>();
    readonly onDidChangeTreeData = this._onChange.event;

    readonly service = new WxOEnvironmentService();

    /** Currently active environment name (set by selectEnvironment command). */
    private _activeEnvironment: string | undefined;

    /** Optional search filter — when set, tree items are filtered by this term. */
    private _searchFilter: string = '';

    get activeEnvironment(): string | undefined { return this._activeEnvironment; }

    get searchFilter(): string { return this._searchFilter; }

    setSearchFilter(term: string): void {
        this._searchFilter = (term ?? '').trim().toLowerCase();
        vscode.commands.executeCommand('setContext', 'wxo-toolkit-vsc.hasFilter', !!this._searchFilter);
        this.refresh();
    }

    clearSearchFilter(): void {
        this._searchFilter = '';
        vscode.commands.executeCommand('setContext', 'wxo-toolkit-vsc.hasFilter', false);
        this.refresh();
    }

    setEnvironment(envName: string | undefined): void {
        this._activeEnvironment = envName;
        // Drive viewsWelcome: show when no env is active
        vscode.commands.executeCommand(
            'setContext',
            'wxo-toolkit-vsc.noEnv',
            !envName,
        );
        this.refresh();
    }

    refresh(): void {
        this._onChange.fire(null);
    }

    getTreeItem(element: AnyItem): AnyItem {
        return element;
    }

    async getChildren(element?: AnyItem): Promise<AnyItem[]> {
        // ── Root ──────────────────────────────────────────────────────────────
        if (!element) {
            // No env selected → return empty so viewsWelcome renders
            if (!this._activeEnvironment) {
                return [];
            }

            // Env selected → full tree with Open Panel at top, extension link at bottom
            return [
                new OpenPanelItem(),
                new EnvSelectorItem(this._activeEnvironment),
                new CategoryItem('agents'),
                new CategoryItem('tools'),
                new CategoryItem('toolkits'),
                new CategoryItem('plugins'),
                new CategoryItem('flows'),
                new CategoryItem('connections'),
                new WxODirRootItem(this.service.getWxORoot()),
                new ExtensionLinkItem(),
            ];
        }

        // ── Category children (lazy-loaded) ───────────────────────────────────
        if (element instanceof CategoryItem) {
            if (!this._activeEnvironment) {
                return [new MessageItem('No environment active', 'warning')];
            }
            return this.loadCategory(element.category);
        }

        // ── WxO directory tree ────────────────────────────────────────────────
        if (element instanceof WxODirRootItem) {
            return this.loadWxODirChildren(element.wxoRoot, 0);
        }
        if (element instanceof WxODirEntryItem && !element.isFile) {
            return this.loadWxODirChildren(element.fsPath, element.depth + 1);
        }

        // ── Connection group children ─────────────────────────────────────────
        if (element instanceof ConnectionGroupItem) {
            if (element.connections.length === 0) {
                return [new MessageItem('None', 'dash')];
            }
            return element.connections.map(c => {
                const item = new ResourceItem({ name: c.name }, 'connections');
                item.description = c.environment;
                item.tooltip = `${c.name}  •  ${c.environment}  •  ${c.credentialsEntered ? 'credentials set' : 'no credentials'}`;
                return item;
            });
        }

        // ── Toolkit children (toolkit name → tools like get_global) ─────────────
        if (element instanceof ToolkitItem) {
            if (element.toolkit.tools.length === 0) {
                return [new MessageItem('No tools', 'dash')];
            }
            return element.toolkit.tools.map(t =>
                new ToolkitToolItem(element.toolkit.name, t.name, t.fullName),
            );
        }

        // ── Tool kind group children (e.g. Tools/Python, Tools/OpenAPI) ────────
        if (element instanceof ToolKindGroupItem) {
            if (element.resources.length === 0) {
                return [new MessageItem('No tools', 'dash')];
            }
            return element.resources.map(r => new ResourceItem(r, 'tools'));
        }

        return [];
    }

    private async loadCategory(category: CategoryKind): Promise<AnyItem[]> {
        try {
            // Connections: return grouped sub-categories
            if (category === 'connections') {
                return this.loadConnectionGroups();
            }

            // Toolkits: MCP servers with nested tools (e.g. wxo-coingecko-demo → get_global)
            if (category === 'toolkits') {
                const toolkits = await this.service.listToolkits();
                if (toolkits.length === 0) {
                    return [new MessageItem('No toolkits found', 'dash')];
                }
                const filtered = this._searchFilter
                    ? toolkits
                        .filter(tk =>
                            this.matchesFilter(tk.name, tk.description) ||
                            tk.tools.some(t => this.matchesFilter(t.name, t.fullName)),
                        )
                        .map(tk => {
                            const nameMatches = this.matchesFilter(tk.name, tk.description);
                            if (nameMatches) return tk;
                            return { ...tk, tools: tk.tools.filter(t => this.matchesFilter(t.name, t.fullName)) };
                        })
                    : toolkits;
                if (filtered.length === 0) {
                    return [new MessageItem('No matching toolkits', 'dash')];
                }
                return filtered.map(tk => new ToolkitItem(tk));
            }

            let resources: WxOResource[] = [];
            if (category === 'agents') { resources = await this.service.listAgents(); }
            else if (category === 'tools') { resources = await this.service.listTools(); }
            else if (category === 'flows') { resources = await this.service.listFlows(); }
            else if (category === 'plugins') { resources = await this.service.listPlugins(); }

            const filteredResources = this._searchFilter
                ? resources.filter(r => this.matchesFilter(r.display_name ?? r.name, r.name))
                : resources;

            if (category === 'tools') {
                if (filteredResources.length === 0) {
                    return [new ImportToolItem(), new CreateToolItem(), new MessageItem(this._searchFilter ? 'No matching tools' : 'No tools found', 'dash')];
                }
                const byKind = new Map<string, WxOResource[]>();
                for (const r of filteredResources) {
                    const k = r.kind ?? 'other';
                    const arr = byKind.get(k) ?? [];
                    arr.push(r);
                    byKind.set(k, arr);
                }
                const groupItems: AnyItem[] = [];
                const order = ['python', 'openapi', 'skill', 'other'];
                for (const k of order) {
                    const arr = byKind.get(k);
                    if (arr && arr.length > 0) {
                        groupItems.push(new ToolKindGroupItem(k, arr));
                        byKind.delete(k);
                    }
                }
                for (const [k, arr] of byKind.entries()) {
                    groupItems.push(new ToolKindGroupItem(k, arr));
                }
                return [new ImportToolItem(), new CreateToolItem(), ...groupItems];
            }
            const resourceItems = filteredResources.map(r => new ResourceItem(r, category));
            if (category === 'plugins') {
                return [new CreatePluginItem(), ...resourceItems];
            }
            if (filteredResources.length === 0) {
                return [new MessageItem(this._searchFilter ? 'No matching items' : `No ${category} found`, 'dash')];
            }
            return resourceItems;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return [new MessageItem(`Error loading ${category}: ${msg}`, 'error')];
        }
    }

    /** Collect all searchable resources for Quick Pick. Requires active environment. */
    async searchAllResources(): Promise<WxOSearchableItem[]> {
        if (!this._activeEnvironment) return [];
        const items: WxOSearchableItem[] = [];
        try {
            const [agents, tools, toolkits, flows, plugins, groups] = await Promise.all([
                this.service.listAgents(),
                this.service.listTools(),
                this.service.listToolkits(),
                this.service.listFlows(),
                this.service.listPlugins(),
                this.service.listConnectionsGrouped(),
            ]);
            for (const r of agents) {
                items.push({ resourceType: 'agents', name: r.name, label: r.display_name ?? r.name, description: 'Agent' });
            }
            for (const r of tools) {
                items.push({ resourceType: 'tools', name: r.name, label: r.display_name ?? r.name, description: `Tool (${r.kind ?? '?'})` });
            }
            for (const tk of toolkits) {
                for (const t of tk.tools) {
                    items.push({ resourceType: 'tools', name: t.fullName, label: t.name, description: `Toolkit: ${tk.name}` });
                }
            }
            for (const r of flows) {
                items.push({ resourceType: 'flows', name: r.name, label: r.display_name ?? r.name, description: 'Flow' });
            }
            for (const r of plugins) {
                items.push({ resourceType: 'plugins', name: r.name, label: r.display_name ?? r.name, description: `Plugin (${r.kind ?? '?'})` });
            }
            for (const c of [...groups.activeLive, ...groups.activeDraft, ...groups.inactive]) {
                items.push({ resourceType: 'connections', name: c.name, label: c.name, description: `Connection (${c.environment})` });
            }
        } catch {
            // ignore
        }
        return items;
    }

    /** Returns true if the given label/name matches the current search filter. */
    private matchesFilter(label: string, name?: string): boolean {
        if (!this._searchFilter) return true;
        const l = (label ?? '').toLowerCase();
        const n = (name ?? '').toLowerCase();
        return l.includes(this._searchFilter) || n.includes(this._searchFilter);
    }

    private async loadConnectionGroups(): Promise<AnyItem[]> {
        try {
            const groups = await this.service.listConnectionsGrouped();
            const filterConn = (arr: WxOConnection[]) =>
                this._searchFilter ? arr.filter(c => this.matchesFilter(c.name, c.name)) : arr;
            const activeLive = filterConn(groups.activeLive);
            const activeDraft = filterConn(groups.activeDraft);
            const inactive = filterConn(groups.inactive);
            const total = activeLive.length + activeDraft.length + inactive.length;

            if (total === 0) {
                return [new MessageItem(this._searchFilter ? 'No matching connections' : 'No connections found', 'dash')];
            }

            const items: AnyItem[] = [];
            const origTotal = groups.activeLive.length + groups.activeDraft.length + groups.inactive.length;
            if (activeLive.length > 0 || origTotal > 0) {
                items.push(new ConnectionGroupItem('active-live', activeLive));
            }
            if (activeDraft.length > 0) {
                items.push(new ConnectionGroupItem('active-draft', activeDraft));
            }
            if (inactive.length > 0) {
                items.push(new ConnectionGroupItem('inactive', inactive));
            }
            return items;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return [new MessageItem(`Error loading connections: ${msg}`, 'error')];
        }
    }

    /** Max depth for WxO dir tree; 50 allows full Exports/Env/DateTime/agents|tools|... structures. */
    private static readonly WXO_MAX_DEPTH = 50;

    private loadWxODirChildren(dirPath: string, depth: number): AnyItem[] {
        if (depth >= WxOImporterExporterViewProvider.WXO_MAX_DEPTH) {
            return [];
        }
        try {
            if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
                return [new MessageItem('Not found', 'warning')];
            }
            const names = fs.readdirSync(dirPath, { withFileTypes: true });
            const entries: WxODirEntryItem[] = [];
            for (const ent of names) {
                // Show env/credential files even though they start with '.'
                const isEnvFile = /^\.env_/.test(ent.name);
                if (ent.name.startsWith('.') && !isEnvFile) { continue; }
                const fullPath = path.join(dirPath, ent.name);
                entries.push(new WxODirEntryItem(ent.name, fullPath, ent.isFile(), depth + 1));
            }
            return entries.sort((a, b) => {
                if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
                return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return [new MessageItem(`Error: ${msg}`, 'error')];
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resourceIcon(category: CategoryKind, kind?: string): string {
    if (category === 'agents') { return 'person'; }
    if (category === 'connections') { return 'link'; }
    if (kind === 'python') { return 'symbol-function'; }
    if (kind === 'openapi') { return 'globe'; }
    if (kind === 'langflow' || kind === 'flow') { return 'git-pull-request-create'; }
    return 'symbol-method';
}
