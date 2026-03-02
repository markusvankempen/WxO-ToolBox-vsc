#!/bin/bash
#
# Script: import_to_wxo.sh
# Version: 1.0.8
# Author: Markus van Kempen <mvankempen@ca.ibm.com>, <markus.van.kempen@gmail.com>
# Date: Feb 25, 2026
#
# Description:
#   Import agents and tools from local filesystem into Watson Orchestrate (WXO).
#   - Discovers Python, OpenAPI, and Flow tools; imports agents with dependencies.
#   - Supports .env for API keys (WXO_API_KEY_<ENV>) when --env <name> is used.
#   - When no --env: prompts for URL/key or uses WO_* from .env if available.
#   - Writes import report (status, ID) to Report/ when --report-dir given.
#
# Usage: ./import_to_wxo.sh [OPTIONS]
#   --env <name>  Use orchestrate env; API key from WXO_API_KEY_<name> in .env or prompt.
#   --env-file    Override .env path (default: ../../.env or script_dir/.env)
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../../.env}"
[[ ! -f "$ENV_FILE" ]] && ENV_FILE="$SCRIPT_DIR/../../.env"
[[ ! -f "$ENV_FILE" ]] && ENV_FILE="$SCRIPT_DIR/.env"

# --- Parse arguments ---
IMPORT_AGENTS=true
IMPORT_TOOLS=true
IMPORT_FLOWS_ONLY=false   # when true (--flows-only): import only Flow tools
IMPORT_PLUGINS_ONLY=false # when true (--plugins-only): import only Plugin tools from plugins/
IMPORT_CONNECTIONS=false   # when true (--connections-only): import only live connections
AGENT_ONLY=false          # when true (--agent-only): import agent YAML only, skip bundled tools/flows
AGENT_FILTER=""
TOOL_FILTER=""
CONNECTION_FILTER=""
REPORT_FILE=""
REPORT_DIR=""
BASE_DIR=""
ENV_NAME=""
SKIP_ENV_PROMPT=false
IF_EXISTS="override"   # override (default): import/update; skip: skip if already exists
HAS_FAILURES=0
VALIDATE=false
VALIDATE_SOURCE_ENV=""  # when set: compare target response with source (e.g. TZ1)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agents-only)   IMPORT_TOOLS=false; shift ;;
    --agent-only)    AGENT_ONLY=true; shift ;;
    --tools-only)    IMPORT_AGENTS=false; shift ;;
    --flows-only)    IMPORT_AGENTS=false; IMPORT_FLOWS_ONLY=true; shift ;;
    --plugins-only)  IMPORT_AGENTS=false; IMPORT_TOOLS=false; IMPORT_PLUGINS_ONLY=true; shift ;;
    --connections-only) IMPORT_AGENTS=false; IMPORT_TOOLS=false; IMPORT_FLOWS_ONLY=false; IMPORT_PLUGINS_ONLY=false; IMPORT_CONNECTIONS=true; shift ;;
    --all)              IMPORT_CONNECTIONS=true; shift ;;  # Import everything in folder (agents, tools, flows, connections)
    --agent)         AGENT_FILTER="$2"; [[ $# -ge 2 ]] && shift 2 || shift ;;
    --tool)          TOOL_FILTER="$2"; [[ $# -ge 2 ]] && shift 2 || shift ;;
    --connection)    CONNECTION_FILTER="$2"; [[ $# -ge 2 ]] && shift 2 || shift ;;
    --report)        REPORT_FILE="$2"; [[ $# -ge 2 ]] && shift 2 || shift ;;
    --report-dir)    REPORT_DIR="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
    --base-dir)      BASE_DIR="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
    --env)           ENV_NAME="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
    --no-credential-prompt) SKIP_ENV_PROMPT=true; shift ;;
    --if-exists)     IF_EXISTS="${2:-override}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
    --env-file)      ENV_FILE="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
    --validate)      VALIDATE=true; shift ;;
    --validate-with-source) VALIDATE=true; VALIDATE_SOURCE_ENV="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
    -v|--version)
      echo "import_to_wxo.sh 1.0.8"
      exit 0
      ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo "  WxO Importer/Export/Comparer/Validator — Import script v1.0.8"
      echo ""
      echo "Options:"
      echo "  --agents-only   Import only agents (and their tool dependencies)"
      echo "  --agent-only    With --agents-only: import agent YAML only (skip bundled tools/flows)"
      echo "  --tools-only    Import tools and flows from tools/ and flows/ (no agents, no connections)"
      echo "  --flows-only       Import only Flow tools (skip agents, Python, OpenAPI)"
      echo "  --plugins-only    Import only Plugin tools from plugins/"
      echo "  --connections-only Import only live connections (skip agents, tools, flows)"
      echo "  --all              Import everything in folder (agents, tools, flows, plugins, connections)"
      echo "  --agent <name>  Import only the specified agent (and its deps)"
      echo "  --tool <name>      Import only the specified tool"
      echo "  --connection <id>  Import only the specified connection (app_id)"
      echo "  --base-dir <dir>  Base directory containing agents/ and tools/ (default: current dir)"
      echo "  --env <name>      Use existing orchestrate environment (skip URL prompt)"
      echo "  --no-credential-prompt  Env already active; skip URL/API key prompts"
      echo "  --report <file> Append import report to file (type|name|status|id|notes)"
      echo "  --report-dir <dir>  Write report to <dir>/Report/import_report.txt (e.g. TZ2/Import/20260225_094444)"
      echo "  --if-exists <mode>  When resource exists: skip (do not import) | override (update, default)"
      echo "  --env-file <path>   Path to .env for WXO_API_KEY_<ENV> (default: ../../.env)"
      echo "  --validate         After import, invoke each agent with a test prompt; report if it responds"
      echo "  --validate-with-source <env>  Also run test on source env; compare responses (e.g. TZ1)"
      echo "  -h, --help      Show help"
      echo ""
      echo "By default: imports all tools and agents. Use --if-exists skip to skip already-existing resources."
      exit 0
      ;;
    *) echo "[WARN] Unknown option: $1"; shift ;;
  esac
done

# Validate --if-exists
IF_EXISTS="${IF_EXISTS:-override}"
IF_EXISTS=$(echo "$IF_EXISTS" | tr '[:upper:]' '[:lower:]')
[[ "$IF_EXISTS" != "skip" && "$IF_EXISTS" != "override" ]] && {
  echo "[WARN] Invalid --if-exists '$IF_EXISTS'; using 'override'."
  IF_EXISTS="override"
}

# Build report path from --report-dir: <dir>/Report/import_report.txt
if [[ -n "$REPORT_DIR" ]]; then
  REPORT_FILE="${REPORT_DIR%/}/Report/import_report.txt"
  mkdir -p "$(dirname "$REPORT_FILE")"
fi

# WxO root for Systems/Connections lookup
WXO_ROOT="${WXO_ROOT:-$SCRIPT_DIR/WxO}"

# Connection credentials: when ENV_CONN_SOURCE is set (e.g. replicate), use source's .env_connection; else use target (ENV_NAME)
ENV_CONN_SOURCE="${ENV_CONN_SOURCE:-}"
_conn_lookup="${ENV_CONN_SOURCE:-$ENV_NAME}"

# Parse connection YAML for environments.live.kind (auth type)
_parse_connection_kind() {
  local yml="$1"
  [[ ! -f "$yml" ]] && return
  grep -A 50 'environments:' "$yml" 2>/dev/null | grep -A 20 'live:' | grep '^\s*kind:' | head -1 | sed 's/.*kind:\s*\([a-z_]*\).*/\1/'
}

