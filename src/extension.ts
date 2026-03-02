/**
 * WxO ToolBox (WxO-ToolBox-vsc) — VS Code Extension
 * Drives wxo-toolkit-cli scripts (export, import, compare, replicate).
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 27 Feb 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { getEffectiveEnv } from './utils/wxoEnv.js';
import { WxOScriptsPanel } from './panels/WxOScriptsPanel.js';
import { WxOCreateToolPanel } from './panels/WxOCreateToolPanel.js';
import { WxOCreatePluginPanel } from './panels/WxOCreatePluginPanel.js';
import { WxOResourceJsonPanel } from './panels/WxOResourceJsonPanel.js';
import { WxOPluginEditorPanel } from './panels/WxOPluginEditorPanel.js';
import { WxOObjectFormPanel } from './panels/WxOObjectFormPanel.js';
import { WxOEnvFileEditorPanel } from './panels/WxOEnvFileEditorPanel.js';
import { WxOTraceDetailPanel } from './panels/WxOTraceDetailPanel.js';
import { WxODirEntryItem, WxODirRootItem } from './views/WxOImporterExporterView.js';
import { WxOImporterExporterViewProvider } from './views/WxOImporterExporterView.js';
import { WxOCredentialsService } from './services/WxOCredentialsService.js';
import { setCredentialsService } from './services/credentialsContext.js';

/** Extension entry point. Registers tree view, commands, and message handlers. */
export function activate(context: vscode.ExtensionContext) {
    const credentialsService = new WxOCredentialsService(context.secrets);
    setCredentialsService(credentialsService);

    const provider = new WxOImporterExporterViewProvider();

    // Show viewsWelcome immediately on first load (no env active yet)
    vscode.commands.executeCommand('setContext', 'WxO-ToolBox-vsc.noEnv', true);

    // Use createTreeView so we can read .selection for multi-select keyboard delete
    const treeView = vscode.window.createTreeView('WxO-ToolBox-vsc-main', {
        treeDataProvider: provider,
        canSelectMany: true,
    });

    context.subscriptions.push(

        // ── Tree view ──────────────────────────────────────────────────────────
        treeView,

        // ── Open panel ─────────────────────────────────────────────────────────
        vscode.commands.registerCommand('WxO-ToolBox-vsc.openPanel', () => {
            WxOScriptsPanel.render(context.extensionUri);
        }),

        // ── Refresh view ───────────────────────────────────────────────────────
        vscode.commands.registerCommand('WxO-ToolBox-vsc.refreshView', () => {
            provider.refresh();
        }),

        // ── Search resources (Quick Pick) ───────────────────────────────────────
        vscode.commands.registerCommand('WxO-ToolBox-vsc.searchResources', async () => {
            if (!provider.activeEnvironment) {
                vscode.window.showWarningMessage('Select an environment first.');
                return;
            }
            const items = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'WxO: Loading resources…', cancellable: false },
                () => provider.searchAllResources(),
            );
            if (items.length === 0) {
                vscode.window.showInformationMessage('No resources found.');
                return;
            }
            const picked = await vscode.window.showQuickPick(
                items.map(it => ({
                    label: it.label,
                    description: it.description,
                    detail: it.name,
                    item: it,
                })),
                {
                    matchOnDescription: true,
                    matchOnDetail: true,
                    placeHolder: 'Search agents, tools, flows, plugins, connections…',
                },
            );
            if (!picked?.item) return;
            const { resourceType, name } = picked.item;
            const fakeItem = { contextValue: `wxo-resource-${resourceType}`, resourceName: name } as vscode.TreeItem;
            await vscode.commands.executeCommand('WxO-ToolBox-vsc.viewResourceJson', fakeItem);
        }),

        // ── Filter tree ────────────────────────────────────────────────────────
        vscode.commands.registerCommand('WxO-ToolBox-vsc.filterResources', async () => {
            const term = await vscode.window.showInputBox({
                prompt: 'Filter resources by name',
                placeHolder: 'e.g. weather, coingecko, get_global',
                value: provider.searchFilter,
                validateInput: () => null,
            });
            if (term !== undefined) provider.setSearchFilter(term);
        }),

        // ── Clear tree filter ───────────────────────────────────────────────────
        vscode.commands.registerCommand('WxO-ToolBox-vsc.clearFilter', () => {
            provider.clearSearchFilter();
        }),

        // ── View resource JSON ─────────────────────────────────────────────────
        vscode.commands.registerCommand(
            'WxO-ToolBox-vsc.viewResourceJson',
            async (item: vscode.TreeItem) => {
                const info = extractItemInfo(item);
                if (!info) {
                    vscode.window.showWarningMessage('Cannot identify resource.');
                    return;
                }
                const { resourceType, name } = info;

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `WxO: Fetching ${resourceType} definition for "${name}"…`,
                        cancellable: false,
                    },
                    async () => {
                        try {
                            const json = await provider.service.fetchResourceJson(resourceType, name);
                            WxOResourceJsonPanel.show(
                                context.extensionUri,
                                resourceType,
                                name,
                                json,
                                async (rt, n, j) => {
                                    await provider.service.updateResourceFromJson(rt as any, n, j);
                                    provider.refresh();
                                },
                            );
                        } catch (err: unknown) {
                            const msg = err instanceof Error ? err.message : String(err);
                            vscode.window.showErrorMessage(`WxO: ${msg}`);
                        }
                    },
                );
            },
        ),

        // ── Edit resource ──────────────────────────────────────────────────────
        vscode.commands.registerCommand(
            'WxO-ToolBox-vsc.editResource',
            async (item: vscode.TreeItem) => {
                const { resourceType, name } = extractItemInfo(item) ?? {};
                if (!resourceType || !name) { return; }

                // Agents, flows, connections → dedicated form panel
                if (resourceType === 'agents' || resourceType === 'connections') {
                    WxOObjectFormPanel.render(context.extensionUri, provider, resourceType, name);
                    return;
                }

                // Flows → form panel
                if (resourceType === 'flows') {
                    WxOObjectFormPanel.render(context.extensionUri, provider, 'flows', name);
                    return;
                }

                // Python / OpenAPI tools → export + load into Create Tool form
                if (resourceType === 'tools') {
                    try {
                        const folderPath = await vscode.window.withProgress(
                            { location: vscode.ProgressLocation.Notification, title: `WxO: Exporting "${name}" to WxO/Edits/…`, cancellable: false },
                            () => provider.service.exportToEditDir(name),
                        );
                        const toolData = provider.service.loadToolFromFolder(folderPath);
                        if (toolData) {
                            WxOCreateToolPanel.render(context.extensionUri, provider, {
                                editMode: true,
                                initialLoad: toolData as unknown as Record<string, unknown>,
                            });
                            return;
                        }
                    } catch (err: unknown) {
                        vscode.window.showErrorMessage(`WxO: Could not load tool form — ${err instanceof Error ? err.message : String(err)}`);
                        return;
                    }
                }
            },
        ),

        // ── Delete resource (supports multi-select + keyboard Delete key) ──────
        vscode.commands.registerCommand(
            'WxO-ToolBox-vsc.deleteResource',
            async (item?: vscode.TreeItem, nodes?: readonly vscode.TreeItem[]) => {
                // Gather targets: context-menu multi-select → treeView.selection → single item
                let candidates: readonly vscode.TreeItem[];
                if (nodes && nodes.length > 0) {
                    candidates = nodes;
                } else if (treeView.selection.length > 0) {
                    candidates = treeView.selection;
                } else if (item) {
                    candidates = [item];
                } else {
                    return;
                }

                const resources = candidates
                    .map(t => extractItemInfo(t))
                    .filter((x): x is { resourceType: ResourceType; name: string } => x !== null);

                if (resources.length === 0) { return; }

                const label = resources.length === 1
                    ? `${resources[0].resourceType.replace(/s$/, '')} "${resources[0].name}"`
                    : `${resources.length} items`;

                const choice = await vscode.window.showWarningMessage(
                    `Delete ${label}?\nThis cannot be undone.`,
                    { modal: true },
                    'Delete',
                );
                if (choice !== 'Delete') { return; }

                // For tools/flows/plugins: offer to remove from agents first
                let removeFromAgents = false;
                const toolLikeTypes = resources.filter(
                    r => (r.resourceType === 'tools' || r.resourceType === 'flows' || r.resourceType === 'plugins'),
                );
                if (toolLikeTypes.length > 0) {
                    const removeChoice = await vscode.window.showQuickPick(
                        [
                            { label: 'Yes, remove from agents first', value: true },
                            { label: 'No, delete only (agents may keep orphaned references)', value: false },
                        ],
                        {
                            placeHolder: 'Also remove this tool/plugin from all agents?',
                            title: 'WxO Delete — Remove from agents?',
                        },
                    );
                    removeFromAgents = removeChoice?.value ?? false;
                }

                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `WxO: Deleting ${label}…`, cancellable: false },
                    async () => {
                        const errors: string[] = [];
                        const scriptsDir = getScriptsDirForCopy(context.extensionPath);
                        const removeScript = scriptsDir && scriptsDir.length > 0
                            ? path.join(scriptsDir, 'remove_tool_from_agents.sh')
                            : null;
                        const env = getEffectiveEnv();

                        for (const { resourceType, name } of resources) {
                            try {
                                if (removeFromAgents && removeScript && fs.existsSync(removeScript) &&
                                    (resourceType === 'tools' || resourceType === 'flows' || resourceType === 'plugins')) {
                                    try {
                                        execSync(`bash "${removeScript}" -n "${name}" -y`, {
                                            encoding: 'utf8',
                                            env: { ...process.env, ...env },
                                        });
                                    } catch (rmErr) {
                                        errors.push(`${name}: remove from agents failed — ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`);
                                        continue;
                                    }
                                }
                                await provider.service.deleteResource(resourceType, name);
                            } catch (err: unknown) {
                                errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
                            }
                        }
                        if (errors.length > 0) {
                            vscode.window.showErrorMessage(`WxO: Some deletions failed:\n${errors.join('\n')}`);
                        } else {
                            vscode.window.showInformationMessage(`WxO: ${label} deleted.`);
                        }
                        provider.refresh();
                    },
                );
            },
        ),

        // ── Compare resource ───────────────────────────────────────────────────
        vscode.commands.registerCommand(
            'WxO-ToolBox-vsc.compareResource',
            async (item: vscode.TreeItem) => {
                const { resourceType, name } = extractItemInfo(item) ?? {};
                if (!resourceType || !name) { return; }

                const currentEnv = provider.activeEnvironment;
                if (!currentEnv) {
                    vscode.window.showWarningMessage('WxO: No active environment selected.');
                    return;
                }

                // Pick compare-with environment
                const allEnvs = await provider.service.listEnvironments();
                const otherEnvs = allEnvs.filter(e => e !== currentEnv);
                if (otherEnvs.length === 0) {
                    vscode.window.showInformationMessage('WxO: No other environments to compare with.');
                    return;
                }

                const picked = await vscode.window.showQuickPick(
                    otherEnvs.map(e => ({ label: e })),
                    { placeHolder: `Compare "${name}" with environment…`, title: 'WxO Compare — Select Environment' },
                );
                if (!picked) { return; }

                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `WxO: Comparing "${name}" (${currentEnv} ↔ ${picked.label})…`, cancellable: false },
                    async () => {
                        try {
                            // Fetch JSON from both environments
                            const [leftJson, rightJson] = await Promise.all([
                                provider.service.fetchResourceJson(resourceType, name),
                                provider.service.fetchResourceJsonFromEnv(picked.label, currentEnv, resourceType, name),
                            ]);

                            // Write to temp files
                            const tmpDir = os.tmpdir();
                            const leftFile  = path.join(tmpDir, `wxo-${currentEnv}-${resourceType}-${name}.json`);
                            const rightFile = path.join(tmpDir, `wxo-${picked.label}-${resourceType}-${name}.json`);
                            fs.writeFileSync(leftFile,  JSON.stringify(leftJson,  null, 2));
                            fs.writeFileSync(rightFile, JSON.stringify(rightJson, null, 2));

                            const leftUri  = vscode.Uri.file(leftFile);
                            const rightUri = vscode.Uri.file(rightFile);
                            await vscode.commands.executeCommand(
                                'vscode.diff',
                                leftUri,
                                rightUri,
                                `${name}: ${currentEnv} ↔ ${picked.label}`,
                                { preview: true },
                            );
                        } catch (err: unknown) {
                            const msg = err instanceof Error ? err.message : String(err);
                            vscode.window.showErrorMessage(`WxO Compare: ${msg}`);
                        }
                    },
                );
            },
        ),

        // ── Show extension in marketplace panel ────────────────────────────────
        vscode.commands.registerCommand('WxO-ToolBox-vsc.showExtension', () => {
            vscode.commands.executeCommand(
                'workbench.extensions.action.showExtensionsWithIds',
                ['markusvankempen.WxO-ToolBox-vsc'],
            );
        }),

        // ── Open user guide ───────────────────────────────────────────────────
        vscode.commands.registerCommand('WxO-ToolBox-vsc.openTraceDetail', async () => {
            const uri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Open Trace',
                filters: { 'Trace JSON': ['json'] },
            });
            if (uri?.[0]) {
                WxOTraceDetailPanel.show(context.extensionUri, uri[0].fsPath);
            }
        }),
        vscode.commands.registerCommand('WxO-ToolBox-vsc.openTraceDetailFromFile', async (item: unknown) => {
            const fsPath = item instanceof WxODirEntryItem ? item.fsPath : null;
            if (fsPath && fs.existsSync(fsPath)) {
                WxOTraceDetailPanel.show(context.extensionUri, fsPath);
            } else {
                vscode.window.showWarningMessage('WxO: File not found.');
            }
        }),
        vscode.commands.registerCommand('WxO-ToolBox-vsc.openUserGuide', async () => {
            const guidePath = path.join(context.extensionPath, 'USER_GUIDE.md');
            if (!fs.existsSync(guidePath)) {
                vscode.window.showWarningMessage('WxO: User guide not found.');
                return;
            }
            const uri = vscode.Uri.file(guidePath);
            // Open as rendered markdown preview beside the current editor
            await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
        }),

        // ── Copy resource to another environment ─────────────────────────────────
        vscode.commands.registerCommand(
            'WxO-ToolBox-vsc.copyResource',
            async (item: vscode.TreeItem) => {
                const { resourceType, name } = extractItemInfo(item) ?? {};
                if (!resourceType || !name) { return; }

                const currentEnv = provider.activeEnvironment;
                if (!currentEnv) {
                    vscode.window.showWarningMessage('WxO: No active environment selected.');
                    return;
                }

                const allEnvs = await provider.service.listEnvironments();
                const targetOpts = allEnvs.filter(e => e !== currentEnv).map(e => ({ label: e }));
                if (targetOpts.length === 0) {
                    vscode.window.showInformationMessage('WxO: No other environments to copy to.');
                    return;
                }

                const target = await vscode.window.showQuickPick(targetOpts, {
                    placeHolder: 'Copy to environment…',
                    title: `WxO Copy: ${resourceType} "${name}"`,
                });
                if (!target) { return; }

                // Dependencies: only for agents (default: include)
                let withDeps = true;
                if (resourceType === 'agents') {
                    const depChoice = await vscode.window.showQuickPick(
                        [
                            { label: 'Include dependencies (recommended)', value: true },
                            { label: 'Copy this agent only (no tools)', value: false },
                        ],
                        { placeHolder: 'Include dependencies?', title: 'WxO Copy Options' },
                    );
                    if (!depChoice) { return; }
                    withDeps = depChoice.value;
                }

                // If exists: Overwrite / Skip / Use new name (add _copy)
                const existsChoice = await vscode.window.showQuickPick(
                    [
                        { label: 'Overwrite if exists', value: 'override' },
                        { label: 'Skip if exists', value: 'skip' },
                        { label: 'Use new name (add "_copy" suffix)', value: 'rename' },
                    ],
                    { placeHolder: 'If resource already exists in target?', title: 'WxO Copy Options' },
                );
                if (!existsChoice) { return; }

                const ifExists = existsChoice.value as 'override' | 'skip' | 'rename';
                const targetName = ifExists === 'rename' ? `${name}_copy` : name;

                const confirm = await vscode.window.showQuickPick(
                    [
                        { label: 'Yes, copy', value: true },
                        { label: 'Cancel', value: false },
                    ],
                    {
                        placeHolder: `Copy ${resourceType} "${name}" to ${target.label}${ifExists === 'rename' ? ` as "${targetName}"` : ''}?`,
                        title: 'Confirm copy',
                    },
                );
                if (!confirm?.value) { return; }

                const scriptsDir = getScriptsDirForCopy(context.extensionPath);
                const tmpBase = path.join(os.tmpdir(), `wxo-copy-${Date.now()}`);
                const copyDir = path.join(tmpBase, 'copy');
                const wsRoot = getWorkspaceRoot();
                const wxoRoot = getWxORoot();

                const lines: string[] = [
                    `echo "=== WxO Copy: ${resourceType} \\"${name}\\" → ${target.label} ==="`,
                    `set -e`,
                    `export ENV_FILE="${path.join(wsRoot, '.env')}"`,
                    `export WXO_ROOT="${wxoRoot}"`,
                    `ORIG_ENV="${currentEnv}"`,
                    `TARGET="${target.label}"`,
                    `NAME="${name}"`,
                    `TARGET_NAME="${targetName}"`,
                    `TMP="${tmpBase}"`,
                    `COPY_DIR="${copyDir}"`,
                    `mkdir -p "$COPY_DIR"`,
                    `echo ""`,
                    `echo "1. Exporting from $ORIG_ENV..."`,
                    `orchestrate env activate "$ORIG_ENV" 2>/dev/null`,
                ];

                if (resourceType === 'agents') {
                    lines.push(`mkdir -p "$COPY_DIR/agents"`);
                    if (withDeps) {
                        lines.push(`( orchestrate agents export -n "$NAME" -k native -o "$TMP/agent.zip" 2>/dev/null ) || ( orchestrate agents export -n "$NAME" -k external -o "$TMP/agent.zip" 2>/dev/null ) || ( orchestrate agents export -n "$NAME" -k assistant -o "$TMP/agent.zip" 2>/dev/null ) || { echo "Export failed"; exit 1; }`);
                        lines.push(`unzip -o -q "$TMP/agent.zip" -d "$COPY_DIR/agents" 2>/dev/null || true`);
                    } else {
                        lines.push(`( orchestrate agents export -n "$NAME" -k native --agent-only -o "$TMP/agent.yaml" 2>/dev/null ) || ( orchestrate agents export -n "$NAME" -k external --agent-only -o "$TMP/agent.yaml" 2>/dev/null ) || ( orchestrate agents export -n "$NAME" -k assistant --agent-only -o "$TMP/agent.yaml" 2>/dev/null ) || { echo "Export failed"; exit 1; }`);
                        lines.push(`mv "$TMP/agent.yaml" "$COPY_DIR/agents/$NAME.yaml" 2>/dev/null || cp "$TMP/agent.yaml" "$COPY_DIR/agents/$NAME.yaml" 2>/dev/null || true`);
                    }
                    if (ifExists === 'rename') {
                        const sedOld = name.replace(/[|\\\/&]/g, '\\$&');
                        const sedNew = targetName.replace(/[&\\]/g, '\\$&');
                        lines.push(`find "$COPY_DIR" \\( -name "*.yaml" -o -name "*.yml" \\) -exec sed -i.bak 's|^name:[[:space:]]*${sedOld}|name: ${sedNew}|' {} \\; 2>/dev/null || true`);
                        lines.push(`[ -d "$COPY_DIR/agents/$NAME" ] && mv "$COPY_DIR/agents/$NAME" "$COPY_DIR/agents/$TARGET_NAME" 2>/dev/null || true`);
                        lines.push(`[ -f "$COPY_DIR/agents/$NAME.yaml" ] && mv "$COPY_DIR/agents/$NAME.yaml" "$COPY_DIR/agents/$TARGET_NAME.yaml" 2>/dev/null || true`);
                    }
                } else if (resourceType === 'tools' || resourceType === 'flows' || resourceType === 'plugins') {
                    const subdir = resourceType === 'flows' ? 'flows' : resourceType === 'plugins' ? 'tools' : 'tools';
                    const exportName = ifExists === 'rename' ? targetName : name;
                    lines.push(`mkdir -p "$COPY_DIR/${subdir}"`);
                    lines.push(`orchestrate tools export -n "$NAME" -o "$TMP/tool.zip" 2>/dev/null`);
                    lines.push(`unzip -o -q "$TMP/tool.zip" -d "$COPY_DIR/${subdir}/$exportName" 2>/dev/null || true`);
                    if (ifExists === 'rename') {
                        const safeOld = name.replace(/[|\\\/&"]/g, '\\$&');
                        const safeNew = targetName.replace(/[&\\]/g, '\\$&');
                        lines.push(`find "$COPY_DIR/${subdir}/$exportName" \\( -name "*.json" -o -name "*.yaml" -o -name "*.yml" \\) -exec sed -i.bak 's/"name":[[:space:]]*"${safeOld}"/"name": "${safeNew}"/g' {} \\; 2>/dev/null || true`);
                    }
                } else if (resourceType === 'connections') {
                    lines.push(`mkdir -p "$COPY_DIR/connections"`);
                    lines.push(`orchestrate connections export -a "$NAME" -o "$COPY_DIR/connections/$NAME.yml" 2>/dev/null`);
                    if (ifExists === 'rename') {
                        const connOld = name.replace(/[|\\\/&]/g, '\\$&');
                        const connNew = targetName.replace(/[&\\]/g, '\\$&');
                        lines.push(`sed -i.bak 's|app_id:[[:space:]]*${connOld}|app_id: ${connNew}|' "$COPY_DIR/connections/$NAME.yml" 2>/dev/null || true`);
                        lines.push(`mv "$COPY_DIR/connections/$NAME.yml" "$COPY_DIR/connections/$TARGET_NAME.yml" 2>/dev/null || true`);
                    }
                }

                lines.push(
                    `echo ""`,
                    `echo "2. Importing to $TARGET..."`,
                    `orchestrate env activate "$TARGET" 2>/dev/null`,
                );

                if (scriptsDir) {
                    const filter = resourceType === 'agents' ? `--agent "$TARGET_NAME"` : resourceType === 'connections' ? `--connection "$TARGET_NAME"` : `--tool "$TARGET_NAME"`;
                    const flags = resourceType === 'agents' ? '--agents-only' : resourceType === 'connections' ? '--connections-only' : resourceType === 'flows' ? '--flows-only' : '--tools-only'; // plugins use --tools-only
                    lines.push(`cd "${scriptsDir}" && ./import_to_wxo.sh --base-dir "$COPY_DIR" --env "$TARGET" --no-credential-prompt --if-exists ${ifExists === 'skip' ? 'skip' : 'override'} ${flags} ${filter} 2>&1`);
                } else {
                    lines.push(`echo "[WARN] Scripts not found. Export saved to: $COPY_DIR"`);
                    lines.push(`echo "Run: orchestrate env activate $TARGET && import from $COPY_DIR manually"`);
                }

                lines.push(
                    `echo ""`,
                    `echo "3. Restoring environment..."`,
                    `orchestrate env activate "$ORIG_ENV" 2>/dev/null`,
                    `rm -rf "$TMP" 2>/dev/null`,
                    `echo ""`,
                    `echo "=== Copy complete ==="`,
                );

                const term = vscode.window.createTerminal({ name: `WxO Copy: ${name} → ${target.label}`, env: getEffectiveEnv() });
                term.show();
                term.sendText(lines.join('\n'));
                vscode.window.showInformationMessage(`WxO: Copying "${name}" to ${target.label} — check the terminal.`);
            },
        ),

        // ── Export single resource ─────────────────────────────────────────────
        vscode.commands.registerCommand(
            'WxO-ToolBox-vsc.exportResource',
            async (item: vscode.TreeItem) => {
                const { resourceType, name } = extractItemInfo(item) ?? {};
                if (!resourceType || !name) { return; }

                const uri = await vscode.window.showOpenDialog({
                    canSelectFolders: true,
                    canSelectMany: false,
                    title: `Export "${name}" — choose output folder`,
                });
                if (!uri?.[0]) { return; }

                const outDir = uri[0].fsPath;
                const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');

                const lines: string[] = [`echo "=== WxO Export: ${resourceType}/${name} → ${outDir} ==="`];

                if (resourceType === 'agents') {
                    const outFile = path.join(outDir, `${safeName}.zip`);
                    lines.push(
                        `( orchestrate agents export -n "${name}" -k native -o "${outFile}" 2>&1 && echo "✓ exported (native)" ) || ` +
                        `( orchestrate agents export -n "${name}" -k external -o "${outFile}" 2>&1 && echo "✓ exported (external)" ) || ` +
                        `( orchestrate agents export -n "${name}" -k assistant -o "${outFile}" 2>&1 && echo "✓ exported (assistant)" ) || ` +
                        `echo "✗ export failed for agent: ${name}"`,
                    );
                } else if (resourceType === 'tools' || resourceType === 'flows' || resourceType === 'plugins') {
                    const outFile = path.join(outDir, `${safeName}.zip`);
                    lines.push(`orchestrate tools export -n "${name}" -o "${outFile}" 2>&1 && echo "✓ exported" || echo "✗ export failed"`);
                } else if (resourceType === 'connections') {
                    const outFile = path.join(outDir, `${safeName}.yml`);
                    lines.push(`orchestrate connections export -a "${name}" -o "${outFile}" 2>&1 && echo "✓ exported" || echo "✗ export failed"`);
                }

                lines.push(`echo "" && echo "=== Done — saved to: ${outDir} ==="`);

                const term = vscode.window.createTerminal({ name: `WxO Export: ${name}`, env: getEffectiveEnv() });
                term.show();
                term.sendText(lines.join('\n'));
            },
        ),

        // ── Import tool from filesystem ───────────────────────────────────────
        vscode.commands.registerCommand(
            'WxO-ToolBox-vsc.importToolFromFilesystem',
            async () => {
                if (!provider.activeEnvironment) {
                    vscode.window.showWarningMessage('WxO: Select an environment first.');
                    return;
                }
                const uri = await vscode.window.showOpenDialog({
                    canSelectFolders: true,
                    canSelectMany: false,
                    title: 'Import Tool — pick a tool folder (Python, OpenAPI, or Flow)',
                });
                if (!uri?.[0]) { return; }

                const folderPath = uri[0].fsPath;
                const detected = provider.service.detectToolInFolder(folderPath);
                if (!detected) {
                    vscode.window.showErrorMessage(
                        'WxO: Not a valid tool folder. Expected:\n' +
                        '  • Python: .py + requirements.txt\n' +
                        '  • OpenAPI: skill_v2.json or openapi.json\n' +
                        '  • Flow: .json with kind "flow"',
                    );
                    return;
                }

                const lines = [
                    `echo "=== WxO Import Tool: ${detected.name} (${detected.kind}) ==="`,
                    `orchestrate env activate "${provider.activeEnvironment}" 2>/dev/null`,
                    detected.cmd,
                    `echo "" && echo "=== Import complete ==="`,
                ];
                const term = vscode.window.createTerminal({ name: `WxO Import: ${detected.name}`, env: getEffectiveEnv() });
                term.show();
                term.sendText(lines.join('\n'));
                vscode.window.showInformationMessage(`WxO: Importing "${detected.name}" (${detected.kind}) — check the terminal.`);
                provider.refresh();
            },
        ),

        // ── Create tool (opens WebView form) ───────────────────────────────────
        vscode.commands.registerCommand(
            'WxO-ToolBox-vsc.createTool',
            () => {
                if (!provider.activeEnvironment) {
                    vscode.window.showWarningMessage('WxO: Select an environment first for import.');
                }
                WxOCreateToolPanel.render(context.extensionUri, provider);
            },
        ),

        // ── Create Agent / Flow / Connection ──────────────────────────────────
        vscode.commands.registerCommand('WxO-ToolBox-vsc.createAgent', () => {
            WxOObjectFormPanel.render(context.extensionUri, provider, 'agents');
        }),
        vscode.commands.registerCommand('WxO-ToolBox-vsc.createFlow', () => {
            WxOObjectFormPanel.render(context.extensionUri, provider, 'flows');
        }),
        vscode.commands.registerCommand('WxO-ToolBox-vsc.createConnection', () => {
            WxOObjectFormPanel.render(context.extensionUri, provider, 'connections');
        }),

        // ── Create plugin (Pre-invoke / Post-invoke) ────────────────────────────
        vscode.commands.registerCommand(
            'WxO-ToolBox-vsc.createPlugin',
            () => {
                if (!provider.activeEnvironment) {
                    vscode.window.showWarningMessage('WxO: Select an environment first for import.');
                }
                WxOCreatePluginPanel.render(context.extensionUri, provider);
            },
        ),

        // ── Edit plugin (dedicated plugin editor panel) ────────────────────────
        vscode.commands.registerCommand(
            'WxO-ToolBox-vsc.editPlugin',
            async (item: vscode.TreeItem) => {
                const info = extractItemInfo(item);
                if (!info || info.resourceType !== 'plugins') {
                    vscode.window.showWarningMessage('WxO: No plugin selected.');
                    return;
                }
                WxOPluginEditorPanel.render(context.extensionUri, provider, info.name);
            },
        ),

        // ── Select environment ─────────────────────────────────────────────────
        vscode.commands.registerCommand(
            'WxO-ToolBox-vsc.selectEnvironment',
            async () => {
                const envs = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'WxO: Loading environments…',
                        cancellable: false,
                    },
                    () => provider.service.listEnvironments(),
                );

                if (envs.length === 0) {
                    vscode.window.showWarningMessage(
                        'No orchestrate environments found. ' +
                        'Ensure the orchestrate CLI is installed and in PATH.',
                    );
                    return;
                }

                const picked = await vscode.window.showQuickPick(
                    envs.map(e => ({
                        label: e,
                        description: e === provider.activeEnvironment ? '$(check) active' : '',
                    })),
                    {
                        placeHolder: 'Select a Watson Orchestrate environment',
                        title: 'WxO ToolBox — Select Environment',
                    },
                );

                if (!picked) { return; }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `WxO: Activating environment "${picked.label}"…`,
                        cancellable: false,
                    },
                    async () => {
                        try {
                            await provider.service.activateEnvironment(picked.label);
                            provider.setEnvironment(picked.label);
                            vscode.window.showInformationMessage(
                                `WxO: Environment "${picked.label}" activated.`,
                            );
                        } catch (err: unknown) {
                            const msg = err instanceof Error ? err.message : String(err);
                            vscode.window.showErrorMessage(
                                `WxO: Failed to activate "${picked.label}": ${msg}`,
                            );
                        }
                    },
                );
            },
        ),

        // ── WxO Project Dir: file / folder commands ───────────────────────────

        /** Open a file from the WxO dir tree. Env-connection files → form editor; others → VS Code editor. */
        vscode.commands.registerCommand('WxO-ToolBox-vsc.openDirFile', async (item: unknown) => {
            const fsPath = (item instanceof WxODirEntryItem) ? item.fsPath
                         : typeof item === 'string' ? item : null;
            if (!fsPath) { return; }
            if (/\.env_connection|\.env_/.test(path.basename(fsPath))) {
                WxOEnvFileEditorPanel.render(context.extensionUri, fsPath);
            } else {
                await vscode.window.showTextDocument(vscode.Uri.file(fsPath), { preview: false });
            }
        }),

        /** Reveal a file or folder in the OS file manager. */
        vscode.commands.registerCommand('WxO-ToolBox-vsc.revealInExplorer', async (item: unknown) => {
            const fsPath = (item instanceof WxODirEntryItem || item instanceof WxODirRootItem)
                ? (item instanceof WxODirEntryItem ? item.fsPath : item.wxoRoot)
                : null;
            if (!fsPath) { return; }
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fsPath));
        }),

        /** Copy the file / folder path to clipboard. */
        vscode.commands.registerCommand('WxO-ToolBox-vsc.copyFilePath', async (item: unknown) => {
            const fsPath = (item instanceof WxODirEntryItem) ? item.fsPath
                         : (item instanceof WxODirRootItem) ? item.wxoRoot : null;
            if (!fsPath) { return; }
            await vscode.env.clipboard.writeText(fsPath);
            vscode.window.showInformationMessage(`Copied path: ${fsPath}`);
        }),

        /** Create a new file inside a folder (or WxO root). */
        vscode.commands.registerCommand('WxO-ToolBox-vsc.newDirFile', async (item: unknown) => {
            const dirPath = (item instanceof WxODirEntryItem && !item.isFile) ? item.fsPath
                          : (item instanceof WxODirRootItem) ? item.wxoRoot : null;
            if (!dirPath) { vscode.window.showWarningMessage('WxO: Select a folder first.'); return; }
            const name = await vscode.window.showInputBox({ prompt: 'New file name', placeHolder: 'filename.yaml' });
            if (!name?.trim()) { return; }
            const fullPath = path.join(dirPath, name.trim());
            if (fs.existsSync(fullPath)) {
                vscode.window.showErrorMessage(`Already exists: ${fullPath}`);
                return;
            }
            fs.writeFileSync(fullPath, '', 'utf8');
            provider.refresh();
            await vscode.window.showTextDocument(vscode.Uri.file(fullPath), { preview: false });
        }),

        /** Create a new subfolder. */
        vscode.commands.registerCommand('WxO-ToolBox-vsc.newDirFolder', async (item: unknown) => {
            const dirPath = (item instanceof WxODirEntryItem && !item.isFile) ? item.fsPath
                          : (item instanceof WxODirRootItem) ? item.wxoRoot : null;
            if (!dirPath) { vscode.window.showWarningMessage('WxO: Select a folder first.'); return; }
            const name = await vscode.window.showInputBox({ prompt: 'New folder name', placeHolder: 'FolderName' });
            if (!name?.trim()) { return; }
            const fullPath = path.join(dirPath, name.trim());
            if (fs.existsSync(fullPath)) {
                vscode.window.showErrorMessage(`Already exists: ${fullPath}`);
                return;
            }
            fs.mkdirSync(fullPath, { recursive: true });
            provider.refresh();
        }),

        /** Rename a file or folder. */
        vscode.commands.registerCommand('WxO-ToolBox-vsc.renameDirItem', async (item: unknown) => {
            if (!(item instanceof WxODirEntryItem)) { return; }
            const oldPath = item.fsPath;
            const oldName = path.basename(oldPath);
            const newName = await vscode.window.showInputBox({ prompt: 'Rename to', value: oldName });
            if (!newName?.trim() || newName.trim() === oldName) { return; }
            const newPath = path.join(path.dirname(oldPath), newName.trim());
            if (fs.existsSync(newPath)) {
                vscode.window.showErrorMessage(`Already exists: ${newPath}`);
                return;
            }
            fs.renameSync(oldPath, newPath);
            provider.refresh();
            vscode.window.showInformationMessage(`Renamed to: ${newName.trim()}`);
        }),

        /** Delete a file or folder (with confirmation). */
        vscode.commands.registerCommand('WxO-ToolBox-vsc.deleteDirItem', async (item: unknown) => {
            if (!(item instanceof WxODirEntryItem)) { return; }
            const fsPath = item.fsPath;
            const label = path.basename(fsPath);
            const choice = await vscode.window.showWarningMessage(
                `Delete "${label}"? This cannot be undone.`,
                { modal: true }, 'Delete',
            );
            if (choice !== 'Delete') { return; }
            if (item.isFile) {
                fs.unlinkSync(fsPath);
            } else {
                fs.rmSync(fsPath, { recursive: true, force: true });
            }
            provider.refresh();
            vscode.window.showInformationMessage(`Deleted: ${label}`);
        }),

        /** Open WxO root folder in a new terminal. */
        vscode.commands.registerCommand('WxO-ToolBox-vsc.openDirInTerminal', async (item: unknown) => {
            const dirPath = (item instanceof WxODirEntryItem && !item.isFile) ? item.fsPath
                          : (item instanceof WxODirRootItem) ? item.wxoRoot : null;
            if (!dirPath) { return; }
            const term = vscode.window.createTerminal({ name: 'WxO Dir', cwd: dirPath, env: getEffectiveEnv() });
            term.show();
        }),

    );
}

