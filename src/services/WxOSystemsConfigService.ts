/**
 * WxO Systems Config Service
 * Extension as source of truth for Watson Orchestrate environments.
 * Stores name + URL in WxO/Systems/systems.json; API keys in SecretStorage.
 * Syncs to orchestrate CLI on add/remove/update.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 28 Feb 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getCredentialsService } from './credentialsContext.js';

export interface WxOSystemEntry {
    name: string;
    url: string;
}

const SYSTEMS_FILE = 'systems.json';

export class WxOSystemsConfigService {
    constructor(private readonly _getWxORoot: () => string) {}

    private _getSystemsFilePath(): string {
        const root = this._getWxORoot();
        const dir = path.join(root, 'Systems');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return path.join(dir, SYSTEMS_FILE);
    }

    private _loadRaw(): { systems: WxOSystemEntry[] } {
        const filePath = this._getSystemsFilePath();
        if (!fs.existsSync(filePath)) {
            return { systems: [] };
        }
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw) as { systems?: WxOSystemEntry[] };
            const systems = Array.isArray(parsed.systems) ? parsed.systems : [];
            return { systems: systems.filter((s) => s && typeof s.name === 'string' && typeof s.url === 'string') };
        } catch {
            return { systems: [] };
        }
    }

    private _save(data: { systems: WxOSystemEntry[] }): void {
        const filePath = this._getSystemsFilePath();
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }

    /** Load all systems from config (extension source of truth). */
    loadSystems(): WxOSystemEntry[] {
        return this._loadRaw().systems;
    }

    /** Add or update a system. If name exists, updates URL. */
    saveSystem(name: string, url: string): void {
        const data = this._loadRaw();
        const idx = data.systems.findIndex((s) => s.name === name);
        const entry: WxOSystemEntry = { name, url };
        if (idx >= 0) {
            data.systems[idx] = entry;
        } else {
            data.systems.push(entry);
        }
        this._save(data);
    }

    /** Remove a system from config. */
    removeSystem(name: string): void {
        const data = this._loadRaw();
        data.systems = data.systems.filter((s) => s.name !== name);
        this._save(data);
    }

    /** Get a system by name. */
    getSystem(name: string): WxOSystemEntry | undefined {
        return this._loadRaw().systems.find((s) => s.name === name);
    }

    /** Merge orchestrate env list with our config. Returns merged list (orchestrate = source for existence, our config = source for URL when we have it). */
    mergeWithOrchestrateList(orchestrateEnvs: Array<{ name: string; url: string; active: boolean }>): Array<{ name: string; url: string; active: boolean }> {
        const ourConfig = this._loadRaw().systems;
        const ourMap = new Map(ourConfig.map((s) => [s.name, s.url]));

        return orchestrateEnvs.map((e) => ({
            name: e.name,
            url: ourMap.get(e.name) ?? e.url,
            active: e.active,
        }));
    }

    /** Bootstrap: if our config is empty, import from orchestrate env list. */
    ensureBootstrap(orchestrateEnvs: Array<{ name: string; url: string; active: boolean }>): void {
        const data = this._loadRaw();
        if (data.systems.length > 0) return;
        if (orchestrateEnvs.length === 0) return;
        data.systems = orchestrateEnvs.map((e) => ({ name: e.name, url: e.url }));
        this._save(data);
    }
}
