/**
 * WxO ToolBox — Environment helpers for orchestrate CLI (including Python venv)
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 27 Feb 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

function getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
    return process.cwd();
}

/**
 * Returns process env with PATH adjusted when orchestrate is in a Python venv.
 * If `WxO-ToolBox-vsc.orchestrateVenvPath` is set, prepends venv/bin to PATH
 * so the orchestrate CLI is found. Use this for all orchestrate/script invocations.
 */
export function getEffectiveEnv(): NodeJS.ProcessEnv {
    const cfg = vscode.workspace.getConfiguration('WxO-ToolBox-vsc');
    const venvPath = cfg.get<string>('orchestrateVenvPath')?.trim();
    if (!venvPath) return process.env;

    const ws = getWorkspaceRoot();
    const resolved = path.isAbsolute(venvPath)
        ? venvPath
        : path.join(ws, venvPath);
    const venvBin = path.join(resolved, 'bin');
    const orchestratePath = path.join(venvBin, 'orchestrate');

    if (!fs.existsSync(orchestratePath)) {
        return process.env; // venv path invalid; fall back to default PATH
    }

    const sep = path.delimiter;
    const existingPath = process.env.PATH || process.env.Path || '';
    return {
        ...process.env,
        PATH: `${venvBin}${sep}${existingPath}`,
        Path: `${venvBin}${sep}${existingPath}`,
    };
}
