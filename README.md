# WxO ToolBox — VS Code Extension (wxo-toolkit-vsc)

**IBM Watsonx Orchestrate**

*Author: Markus van Kempen · 28 Feb 2026*

**Repository:** [github.com/markusvankempen/wxo-toolkit-vsc](https://github.com/markusvankempen/wxo-toolkit-vsc)

Export, import, compare, and replicate Watson Orchestrate agents, tools, flows, and connections via the orchestrate CLI from VS Code. Uses the [**WxO-Importer-Export-Comparer-Validator**](https://github.com/markusvankempen/WxO-Importer-Export-Comparer-Validator) CLI scripts (wxo-toolkit-cli) bundled with the extension. Standalone extension (independent of wxo-builder).

## Features

- **Activity Bar** — Browse agents, tools, **toolkits** (MCP servers with nested tools), flows, connections, and plugins with display names; inline Create/Edit (form-based), View JSON, Export, Copy, Compare, Delete; multi-select (Shift/Ctrl+click) for bulk delete
- **Search & Filter** — Search Resources (Quick Pick across all resources); Filter tree by name; Clear Filter when active
- **Create Agent / Flow / Connection / Tool** — Form-based creation with YAML/JSON editor; Connection form supports API Key, Bearer, Basic Auth, OAuth flows
- **Edit forms** — Edit opens pre-filled forms (not raw JSON) for agents, flows, connections, and tools; changes sync to YAML/JSON; save pushes via orchestrate CLI
- **Main Panel** — Export, Import, Compare, Replicate, Systems, **Observability**, Secrets, Dependencies, Help
- **Object picker** — Export/Import/Replicate: pick specific agents, tools, or connections by name (checkbox list from env)
- **Latest Report links** — Each tab shows a link to the most recent report with Refresh button
- **Systems** — Add, activate, **Edit** (opens credential form), remove Watson Orchestrate environments
- **Observability** — Search and export traces (ADK 2.5.0+; watsonx Orchestrate SaaS or Developer Edition with telemetry)
- **Secrets** — Edit connection credentials per environment; `.env_connection_*` files open in form editor
- **WxO Project Dir** — Tree view with context menus (New File/Folder, Rename, Delete, Reveal, Copy Path, Open in Terminal)

## Screenshots

| Panel & Export | Create Connection | Edit Tool |
|----------------|-------------------|-----------|
| ![WxO Toolkit Panel](resources/wxo-toolkit-Panel.png) | ![Create Connection](resources/wxo-tookkit-CreateConnection.png) | ![Edit Tool](resources/wxo-toolkit-EditTool.png) |

| Export | Export Report | Compare | Delete |
|--------|---------------|---------|--------|
| ![Export Panel](resources/wxo-toolkit-ExportPanel.png) | ![Export Report](resources/wxo-toolkit-ExportReport.png) | ![System Compare](resources/wxo-toolkit-SystemCompareReport.png) | ![Delete Multiple](resources/wxp-toolkit-DeleteMultipleTools.png) |

## Usage

1. Open any workspace. The extension bundles the wxo-toolkit-cli scripts.
2. In the Activity Bar, click **WxO ToolBox** (↔ icon) → **Select Environment** to choose a Watson Orchestrate instance.
3. **Open Panel** to access Export, Import, Compare, Replicate, and more.
4. Use inline buttons on each resource for quick actions.

## Documentation

- **User Guide** — Run **WxO ToolBox: Open User Guide** from the Command Palette, or open the **Help** tab in the panel.
- Full guide: `USER_GUIDE.md` in this folder.

## Related

| Repo | Description |
|------|--------------|
| [WxO-Importer-Export-Comparer-Validator](https://github.com/markusvankempen/WxO-Importer-Export-Comparer-Validator) | CLI toolkit (shell scripts) — the scripts this extension bundles and runs. Use it standalone for terminal-based Export/Import/Compare. |
| [WxO-ToolBox-VSC](https://github.com/markusvankempen/WxO-ToolBox-VSC) | Future standalone repository for the WxO ToolBox VS Code extension. Currently the extension lives inside the watsonx-orchestrate-devkit monorepo; this repo will eventually become the primary home. |

## Install from source

```bash
# Clone the repo (or use existing checkout)
git clone https://github.com/markusvankempen/wxo-toolkit-vsc.git
cd wxo-toolkit-vsc

npm install
npm run compile
```

Then in VS Code: **Run and Debug** → **Run Extension** (F5).

*When developing within the watson-orchestrate-builder monorepo, use `watsonx-orchestrate-devkit/packages/wxo-toolkit/vscode-extension` as the working directory.*

## Package for publishing

```bash
cd wxo-toolkit-vsc   # or watsonx-orchestrate-devkit/packages/wxo-toolkit/vscode-extension
npm run package
```

Produces `wxo-toolkit-vsc-1.2.4.vsix` (version from package.json). Install via **Extensions** → "..." → **Install from VSIX**.

See `PUBLISHING.md` for publishing to VS Code Marketplace and Open VSX.

### Files included in the VSIX

| File | Purpose |
|------|---------|
| `package.json` | Extension manifest |
| `dist/extension.js` | Bundled extension (esbuild) |
| `resources/*` | Icons, webview assets |
| `USER_GUIDE.md` | Full user guide (Help tab, Command Palette) |
| `SETUP.md` | Setup flow diagrams and detailed guide |
| `README.md` | Marketplace listing |

## Quick setup

1. **Add environment** — Open Panel → Systems tab → Add Environment (Name, URL, API Key)
2. Credentials are stored securely and synced to the orchestrate CLI
3. Export, Import, Compare, and Create Tool work immediately

See [SETUP.md](SETUP.md) for flow diagrams and a detailed guide.

## Using orchestrate in a Python venv

If you install the orchestrate CLI inside a Python virtual environment (e.g. `pip install ibm-watsonx-orchestrate` inside a venv), the extension needs to know where it is:

1. **Settings** → search `orchestrateVenvPath` (or **WxO Toolkit**)
2. Set **Orchestrate Venv Path** to your venv folder:
   - Workspace-relative: `.venv` or `venv` (if the venv is in your workspace root)
   - Absolute: `/path/to/your/venv`

The extension prepends `venv/bin` to `PATH` for all CLI operations. If you don't set this, Export/Import/Compare may fail with "orchestrate: command not found".

## Settings

| Setting | Description |
|---------|-------------|
| `wxo-toolkit-vsc.scriptsPath` | Path to wxo-toolkit-cli scripts folder. Leave empty to use bundled scripts. |
| `wxo-toolkit-vsc.wxoRoot` | WxO Project Dir (default: `{workspaceRoot}/WxO`) |
| `wxo-toolkit-vsc.orchestrateVenvPath` | Path to Python venv where orchestrate CLI is installed (e.g. `.venv`). **Required when orchestrate is in a venv** — see above. |
| `wxo-toolkit-vsc.debugPanel` | Write panel HTML to `.vscode/wxo-panel-debug.html` for debugging |
