/**
 * WxO ToolBox — Credentials Service
 * Stores API keys in VS Code SecretStorage (encrypted, not in settings.json).
 * Primary source for activation; falls back to workspace .env.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const SECRET_KEY_PREFIX = 'wxo-toolkit-vsc.apiKey.';
const ENV_LIST_KEY = 'wxo-toolkit-vsc.envNames';

export class WxOCredentialsService {
    constructor(private readonly _secrets: vscode.SecretStorage) {}

    /** Get API key for an environment. Checks SecretStorage first, then workspace .env. */
    async getApiKey(envName: string): Promise<string | undefined> {
        const stored = await this._getStoredApiKey(envName);
        if (stored) return stored;

        const envFile = this._findEnvFile();
        if (envFile) {
            const vars = this._parseEnvFile(envFile);
            return vars[`WXO_API_KEY_${envName}`];
        }
        return undefined;
    }

    /** Get API key from SecretStorage only (no .env fallback). */
    private async _getStoredApiKey(envName: string): Promise<string | undefined> {
        const key = SECRET_KEY_PREFIX + envName;
        return this._secrets.get(key) ?? undefined;
    }

    /** Store API key in SecretStorage (encrypted). */
    async setApiKey(envName: string, apiKey: string): Promise<void> {
        const key = SECRET_KEY_PREFIX + envName;
        await this._secrets.store(key, apiKey);
        const list = await this._getEnvNamesList();
        if (!list.includes(envName)) {
            await this._secrets.store(ENV_LIST_KEY, [...list, envName].join(','));
        }
    }

    /** Remove stored API key. */
    async deleteApiKey(envName: string): Promise<void> {
        const key = SECRET_KEY_PREFIX + envName;
        await this._secrets.delete(key);
        const list = (await this._getEnvNamesList()).filter(n => n !== envName);
        if (list.length > 0) {
            await this._secrets.store(ENV_LIST_KEY, list.join(','));
        } else {
            await this._secrets.delete(ENV_LIST_KEY);
        }
    }

    /**
     * Copy stored credentials to workspace .env.
     * Writes WXO_API_KEY_<env> for each env we have a key for.
     * Preserves existing .env content; updates or appends keys.
     */
    async copyToWorkspaceEnv(): Promise<string> {
        const envNames = await this._getEnvNamesList();
        const envFile = this._findEnvFile();
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const filePath = envFile ?? (wsRoot ? path.join(wsRoot, '.env') : '');
        if (!filePath) throw new Error('No workspace folder to write .env');

        let content = envFile ? fs.readFileSync(envFile, 'utf8') : '';
        const vars = envFile ? this._parseEnvFile(envFile) : {};

        for (const name of envNames) {
            const key = await this._getStoredApiKey(name);
            if (key) vars[`WXO_API_KEY_${name}`] = key;
        }

        const lines: string[] = [];
        const written = new Set<string>();
        for (const line of content.split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#')) {
                lines.push(line);
                continue;
            }
            const eq = t.indexOf('=');
            if (eq < 0) {
                lines.push(line);
                continue;
            }
            const k = t.slice(0, eq).trim();
            if (vars[k] !== undefined) {
                lines.push(`${k}=${vars[k]}`);
                written.add(k);
            } else {
                lines.push(line);
            }
        }
        for (const [k, v] of Object.entries(vars)) {
            if (!written.has(k)) lines.push(`${k}=${v}`);
        }
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
        return filePath;
    }

    private async _getEnvNamesList(): Promise<string[]> {
        const raw = await this._secrets.get(ENV_LIST_KEY);
        if (!raw) return [];
        return raw.split(',').map(s => s.trim()).filter(Boolean);
    }

    /** Check if we have a stored key for this env (SecretStorage only). */
    async hasStoredKey(envName: string): Promise<boolean> {
        const v = await this._getStoredApiKey(envName);
        return !!v;
    }

    /**
     * Build merged env file content for script runs.
     * Starts with workspace .env, overlays WXO_API_KEY_* from SecretStorage for the given envs.
     * Returns path to a temp file to use as ENV_FILE; caller must unlink when done.
     */
    async buildEnvFileForScripts(envNames: string[]): Promise<string> {
        const baseContent = this._readWorkspaceEnv();
        const overrides: Record<string, string> = {};

        for (const name of envNames) {
            const key = await this.getApiKey(name); // use getApiKey to include .env fallback
            if (key) overrides[`WXO_API_KEY_${name}`] = key;
        }

        const merged = this._mergeEnvContent(baseContent, overrides);
        const tmpPath = path.join(os.tmpdir(), `wxo-env-${Date.now()}.env`);
        fs.writeFileSync(tmpPath, merged, 'utf8');
        return tmpPath;
    }

    private _findEnvFile(): string | undefined {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const candidates = folders.flatMap(f => [
            path.join(f.uri.fsPath, '.env'),
            path.join(f.uri.fsPath, 'internal', 'WxOImporterAndExporter', '.env'),
        ]);
        return candidates.find(p => fs.existsSync(p));
    }

    private _parseEnvFile(filePath: string): Record<string, string> {
        const vars: Record<string, string> = {};
        for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const eq = t.indexOf('=');
            if (eq < 0) continue;
            vars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
        }
        return vars;
    }

    private _readWorkspaceEnv(): string {
        const envFile = this._findEnvFile();
        if (!envFile) return '';
        return fs.readFileSync(envFile, 'utf8');
    }

    private _mergeEnvContent(baseContent: string, overrides: Record<string, string>): string {
        const vars: Record<string, string> = {};
        for (const line of baseContent.split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const eq = t.indexOf('=');
            if (eq < 0) continue;
            vars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
        }
        Object.assign(vars, overrides);
        return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n');
    }
}