/** Cleanup on extension deactivation. */
export function deactivate() {}

// ── Helpers ───────────────────────────────────────────────────────────────────

type ResourceType = 'agents' | 'tools' | 'flows' | 'connections' | 'plugins';

/**
 * Extract resource type and name from a TreeItem (from contextValue and label).
 * @param item - Tree item from the Activity Bar view
 * @returns `{ resourceType, name }` or null if not a resource item
 */
function extractItemInfo(item: vscode.TreeItem): { resourceType: ResourceType; name: string } | null {
    const ctx = typeof item.contextValue === 'string' ? item.contextValue : '';
    const rawType = ctx.replace('wxo-resource-', '');
    if (!['agents', 'tools', 'flows', 'connections', 'plugins'].includes(rawType)) { return null; }
    // Prefer resourceName (API id) when item has it; fall back to label for connections/legacy
    const resourceItem = item as vscode.TreeItem & { resourceName?: string };
    const name = resourceItem.resourceName ?? (typeof item.label === 'string'
        ? item.label
        : (item.label as vscode.TreeItemLabel | undefined)?.label ?? '');
    if (!name) { return null; }
    return { resourceType: rawType as ResourceType, name };
}

/** Returns the first workspace folder path, or process.cwd() if none. */
function getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
    return process.cwd();
}

