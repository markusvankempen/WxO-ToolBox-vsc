# WxO ToolBox — Setup Guide

**VS Code Extension** (WxO-ToolBox-vsc) · IBM Watsonx Orchestrate · v2.0.2

*Author: Markus van Kempen · 06 Mar 2026*

This guide walks you through configuring the WxO ToolBox extension with a **single, simple flow**: configure in the extension first, then optionally copy to orchestrate or `.env`.

---

## Credentials Flow Overview

```mermaid
flowchart TB
    subgraph Primary["Primary: Extension (Recommended)"]
        UI[Systems tab: Add Environment]
        Form[Name + URL + API Key]
        SecretStorage[(SecretStorage)]
        OrchestrateSync[orchestrate env add + activate]
    end

    subgraph Secondary["Secondary: Optional Sync"]
        CopyBtn["Copy to .env button"]
        DotEnv[Workspace .env file]
    end

    subgraph Scripts["Scripts Use"]
        Export[Export]
        Import[Import]
        Compare[Compare]
    end

    UI --> Form
    Form -->|"API key entered"| SecretStorage
    Form -->|"Add"| OrchestrateSync
    SecretStorage -->|"Merged at run time"| Export
    SecretStorage --> Import
    SecretStorage --> Compare
    CopyBtn -->|"Optional"| DotEnv
```

---

## Step-by-Step Setup

### 1. Install Prerequisites

- **orchestrate CLI (ADK 2.5.0+)** — `pip install --upgrade ibm-watsonx-orchestrate`
- **jq** — `brew install jq` (macOS) or `apt-get install jq` (Linux)
- **unzip** — usually preinstalled

**Python venv?** If orchestrate is in a virtual environment, set **Settings** → `orchestrateVenvPath` → `.venv` (or your venv path).

### Python venv Decision Flow

```mermaid
flowchart TD
    A[Install orchestrate CLI] --> B{Installed inside\na Python venv?}
    B -->|No — global install| C[Extension finds it\nautomatically via PATH]
    B -->|Yes — venv install| D[Open VS Code Settings\nSearch: orchestrateVenvPath]
    D --> E[Set value to venv folder\ne.g. .venv or /home/me/venv]
    E --> F[Extension prepends\nvenv/bin to PATH]
    F --> C
    C --> G[Export · Import · Compare\nCreate Tool · Systems — all work]
```

### 2. Add Your First Environment (Extension UI)

1. Open **WxO ToolBox** in the Activity Bar.
2. Click **Open Panel**.
3. Go to the **⊕ Systems** tab.
4. Fill in **Add Environment**:
   - **Name** — e.g. `TZ1`
   - **URL** — e.g. `https://api.us-south.watson-orchestrate.cloud.ibm.com/instances/...`
   - **API Key** — paste your API key (recommended; stored securely)
5. Click **+ Add Environment**.

**What happens:**
- The extension runs `orchestrate env add` and `orchestrate env activate --api-key`.
- Your API key is stored in VS Code **SecretStorage** (encrypted, not in `settings.json`).
- Export, Import, Compare, and Create Tool will use these credentials automatically.

### 3. Optional: Copy to Workspace `.env`

If you want credentials in a workspace `.env` file (e.g. for terminal use or sharing):

1. In **Systems** tab, click **📋 Copy to .env**.
2. This writes `WXO_API_KEY_<env>` for each stored environment to your workspace `.env`.

---

## Auto-Reconnect on Startup

The extension persists the last active environment across VS Code restarts and silently re-activates it on startup.

```mermaid
flowchart TD
    A[VS Code starts\nExtension activates] --> B{Last active env\nstored in workspaceState?}
    B -->|No| C[Show empty tree\nUser picks environment manually]
    B -->|Yes| D[Call orchestrate env activate\nsilently in background]
    D --> E{Activation result}
    E -->|Success| F[Tree loads with\nlast environment]
    E -->|Fail — session expired| G{API key in\nSecretStorage?}
    G -->|Yes| H[Re-authenticate with key\nand retry activation]
    H --> F
    G -->|No| I[Show warning notification\n'Could not reactivate — Select Environment']
    I --> C

    J[User opens Select Environment picker] --> K[Silent activate current env\nbefore showing picker]
    K --> L[Show environment list]
    L --> M[User picks env]
    M --> N[Activate + persist to workspaceState]
```

> **Tip:** To enable fully automatic reconnection, always add environments via **Systems → Add Environment** with an API key. The key is stored in VS Code SecretStorage and used for silent re-activation.

---

## Credential Resolution Order

```mermaid
flowchart LR
    A[Need API key] --> B{SecretStorage?}
    B -->|Yes| C[Use it]
    B -->|No| D{.env?}
    D -->|Yes| E[Use WXO_API_KEY_<env>]
    D -->|No| F[orchestrate cached / prompt]
    C --> G[Activate + run]
    E --> G
    F --> G
```

| Priority | Source | When used |
|----------|--------|-----------|
| 1 | Extension SecretStorage | When you add env with API key in Systems tab |
| 2 | Workspace `.env` | `WXO_API_KEY_TZ1=...` |
| 3 | orchestrate CLI config | Previously activated with `orchestrate env activate` |

---

## Flow: Add Environment (Detailed)

```mermaid
sequenceDiagram
    participant User
    participant Panel
    participant Creds
    participant Orchestrate

    User->>Panel: Fill name, URL, API key
    User->>Panel: Click Add Environment
    Panel->>Orchestrate: orchestrate env add -n X -u URL
    alt API key provided
        Panel->>Creds: setApiKey(env, key)
        Panel->>Orchestrate: orchestrate env activate X --api-key KEY
    end
    Panel->>User: "Environment added. Credentials stored securely."
```

---

## Flow: Running Export/Import (Detailed)

```mermaid
sequenceDiagram
    participant User
    participant Panel
    participant Creds
    participant Script

    User->>Panel: Run Export (env=TZ1)
    Panel->>Creds: buildEnvFileForScripts([TZ1])
    Creds->>Creds: Merge SecretStorage + .env
    Creds-->>Panel: temp file path
    Panel->>Script: spawn(export_from_wxo.sh, ENV_FILE=temp)
    Script->>Script: source ENV_FILE, orchestrate env activate
    Script-->>User: Export report
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "orchestrate: command not found" | Install orchestrate CLI; if in venv, set `orchestrateVenvPath` |
| "API key required" | Add environment with API key in Systems tab, or add `WXO_API_KEY_<env>` to `.env` |
| "No environments found" | Add at least one environment in Systems tab |
| Scripts fail with missing key | Use **Copy to .env** or ensure you added the env with API key in the extension |
| Auto-reconnect warning on startup | Store API key via Systems tab; extension needs it for silent re-activation |
| `.env` key not picked up | Use `WXO_API_KEY_<ENV>` naming (uppercase); `WO_<ENV>_API_KEY` is not auto-resolved |

---

## See Also

- [USER_GUIDE.md](USER_GUIDE.md) — Full feature reference
- [README.md](README.md) — Quick start and settings