# Map connection kind to set-credentials flag names
_connection_kind_to_flags() {
  case "$1" in
    api_key) echo "API_KEY" ;;
    bearer) echo "TOKEN" ;;
    basic) echo "USERNAME PASSWORD" ;;
    oauth_auth_client_credentials_flow) echo "CLIENT_ID CLIENT_SECRET TOKEN_URL" ;;
    oauth_auth_password_flow) echo "USERNAME PASSWORD CLIENT_ID CLIENT_SECRET TOKEN_URL" ;;
    oauth_auth_on_behalf_of_flow|oauth_auth_token_exchange_flow) echo "CLIENT_ID CLIENT_SECRET TOKEN_URL" ;;
    oauth_auth_code_flow) echo "CLIENT_ID CLIENT_SECRET AUTH_URL TOKEN_URL" ;;
    key_value|kv) echo "ENTRIES" ;;
    *) echo "API_KEY" ;;
  esac
}

# Map env var suffix to set-credentials CLI flag
_conn_flag_for_secret() {
  case "$1" in
    API_KEY) echo "--api-key" ;;
    TOKEN) echo "--token" ;;
    USERNAME) echo "--username" ;;
    PASSWORD) echo "--password" ;;
    CLIENT_ID) echo "--client-id" ;;
    CLIENT_SECRET) echo "--client-secret" ;;
    TOKEN_URL) echo "--token-url" ;;
    AUTH_URL) echo "--auth-url" ;;
    ENTRIES) echo "-e" ;;
    *) echo "" ;;
  esac
}

# Read DEFAULT_LLM from .env_connection file or .env (WXO_LLM). Used when agent YAML has no llm field.
_get_default_llm() {
  if [[ -n "${_conn_lookup:-}" ]]; then
    local env_conn="${WXO_ROOT}/Systems/${_conn_lookup}/Connections/.env_connection_${_conn_lookup}"
    if [[ -f "$env_conn" ]]; then
      local val
      val=$(grep -E '^DEFAULT_LLM=' "$env_conn" 2>/dev/null | head -1 | sed 's/^DEFAULT_LLM=//' | sed 's/^["'\'']//;s/["'\'']$//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      [[ -n "$val" ]] && { echo "$val"; return; }
    fi
  fi
  [[ -n "${WXO_LLM:-}" ]] && echo "${WXO_LLM}" && return
  return 1
}

