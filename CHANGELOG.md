# Changelog

All notable changes to the WxO ToolBox VS Code extension ([wxo-toolkit-vsc](https://github.com/markusvankempen/wxo-toolkit-vsc)).

## [1.2.4] - 2026-02-27

### Added

- **Toolkits category** — MCP servers (e.g. `wxo-coingecko-demo`) appear in a separate Toolkits category with nested tools (e.g. `get_global`, `get_coins_markets`). Toolkit tools are no longer mixed with regular Tools.
- **Search Resources** — Quick Pick command to search across agents, tools, toolkit tools, flows, plugins, and connections. Type to filter; select to open JSON definition. Available from the view title bar (search icon) or Command Palette.
- **Filter Resources** — Filter the tree by name across all categories. Use the filter icon in the view title; enter a term to narrow results. Clear Filter appears when a filter is active.

### Changed

- **Tools category** — Regular tools (Python, OpenAPI, etc.) only; toolkit/MCP tools moved to Toolkits.

---

## [1.2.3] - 2026-02-27

### Added

- **Observability tab** — Search traces (`orchestrate observability traces search`) and export trace spans as JSON (`orchestrate observability traces export`). Requires ADK 2.5.0+ and watsonx Orchestrate SaaS or Developer Edition with `--with-ibm-telemetry`. Exports saved to `WxO/Observability/{env}/` by default.

---

## [1.2.2] - 2026-03-01

### Added

- **Screenshots in documentation** — README and USER_GUIDE now include screenshots: Panel, Create Connection, Edit Tool, Export Panel, Export Report, System Compare, Delete Multiple Tools.

---

## [1.2.1] - 2026-03-01

### Changed

- **Synced CLI scripts** — Bundled scripts (`wxo_exporter_importer.sh`, `export_from_wxo.sh`, `import_to_wxo.sh`, `compare_wxo_systems.sh`) updated to wxo-toolkit 1.0.8. Includes Python module collision fix for tools like `dad_joke_plugin`, `greeting_prefix_plugin`, `check_ticket_status` (avoids "No module named 'X.X'; 'X' is not a package" on import).

---

## [1.2.0] - 2026-02-28

### Added

- **Remove tool from agents when deleting** — When deleting a tool, flow, or plugin, you can optionally remove it from all agent assignments first (avoids orphaned references). Available in both the Activity Bar delete and the Danger Zone interactive script. Uses `remove_tool_from_agents.sh` (orchestrate CLI only; requires jq, python3 + PyYAML).
- **Create Agent / Flow / Connection** — Inline "Create" buttons in the Activity Bar for each category; opens form-based editors to create new resources and import via CLI.
- **Edit forms** — Edit Agent, Flow, Connection, and Tool now open form views (not raw JSON). Form fields stay synced with the YAML/JSON editor; save pushes changes via orchestrate CLI.
- **Connection form with auth** — Create/Edit Connection supports API Key, Bearer Token, Basic Auth, and OAuth flows (Client Credentials, Password, Auth Code, On-Behalf-Of, Token Exchange). Integrates with `orchestrate connections set-credentials` for live connections.
- **Systems Edit button** — "Edit" next to each environment in the Systems tab opens that system's connection credentials file (`.env_connection_{env}`) in the form editor.
- **Object picker for Export/Import/Replicate** — "Pick specific objects by name" option to select individual agents, tools, or connections instead of exporting/importing a whole category. Use "Load from env" to populate checkboxes from the active environment.
- **WxO Project Dir context menus** — Right-click on folders and files: New File, New Folder, Rename, Delete, Reveal in Explorer, Copy Path, Open in Terminal. `.env_connection_*` files open in the credential form editor.
- **Plugin editor** — Dedicated form for editing plugins (agent_pre_invoke/agent_post_invoke). Exports to `WxO/Edits/{name}/`, edit source files, re-import via CLI.
- **Multi-select for delete** — Shift-click or Ctrl/Cmd-click to select multiple agents, tools, or flows; Delete key removes all selected.
- **Persistent Edits directory** — Tools and plugins are exported to `WxO/Edits/{name}/` for editing; files persist in the workspace instead of temp folders.

### Changed

- **Edit Tool** — Python and OpenAPI tools now open in the Create Tool form (pre-filled) instead of raw JSON.
- **Resource Actions** — Edit (open form) replaces inline JSON editing for agents, flows, connections, and tools.

### Fixed

- **Webview JavaScript errors** — Replaced inline `onclick`/`onchange` handlers with `addEventListener` to comply with VS Code webview CSP (`switchTab is not defined`, etc.).
- **package.json parse error** — Removed JavaScript-style comments from `package.json` (JSON does not support comments).

---

## [1.1.0] - 2026-02-25

### Added

- **Extension-first credentials** — API keys are stored in VS Code SecretStorage (encrypted). Add Environment in the Systems tab now syncs to orchestrate CLI and stores credentials securely.
- **Copy to .env** — New button in Systems tab to copy stored credentials to workspace `.env` (optional).
- **SETUP.md** — Setup guide with Mermaid flow diagrams for credentials flow, add environment, and script execution.
- **Credential merge** — Export, Import, Compare, Replicate, and Create Tool merge SecretStorage + `.env`; SecretStorage takes precedence.

### Changed

- **Add Environment** — API key is now recommended; when provided, credentials are saved to SecretStorage and `orchestrate env activate` is run so orchestrate config is populated.
- **WxOEnvironmentService** — `activateEnvironment` checks SecretStorage first, then `.env`.
- **Script execution** — Scripts receive a merged env file (SecretStorage + workspace `.env`) when credentials are in extension storage.
- **Documentation** — USER_GUIDE and README updated for the new flow; SETUP.md added with flow diagrams.

---

## [1.0.1] - 2026-02-25

### Added

- **Python venv documentation** — README, USER_GUIDE, Help tab, and Dependencies pane now explain how to set `orchestrateVenvPath` when orchestrate CLI is in a virtual environment
- **Marketplace discoverability** — Categories (Machine Learning, Data Science, Testing, Other), expanded keywords, and updated description for better findability on VS Code Marketplace and Open VSX

### Changed

- Improved `orchestrateVenvPath` setting description in Settings UI
- Enhanced USER_GUIDE with venv path examples table

### Fixed

- **Packaging** — Added tslib dependency and npm overrides so `npm run package` succeeds (vsce/@azure/identity requires tslib)

---

## [1.0.0] - 2026-02-27

### Added

- **Activity Bar view** — Browse agents, tools, flows, connections with display names
- **Main Panel** — Export, Import, Compare, Replicate, Systems, Secrets, Dependencies, Help tabs
- **Latest report links** — Export, Import, Compare, Replicate tabs show "Latest report: 📄 Open Report" with Refresh button
- **Create Tool form** — Create Python or OpenAPI tools; output to `WxO/Exports/{env}/{datetime}/tools/{name}` (matches Export structure)
- **Import what** — Choose to import all, agents only, tools only, flows only, or connections only
- **Display names** — Tools and flows show `display_name` in the Activity Bar (fallback to `name`)
- **WxO Project Dir tree** — Browse all subdirectories and files (depth 50)
- **Inline actions** — View JSON, Export, Copy, Edit, Compare, Delete on each resource
- **Systems management** — Add, activate, remove Watson Orchestrate environments
- **Secrets editor** — Edit connection credentials per environment
- **Bundled scripts** — wxo-toolkit-cli scripts included; optional `scriptsPath` override

### Configuration

- `wxo-toolkit-vsc.scriptsPath` — Path to wxo-toolkit-cli scripts (default: use bundled)
- `wxo-toolkit-vsc.wxoRoot` — WxO project root (default: `{workspaceRoot}/WxO`)
- `wxo-toolkit-vsc.debugPanel` — Write panel HTML for browser debugging