/** Path to folder containing import_to_wxo.sh, or null if not found.
 * Checks: (1) bundled extension scripts, (2) scriptsPath config, (3) workspace candidates. */
function getScriptsDirForCopy(extensionPath?: string): string | null {
    if (extensionPath) {
        const bundled = path.join(extensionPath, 'scripts');
        if (fs.existsSync(path.join(bundled, 'import_to_wxo.sh'))) return bundled;
    }
    const cfg = vscode.workspace.getConfiguration('WxO-ToolBox-vsc');
    const custom = cfg.get<string>('scriptsPath')?.trim();
    if (custom) {
        const p = path.isAbsolute(custom) ? custom : path.join(getWorkspaceRoot(), custom);
        if (fs.existsSync(path.join(p, 'wxo_exporter_importer.sh'))) return p;
        if (fs.existsSync(path.join(p, 'import_to_wxo.sh'))) return p;
        return null;
    }
    const ws = getWorkspaceRoot();
    for (const p of [ws, path.join(ws, 'internal', 'WxOImporterAndExporter'), path.join(ws, 'WxOImporterAndExporter')]) {
        if (fs.existsSync(path.join(p, 'import_to_wxo.sh'))) return p;
    }
    return null;
}

/** Root folder for WxO Exports, Imports, Systems. From config or default WxO/. */
function getWxORoot(): string {
    const cfg = vscode.workspace.getConfiguration('WxO-ToolBox-vsc');
    const custom = cfg.get<string>('wxoRoot')?.trim();
    if (custom) {
        return path.isAbsolute(custom) ? custom : path.join(getWorkspaceRoot(), custom);
    }
    return path.join(getWorkspaceRoot(), 'WxO');
}