# Set connection credentials from .env_connection file. Returns 0 if any credentials were set.
_set_connection_credentials_from_env() {
  local app_id="$1" yml_file="$2" env_file="$3"
  [[ ! -f "$env_file" ]] && return 1
  [[ ! -f "$yml_file" ]] && return 1
  local kind
  kind=$(_parse_connection_kind "$yml_file")
  [[ -z "$kind" ]] && kind="api_key"
  local flags_secrets
  flags_secrets=$(_connection_kind_to_flags "$kind")
  local app_safe="${app_id//./_}"
  local has_creds=0
  local set_args=()
  for sec in $flags_secrets; do
    local var_name="CONN_${app_safe}_${sec}"
    local val
    val=$(grep -E "^${var_name}=" "$env_file" 2>/dev/null | head -1 | sed "s/^${var_name}=//" | sed 's/^["'\'']//;s/["'\'']$//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$val" ]] && continue
    local flag
    flag=$(_conn_flag_for_secret "$sec")
    [[ -z "$flag" ]] && continue
    has_creds=1
    if [[ "$sec" == "ENTRIES" ]]; then
      # key_value: split comma-separated key=value pairs into multiple -e
      while IFS= read -r entry; do
        [[ -z "$entry" ]] && continue
        set_args+=("$flag" "$entry")
      done < <(echo "$val" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    else
      set_args+=("$flag" "$val")
    fi
  done
  [[ $has_creds -eq 0 ]] && return 1
  set +e
  orchestrate connections set-credentials -a "$app_id" --env draft "${set_args[@]}" 2>&1
  local rc1=$?
  orchestrate connections set-credentials -a "$app_id" --env live "${set_args[@]}" 2>&1
  local rc2=$?
  set -e
  [[ $rc1 -eq 0 ]] && [[ $rc2 -eq 0 ]] && return 0 || return 1
}

# --- WXO CONFIGURATION ---
command -v orchestrate >/dev/null 2>&1 || { echo "[ERROR] 'orchestrate' CLI not found."; exit 1; }

if [[ "$SKIP_ENV_PROMPT" == "true" ]]; then
  echo "  Using active environment."
  echo ""
elif [[ -n "$ENV_NAME" ]]; then
  echo "Using existing environment: $ENV_NAME"
  if [[ -f "$ENV_FILE" ]]; then set -a; source "$ENV_FILE" 2>/dev/null || true; set +a; fi
  API_KEY_VAR="WXO_API_KEY_${ENV_NAME}"
  API_KEY="${!API_KEY_VAR}"
  if [[ -z "$API_KEY" ]]; then
    read -p "Enter your API key: " API_KEY
    API_KEY=$(echo "$API_KEY" | tr -d '[:space:]')
  else
    echo "  Using API key from .env"
  fi
  [[ -z "$API_KEY" ]] && { echo "[ERROR] API key required."; exit 1; }
  orchestrate env activate "$ENV_NAME" --api-key "$API_KEY" || { echo "[ERROR] Failed to activate environment."; exit 1; }
  echo ""; echo "Environment '$ENV_NAME' activated."; echo ""
else
  if [[ -f "$ENV_FILE" ]]; then set -a; source "$ENV_FILE" 2>/dev/null || true; set +a; fi
  WXO_INSTANCE_URL="${WXO_INSTANCE_URL:-$WO_INSTANCE_URL}"
  API_KEY="${WO_API_KEY}"
  [[ -z "$WXO_INSTANCE_URL" ]] && { read -p "Enter WXO instance URL: " WXO_INSTANCE_URL; WXO_INSTANCE_URL=$(echo "$WXO_INSTANCE_URL" | tr -d '[:space:]'); }
  [[ -z "$API_KEY" ]] && { read -p "Enter API key: " API_KEY; API_KEY=$(echo "$API_KEY" | tr -d '[:space:]'); }
  [[ -z "$WXO_INSTANCE_URL" ]] || [[ -z "$API_KEY" ]] && { echo "[ERROR] URL and API key required."; exit 1; }
  echo ""; echo "Configuring Watson Orchestrate environment 'bootcamp'..."
  orchestrate env add --name bootcamp --url "$WXO_INSTANCE_URL" -t ibm_iam || { echo "[ERROR] Failed to add environment."; exit 1; }
  orchestrate env activate bootcamp --api-key "$API_KEY" || { echo "[ERROR] Failed to activate."; exit 1; }
  echo ""; echo "Environment 'bootcamp' configured."; echo ""
fi
# GitHub MCP connection removed as per user request

# =======================================================
# VALIDATION — REQUIRED DIRECTORY STRUCTURE
# =======================================================

BASE_DIR="${BASE_DIR:-.}"
BASE_DIR="${BASE_DIR%/}"  # strip trailing slash
TOOLS_DIR="$BASE_DIR/tools"
FLOWS_DIR="$BASE_DIR/flows"
PLUGINS_DIR="$BASE_DIR/plugins"
AGENTS_DIR="$BASE_DIR/agents"

# Validation: need tools, flows, or plugins dir for top-level tools import; when --agent filter used, tools come from agent deps
# When agents/ exists with bundled tools (agents/<name>/tools/), tools/ is optional — we import from agent deps
if [[ "$IMPORT_TOOLS" == "true" ]] || [[ "$IMPORT_PLUGINS_ONLY" == "true" ]]; then
  if [[ -z "$AGENT_FILTER" ]]; then
    if [[ "$IMPORT_PLUGINS_ONLY" == "true" ]]; then
      [[ ! -d "$PLUGINS_DIR" ]] && { echo "❌ Plugins directory not found. Create: $PLUGINS_DIR"; exit 1; }
    elif [[ "$IMPORT_FLOWS_ONLY" == "true" ]]; then
      [[ ! -d "$FLOWS_DIR" ]] && { echo "❌ Flows directory not found. Create: $FLOWS_DIR"; exit 1; }
    else
      if [[ ! -d "$TOOLS_DIR" ]] && [[ ! -d "$AGENTS_DIR" ]]; then
        echo "❌ Tools directory not found. Create: $TOOLS_DIR (or export with agents to get agents/<name>/tools/)"
        exit 1
      fi
    fi
  fi
fi
if [[ "$IMPORT_AGENTS" == "true" ]] && [[ ! -d "$AGENTS_DIR" ]]; then
  if [[ "$IMPORT_TOOLS" == "true" ]] && { [[ -d "$TOOLS_DIR" ]] || [[ -d "$FLOWS_DIR" ]]; }; then
    echo "  [WARN] Agents directory not found; importing tools and flows only."
    IMPORT_AGENTS=false
    # If only flows/ exists, use flows-only mode
    [[ ! -d "$TOOLS_DIR" ]] && [[ -d "$FLOWS_DIR" ]] && IMPORT_FLOWS_ONLY=true
  else
    echo "❌ Agents directory not found. Create: $AGENTS_DIR"
    exit 1
  fi
fi
if [[ "$IMPORT_TOOLS" != "true" ]] && [[ "$IMPORT_AGENTS" != "true" ]] && [[ "$IMPORT_CONNECTIONS" != "true" ]] && [[ "$IMPORT_PLUGINS_ONLY" != "true" ]]; then
  echo "❌ Use --agents-only, --tools-only, --flows-only, --plugins-only, --connections-only, or omit for agents+tools."
  exit 1
fi
if [[ "$IMPORT_CONNECTIONS" == "true" ]]; then
  if [[ ! -d "$BASE_DIR/connections" ]]; then
    if [[ "$IMPORT_AGENTS" == "true" ]] || [[ "$IMPORT_TOOLS" == "true" ]]; then
      echo "  [WARN] No connections/ directory; skipping connections import."
      IMPORT_CONNECTIONS=false
    else
      echo "❌ Connections directory not found. Create: $BASE_DIR/connections"
      exit 1
    fi
  fi
fi

echo ""
echo "  Watson Orchestrate — Import"
echo "  ───────────────────────────"
echo "  Source:   $BASE_DIR"
[[ -n "$ENV_NAME" ]] && echo "  Env:      $ENV_NAME"
echo "  Agents:   $IMPORT_AGENTS  |  Tools: $IMPORT_TOOLS  |  Plugins: $IMPORT_PLUGINS_ONLY  |  Connections: $IMPORT_CONNECTIONS  |  If exists: $IF_EXISTS"
[[ -n "$AGENT_FILTER" ]] && echo "  Filter:   agent=$AGENT_FILTER"
[[ -n "$TOOL_FILTER" ]] && echo "  Filter:   tool=$TOOL_FILTER"
[[ -n "$CONNECTION_FILTER" ]] && echo "  Filter:   connection=$CONNECTION_FILTER"
[[ -n "$REPORT_FILE" ]] && echo "  Report:   $REPORT_FILE"
echo ""

# Helper: check if name matches filter (empty = match all)
_matches_filter() { local n="$1"; local f="$2";
  [[ -z "$f" ]] && return 0
  [[ "$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')" ]] && return 0
  return 1; }

# Cached lists of existing resources (populated when --if-exists skip, before first import)
EXISTING_TOOLS=""
EXISTING_AGENTS=""
EXISTING_CONNECTIONS=""
EXISTING_RESOURCES_FETCHED=false
_strip_json_prefix() {
  local raw="$1"
  local first
  first=$(echo "$raw" | head -1)
  if [[ -n "$first" ]] && ! echo "$first" | grep -qE '^[\[{]'; then
    echo "$raw" | tail -n +2
  else
    echo "$raw"
  fi
}
_fetch_existing_resources() {
  [[ "$EXISTING_RESOURCES_FETCHED" == "true" ]] && return 0
  local tools_raw agents_raw conn_raw tools_json agents_json conn_json
  tools_raw=$(orchestrate tools list -v 2>/dev/null) || true
  agents_raw=$(orchestrate agents list -v 2>/dev/null) || true
  conn_raw=$(orchestrate connections list -v --env live 2>/dev/null) || true
  tools_json=$(_strip_json_prefix "$tools_raw")
  agents_json=$(_strip_json_prefix "$agents_raw")
  conn_json=$(_strip_json_prefix "$conn_raw")
  EXISTING_TOOLS=$(echo "$tools_json" | jq -r '
    (if type == "array" then . else (.tools // .native // .data // .items) end) |
    if type == "array" then . else [] end |
    .[] | select(type == "object") | (.name // .id) // empty
  ' 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
  EXISTING_AGENTS=$(echo "$agents_json" | jq -r '
    (.native // .agents // .data // .items // .) |
    if type == "array" then . else [] end |
    .[] | select(type == "object") | (.name // .id) // empty
  ' 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
  EXISTING_CONNECTIONS=$(echo "$conn_json" | jq -r '
    (.live // .connections // .data // .items // .) |
    if type == "array" then . else [] end |
    .[] | select(type == "object") | (.app_id // .appId // .id // .name) // empty |
    select(length > 0)
  ' 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
  EXISTING_RESOURCES_FETCHED=true
}
_resource_exists() {
  local type="$1" name="$2"
  [[ "$IF_EXISTS" != "skip" ]] && return 1
  _fetch_existing_resources
  local n_lower; n_lower=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
  if [[ "$type" == "Tool" ]]; then
    echo "$EXISTING_TOOLS" | grep -qFx "$n_lower" 2>/dev/null && return 0
  elif [[ "$type" == "Agent" ]]; then
    echo "$EXISTING_AGENTS" | grep -qFx "$n_lower" 2>/dev/null && return 0
  elif [[ "$type" == "Connection" ]]; then
    echo "$EXISTING_CONNECTIONS" | grep -qFx "$n_lower" 2>/dev/null && return 0
  fi
  return 1
}

# --- Helpers for readable output ---
_strip_ansi() { echo "$1" | sed 's/\x1b\[[0-9;]*m//g' 2>/dev/null || echo "$1"; }
_status_icon() { case "$1" in OK) echo "✓";; FAILED) echo "✗";; SKIPPED) echo "⏭";; *) echo " "; esac; }

# Patch OpenAPI/skill spec:
# 1. Add description from summary when missing (Watson Orchestrate requires it)
# 2. Use info.title or x-ibm-skill-name for operation summary when single operation (so tool displays with intended name)
_patch_openapi_operation_descriptions() {
  local spec="$1"
  [[ ! -f "$spec" ]] && return 1
  if jq -e '.paths' "$spec" >/dev/null 2>&1; then
    local tmp; tmp=$(mktemp)
    # Step 1: description from summary when missing
    if ! jq '.paths |= with_entries(.value |= (if type == "object" then with_entries(.value |= (if type == "object" and (.description == null or .description == "") then . + {description: (.summary // "No description provided")} else . end)) else . end))' "$spec" >"$tmp" 2>/dev/null; then
      rm -f "$tmp"
      return 1
    fi
    mv "$tmp" "$spec"
    # Step 2: for single-operation tools, set summary from info.title/x-ibm-skill-name so display name matches
    local skill_name
    skill_name=$(jq -r '.info["x-ibm-skill-name"] // .info.title // empty' "$spec" 2>/dev/null)
    if [[ -n "$skill_name" ]]; then
      local op_count
      op_count=$(jq '[.paths[][]? | select(type == "object")] | length' "$spec" 2>/dev/null)
      if [[ "$op_count" == "1" ]]; then
        tmp=$(mktemp)
        jq --arg sn "$skill_name" '
          .paths |= with_entries(.value |= (if type == "object" then with_entries(.value |= (if type == "object" then . + {summary: $sn} else . end)) else . end)) 
        ' "$spec" >"$tmp" 2>/dev/null && mv "$tmp" "$spec" || rm -f "$tmp"
      fi
    fi
  fi
  return 0
}

# Resolve Python entry file for import, avoiding module/package name collision.
# When the .py file has the same name as the tool dir (e.g. dad_joke_plugin/dad_joke_plugin.py),
# the Orchestrate runtime can fail with "No module named 'X.X'; 'X' is not a package".
# Fix: prefer <name>_tool.py if present, else create a temp copy with that name.
# Sets globals: PY_IMPORT_DIR, PY_IMPORT_FILE, PY_IMPORT_CLEANUP (temp dir to rm, or empty)
_resolve_python_entry() {
  local subdir="$1" tool_name="$2" exclude="${3:-}"
  local py_file req_file find_args
  find_args=("$subdir" -maxdepth 1 -type f -name "*.py")
  [[ -n "$exclude" ]] && find_args+=(! -name "$exclude")
  py_file=$(find "${find_args[@]}" 2>/dev/null | head -1)
  req_file="$subdir/requirements.txt"
  [[ -z "$py_file" ]] || [[ ! -f "$req_file" ]] && return 1
  local py_basename py_stem
  py_basename=$(basename "$py_file")
  py_stem="${py_basename%.py}"
  PY_IMPORT_DIR="$subdir"
  PY_IMPORT_FILE="$py_basename"
  PY_IMPORT_CLEANUP=""
  if [[ "$py_stem" == "$tool_name" ]]; then
    if [[ -f "$subdir/${tool_name}_tool.py" ]]; then
      PY_IMPORT_FILE="${tool_name}_tool.py"
    else
      PY_IMPORT_DIR=$(mktemp -d)
      cp -r "$subdir"/* "$PY_IMPORT_DIR/"
      cp "$py_file" "$PY_IMPORT_DIR/${tool_name}_tool.py"
      PY_IMPORT_FILE="${tool_name}_tool.py"
      PY_IMPORT_CLEANUP="$PY_IMPORT_DIR"
    fi
  fi
  return 0
}

# --- Import report tracking ---
REPORT_FILE="${REPORT_FILE:-}"
REPORT_ENTRIES=()

_record_import() {
  local type="$1" name="$2" status="$3" id="$4" errmsg="$5"
  REPORT_ENTRIES+=("${type}|${name}|${status}|${id}|${errmsg:-}")
}

# Update notes on the last Connection entry (after _run_import, for credential status)
_update_last_connection_note() {
  local note="$1"
  [[ ${#REPORT_ENTRIES[@]} -eq 0 ]] && return
  local idx=$((${#REPORT_ENTRIES[@]} - 1))
  local entry="${REPORT_ENTRIES[$idx]}"
  local type
  IFS='|' read -r type _ _ _ _ <<< "$entry"
  [[ "$type" != "Connection" ]] && return
  local rest="${entry#*|}"
  local name="${rest%%|*}"; rest="${rest#*|}"
  local status="${rest%%|*}"; rest="${rest#*|}"
  local id="${rest%%|*}"; rest="${rest#*|}"
  local old_notes="${rest#*|}"
  local new_notes="$note"
  [[ -n "$old_notes" ]] && new_notes="${old_notes}; ${note}"
  REPORT_ENTRIES[$idx]="${type}|${name}|${status}|${id}|${new_notes}"
}

# Look up IDs from orchestrate list commands for report entries that have "-"
_fill_report_ids() {
  [[ ${#REPORT_ENTRIES[@]} -eq 0 ]] && return 0
  local tools_raw conn_raw agents_raw tools_json conn_json agents_json
  tools_raw=$(orchestrate tools list -v 2>/dev/null) || true
  conn_raw=$(orchestrate connections list -v --env live 2>/dev/null) || true
  agents_raw=$(orchestrate agents list -v 2>/dev/null) || true
  tools_json=$(_strip_json_prefix "$tools_raw")
  conn_json=$(_strip_json_prefix "$conn_raw")
  agents_json=$(_strip_json_prefix "$agents_raw")
  # Build name|id lines (short id for display: first 22 chars)
  local tool_ids conn_ids agent_ids
  tool_ids=$(echo "$tools_json" | jq -r '
    (if type == "array" then . else (.tools // .native // .data // .items) end) |
    if type == "array" then . else [] end |
    .[] | select(type == "object") | "\(.name // .id // "")|\(.id // ._id // "" | tostring)"
  ' 2>/dev/null) || true
  conn_ids=$(echo "$conn_json" | jq -r '
    (if type == "array" then . else (.live // .connections // .data // .) end) |
    if type == "array" then . else [] end |
    .[] | select(type == "object") | select(.environment == "live" or .environment == null) |
    "\(.app_id // .appId // .id // .name // "")|\(.id // ._id // "" | tostring)"
  ' 2>/dev/null) || true
  agent_ids=$(echo "$agents_json" | jq -r '
    (.native // .agents // .data // .items // .) |
    if type == "array" then . else [] end |
    .[] | select(type == "object") | "\(.name // .id // "")|\(.id // ._id // "" | tostring)"
  ' 2>/dev/null) || true
  local new_entries=() type name status id errmsg new_id list
  for entry in "${REPORT_ENTRIES[@]}"; do
    IFS='|' read -r type name status id errmsg <<< "$entry"
    if [[ "$id" == "-" || -z "$id" ]] && [[ "$status" == "OK" ]]; then
      new_id="-"
      if [[ "$type" == "Agent" ]]; then list="$agent_ids"
      elif [[ "$type" == "Tool"* ]]; then list="$tool_ids"
      elif [[ "$type" == "Connection"* ]]; then list="$conn_ids"
      else list=""
      fi
      if [[ -n "$list" ]]; then
        new_id=$(echo "$list" | while IFS='|' read -r n i; do
          [[ -z "$n" ]] && continue
          [[ "$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" ]] && { echo "${i:0:22}"; break; }
        done | head -1)
      fi
      [[ -n "$new_id" ]] && id="$new_id"
    fi
    new_entries+=("${type}|${name}|${status}|${id}|${errmsg:-}")
  done
  REPORT_ENTRIES=("${new_entries[@]}")
}

_print_report() {
  local agent_ok=0 agent_fail=0 agent_skip=0 tool_ok=0 tool_fail=0 tool_skip=0 conn_ok=0 conn_fail=0 conn_skip=0 conn_creds_ok=0
  local REPORT_CONTENT=""
  REPORT_CONTENT+=$'\n'
  REPORT_CONTENT+="  ═════════════════════════════════════════════════════════════════════════════════════════════"$'\n'
  REPORT_CONTENT+="  IMPORT REPORT"$'\n'
  REPORT_CONTENT+="  ═════════════════════════════════════════════════════════════════════════════════════════════"$'\n'
  if [[ ${#REPORT_ENTRIES[@]} -eq 0 ]]; then
    REPORT_CONTENT+="  (No resources imported — check that source contains agents/, tools/, flows/, or connections/)"$'\n'
  else
  REPORT_CONTENT+="  $(printf '%-8s  %-36s  %-12s  %-24s  %s' 'TYPE' 'NAME' 'STATUS' 'ID' 'NOTES')"$'\n'
  REPORT_CONTENT+="  ───────────────────────────────────────────────────────────────────────────────────────────"$'\n'
  for entry in "${REPORT_ENTRIES[@]}"; do
    IFS='|' read -r type name status id errmsg <<< "$entry"
    errmsg="$(_strip_ansi "${errmsg:-}")"
    errmsg="${errmsg:0:48}"
    id="${id:0:22}"
    icon="$(_status_icon "$status")"
    REPORT_CONTENT+="  $(printf '%-8s  %-36s  %s %-10s  %-24s  %s' "$type" "${name:0:36}" "$icon" "${status}" "$id" "$errmsg")"$'\n'
    { [[ "$type" == "Agent" ]] && [[ "$status" == "OK" ]] && agent_ok=$((agent_ok + 1)); } || true
    { [[ "$type" == "Agent" ]] && [[ "$status" == "FAILED" ]] && agent_fail=$((agent_fail + 1)); } || true
    { [[ "$type" == "Agent" ]] && [[ "$status" == "SKIPPED" ]] && agent_skip=$((agent_skip + 1)); } || true
    { [[ "$type" == "Tool"* ]] && [[ "$status" == "OK" ]] && tool_ok=$((tool_ok + 1)); } || true
    { [[ "$type" == "Tool"* ]] && [[ "$status" == "FAILED" ]] && tool_fail=$((tool_fail + 1)); } || true
    { [[ "$type" == "Tool"* ]] && [[ "$status" == "SKIPPED" ]] && tool_skip=$((tool_skip + 1)); } || true
    { [[ "$type" == "Connection"* ]] && [[ "$status" == "OK" ]] && conn_ok=$((conn_ok + 1)); } || true
    { [[ "$type" == "Connection"* ]] && [[ "$status" == "OK" ]] && [[ "$errmsg" == *"credentials set"* ]] && conn_creds_ok=$((conn_creds_ok + 1)); } || true
    { [[ "$type" == "Connection"* ]] && [[ "$status" == "FAILED" ]] && conn_fail=$((conn_fail + 1)); } || true
    { [[ "$type" == "Connection"* ]] && [[ "$status" == "SKIPPED" ]] && conn_skip=$((conn_skip + 1)); } || true
  done
  REPORT_CONTENT+="  ───────────────────────────────────────────────────────────────────────────────────────────"$'\n'
  REPORT_CONTENT+="  SUMMARY:  agents: ✓ $agent_ok OK, ⏭ $agent_skip skipped, ✗ $agent_fail failed"
  REPORT_CONTENT+="  |  tools: ✓ $tool_ok OK, ⏭ $tool_skip skipped, ✗ $tool_fail failed"
  if [[ $conn_ok -gt 0 ]]; then
    REPORT_CONTENT+="  |  connections: ✓ $conn_ok OK ($conn_creds_ok creds set), ⏭ $conn_skip skipped, ✗ $conn_fail failed"$'\n'
  else
    REPORT_CONTENT+="  |  connections: ✓ $conn_ok OK, ⏭ $conn_skip skipped, ✗ $conn_fail failed"$'\n'
  fi
  fi
  REPORT_CONTENT+="  ═════════════════════════════════════════════════════════════════════════════════════════════"$'\n'
  REPORT_CONTENT+=$'\n'

  # Console output
  echo "$REPORT_CONTENT"

  # File: same formatted content + timestamp header (like export)
  if [[ -n "$REPORT_FILE" ]]; then
    {
      echo "=== Import Report $(date '+%Y-%m-%dT%H:%M:%S') ==="
      echo "$REPORT_CONTENT"
    } > "$REPORT_FILE"
    echo "  Report saved: $REPORT_FILE"
    echo ""
  fi
}

# Run import and record result. Usage: _run_import "name" "type" "cmd"
# cmd is eval'd; use (cd dir && orchestrate ...) for dir-scoped imports.
# When --if-exists skip and resource exists, records SKIPPED and returns.
# Always returns 0 so script continues; sets HAS_FAILURES=1 on error.
_run_import() {
  local name="$1" type="$2" cmd="$3"
  [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE" 2>/dev/null; set +a; }
  [[ "${WXO_DEBUG:-0}" == "1" || "${WXO_LOG:-0}" == "1" ]] && echo "  $ $cmd"
  if _resource_exists "$type" "$name"; then
    _record_import "$type" "$name" "SKIPPED" "-" "already exists"
    echo "     ⏭ skipped (exists)"
    return 0
  fi
  local out id errmsg rc
  set +e
  out=$(eval "$cmd" 2>&1)
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    # Extract ID: orchestrate may return "generated-xxx", or JSON with "id": "xxx"
    id=$(echo "$out" | grep -oE 'generated-[a-zA-Z0-9_-]+' | head -1) || true
    [[ -z "$id" ]] && id=$(echo "$out" | jq -r '(.id // ._id // .tool_id // .agent_id // .data.id // empty) // empty' 2>/dev/null) || true
    [[ -z "$id" ]] && id=$(echo "$out" | grep -oE '"[a-z_-]*id[a-z_-]*"\s*:\s*"[^"]+"' | head -1 | sed 's/.*:\s*"\([^"]*\)".*/\1/') || true
    [[ -z "$id" ]] && id="-"
    _record_import "$type" "$name" "OK" "$id" ""
    echo "     ✓ OK"
  else
    HAS_FAILURES=1
    errmsg=$(echo "$out" | grep -E '\[ERROR\]|Error|error:' | tail -1 | cut -c1-60) || true
    [[ -z "$errmsg" ]] && errmsg=$(echo "$out" | tail -1 | cut -c1-60)
    _record_import "$type" "$name" "FAILED" "-" "$errmsg"
    echo "     ✗ failed"
    echo "$out" | sed 's/\x1b\[[0-9;]*m//g' | tail -4
  fi
}

# =======================================================
# AUTO DISCOVERY & IMPORT — TOOLS (from tools/)
# Skip when --agent <name>: only import that agent's deps from agents/<name>/tools/
# =======================================================

if [[ "$IMPORT_TOOLS" == "true" ]] || [[ "$IMPORT_PLUGINS_ONLY" == "true" ]]; then
if [[ -z "$AGENT_FILTER" ]]; then
# --plugins-only: import only from plugins/; --flows-only: only from flows/; else tools/ and flows/
if [[ "$IMPORT_PLUGINS_ONLY" == "true" ]]; then
echo "  Plugins (from plugins/)"
echo "  ───────────────────────"
elif [[ "$IMPORT_FLOWS_ONLY" == "true" ]]; then
echo "  Flows (from flows/)"
echo "  ───────────────────"
else
echo "  Tools and flows (from tools/ and flows/)"
echo "  ───────────────────────────────────────"
fi
# Resolve .env_connection for tool-bundled connections (credentials)
# Replicate uses ENV_CONN_SOURCE (source env, e.g. TZ1) so same API keys apply to target connections
ENV_CONN_FILE=""
[[ -n "$_conn_lookup" ]] && [[ -f "${WXO_ROOT}/Systems/${_conn_lookup}/Connections/.env_connection_${_conn_lookup}" ]] && ENV_CONN_FILE="${WXO_ROOT}/Systems/${_conn_lookup}/Connections/.env_connection_${_conn_lookup}"

# 0. Plugin tools (plugins/<name>/) — when --plugins-only or when importing all (plugins/ exists)
if [[ -d "$PLUGINS_DIR" ]] && ([[ "$IMPORT_PLUGINS_ONLY" == "true" ]] || ([[ "$IMPORT_TOOLS" == "true" ]] && [[ "$IMPORT_FLOWS_ONLY" != "true" ]])); then
for SUBDIR in "$PLUGINS_DIR"/*/; do
  [ -d "$SUBDIR" ] || continue
  TOOL_NAME=$(basename "$SUBDIR")
  _matches_filter "$TOOL_NAME" "$TOOL_FILTER" || continue
  if _resolve_python_entry "$SUBDIR" "$TOOL_NAME"; then
    echo "  → $TOOL_NAME (plugin)"
    _run_import "$TOOL_NAME" "Tool" "(cd \"$PY_IMPORT_DIR\" && orchestrate tools import -k python -p . -f \"$PY_IMPORT_FILE\" -r requirements.txt)"
    [[ -n "$PY_IMPORT_CLEANUP" ]] && rm -rf "$PY_IMPORT_CLEANUP"
  fi
done
fi

# 1. Python tools at top level (tools/*.py) — skip when --flows-only or --plugins-only
if [[ "$IMPORT_FLOWS_ONLY" != "true" ]] && [[ "$IMPORT_PLUGINS_ONLY" != "true" ]]; then
for TOOL_FILE in "$TOOLS_DIR"/*.py; do
  [ -f "$TOOL_FILE" ] || continue
  TOOL_STEM=$(basename "$TOOL_FILE" .py)
  _matches_filter "$TOOL_STEM" "$TOOL_FILTER" || continue
  echo "  → $TOOL_STEM (python)"
  _run_import "$TOOL_STEM" "Tool" "orchestrate tools import -k python -p \"$TOOLS_DIR\" -f \"$(basename "$TOOL_FILE")\" -r requirements.txt"
done

# 2. Python tools in subdirs (from export: tools/<name>/ with *.py, requirements.txt) — skip when --plugins-only
if [[ "$IMPORT_PLUGINS_ONLY" != "true" ]]; then
for SUBDIR in "$TOOLS_DIR"/*/; do
  [ -d "$SUBDIR" ] || continue
  TOOL_NAME=$(basename "$SUBDIR")
  _matches_filter "$TOOL_NAME" "$TOOL_FILTER" || continue
  if _resolve_python_entry "$SUBDIR" "$TOOL_NAME"; then
    echo "  → $TOOL_NAME (python)"
    _run_import "$TOOL_NAME" "Tool" "(cd \"$PY_IMPORT_DIR\" && orchestrate tools import -k python -p . -f \"$PY_IMPORT_FILE\" -r requirements.txt)"
    [[ -n "$PY_IMPORT_CLEANUP" ]] && rm -rf "$PY_IMPORT_CLEANUP"
  fi
done
fi
fi

# 3. OpenAPI tools in subdirs (tools/<name>/) — skip when --flows-only or --plugins-only
if [[ "$IMPORT_FLOWS_ONLY" != "true" ]] && [[ "$IMPORT_PLUGINS_ONLY" != "true" ]]; then
for SUBDIR in "$TOOLS_DIR"/*/; do
  [ -d "$SUBDIR" ] || continue
  TOOL_NAME=$(basename "$SUBDIR")
  _matches_filter "$TOOL_NAME" "$TOOL_FILTER" || continue
  [ -f "$SUBDIR/requirements.txt" ] && [ -n "$(find "$SUBDIR" -maxdepth 1 -name "*.py" 2>/dev/null)" ] && continue
  for SPEC in "$SUBDIR"/skill_v2.json "$SUBDIR"/openapi.json; do
    [ -f "$SPEC" ] || continue
    _patch_openapi_operation_descriptions "$SPEC"
    TOOL_CONN_APP_ID=""
    # Import tool's bundled connections first — use app_id from source export to preserve same connection assignment
    if [[ -d "$SUBDIR/connections" ]]; then
      for CONN_YAML in "$SUBDIR"/connections/*.yml "$SUBDIR"/connections/*.yaml; do
        [ -f "$CONN_YAML" ] || continue
        CONN_APP_ID=$(grep -E '^\s*app_id:' "$CONN_YAML" 2>/dev/null | head -1 | sed 's/.*app_id:\s*\([^[:space:]]*\).*/\1/')
        [[ -z "$CONN_APP_ID" ]] && { CONN_APP_ID=$(basename "$CONN_YAML"); CONN_APP_ID="${CONN_APP_ID%.yml}"; CONN_APP_ID="${CONN_APP_ID%.yaml}"; }
        [[ -z "$TOOL_CONN_APP_ID" ]] && TOOL_CONN_APP_ID="$CONN_APP_ID"
        echo "  → $CONN_APP_ID (connection for $TOOL_NAME)"
        _run_import "$CONN_APP_ID" "Connection" "orchestrate connections import -f \"$CONN_YAML\""
        if [[ -n "$_conn_lookup" ]]; then
          ENV_CONN_FILE="${WXO_ROOT}/Systems/${_conn_lookup}/Connections/.env_connection_${_conn_lookup}"
          if [[ -f "$ENV_CONN_FILE" ]] && _set_connection_credentials_from_env "$CONN_APP_ID" "$CONN_YAML" "$ENV_CONN_FILE"; then
            echo "     ✓ credentials set"
            _update_last_connection_note "credentials set"
          elif [[ -f "$ENV_CONN_FILE" ]]; then
            _update_last_connection_note "credentials not set"
          fi
        fi
      done
    fi
    echo "  → $TOOL_NAME (openapi)"
    if [[ -n "$TOOL_CONN_APP_ID" ]]; then
      _run_import "$TOOL_NAME" "Tool" "(cd \"$SUBDIR\" && orchestrate tools import -k openapi -f \"$(basename "$SPEC")\" -a \"$TOOL_CONN_APP_ID\")"
    else
      _run_import "$TOOL_NAME" "Tool" "(cd \"$SUBDIR\" && orchestrate tools import -k openapi -f \"$(basename "$SPEC")\")"
    fi
    break
  done
done
fi

# 4. Flow tools in tools/<name>/ (legacy — flows from older exports) — skip when --plugins-only
if [[ "$IMPORT_FLOWS_ONLY" != "true" ]] && [[ "$IMPORT_PLUGINS_ONLY" != "true" ]] && [[ -d "$TOOLS_DIR" ]]; then
for SUBDIR in "$TOOLS_DIR"/*/; do
  [ -d "$SUBDIR" ] || continue
  TOOL_NAME=$(basename "$SUBDIR")
  _matches_filter "$TOOL_NAME" "$TOOL_FILTER" || continue
  # Skip Python (has .py + requirements.txt)
  [ -f "$SUBDIR/requirements.txt" ] && [ -n "$(find "$SUBDIR" -maxdepth 1 -name "*.py" 2>/dev/null)" ] && continue
  # Skip OpenAPI (has skill_v2.json or openapi.json)
  [ -f "$SUBDIR/skill_v2.json" ] || [ -f "$SUBDIR/openapi.json" ] && continue
  # Flow: *.json with kind:"flow" (exclude tool-spec.json)
  for FLOW_JSON in "$SUBDIR"/*.json; do
    [ -f "$FLOW_JSON" ] || continue
    [[ "$(basename "$FLOW_JSON")" == "tool-spec.json" ]] && continue
    if jq -e '.spec.kind == "flow" or .kind == "flow"' "$FLOW_JSON" >/dev/null 2>&1; then
      echo "  → $TOOL_NAME (flow)"
      _run_import "$TOOL_NAME" "Tool" "orchestrate tools import -k flow -f \"$FLOW_JSON\""
      break
    fi
  done
done
fi

# 5. Flow tools in flows/<name>/ (primary location for flow exports) — skip when --plugins-only
if [[ "$IMPORT_PLUGINS_ONLY" != "true" ]] && [[ -d "$FLOWS_DIR" ]]; then
for SUBDIR in "$FLOWS_DIR"/*/; do
  [ -d "$SUBDIR" ] || continue
  TOOL_NAME=$(basename "$SUBDIR")
  _matches_filter "$TOOL_NAME" "$TOOL_FILTER" || continue
  for FLOW_JSON in "$SUBDIR"/*.json; do
    [ -f "$FLOW_JSON" ] || continue
    [[ "$(basename "$FLOW_JSON")" == "tool-spec.json" ]] && continue
    echo "  → $TOOL_NAME (flow)"
    _run_import "$TOOL_NAME" "Tool" "(cd \"$SUBDIR\" && orchestrate tools import -k flow -f \"$(basename "$FLOW_JSON")\")"
    break
  done
done
fi

echo ""
fi
fi

# =======================================================
# AUTO DISCOVERY & IMPORT — TOOLS FROM AGENT DEPENDENCIES
# (agents/<name>/tools/ — must be imported before the agent)
# Skip when --agent-only: import agent YAML only, no bundled tools
# =======================================================

if [[ "$IMPORT_AGENTS" == "true" ]] && [[ "$AGENT_ONLY" != "true" ]]; then
echo "  Tools (agent dependencies)"
echo "  ──────────────────────────"

for AGENT_SUBDIR in "$AGENTS_DIR"/*/; do
  [ -d "$AGENT_SUBDIR" ] || continue
  AGENT_NAME=$(basename "$AGENT_SUBDIR")
  _matches_filter "$AGENT_NAME" "$AGENT_FILTER" || continue
  TOOLS_SUBDIR="${AGENT_SUBDIR}tools"
  [ -d "$TOOLS_SUBDIR" ] || continue

  for TOOL_DIR in "$TOOLS_SUBDIR"/*/; do
    [ -d "$TOOL_DIR" ] || continue
    TOOL_NAME=$(basename "$TOOL_DIR")

    # Python: *.py + requirements.txt (exclude __init__.py — it's not the main module)
    if _resolve_python_entry "$TOOL_DIR" "$TOOL_NAME" "__init__.py"; then
      echo "  → $TOOL_NAME (python, agent dep)"
      # Run from inside tool dir. Hide __init__.py if it imports wrong name (e.g. pto_tool when function is pto_balance)
      _init="$TOOL_DIR/__init__.py"
      _init_bak="${_init}.import_bak"
      [[ -f "$_init" ]] && mv "$_init" "$_init_bak" 2>/dev/null || true
      _run_import "$TOOL_NAME" "Tool" "(cd \"$PY_IMPORT_DIR\" && orchestrate tools import -k python -p . -f \"$PY_IMPORT_FILE\" -r requirements.txt)"
      [[ -f "$_init_bak" ]] && mv "$_init_bak" "$_init" 2>/dev/null || true
      [[ -n "$PY_IMPORT_CLEANUP" ]] && rm -rf "$PY_IMPORT_CLEANUP"
      continue
    fi

    # OpenAPI: skill_v2.json or openapi.json
    for SPEC in "$TOOL_DIR"/skill_v2.json "$TOOL_DIR"/openapi.json; do
      [ -f "$SPEC" ] || continue
      _patch_openapi_operation_descriptions "$SPEC"
      TOOL_CONN_APP_ID=""
      # Import tool's bundled connections first — use app_id from source export to preserve same connection assignment
      if [[ -d "$TOOL_DIR/connections" ]]; then
        for CONN_YAML in "$TOOL_DIR"/connections/*.yml "$TOOL_DIR"/connections/*.yaml; do
          [ -f "$CONN_YAML" ] || continue
          CONN_APP_ID=$(grep -E '^\s*app_id:' "$CONN_YAML" 2>/dev/null | head -1 | sed 's/.*app_id:\s*\([^[:space:]]*\).*/\1/')
          [[ -z "$CONN_APP_ID" ]] && { CONN_APP_ID=$(basename "$CONN_YAML"); CONN_APP_ID="${CONN_APP_ID%.yml}"; CONN_APP_ID="${CONN_APP_ID%.yaml}"; }
          [[ -z "$TOOL_CONN_APP_ID" ]] && TOOL_CONN_APP_ID="$CONN_APP_ID"
          echo "  → $CONN_APP_ID (connection for $TOOL_NAME)"
          _run_import "$CONN_APP_ID" "Connection" "orchestrate connections import -f \"$CONN_YAML\""
          if [[ -n "$ENV_NAME" ]] && [[ -n "$ENV_CONN_FILE" ]] && _set_connection_credentials_from_env "$CONN_APP_ID" "$CONN_YAML" "$ENV_CONN_FILE"; then
            echo "     ✓ credentials set"
            _update_last_connection_note "credentials set"
          elif [[ -n "$ENV_CONN_FILE" ]]; then
            _update_last_connection_note "credentials not set"
          fi
        done
      fi
      echo "  → $TOOL_NAME (openapi, agent dep)"
      if [[ -n "$TOOL_CONN_APP_ID" ]]; then
        _run_import "$TOOL_NAME" "Tool" "(cd \"$TOOL_DIR\" && orchestrate tools import -k openapi -f \"$(basename "$SPEC")\" -a \"$TOOL_CONN_APP_ID\")"
      else
        _run_import "$TOOL_NAME" "Tool" "(cd \"$TOOL_DIR\" && orchestrate tools import -k openapi -f \"$(basename "$SPEC")\")"
      fi
      continue 2
    done

    # Flow: *.json (flow spec — exclude tool-spec.json which is Python metadata)
    for FLOW_JSON in "$TOOL_DIR"/*.json; do
      [ -f "$FLOW_JSON" ] || continue
      [[ "$(basename "$FLOW_JSON")" == "tool-spec.json" ]] && continue
      echo "  → $TOOL_NAME (flow, agent dep)"
      _run_import "$TOOL_NAME" "Tool" "(cd \"$TOOL_DIR\" && orchestrate tools import -k flow -f \"$(basename "$FLOW_JSON")\")"
      break
    done
  done
done

echo ""

# =======================================================
# AUTO DISCOVERY & IMPORT — AGENTS
# =======================================================

echo "  Agents"
echo "  ───────"

if [ ! -d "$AGENTS_DIR" ]; then
  echo "[ERROR] Agents directory not found: $AGENTS_DIR"
  exit 1
fi

DEFAULT_LLM=""
_get_default_llm >/dev/null && DEFAULT_LLM=$(_get_default_llm) || true

_agent_import_yaml() {
  local yaml="$1"
  local tmp_yaml=""
  if [[ -n "$DEFAULT_LLM" ]] && ! grep -qE '^llm:' "$yaml" 2>/dev/null; then
    tmp_yaml=$(mktemp 2>/dev/null || echo "/tmp/wxo_agent_$$.yaml")
    awk -v llm="$DEFAULT_LLM" '/^name:/{print; print "llm: " llm; next}1' "$yaml" > "$tmp_yaml"
    echo "$tmp_yaml"
  else
    echo "$yaml"
  fi
}

# 1. Agents with dependencies (agents/<name>/agents/native/<name>.yaml)
for AGENT_SUBDIR in "$AGENTS_DIR"/*/; do
  [ -d "$AGENT_SUBDIR" ] || continue
  AGENT_NAME=$(basename "$AGENT_SUBDIR")
  _matches_filter "$AGENT_NAME" "$AGENT_FILTER" || continue
  YAML_FILE="${AGENT_SUBDIR}agents/native/${AGENT_NAME}.yaml"
  [ -f "$YAML_FILE" ] || continue

  echo "  → $AGENT_NAME (with deps)"
  USE_YAML=$(_agent_import_yaml "$YAML_FILE")
  _run_import "$AGENT_NAME" "Agent" "orchestrate agents import -f \"$USE_YAML\""
  [[ "$USE_YAML" != "$YAML_FILE" ]] && [[ -f "$USE_YAML" ]] && rm -f "$USE_YAML"
done

# 2. Top-level agent YAML (agents/*.yaml) — skip if already imported from subdir
for AGENT_FILE in "$AGENTS_DIR"/*.yaml "$AGENTS_DIR"/*.yml; do
  [ -f "$AGENT_FILE" ] || continue
  STEM=$(basename "$AGENT_FILE")
  STEM="${STEM%.yaml}"
  STEM="${STEM%.yml}"
  _matches_filter "$STEM" "$AGENT_FILTER" || continue
  [ -d "$AGENTS_DIR/$STEM" ] && continue   # already imported from agents/<name>/

  echo "  → $STEM (yaml)"
  USE_YAML=$(_agent_import_yaml "$AGENT_FILE")
  _run_import "$STEM" "Agent" "orchestrate agents import -f \"$USE_YAML\""
  [[ "$USE_YAML" != "$AGENT_FILE" ]] && [[ -f "$USE_YAML" ]] && rm -f "$USE_YAML"
done

echo ""
echo ""
fi

# =======================================================
# AUTO DISCOVERY & IMPORT — CONNECTIONS (from connections/)
# =======================================================
if [[ "$IMPORT_CONNECTIONS" == "true" ]]; then
CONNECTIONS_DIR="$BASE_DIR/connections"
echo ""
echo "  Connections (from connections/)"
echo "  ──────────────────────────────"
# Resolve env file for set-credentials: WxO/Systems/<env>/Connections/.env_connection_<env>
# Use ENV_CONN_SOURCE when set (replicate) else ENV_NAME
ENV_CONN_FILE=""
if [[ -n "$_conn_lookup" ]]; then
  ENV_CONN_FILE="${WXO_ROOT}/Systems/${_conn_lookup}/Connections/.env_connection_${_conn_lookup}"
  [[ ! -f "$ENV_CONN_FILE" ]] && ENV_CONN_FILE=""
fi
for CONN_FILE in "$CONNECTIONS_DIR"/*.yml "$CONNECTIONS_DIR"/*.yaml; do
  [ -f "$CONN_FILE" ] || continue
  APP_ID=$(grep -E '^\s*app_id:' "$CONN_FILE" 2>/dev/null | head -1 | sed 's/.*app_id:\s*\([^[:space:]]*\).*/\1/')
  [[ -z "$APP_ID" ]] && { APP_ID=$(basename "$CONN_FILE"); APP_ID="${APP_ID%.yml}"; APP_ID="${APP_ID%.yaml}"; }
  _matches_filter "$APP_ID" "$CONNECTION_FILTER" || continue
  echo "  → $APP_ID"
  _run_import "$APP_ID" "Connection" "orchestrate connections import -f \"$CONN_FILE\""
  # When .env_connection exists, set credentials (function exits early if no values for this app)
  if [[ -n "$ENV_CONN_FILE" ]]; then
    if _set_connection_credentials_from_env "$APP_ID" "$CONN_FILE" "$ENV_CONN_FILE"; then
      echo "     ✓ credentials set"
      _update_last_connection_note "credentials set"
    else
      echo "     ⚠ credentials not set (no CONN_${APP_ID//./_}.* in .env_connection or file missing)"
      _update_last_connection_note "credentials not set (no CONN_* in .env_connection)"
    fi
  else
    echo "     ⚠ credentials not set (no .env_connection at WxO/Systems/${_conn_lookup}/Connections/ - add CONN_<app_id>_API_KEY etc.)"
    _update_last_connection_note "credentials not set (no .env_connection file)"
  fi
done
echo ""
fi

_fill_report_ids
_print_report

# --- Final summary: report location ---
if [[ -n "$REPORT_FILE" ]]; then
  echo "  Report saved: $REPORT_FILE"
  echo "  View: cat \"$REPORT_FILE\""
  echo ""
fi

# --- Optional: validate imported agents (invoke and check response) ---
_validate_agents() {
  [[ "$VALIDATE" != "true" ]] && return 0
  local agents_to_validate=()
  for entry in "${REPORT_ENTRIES[@]}"; do
    IFS='|' read -r type name status _ _ <<< "$entry"
    [[ "$type" == "Agent" ]] && [[ "$status" == "OK" ]] && agents_to_validate+=("$name")
  done
  [[ ${#agents_to_validate[@]} -eq 0 ]] && return 0

  echo ""
  echo "  ═══════════════════════════════════════════════════════════════════════════════════"
  echo "  VALIDATION — Invoking agents with test prompt"
  echo "  ═══════════════════════════════════════════════════════════════════════════════════"
  local test_prompt="Hello"
  local target_env="${ENV_NAME:-bootcamp}"
  if [[ -f "$ENV_FILE" ]]; then set -a; source "$ENV_FILE" 2>/dev/null || true; set +a; fi

  _get_env_key() {
    local env="$1"
    local key_var="WXO_API_KEY_${env}"
    local key="${!key_var}"
    [[ -z "$key" ]] && [[ "$env" == "bootcamp" ]] && key="${WO_API_KEY}"
    echo "$key"
  }

  _invoke_agent() {
    local env="$1" agent="$2"
    local key
    key=$(_get_env_key "$env")
    [[ -z "$key" ]] && { echo "(no key for $env)"; return 1; }
    orchestrate env activate "$env" --api-key "$key" 2>/dev/null || return 1
    local out
    # Pipe 'q' so CLI exits after response instead of staying in interactive chat mode
    out=$(printf 'q\n' | orchestrate chat ask -n "$agent" "$test_prompt" -r 2>&1) || { echo "(invoke failed)"; return 1; }
    out=$(echo "$out" | sed 's/\x1b\[[0-9;]*m//g')
    if [[ -z "${out// }" ]]; then echo "(empty)"; return 1; fi
    if echo "$out" | grep -qE '\[ERROR\]|Error:|error:|not found'; then echo "(error)"; return 1; fi
    echo "$out"
    return 0
  }

  for agent in "${agents_to_validate[@]}"; do
    echo ""
    echo "  → $agent"
    local target_out="" source_out="" target_ok=false source_ok=false
    target_out=$(_invoke_agent "$target_env" "$agent") && target_ok=true
    if [[ "$target_ok" == "true" ]]; then
      echo "     Target ($target_env): ✓ responded"
    else
      echo "     Target ($target_env): ✗ no response or error"
      HAS_FAILURES=1
    fi

    if [[ -n "$VALIDATE_SOURCE_ENV" ]]; then
      source_out=$(_invoke_agent "$VALIDATE_SOURCE_ENV" "$agent") && source_ok=true
      if [[ "$source_ok" == "true" ]]; then
        echo "     Source ($VALIDATE_SOURCE_ENV): ✓ responded"
        if [[ "$target_ok" == "true" ]]; then
          local norm_src norm_tgt
          norm_src=$(echo "$source_out" | tr -d '[:space:]' | head -c 200)
          norm_tgt=$(echo "$target_out" | tr -d '[:space:]' | head -c 200)
          if [[ "$norm_src" == "$norm_tgt" ]]; then
            echo "     Match: ✓ same response"
          else
            echo "     Match: — different (LLM output may vary)"
          fi
        fi
      else
        echo "     Source ($VALIDATE_SOURCE_ENV): ✗ no response or error"
      fi
    fi
    key=$(_get_env_key "$target_env")
    [[ -n "$key" ]] && orchestrate env activate "$target_env" --api-key "$key" 2>/dev/null || true
  done

  echo ""
  echo "  ═══════════════════════════════════════════════════════════════════════════════════"
  echo ""
}

_validate_agents

[[ $HAS_FAILURES -eq 1 ]] && exit 1
echo ""
echo "  ───────────────────────────────────────────────────────────────────────────"
echo "  IMPORT COMPLETE"
echo "  ───────────────────────────────────────────────────────────────────────────"
[[ -n "$REPORT_FILE" ]] && { echo "  Report: $REPORT_FILE"; echo "  View:   cat \"$REPORT_FILE\""; }
echo ""