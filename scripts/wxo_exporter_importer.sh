#!/bin/bash
#
# Script: wxo_exporter_importer.sh
# Version: 1.0.8
# Author: Markus van Kempen <mvankempen@ca.ibm.com>, <markus.van.kempen@gmail.com>
# Date: Feb 25, 2026
#
# Description:
#   Interactive main script for Watson Orchestrate (WXO) export/import.
#   Guides the user through: (1) environment selection from 'orchestrate env list',
#   (2) Export or Import, (3) local directory, (4) agent/tool selection, then runs.
#
#   - Uses .env for API keys (WXO_API_KEY_<ENV>) when available; prompts otherwise.
#   - When adding a new env: can prefill from .env (WXO_URL_<name>, WXO_API_KEY_<name>).
#   - Requires: orchestrate CLI, jq (for export/compare).
#
# Usage: ./wxo_exporter_importer.sh
#   ENV_FILE=/path/to/.env ./wxo_exporter_importer.sh   # override .env location
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

[[ -f "$SCRIPT_DIR/VERSION" ]] && WXO_VERSION=$(cat "$SCRIPT_DIR/VERSION" 2>/dev/null | head -1 | tr -d '[:space:]') || WXO_VERSION="1.0.8"
[[ " ${*} " = *" --version "* ]] || [[ " ${*} " = *" -v "* ]] && { echo "WxO Importer/Export/Comparer/Validator v${WXO_VERSION} by mvk"; exit 0; }

# --- .env and paths ---
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../../.env}"
[[ ! -f "$ENV_FILE" ]] && ENV_FILE="$SCRIPT_DIR/../../.env"
[[ ! -f "$ENV_FILE" ]] && ENV_FILE="$SCRIPT_DIR/.env"

EXPORT_SCRIPT="$SCRIPT_DIR/export_from_wxo.sh"
DEPLOY_SCRIPT="$SCRIPT_DIR/import_to_wxo.sh"
COMPARE_SCRIPT="$SCRIPT_DIR/compare_wxo_systems.sh"

# --- Guardrails: require orchestrate CLI ---
if ! command -v orchestrate >/dev/null 2>&1; then
  echo "[ERROR] 'orchestrate' CLI not found. Install it first:"
  echo "  https://developer.watson-orchestrate.ibm.com/getting_started/installing"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[ERROR] 'jq' is required. Install: sudo apt-get install jq  (or brew install jq)"
  exit 1
fi

# Load .env (API keys, URLs) — called when needed
_load_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE" 2>/dev/null || true
  set +a
}

# --- Debug/log (optional: set WXO_DEBUG=1 or WXO_LOG=1) ---
WXO_ROOT="${WXO_ROOT:-$SCRIPT_DIR/WxO}"
_log() {
  [[ "${WXO_DEBUG:-0}" == "1" || "${WXO_LOG:-0}" == "1" ]] || return 0
  local log_dir="$WXO_ROOT/logs"
  mkdir -p "$log_dir"
  local log_file="$log_dir/wxo_debug_$(date +%Y%m%d).log"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$log_file"
}

# Print command to console and optionally to log
_log_cmd() {
  echo "  $ orchestrate $*"
  _log "CMD: orchestrate $*"
}

# Init debug log at start when enabled
_init_debug_log() {
  if [[ "${WXO_DEBUG:-0}" == "1" || "${WXO_LOG:-0}" == "1" ]]; then
    _load_env
    local log_dir="$WXO_ROOT/logs"
    mkdir -p "$log_dir"
    local log_file="$log_dir/wxo_debug_$(date +%Y%m%d).log"
    _log "=== WXO session started ==="
    echo "  [DEBUG] Logging to $log_file"
  fi
}

# Get API key for env from .env or env var (WXO_API_KEY_<ENV>)
_get_api_key_from_env() {
  local env_name="$1"
  _load_env
  local var="WXO_API_KEY_${env_name}"
  echo "${!var}"
}

# Get URL for env from .env (WXO_URL_<ENV>)
_get_url_from_env() {
  local env_name="$1"
  _load_env
  local var="WXO_URL_${env_name}"
  echo "${!var}"
}

# --- Breadcrumb (path + current selection) ---
BREADCRUMB=()
NAV_BACK=0

_breadcrumb_push() {
  BREADCRUMB+=("$1")
}

_breadcrumb_pop() {
  if [[ ${#BREADCRUMB[@]} -gt 0 ]]; then
    BREADCRUMB=("${BREADCRUMB[@]:0:${#BREADCRUMB[@]}-1}")
  fi
}

# Append user's selection to the last breadcrumb (e.g. "Directory" -> "Directory: TZ1 — 20260225")
_breadcrumb_set_selection() {
  local sel="$1"
  local max_len="${2:-40}"
  if [[ ${#BREADCRUMB[@]} -gt 0 ]] && [[ -n "$sel" ]]; then
    local idx=$((${#BREADCRUMB[@]}-1))
    local last="${BREADCRUMB[$idx]}"
    if [[ ${#sel} -gt "$max_len" ]]; then
      sel="${sel:0:$((max_len-3))}..."
    fi
    BREADCRUMB[$idx]="${last}: ${sel}"
  fi
}

_breadcrumb_show() {
  if [[ ${#BREADCRUMB[@]} -gt 0 ]]; then
    local path=""
    local i
    for i in "${!BREADCRUMB[@]}"; do
      [[ -n "$path" ]] && path+=" > "
      path+="${BREADCRUMB[$i]}"
    done
    echo ""
    echo "  ┌─ Path: $path"
    echo "  └───────────────────────────────────────────────────────────────"
  fi
}

# --- Helpers ---
_print_header() {
  _breadcrumb_show
  echo ""
  echo "  ═══════════════════════════════════════════════════════════"
  echo "  $1"
  echo "  ═══════════════════════════════════════════════════════════"
  echo ""
}

_read_choice() {
  local prompt="$1"
  local max="$2"
  local allow_back="${3:-0}"
  local choice
  while true; do
    read -p "$prompt" choice
    if [[ "$choice" =~ ^[0-9]+$ ]]; then
      if [[ "$allow_back" == "1" ]] && [[ "$choice" -eq 0 ]]; then
        echo "0"
        return
      fi
      if [[ "$choice" -ge 1 ]] && [[ "$choice" -le "$max" ]]; then
        echo "$choice"
        return
      fi
    fi
    if [[ "$allow_back" == "1" ]]; then
      echo "  Invalid. Enter 0-$max (0 = Back)."
    else
      echo "  Invalid. Enter 1-$max."
    fi
  done
}

# --- Step 1: Environment selection (from orchestrate env list) ---
_select_environment() {
  BREADCRUMB=("Home")
  _print_header "WxO Importer/Export/Comparer/Validator v${WXO_VERSION} by mvk"
  echo ""
  echo "  Select environment (from 'orchestrate env list'):"
  echo ""

  local env_list
  env_list=$(orchestrate env list 2>&1) || {
    echo "[ERROR] Failed to run 'orchestrate env list'."
    echo "  Ensure the orchestrate CLI is installed and in PATH."
    exit 1
  }

  # Parse env names (first column; skip header/empty)
  local envs=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local name
    name=$(echo "$line" | awk '{print $1}')
    [[ -n "$name" ]] && [[ "$name" != "Name" ]] && envs+=("$name")
  done <<< "$env_list"

  if [[ ${#envs[@]} -gt 0 ]]; then
    echo "Environments:"
    local i=1
    for e in "${envs[@]}"; do
      echo "  [$i] $e"
      ((i++))
    done
    echo "  [$i] Create/Add new environment"
    echo "  [0] Exit"
    echo ""

    local choice=$(_read_choice "Choose (0-$i): " "$i" 1)
    if [[ "$choice" -eq 0 ]]; then
      echo ""
      echo "Goodbye."
      exit 0
    fi
    if [[ "$choice" -lt "$i" ]]; then
      WXO_ENV="${envs[$((choice-1))]}"
      _breadcrumb_push "$WXO_ENV"
      echo ""
      echo "Using environment: $WXO_ENV"
    else
      _add_environment
    fi
  else
    echo "No environments found."
    _add_environment
  fi
}

_add_environment() {
  echo ""
  echo "Add new environment (orchestrate env add)"
  read -p "  Name (e.g. TZ1, PROD): " env_name
  env_name=$(echo "$env_name" | tr -d '[:space:]')
  [[ -z "$env_name" ]] && { echo "[ERROR] Name required."; exit 1; }

  # Try .env: WXO_URL_<name>, WXO_API_KEY_<name>
  _load_env
  local url_var="WXO_URL_${env_name}"
  local key_var="WXO_API_KEY_${env_name}"
  local env_url="${!url_var}"
  local env_key="${!key_var}"

  if [[ -z "$env_url" ]]; then
    read -p "  WXO instance URL: " env_url
    env_url=$(echo "$env_url" | tr -d '[:space:]')
  else
    echo "  WXO instance URL: (from .env) ${env_url:0:50}..."
  fi
  [[ -z "$env_url" ]] && { echo "[ERROR] URL required. Add WXO_URL_${env_name} to .env or enter at prompt."; exit 1; }

  if [[ -z "$env_key" ]]; then
    read -p "  API key: " env_key
    env_key=$(echo "$env_key" | tr -d '[:space:]')
  else
    echo "  API key: (from .env)"
  fi
  [[ -z "$env_key" ]] && { echo "[ERROR] API key required. Add WXO_API_KEY_${env_name} to .env or enter at prompt."; exit 1; }

  echo ""
  orchestrate env add --name "$env_name" --url "$env_url" -t ibm_iam || { echo "[ERROR] Failed to add environment."; exit 1; }
  orchestrate env activate "$env_name" --api-key "$env_key" || { echo "[ERROR] Failed to activate."; exit 1; }

  WXO_ENV="$env_name"
  _breadcrumb_push "$WXO_ENV"
  echo ""
  echo "Environment '$WXO_ENV' added and activated."
  ALREADY_ACTIVATED=1
}

_activate_environment() {
  if [[ "$ALREADY_ACTIVATED" -eq 1 ]]; then
    return
  fi
  echo ""
  API_KEY=$(_get_api_key_from_env "$WXO_ENV")
  if [[ -z "$API_KEY" ]]; then
    read -p "Enter API key for '$WXO_ENV': " API_KEY
    API_KEY=$(echo "$API_KEY" | tr -d '[:space:]')
  else
    echo "  Using API key from .env (WXO_API_KEY_${WXO_ENV})"
  fi
  [[ -z "$API_KEY" ]] && { echo "[ERROR] API key required. Add WXO_API_KEY_${WXO_ENV} to .env or enter at prompt."; exit 1; }
  _log_cmd "env activate $WXO_ENV --api-key <hidden>"
  orchestrate env activate "$WXO_ENV" --api-key "$API_KEY" || { echo "[ERROR] Failed to activate environment."; exit 1; }
  echo ""
  echo "Environment '$WXO_ENV' activated."
}

# --- Step 2: Local directory (for Export target or Import source) ---
WXO_ROOT="${WXO_ROOT:-$SCRIPT_DIR/WxO}"

# Shorten path for display: WxO/Exports/TZ1/20260225_094225 -> TZ1 — 20260225_094225
_short_dir_label() {
  local d="${1%/}"
  [[ -z "$d" ]] && return
  if [[ "$d" == *"/WxO/Exports/"* ]]; then
    local rest="${d#*WxO/Exports/}"
    if [[ "$rest" == *"/"* ]]; then
      local sys="${rest%%/*}"
      local dt="${rest##*/}"
      echo "${sys} — ${dt}"
    else
      echo "$rest"
    fi
  elif [[ "$d" == *"/WxO/Replicate/"* ]]; then
    local rest="${d#*WxO/Replicate/}"
    if [[ "$rest" == *"/"* ]]; then
      local label="${rest%%/*}"
      local dt="${rest##*/}"
      echo "${label} — ${dt} (replicate)"
    else
      echo "$rest (replicate)"
    fi
  elif [[ "$d" == *"/WxOExports/"* ]] || [[ "$d" == *"/WxOExports" ]]; then
    # Legacy: WxOExports/System/Export/datetime
    local rest="${d#*WxOExports/}"
    [[ "$rest" == "$d" ]] && { echo "(new)"; return; }
    if [[ "$rest" == *"/Export/"* ]]; then
      local sys="${rest%%/Export/*}"
      local dt="${rest##*Export/}"
      echo "${sys} — ${dt} (legacy)"
    else
      echo "$(basename "$d")"
    fi
  elif [[ "$d" == *"/WxO" ]] || [[ "$d" == *"/WxO/"* ]]; then
    echo "(new)"
  else
    echo "$(basename "$d")"
  fi
}

_select_local_dir() {
  _breadcrumb_push "Directory"
  _print_header "Local directory"
  if [[ "$ACTION" -eq 1 ]]; then
    echo "Where to save the export?"
  else
    echo "Which local directory to import from?"
    echo "(Select from exports: System -> DateTime)"
  fi
  echo ""

  if [[ "$ACTION" -eq 2 ]]; then
    # Import: show Exports or Replicate - pick source, then system/pair, then date
    echo "  Import from:"
    echo "  [1] Exports   — WxO/Exports/<System>/<DateTime>/"
    echo "  [2] Replicate — WxO/Replicate/<Source>_to_<Target>/<DateTime>/"
    echo ""
    local source_type=$(_read_choice "Choose (1-2): " 2)
    local base_dir=""
    if [[ "$source_type" -eq 1 ]]; then
      base_dir="$WXO_ROOT/Exports"
      [[ ! -d "$base_dir" ]] && base_dir="$SCRIPT_DIR/WxOExports"
    else
      base_dir="$WXO_ROOT/Replicate"
    fi
    [[ ! -d "$base_dir" ]] && base_dir=""
    if [[ -z "$base_dir" ]] || [[ ! -d "$base_dir" ]]; then
      echo "No directory found at $base_dir. Run Export or Replicate first."
      exit 1
    fi

    local systems=()
    for system in "$base_dir"/*/; do
      [[ ! -d "$system" ]] && continue
      systems+=("$(basename "$system")")
    done
    # Legacy: WxOExports/System/Export/
    if [[ "$base_dir" == *"WxOExports" ]] && [[ ${#systems[@]} -eq 0 ]]; then
      for system in "$base_dir"/*/; do
        [[ ! -d "$system" ]] && continue
        [[ -d "$system/Export" ]] || continue
        systems+=("$(basename "$system")")
      done
    fi

    if [[ ${#systems[@]} -eq 0 ]]; then
      echo "No systems found under $base_dir/"
      exit 1
    fi

    echo "  Select $( [[ "$source_type" -eq 2 ]] && echo "replicate pair" || echo "system" ) (source):"
    local si=1
    for s in "${systems[@]}"; do
      echo "  [$si] $s"
      ((si++))
    done
    echo "  [0] Back"
    echo ""
    local sys_choice=$(_read_choice "Choose (0-${#systems[@]}): " "${#systems[@]}" 1)
    if [[ "$sys_choice" -eq 0 ]]; then
      _breadcrumb_pop
      NAV_BACK=1
      return
    fi
    local CHOSEN_SYSTEM="${systems[$((sys_choice-1))]}"

    # List DateTime dirs: Base/System/datetime or legacy Base/System/Export/datetime
    local datetimes=()
    local use_legacy=false
    if [[ -d "$base_dir/$CHOSEN_SYSTEM" ]]; then
      for dt in "$base_dir/$CHOSEN_SYSTEM/"*/; do
        [[ ! -d "$dt" ]] && continue
        dt="${dt%/}"
        dt="$(basename "$dt")"
        [[ "$dt" == "Export" ]] && continue
        [[ -d "$base_dir/$CHOSEN_SYSTEM/$dt/agents" ]] || [[ -d "$base_dir/$CHOSEN_SYSTEM/$dt/tools" ]] || [[ -d "$base_dir/$CHOSEN_SYSTEM/$dt/plugins" ]] || [[ -d "$base_dir/$CHOSEN_SYSTEM/$dt/connections" ]] && datetimes+=("$dt")
      done
    fi
    if [[ ${#datetimes[@]} -eq 0 ]] && [[ -d "$base_dir/$CHOSEN_SYSTEM/Export" ]]; then
      use_legacy=true
      for dt in "$base_dir/$CHOSEN_SYSTEM/Export/"*/; do
        [[ ! -d "$dt" ]] && continue
        dt="${dt%/}"
        dt="$(basename "$dt")"
        [[ -d "$base_dir/$CHOSEN_SYSTEM/Export/$dt/agents" ]] || [[ -d "$base_dir/$CHOSEN_SYSTEM/Export/$dt/tools" ]] || [[ -d "$base_dir/$CHOSEN_SYSTEM/Export/$dt/plugins" ]] || [[ -d "$base_dir/$CHOSEN_SYSTEM/Export/$dt/connections" ]] && datetimes+=("$dt")
      done
    fi
    if [[ ${#datetimes[@]} -gt 1 ]]; then
      datetimes=($(printf '%s\n' "${datetimes[@]}" | sort -ru))
    fi

    if [[ ${#datetimes[@]} -eq 0 ]]; then
      echo "No dates found under $base_dir/$CHOSEN_SYSTEM/"
      exit 1
    fi

    echo ""
    echo "  Select export date/time:"
    local di=1
    for dt in "${datetimes[@]}"; do
      echo "  [$di] $dt"
      ((di++))
    done
    echo "  [0] Back"
    echo ""
    local dt_choice=$(_read_choice "Choose (0-${#datetimes[@]}): " "${#datetimes[@]}" 1)
    if [[ "$dt_choice" -eq 0 ]]; then
      _breadcrumb_pop
      NAV_BACK=1
      return
    fi
    local CHOSEN_DT="${datetimes[$((dt_choice-1))]}"

    if [[ "$use_legacy" == "true" ]]; then
      SYS_DIR="$base_dir/$CHOSEN_SYSTEM/Export/$CHOSEN_DT"
    else
      SYS_DIR="$base_dir/$CHOSEN_SYSTEM/$CHOSEN_DT"
    fi
  else
    # Export: show existing exports or create new
    local dirs=()
    # New structure: WxO/Exports/System/datetime/
    local exports_dir="$WXO_ROOT/Exports"
    if [[ -d "$exports_dir" ]]; then
      for system in "$exports_dir"/*/; do
        [[ ! -d "$system" ]] && continue
        system="${system%/}"
        system="$(basename "$system")"
        for datetime in "$exports_dir/$system/"*/; do
          [[ ! -d "$datetime" ]] && continue
          datetime="${datetime%/}"
          datetime="$(basename "$datetime")"
          [[ -d "$exports_dir/$system/$datetime/agents" ]] || [[ -d "$exports_dir/$system/$datetime/tools" ]] || [[ -d "$exports_dir/$system/$datetime/plugins" ]] || [[ -d "$exports_dir/$system/$datetime/connections" ]] && dirs+=("$exports_dir/$system/$datetime")
        done
      done
    fi
    # Legacy: WxOExports/System/Export/datetime
    local legacy_base="$SCRIPT_DIR/WxOExports"
    if [[ -d "$legacy_base" ]]; then
      for system in "$legacy_base"/*/; do
        [[ ! -d "$system" ]] && continue
        system="${system%/}"
        system="$(basename "$system")"
        [[ -d "$legacy_base/$system/Export" ]] || continue
        for datetime in "$legacy_base/$system/Export/"*/; do
          [[ ! -d "$datetime" ]] && continue
          datetime="${datetime%/}"
          [[ -d "$datetime/agents" ]] || [[ -d "$datetime/tools" ]] || [[ -d "$datetime/plugins" ]] || [[ -d "$datetime/connections" ]] && dirs+=("$legacy_base/$system/Export/$(basename "$datetime")")
        done
      done
    fi
    # Legacy: export_* or flat dirs in script dir
    for dir in "$SCRIPT_DIR"/export_*; do
      [[ -d "$dir" ]] && dirs+=("$dir")
    done
    for dir in "$SCRIPT_DIR"/*/; do
      [[ ! -d "$dir" ]] && continue
      dir="${dir%/}"
      [[ "$dir" == *"/export_"* ]] && continue
      [[ -d "$dir/Export" ]] && continue
      [[ -d "$dir/agents" ]] || [[ -d "$dir/tools" ]] || [[ -d "$dir/plugins" ]] || [[ -d "$dir/connections" ]] && dirs+=("$dir")
    done

    if [[ ${#dirs[@]} -gt 0 ]]; then
      echo "  Export directories:"
      i=1
      for d in "${dirs[@]}"; do
        echo "  [$i] $(_short_dir_label "$d")"
        ((i++))
      done
      echo "  [$i] Create new directory"
      echo "  [0] Back"
      echo ""
      local choice=$(_read_choice "Choose (0-$i): " "$i" 1)
      if [[ "$choice" -eq 0 ]]; then
        _breadcrumb_pop
        NAV_BACK=1
        return
      fi
      if [[ "$choice" -lt "$i" ]]; then
        SYS_DIR="${dirs[$((choice-1))]}"
      else
        _create_new_dir
      fi
    else
      echo "No existing directories. Creating new one."
      _create_new_dir
    fi
  fi
  _breadcrumb_set_selection "$(_short_dir_label "$SYS_DIR")"
  echo ""
  echo "  Selected: $(_short_dir_label "$SYS_DIR")"
}

_create_new_dir() {
  # Export script creates WxO/Exports/System/datetime/ via -o WxO --env-name
  SYS_DIR="$WXO_ROOT"
  echo "  New: $WXO_ENV — <datetime> (created by export)"
}

# --- Step 3: Action ---
_select_action() {
  _breadcrumb_push "Action"
  _print_header "What would you like to do?"
  echo "  [1] Export    — Pull agents/tools/flows/connections FROM Watson Orchestrate TO local"
  echo "  [2] Import    — Push agents/tools/flows/connections FROM local TO Watson Orchestrate"
  echo "  [3] Compare   — Compare agents, tools, flows between two systems (report table)"
  echo "  [4] Validate  — Invoke agents with test prompt; optionally compare with another system"
  echo "  [5] Replicate — Copy from source to target via Replicate/ folder (choose agents/tools, with/without deps)"
  echo "  [6] Danger Zone — Delete agents, tools, flows, or connections (irreversible)"
  echo "  [0] Back      — Return to environment selection"
  echo ""
  local choice=$(_read_choice "Choose (0-6): " 6 1)
  ACTION="$choice"
  if [[ "$ACTION" -eq 0 ]]; then
    _breadcrumb_pop
    _breadcrumb_pop
    return 1
  fi
  _breadcrumb_pop
  case "$ACTION" in
    1) _breadcrumb_push "Export" ;;
    2) _breadcrumb_push "Import" ;;
    3) _breadcrumb_push "Compare" ;;
    4) _breadcrumb_push "Validate" ;;
    5) _breadcrumb_push "Replicate" ;;
    6) _breadcrumb_push "Danger Zone" ;;
    *) _breadcrumb_push "Action" ;;
  esac
  return 0
}

# --- Step 4a: Export options ---
_fetch_agents() {
  orchestrate agents list -v 2>/dev/null | jq -r '
    (.native // .agents // .data // .items // .) |
    if type == "array" then . else [] end |
    .[] | select(type == "object") | (.name // .id) // empty
  ' 2>/dev/null || echo ""
}

_fetch_tools() {
  local type_filter="${1:-}"
  local raw
  raw=$(orchestrate tools list -v 2>/dev/null) || true
  [[ -z "$raw" ]] && { echo ""; return; }
  # Strip leading non-JSON line
  local first=$(echo "$raw" | head -1)
  if [[ -n "$first" ]] && ! echo "$first" | grep -qE '^[\[{]'; then
    raw=$(echo "$raw" | tail -n +2)
  fi
  # Output: name|kind per line; kind = python|openapi|flow|langflow|plugin|skill|other
  local lines
  lines=$(echo "$raw" | jq -r '
    (if type == "array" then . else (.tools // .native // .data // .items) end) |
    if type == "array" then . else [] end |
    .[] | select(type == "object") |
    ((.binding.python.type // .binding.python.kind // "") | if type == "string" then ascii_downcase else "" end) as $ptype |
    (if ($ptype == "agent_pre_invoke" or $ptype == "agent_post_invoke") then "plugin"
     elif .binding.python then "python"
     elif .binding.skill then "skill"
     elif .binding.openapi then "openapi"
     elif .binding.langflow then "langflow"
     elif .binding.flow or (.spec.kind == "flow") or (.kind == "flow") then "flow"
     else "other"
     end) as $k |
    ((.name // .id) // "") as $n |
    if $n != "" then "\($n)|\($k)" else empty end
  ' 2>/dev/null) || true
  if [[ -z "$type_filter" ]]; then
    while IFS='|' read -r name kind; do
      [[ -z "$name" ]] && continue
      [[ "$kind" == "skill" ]] && continue  # exclude catalog skills (not exportable)
      echo "$name"
    done <<< "$lines"
    return
  fi
  # Filter by type: flow matches both flow and langflow
  local name kind
  while IFS='|' read -r name kind; do
    [[ -z "$name" ]] && continue
    [[ "$kind" == "skill" ]] && continue  # skip catalog skills
    local kind_match=0
    local old_ifs="$IFS"
    IFS=,
    for t in $type_filter; do
      t=$(echo "$t" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
      if [[ "$t" == "flow" ]]; then
        [[ "$kind" == "flow" ]] || [[ "$kind" == "langflow" ]] && { kind_match=1; break; }
      elif [[ "$t" == "plugin" ]]; then
        [[ "$kind" == "plugin" ]] && { kind_match=1; break; }
      else
        [[ "$t" == "$kind" ]] && { kind_match=1; break; }
      fi
    done
    IFS="$old_ifs"
    [[ $kind_match -eq 1 ]] && echo "$name"
  done <<< "$lines"
}

# Fetch live connections (for Connections only export/copy)
_fetch_connections() {
  local raw json
  raw=$(orchestrate connections list -v --env live 2>/dev/null) || true
  [[ -z "$raw" ]] && { echo ""; return; }
  # Strip leading non-JSON line (cli [INFO]) — portable
  first=$(echo "$raw" | head -1)
  if [[ -n "$first" ]] && ! echo "$first" | grep -qE '^[\[{]'; then
    json=$(echo "$raw" | tail -n +2)
  else
    json="$raw"
  fi
  echo "$json" | jq -r '
    (if type == "array" then . else (.live // .connections // .data // .) end) |
    if type == "array" then . else [] end |
    .[] | select(type == "object") |
    select(.environment == "live") |
    select(.credentials_entered == true) |
    (.app_id // .appId // .id // .name) // empty | select(length > 0)
  ' 2>/dev/null | sort -u || echo ""
}

# Fetch only flow/langflow tools (for Flows only export)
_fetch_flows() {
  orchestrate tools list -v 2>/dev/null | jq -r '
    (if type == "array" then . else (.tools // .native // .agents // .data // .items) end) |
    if type == "array" then . else [] end |
    .[] | select(type == "object") |
    if .binding.flow or .binding.langflow or (.spec.kind == "flow") or (.kind == "flow") then (.name // .id) // empty else empty end
  ' 2>/dev/null || echo ""
}

_export_options() {
  _breadcrumb_push "What to export"
  _print_header "Export — What to export?"
  echo "  [1] Agents only (with optional tool/flow dependencies)"
  echo "  [2] Tools only (with bundled connections)"
  echo "  [3] Flows only (can include tools, agents, connections)"
  echo "  [4] Plugins only (agent_pre/post_invoke)"
  echo "  [5] All — agents, tools, flows (dependencies included by default)"
  echo "  [6] Connections only (live)"
  echo "  [0] Back"
  echo ""
  local what=$(_read_choice "Choose (0-6): " 6 1)
  if [[ "$what" -eq 0 ]]; then
    _breadcrumb_pop
    NAV_BACK=1
    return
  fi

  local agent_filter="" tool_filter="" flow_filter="" plugin_filter="" connection_filter="" tool_type_filter=""
  local agents_arr=() tools_arr=() flows_arr=() plugins_arr=() connections_arr=()

  if [[ "$what" -eq 1 ]] || [[ "$what" -eq 5 ]]; then
    echo ""
    _print_header "Select agents to export"
    agents_arr=()
    while IFS= read -r line; do [[ -n "$line" ]] && agents_arr+=("$line"); done < <(_fetch_agents)
    if [[ ${#agents_arr[@]} -gt 0 ]]; then
      local i=1
      for a in "${agents_arr[@]}"; do
        echo "  [$i] $a"
        ((i++))
      done
      echo ""
      read -p "Enter numbers (comma/space-separated), 'all', or Enter for all: " choice
      choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
      if [[ "$choice" == "all" ]] || [[ -z "${choice// }" ]]; then
        agent_filter=$(IFS=,; echo "${agents_arr[*]}")
      else
        local sel=()
        for num in $(echo "$choice" | tr ',' ' '); do
          num=$(echo "$num" | tr -cd '0-9')
          [[ -n "$num" ]] && [[ "$num" -ge 1 ]] && [[ "$num" -le ${#agents_arr[@]} ]] && sel+=("${agents_arr[$((num-1))]}")
        done
        [[ ${#sel[@]} -gt 0 ]] && agent_filter=$(IFS=,; echo "${sel[*]}")
      fi
      [[ -n "$agent_filter" ]] && echo "  Selected: $agent_filter"
    else
      echo "  No agents found in environment."
    fi
    echo ""
    echo "  Include agent dependencies (tools, flows) with each agent?"
    echo "  [1] Yes — Full export with tools and flows"
    echo "  [2] No  — Agent YAML only (no tools/flows)"
    echo ""
    local deps=$(_read_choice "Choose (1-2): " 2)
    [[ "$deps" -eq 2 ]] && with_deps="--agent-only" || true
  fi

  if [[ "$what" -eq 2 ]] || [[ "$what" -eq 5 ]]; then
    echo ""
    _print_header "Which tool types to export?"
    echo "  [1] All types (Python, OpenAPI, Flow)"
    echo "  [2] Python only"
    echo "  [3] OpenAPI only"
    echo "  [4] Flow only"
    echo "  [5] Python + OpenAPI (exclude Flow)"
    echo "  [6] Python + Flow (exclude OpenAPI)"
    echo "  [7] OpenAPI + Flow (exclude Python)"
    echo ""
    local type_choice=$(_read_choice "Choose (1-7): " 7)
    case "$type_choice" in
      1) tool_type_filter="" ;;
      2) tool_type_filter="python" ;;
      3) tool_type_filter="openapi" ;;
      4) tool_type_filter="flow" ;;
      5) tool_type_filter="python,openapi" ;;
      6) tool_type_filter="python,flow" ;;
      7) tool_type_filter="openapi,flow" ;;
      *) tool_type_filter="" ;;
    esac
    [[ -n "$tool_type_filter" ]] && echo "  Selected: $tool_type_filter"
    echo ""
    _print_header "Select tools to export"
    tools_arr=()
    while IFS= read -r line; do [[ -n "$line" ]] && tools_arr+=("$line"); done < <(_fetch_tools "$tool_type_filter")
    if [[ ${#tools_arr[@]} -gt 0 ]]; then
      local i=1
      for t in "${tools_arr[@]}"; do
        echo "  [$i] $t"
        ((i++))
      done
      echo ""
      read -p "Enter numbers (comma/space-separated), 'all', or Enter for all: " choice
      choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
      if [[ "$choice" == "all" ]] || [[ -z "${choice// }" ]]; then
        tool_filter=$(IFS=,; echo "${tools_arr[*]}")
      else
        local sel=()
        for num in $(echo "$choice" | tr ',' ' '); do
          num=$(echo "$num" | tr -cd '0-9')
          [[ -n "$num" ]] && [[ "$num" -ge 1 ]] && [[ "$num" -le ${#tools_arr[@]} ]] && sel+=("${tools_arr[$((num-1))]}")
        done
        [[ ${#sel[@]} -gt 0 ]] && tool_filter=$(IFS=,; echo "${sel[*]}")
      fi
      [[ -n "$tool_filter" ]] && echo "  Selected: $tool_filter"
    else
      echo "  No tools found matching the selected type(s)."
    fi
  fi

  if [[ "$what" -eq 3 ]]; then
    echo ""
    _print_header "Select flows to export"
    flows_arr=()
    while IFS= read -r line; do [[ -n "$line" ]] && flows_arr+=("$line"); done < <(_fetch_flows)
    if [[ ${#flows_arr[@]} -gt 0 ]]; then
      local i=1
      for f in "${flows_arr[@]}"; do
        echo "  [$i] $f"
        ((i++))
      done
      echo ""
      read -p "Enter numbers (comma/space-separated), 'all', or Enter for all: " choice
      choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
      if [[ "$choice" == "all" ]] || [[ -z "${choice// }" ]]; then
        flow_filter=$(IFS=,; echo "${flows_arr[*]}")
      else
        local sel=()
        for num in $(echo "$choice" | tr ',' ' '); do
          num=$(echo "$num" | tr -cd '0-9')
          [[ -n "$num" ]] && [[ "$num" -ge 1 ]] && [[ "$num" -le ${#flows_arr[@]} ]] && sel+=("${flows_arr[$((num-1))]}")
        done
        [[ ${#sel[@]} -gt 0 ]] && flow_filter=$(IFS=,; echo "${sel[*]}")
      fi
      [[ -n "$flow_filter" ]] && echo "  Selected: $flow_filter"
    else
      echo "  No flows found in environment."
    fi
  fi

  if [[ "$what" -eq 4 ]]; then
    echo ""
    _print_header "Select plugins to export"
    plugins_arr=()
    while IFS= read -r line; do [[ -n "$line" ]] && plugins_arr+=("$line"); done < <(_fetch_tools "plugin")
    if [[ ${#plugins_arr[@]} -gt 0 ]]; then
      local i=1
      for p in "${plugins_arr[@]}"; do
        echo "  [$i] $p"
        ((i++))
      done
      echo ""
      read -p "Enter numbers (comma/space-separated), 'all', or Enter for all: " choice
      choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
      if [[ "$choice" == "all" ]] || [[ -z "${choice// }" ]]; then
        plugin_filter=$(IFS=,; echo "${plugins_arr[*]}")
      else
        local sel=()
        for num in $(echo "$choice" | tr ',' ' '); do
          num=$(echo "$num" | tr -cd '0-9')
          [[ -n "$num" ]] && [[ "$num" -ge 1 ]] && [[ "$num" -le ${#plugins_arr[@]} ]] && sel+=("${plugins_arr[$((num-1))]}")
        done
        [[ ${#sel[@]} -gt 0 ]] && plugin_filter=$(IFS=,; echo "${sel[*]}")
      fi
      [[ -n "$plugin_filter" ]] && echo "  Selected: $plugin_filter"
    else
      echo "  No plugins found in environment."
    fi
  fi

  if [[ "$what" -eq 6 ]]; then
    echo ""
    _print_header "Select connections to export (live only)"
    connections_arr=()
    while IFS= read -r line; do [[ -n "$line" ]] && connections_arr+=("$line"); done < <(_fetch_connections)
    if [[ ${#connections_arr[@]} -gt 0 ]]; then
      local i=1
      for c in "${connections_arr[@]}"; do
        echo "  [$i] $c"
        ((i++))
      done
      echo ""
      read -p "Enter numbers (comma/space-separated), 'all', or Enter for all: " choice
      choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
      if [[ "$choice" == "all" ]] || [[ -z "${choice// }" ]]; then
        connection_filter=$(IFS=,; echo "${connections_arr[*]}")
      else
        local sel=()
        for num in $(echo "$choice" | tr ',' ' '); do
          num=$(echo "$num" | tr -cd '0-9')
          [[ -n "$num" ]] && [[ "$num" -ge 1 ]] && [[ "$num" -le ${#connections_arr[@]} ]] && sel+=("${connections_arr[$((num-1))]}")
        done
        [[ ${#sel[@]} -gt 0 ]] && connection_filter=$(IFS=,; echo "${sel[*]}")
      fi
      [[ -n "$connection_filter" ]] && echo "  Selected: $connection_filter"
    else
      echo "  No live connections found in environment."
    fi
  fi

  # Structured output: -o WxO root, --env-name system. Export creates WxO/Exports/System/datetime/
  local export_base="$WXO_ROOT" export_env="$WXO_ENV"
  if [[ "$SYS_DIR" != "$WXO_ROOT" ]] && [[ -d "$SYS_DIR" ]]; then
    # Selected existing dir: derive system from path (WxO/Exports/TZ1/dt or legacy)
    if [[ "$SYS_DIR" == *"/Exports/"* ]]; then
      local rest="${SYS_DIR#*Exports/}"
      export_env="${rest%%/*}"
    elif [[ "$SYS_DIR" == *"/WxOExports/"* ]]; then
      local rest="${SYS_DIR#*WxOExports/}"
      export_env="${rest%%/*}"
    fi
  fi
  EXPORT_ARGS="-o \"$export_base\" --env-name \"$export_env\""
  case "$what" in
    1) EXPORT_ARGS="$EXPORT_ARGS --agents-only ${with_deps:-}" ;;
    2) EXPORT_ARGS="$EXPORT_ARGS --tools-only" ;;
    3) EXPORT_ARGS="$EXPORT_ARGS --flows-only" ;;
    4) EXPORT_ARGS="$EXPORT_ARGS --plugins-only" ;;
    5) EXPORT_ARGS="$EXPORT_ARGS ${with_deps:-}" ;;
    6) EXPORT_ARGS="$EXPORT_ARGS --connections-only" ;;
  esac
  [[ -n "$agent_filter" ]] && EXPORT_ARGS="$EXPORT_ARGS --agent \"$agent_filter\"" || true
  [[ -n "$tool_filter" ]] && EXPORT_ARGS="$EXPORT_ARGS --tool \"$tool_filter\"" || true
  [[ -n "$tool_type_filter" ]] && EXPORT_ARGS="$EXPORT_ARGS --tool-type \"$tool_type_filter\"" || true
  [[ -n "$flow_filter" ]] && EXPORT_ARGS="$EXPORT_ARGS --tool \"$flow_filter\"" || true
  [[ -n "$plugin_filter" ]] && EXPORT_ARGS="$EXPORT_ARGS --tool \"$plugin_filter\"" || true
  [[ -n "$connection_filter" ]] && EXPORT_ARGS="$EXPORT_ARGS --connection \"$connection_filter\"" || true

  local export_sel="" n
  case "$what" in
    1) export_sel="Agents"; [[ -n "$agent_filter" ]] && { n=$(echo "$agent_filter" | awk -F',' '{print NF}'); export_sel="$export_sel ($n)"; } ;;
    2) export_sel="Tools"; [[ -n "$tool_filter" ]] && { n=$(echo "$tool_filter" | awk -F',' '{print NF}'); export_sel="$export_sel ($n)"; } ;;
    3) export_sel="Flows" ;;
    4) export_sel="Plugins"; [[ -n "$plugin_filter" ]] && { n=$(echo "$plugin_filter" | awk -F',' '{print NF}'); export_sel="$export_sel ($n)"; } ;;
    5) export_sel="All" ;;
    6) export_sel="Connections"; [[ -n "$connection_filter" ]] && { n=$(echo "$connection_filter" | awk -F',' '{print NF}'); export_sel="$export_sel ($n)"; } ;;
  esac
  _breadcrumb_set_selection "${export_sel:-Export}" 35
}

# --- Step 4b: Import options ---
_import_options() {
  _breadcrumb_push "What to import"
  _print_header "Import — What to import?"
  echo "  Without Dependencies"
  echo "  [1] Agents (YAML only)"
  echo "  [2] Tools"
  echo "  [3] Flows"
  echo "  [4] Plugins (from plugins/)"
  echo "  [5] Connections"
  echo ""
  echo "  With Dependencies"
  echo "  [6] Agents (+ bundled tools/flows)"
  echo "  [7] Tools (+ bundled connections)"
  echo "  [8] Flows (+ bundled connections)"
  echo "  [9] Folder — all objects in directory"
  echo ""
  echo "  [0] Back"
  echo ""
  local what=$(_read_choice "Choose (0-9): " 9 1)
  if [[ "$what" -eq 0 ]]; then
    _breadcrumb_pop
    NAV_BACK=1
    return
  fi

  echo ""
  echo "  If resource already exists in target:"
  echo "  [1] Override — Update/replace with imported version"
  echo "  [2] Skip    — Do not import (keep existing)"
  echo "  [0] Back"
  echo ""
  local if_exists=$(_read_choice "Choose (0-2): " 2 1)
  if [[ "$if_exists" -eq 0 ]]; then
    _breadcrumb_pop
    NAV_BACK=1
    return
  fi
  local if_mode="override"
  [[ "$if_exists" -eq 2 ]] && if_mode="skip"

  local validate_opt=""
  if [[ "$what" -eq 1 ]] || [[ "$what" -eq 6 ]] || [[ "$what" -eq 9 ]]; then
    echo ""
    echo "  Validate imported agents after import? (orchestrate CLI invokes agents only, not flows/tools)"
    echo "  [1] No"
    echo "  [2] Yes — check agents respond"
    echo "  [3] Yes — also compare with source system"
    echo ""
    local val_choice=$(_read_choice "Choose (1-3): " 3)
    if [[ "$val_choice" -eq 2 ]]; then
      validate_opt="--validate"
    elif [[ "$val_choice" -eq 3 ]]; then
      local source_env=""
      if [[ "$SYS_DIR" == *"/Exports/"* ]]; then
        source_env="${SYS_DIR#*Exports/}"
        source_env="${source_env%%/*}"
      elif [[ "$SYS_DIR" == *"/WxOExports/"* ]]; then
        source_env="${SYS_DIR#*WxOExports/}"
        source_env="${source_env%%/*}"
      fi
      if [[ -n "$source_env" ]]; then
        validate_opt="--validate --validate-with-source $source_env"
      else
        validate_opt="--validate"
      fi
    fi
  fi

  # Write import report to WxO/Imports/TargetEnv/datetime/Report/
  local import_report_dir="$WXO_ROOT/Imports/$WXO_ENV/$(date +%Y%m%d_%H%M%S)"
  IMPORT_ARGS="--base-dir \"$SYS_DIR\" --env \"$WXO_ENV\" --no-credential-prompt --if-exists \"$if_mode\" --report-dir \"$import_report_dir\" ${validate_opt}"
  case "$what" in
    1) IMPORT_ARGS="$IMPORT_ARGS --agents-only --agent-only" ;;
    2) IMPORT_ARGS="$IMPORT_ARGS --tools-only" ;;
    3) IMPORT_ARGS="$IMPORT_ARGS --flows-only" ;;
    4) IMPORT_ARGS="$IMPORT_ARGS --plugins-only" ;;
    5) IMPORT_ARGS="$IMPORT_ARGS --connections-only" ;;
    6) IMPORT_ARGS="$IMPORT_ARGS --agents-only" ;;
    7) IMPORT_ARGS="$IMPORT_ARGS --tools-only" ;;
    8) IMPORT_ARGS="$IMPORT_ARGS --flows-only" ;;
    9) IMPORT_ARGS="$IMPORT_ARGS --all" ;;  # Folder — agents, tools, flows, plugins, connections (whatever exists)
  esac

  local import_labels=("" "Agents (no deps)" "Tools" "Flows" "Plugins" "Connections" "Agents (+ deps)" "Tools (+ conns)" "Flows (+ conns)" "Folder (all)")
  _breadcrumb_set_selection "${import_labels[$what]}"
}

# --- Replicate (Action 6): Select source and target, what to replicate ---
_select_replicate_envs() {
  _breadcrumb_push "Source & Target"
  _print_header "Replicate — Source and target"
  echo "  Replicate exports to WxO/Replicate/<Source>_to_<Target>/<DateTime>/ then imports to target."
  echo ""
  echo "  Select SOURCE environment (copy FROM):"
  echo ""

  local env_list envs=()
  env_list=$(orchestrate env list 2>&1) || { echo "[ERROR] Failed to run 'orchestrate env list'."; exit 1; }
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local name; name=$(echo "$line" | awk '{print $1}')
    [[ -n "$name" ]] && [[ "$name" != "Name" ]] && envs+=("$name")
  done <<< "$env_list"

  if [[ ${#envs[@]} -lt 2 ]]; then
    echo "  [ERROR] Need at least 2 environments for Replicate. Found: ${envs[*]:-none}"
    exit 1
  fi

  local i=1
  for e in "${envs[@]}"; do echo "  [$i] $e"; ((i++)); done
  echo "  [0] Back"
  echo ""
  local src_choice=$(_read_choice "Source (0-${#envs[@]}): " "${#envs[@]}" 1)
  if [[ "$src_choice" -eq 0 ]]; then
    _breadcrumb_pop
    NAV_BACK=1
    return
  fi
  REPLICATE_SOURCE="${envs[$((src_choice-1))]}"
  echo "  Source: $REPLICATE_SOURCE"
  echo ""

  echo "  Select TARGET environment (copy TO):"
  local targets=()
  for e in "${envs[@]}"; do
    [[ "$e" == "$REPLICATE_SOURCE" ]] && continue
    targets+=("$e")
  done
  local ti=1
  for t in "${targets[@]}"; do echo "  [$ti] $t"; ((ti++)); done
  echo "  [0] Back"
  echo ""
  local tgt_choice=$(_read_choice "Target (0-${#targets[@]}): " "${#targets[@]}" 1)
  if [[ "$tgt_choice" -eq 0 ]]; then
    _breadcrumb_pop
    NAV_BACK=1
    return
  fi
  REPLICATE_TARGET="${targets[$((tgt_choice-1))]}"
  _breadcrumb_set_selection "$REPLICATE_SOURCE → $REPLICATE_TARGET" 30
  echo "  Target: $REPLICATE_TARGET"
  echo ""
}

_replicate_options() {
  _breadcrumb_push "What to replicate"
  _print_header "Replicate — What to replicate?"
  echo "  [1] Agents only — YAML only (no tool/flow deps)"
  echo "  [2] Agents with dependencies — agents + bundled tools/flows"
  echo "  [3] Tools only — no connections"
  echo "  [4] Tools with connections — tools + bundled connections"
  echo "  [5] Flows only (can include tools, agents, connections)"
  echo "  [6] Flows with connections (can include tools, agents)"
  echo "  [7] All — agents (with deps), tools, flows (connections bundled)"
  echo "  [8] Connections only (live)"
  echo "  [0] Back"
  echo ""
  local what=$(_read_choice "Choose (0-8): " 8 1)
  if [[ "$what" -eq 0 ]]; then
    _breadcrumb_pop
    NAV_BACK=1
    return
  fi

  local agent_filter="" tool_filter="" flow_filter="" connection_filter="" tool_type_filter=""
  local agents_arr=() tools_arr=() flows_arr=() connections_arr=()

  _load_env
  local src_key=$(_get_api_key_from_env "$REPLICATE_SOURCE")
  [[ -z "$src_key" ]] && read -p "API key for $REPLICATE_SOURCE: " src_key
  orchestrate env activate "$REPLICATE_SOURCE" --api-key "$src_key" 2>/dev/null || { echo "[ERROR] Failed to activate $REPLICATE_SOURCE"; exit 1; }

  if [[ "$what" -eq 1 ]] || [[ "$what" -eq 2 ]] || [[ "$what" -eq 7 ]]; then
    REPLICATE_AGENT_ONLY=""
    [[ "$what" -eq 1 ]] && REPLICATE_AGENT_ONLY="--agent-only"
    while IFS= read -r line; do [[ -n "$line" ]] && agents_arr+=("$line"); done < <(_fetch_agents)
    if [[ ${#agents_arr[@]} -gt 0 ]]; then
      if [[ "$what" -eq 7 ]]; then
        agent_filter=$(IFS=,; echo "${agents_arr[*]}")
        echo "  Selected: all agents (${#agents_arr[@]})"
      else
        echo ""; _print_header "Select agents to replicate"
        local i=1; for a in "${agents_arr[@]}"; do echo "  [$i] $a"; ((i++)); done
        echo ""
        read -p "Enter numbers (comma-separated), 'all', or Enter for all: " choice
        choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
        if [[ "$choice" == "all" ]] || [[ -z "${choice// }" ]]; then
          agent_filter=$(IFS=,; echo "${agents_arr[*]}")
        else
          local sel=()
          for num in $(echo "$choice" | tr ',' ' '); do
            num=$(echo "$num" | tr -cd '0-9')
            [[ -n "$num" ]] && [[ "$num" -ge 1 ]] && [[ "$num" -le ${#agents_arr[@]} ]] && sel+=("${agents_arr[$((num-1))]}")
          done
          [[ ${#sel[@]} -gt 0 ]] && agent_filter=$(IFS=,; echo "${sel[*]}")
        fi
        [[ -n "$agent_filter" ]] && echo "  Selected: $agent_filter"
      fi
    else
      echo "  No agents found in $REPLICATE_SOURCE."
    fi
  fi
  if [[ "$what" -eq 3 ]] || [[ "$what" -eq 4 ]] || [[ "$what" -eq 7 ]]; then
    REPLICATE_TOOLS_WITH_CONNS=""
    [[ "$what" -eq 4 ]] || [[ "$what" -eq 7 ]] && REPLICATE_TOOLS_WITH_CONNS="yes"
    echo ""; _print_header "Which tool types?"
    echo "  [1] All (Python, OpenAPI, Flow)"
    echo "  [2] Python only"
    echo "  [3] OpenAPI only"
    echo "  [4] Flow only"
    echo ""
    local type_choice=$(_read_choice "Choose (1-4): " 4)
    case "$type_choice" in
      1) tool_type_filter="" ;;
      2) tool_type_filter="python" ;;
      3) tool_type_filter="openapi" ;;
      4) tool_type_filter="flow" ;;
      *) tool_type_filter="" ;;
    esac
    while IFS= read -r line; do [[ -n "$line" ]] && tools_arr+=("$line"); done < <(_fetch_tools "$tool_type_filter")
    if [[ ${#tools_arr[@]} -gt 0 ]]; then
      if [[ "$type_choice" -eq 1 ]]; then
        tool_filter=$(IFS=,; echo "${tools_arr[*]}")
        echo "  Selected: all tools (${#tools_arr[@]})"
      else
        echo ""; _print_header "Select tools to replicate"
        local i=1; for t in "${tools_arr[@]}"; do echo "  [$i] $t"; ((i++)); done
        echo ""
        read -p "Enter numbers (comma-separated), 'all', or Enter for all: " choice
        choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
        if [[ "$choice" == "all" ]] || [[ -z "${choice// }" ]]; then
          tool_filter=$(IFS=,; echo "${tools_arr[*]}")
        else
          local sel=()
          for num in $(echo "$choice" | tr ',' ' '); do
            num=$(echo "$num" | tr -cd '0-9')
            [[ -n "$num" ]] && [[ "$num" -ge 1 ]] && [[ "$num" -le ${#tools_arr[@]} ]] && sel+=("${tools_arr[$((num-1))]}")
          done
          [[ ${#sel[@]} -gt 0 ]] && tool_filter=$(IFS=,; echo "${sel[*]}")
        fi
        [[ -n "$tool_filter" ]] && echo "  Selected: $tool_filter"
      fi
    else
      echo "  No tools found."
    fi
  fi
  if [[ "$what" -eq 5 ]] || [[ "$what" -eq 6 ]] || [[ "$what" -eq 7 ]]; then
    while IFS= read -r line; do [[ -n "$line" ]] && flows_arr+=("$line"); done < <(_fetch_flows)
    if [[ ${#flows_arr[@]} -gt 0 ]]; then
      if [[ "$what" -eq 7 ]]; then
        flow_filter=$(IFS=,; echo "${flows_arr[*]}")
        echo "  Selected: all flows (${#flows_arr[@]})"
      else
        echo ""; _print_header "Select flows to replicate"
        local i=1; for f in "${flows_arr[@]}"; do echo "  [$i] $f"; ((i++)); done
        echo ""
        read -p "Enter numbers (comma-separated), 'all', or Enter for all: " choice
        choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
        if [[ "$choice" == "all" ]] || [[ -z "${choice// }" ]]; then
          flow_filter=$(IFS=,; echo "${flows_arr[*]}")
        else
          local sel=()
          for num in $(echo "$choice" | tr ',' ' '); do
            num=$(echo "$num" | tr -cd '0-9')
            [[ -n "$num" ]] && [[ "$num" -ge 1 ]] && [[ "$num" -le ${#flows_arr[@]} ]] && sel+=("${flows_arr[$((num-1))]}")
          done
          [[ ${#sel[@]} -gt 0 ]] && flow_filter=$(IFS=,; echo "${sel[*]}")
        fi
        [[ -n "$flow_filter" ]] && echo "  Selected: $flow_filter"
      fi
    else
      echo "  No flows found."
    fi
  fi
  if [[ "$what" -eq 8 ]]; then
    echo ""; _print_header "Select connections to replicate"
    while IFS= read -r line; do [[ -n "$line" ]] && connections_arr+=("$line"); done < <(_fetch_connections)
    if [[ ${#connections_arr[@]} -gt 0 ]]; then
      local i=1; for c in "${connections_arr[@]}"; do echo "  [$i] $c"; ((i++)); done
      echo ""
      read -p "Enter numbers (comma-separated), 'all', or Enter for all: " choice
      choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
      if [[ "$choice" == "all" ]] || [[ -z "${choice// }" ]]; then
        connection_filter=$(IFS=,; echo "${connections_arr[*]}")
      else
        local sel=()
        for num in $(echo "$choice" | tr ',' ' '); do
          num=$(echo "$num" | tr -cd '0-9')
          [[ -n "$num" ]] && [[ "$num" -ge 1 ]] && [[ "$num" -le ${#connections_arr[@]} ]] && sel+=("${connections_arr[$((num-1))]}")
        done
        [[ ${#sel[@]} -gt 0 ]] && connection_filter=$(IFS=,; echo "${sel[*]}")
      fi
      [[ -n "$connection_filter" ]] && echo "  Selected: $connection_filter"
    else
      echo "  No live connections found."
    fi
  fi

  echo ""
  echo "  If resource already exists in target:"
  echo "  [1] Override — Update/replace"
  echo "  [2] Skip    — Do not import (keep existing)"
  echo "  [0] Back"
  echo ""
  local if_exists=$(_read_choice "Choose (0-2): " 2 1)
  if [[ "$if_exists" -eq 0 ]]; then
    _breadcrumb_pop
    NAV_BACK=1
    return
  fi
  REPLICATE_IF_EXISTS="override"; [[ "$if_exists" -eq 2 ]] && REPLICATE_IF_EXISTS="skip"
  echo "  Replicate: if-exists=$REPLICATE_IF_EXISTS, building export args..."

  local replicate_label=""
  case "$what" in
    1) replicate_label="Agents (no deps)"; [[ -n "$agent_filter" ]] && replicate_label="$replicate_label ($(echo "$agent_filter" | awk -F',' '{print NF}'))" ;;
    2) replicate_label="Agents (+ deps)"; [[ -n "$agent_filter" ]] && replicate_label="$replicate_label ($(echo "$agent_filter" | awk -F',' '{print NF}'))" ;;
    3) replicate_label="Tools"; [[ -n "$tool_filter" ]] && replicate_label="$replicate_label ($(echo "$tool_filter" | awk -F',' '{print NF}'))" ;;
    4) replicate_label="Tools (+ conns)"; [[ -n "$tool_filter" ]] && replicate_label="$replicate_label ($(echo "$tool_filter" | awk -F',' '{print NF}'))" ;;
    5) replicate_label="Flows"; [[ -n "$flow_filter" ]] && replicate_label="$replicate_label ($(echo "$flow_filter" | awk -F',' '{print NF}'))" ;;
    6) replicate_label="Flows (+ conns)"; [[ -n "$flow_filter" ]] && replicate_label="$replicate_label ($(echo "$flow_filter" | awk -F',' '{print NF}'))" ;;
    7) replicate_label="All" ;;
    8) replicate_label="Connections"; [[ -n "$connection_filter" ]] && replicate_label="$replicate_label ($(echo "$connection_filter" | awk -F',' '{print NF}'))" ;;
  esac
  echo "  [REPL] 1. label=$replicate_label"
  _breadcrumb_set_selection "${replicate_label}" 35
  echo "  [REPL] 2. after breadcrumb"

  REPLICATE_WHAT="$what"
  REPLICATE_EXPORT_ARGS="-o \"$WXO_ROOT\" --env-name \"${REPLICATE_SOURCE}_to_${REPLICATE_TARGET}\" --replicate"
  case "$what" in
    1) REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --agents-only ${REPLICATE_AGENT_ONLY:-}" ;;
    2) REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --agents-only ${REPLICATE_AGENT_ONLY:-}" ;;
    3) REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --tools-only" ;;
    4) REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --tools-only" ;;
    5) REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --flows-only" ;;
    6) REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --flows-only" ;;
    7) REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS" ;;
    8) REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --connections-only" ;;
  esac
  [[ -n "$agent_filter" ]] && REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --agent \"$agent_filter\""
  if [[ -n "$tool_filter" ]] && [[ -n "$flow_filter" ]]; then
    REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --tool \"$tool_filter,$flow_filter\""
  elif [[ -n "$tool_filter" ]]; then
    REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --tool \"$tool_filter\""
  elif [[ -n "$flow_filter" ]]; then
    REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --tool \"$flow_filter\""
  fi
  [[ -n "$tool_type_filter" ]] && REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --tool-type \"$tool_type_filter\""
  [[ -n "$connection_filter" ]] && REPLICATE_EXPORT_ARGS="$REPLICATE_EXPORT_ARGS --connection \"$connection_filter\""
  echo "  [REPL] 3. after export args"

  case "$what" in
    1|2) REPLICATE_IMPORT_OPTS="--agents-only" ;;
    3|4) REPLICATE_IMPORT_OPTS="--tools-only" ;;
    5|6) REPLICATE_IMPORT_OPTS="--flows-only" ;;
    7) REPLICATE_IMPORT_OPTS="" ;;
    8) REPLICATE_IMPORT_OPTS="--connections-only" ;;
  esac
  [[ "$what" -eq 1 ]] && REPLICATE_IMPORT_OPTS="$REPLICATE_IMPORT_OPTS --agent-only"
  echo "  [REPL] 4. done, returning to main"
}

_run_replicate() {
  echo "  Replicate: starting ($REPLICATE_SOURCE → $REPLICATE_TARGET)..."
  _print_header "Running Replicate"
  echo "  Source: $REPLICATE_SOURCE  →  Target: $REPLICATE_TARGET"
  echo "  Output: WxO/Replicate/${REPLICATE_SOURCE}_to_${REPLICATE_TARGET}/<DateTime>/"
  echo ""

  _load_env
  local src_key=$(_get_api_key_from_env "$REPLICATE_SOURCE")
  [[ -z "$src_key" ]] && read -p "API key for $REPLICATE_SOURCE: " src_key
  local tgt_key=$(_get_api_key_from_env "$REPLICATE_TARGET")
  [[ -z "$tgt_key" ]] && read -p "API key for $REPLICATE_TARGET: " tgt_key

  echo "  Step 1/2: Export from $REPLICATE_SOURCE to Replicate folder"
  echo "  $ bash \"$EXPORT_SCRIPT\" $REPLICATE_EXPORT_ARGS"
  orchestrate env activate "$REPLICATE_SOURCE" --api-key "$src_key" || { echo "[ERROR] Failed to activate $REPLICATE_SOURCE"; exit 1; }
  [[ "${WXO_DEBUG:-0}" == "1" ]] && echo "  [REPL-DEBUG] Running export..."
  export_rc=0
  eval "bash \"$EXPORT_SCRIPT\" $REPLICATE_EXPORT_ARGS" || export_rc=$?
  [[ "${WXO_DEBUG:-0}" == "1" ]] && echo "  [REPL-DEBUG] Export finished rc=${export_rc:-0}"
  echo ""

  local replicate_dir="$WXO_ROOT/Replicate/${REPLICATE_SOURCE}_to_${REPLICATE_TARGET}/$(ls -1 "$WXO_ROOT/Replicate/${REPLICATE_SOURCE}_to_${REPLICATE_TARGET}" 2>/dev/null | tail -1)"
  if [[ ! -d "$replicate_dir" ]]; then
    echo "  [ERROR] Replicate dir not found. Export may have failed."
    exit 1
  fi

  echo "  Step 2/2: Import from Replicate folder to $REPLICATE_TARGET"
  echo "  $ bash \"$DEPLOY_SCRIPT\" --base-dir \"$replicate_dir\" --env \"$REPLICATE_TARGET\" --no-credential-prompt --if-exists \"$REPLICATE_IF_EXISTS\" --report-dir \"$replicate_dir\" ${REPLICATE_IMPORT_OPTS:-}"
  orchestrate env activate "$REPLICATE_TARGET" --api-key "$tgt_key" || { echo "[ERROR] Failed to activate $REPLICATE_TARGET"; exit 1; }
  [[ "${WXO_DEBUG:-0}" == "1" ]] && echo "  [REPL-DEBUG] Running import..."
  import_rc=0
  ENV_CONN_SOURCE="$REPLICATE_SOURCE" WXO_ROOT="$WXO_ROOT" eval "bash \"$DEPLOY_SCRIPT\" --base-dir \"$replicate_dir\" --env \"$REPLICATE_TARGET\" --no-credential-prompt --if-exists \"$REPLICATE_IF_EXISTS\" --report-dir \"$replicate_dir\" ${REPLICATE_IMPORT_OPTS:-}" || import_rc=$?
  [[ "${WXO_DEBUG:-0}" == "1" ]] && echo "  [REPL-DEBUG] Import finished rc=${import_rc:-0}"
  echo ""

  local report_file="$replicate_dir/Report/import_report.txt"
  echo "  Replicate complete."
  echo "  Export/Import dir: $replicate_dir"
  echo "  Import report:     $report_file"
  [[ ${export_rc:-0} -ne 0 ]] && echo "  [WARN] Export had failures (rc=$export_rc). Check output above."
  [[ ${import_rc:-0} -ne 0 ]] && echo "  [WARN] Import had failures (rc=$import_rc). Check report: $report_file"
  echo ""
}

# --- Danger Zone: Fetch connections (all app_ids, unique) ---
_fetch_connections_all() {
  local raw json
  raw=$(orchestrate connections list -v 2>/dev/null) || true
  [[ -z "$raw" ]] && { echo ""; return; }
  first=$(echo "$raw" | head -1)
  if [[ -n "$first" ]] && ! echo "$first" | grep -qE '^[\[{]'; then
    json=$(echo "$raw" | tail -n +2)
  else
    json="$raw"
  fi
  echo "$json" | jq -r '
    (if type == "array" then . else (.live // .connections // .data // .) end) |
    if type == "array" then . else [] end |
    .[] | select(type == "object") | (.app_id // .appId // .id // .name) // empty |
    select(length > 0)
  ' 2>/dev/null | sort -u || echo ""
}

# --- Danger Zone: Delete agents, tools, flows, connections ---
_danger_zone_menu() {
  _print_header "⚠ Danger Zone — Delete resources (irreversible)"
  echo "  [1] Delete Agent(s)"
  echo "  [2] Delete Tool(s)"
  echo "  [3] Delete Flow(s)"
  echo "  [4] Delete Connection(s)"
  echo "  [0] Back"
  echo ""
  local choice=$(_read_choice "Choose (0-4): " 4 1)
  if [[ "$choice" -eq 0 ]]; then
    _breadcrumb_pop
    NAV_BACK=1
    return 1
  fi
  DELETE_TYPE="$choice"
  return 0
}

_delete_options() {
  local arr=() sel=()
  local with_deps=1
  local prompt_extra=""

  case "$DELETE_TYPE" in
    1)
      _breadcrumb_push "Delete Agents"
      _print_header "Select agents to delete"
      while IFS= read -r line; do [[ -n "$line" ]] && arr+=("$line"); done < <(_fetch_agents)
      prompt_extra="Include agent's tool dependencies? [1] No (agent only) [2] Yes (agent + tools from agent)"
      ;;
    2)
      _breadcrumb_push "Delete Tools"
      _print_header "Select tools to delete"
      while IFS= read -r line; do [[ -n "$line" ]] && arr+=("$line"); done < <(_fetch_tools)
      prompt_extra="Include tool's bundled connections? [1] No (tool only) [2] Yes (tool + connections)"
      ;;
    3)
      _breadcrumb_push "Delete Flows"
      _print_header "Select flows to delete"
      while IFS= read -r line; do [[ -n "$line" ]] && arr+=("$line"); done < <(_fetch_tools "flow")
      prompt_extra="Include flow's bundled connections? [1] No [2] Yes"
      ;;
    4)
      _breadcrumb_push "Delete Connections"
      _print_header "Select connections to delete"
      while IFS= read -r line; do [[ -n "$line" ]] && arr+=("$line"); done < <(_fetch_connections_all)
      ;;
    *) echo "  Unknown delete type."; return 1 ;;
  esac

  if [[ ${#arr[@]} -eq 0 ]]; then
    echo "  No resources found."
    _breadcrumb_pop
    return 1
  fi

  local i=1
  for r in "${arr[@]}"; do
    echo "  [$i] $r"
    ((i++))
  done
  echo ""
  read -p "Enter numbers (comma/space-separated), 'all', or Enter for all: " choice
  choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
  if [[ "$choice" == "all" ]] || [[ -z "${choice// }" ]]; then
    sel=("${arr[@]}")
  else
    for num in $(echo "$choice" | tr ',' ' '); do
      num=$(echo "$num" | tr -cd '0-9')
      [[ -n "$num" ]] && [[ "$num" -ge 1 ]] && [[ "$num" -le ${#arr[@]} ]] && sel+=("${arr[$((num-1))]}")
    done
  fi

  [[ ${#sel[@]} -eq 0 ]] && { echo "  No selection."; _breadcrumb_pop; return 1; }
  echo "  Selected: $(IFS=,; echo "${sel[*]}")"
  echo ""

  if [[ "$DELETE_TYPE" -ne 4 ]] && [[ -n "$prompt_extra" ]]; then
    echo "  $prompt_extra"
    echo ""
    with_deps=$(_read_choice "Choose (1-2): " 2)
    echo ""
  fi

  echo "  ⚠ WARNING: This will permanently delete the selected resource(s)."
  read -p "  Type 'DELETE' to confirm, or anything else to cancel: " confirm
  if [[ "$confirm" != "DELETE" ]]; then
    echo "  Cancelled."
    _breadcrumb_pop
    return 1
  fi
  echo ""

  DELETE_SEL=("${sel[@]}")
  DELETE_WITH_DEPS="$with_deps"
  _breadcrumb_set_selection "${#sel[@]} selected" 20
  return 0
}

_run_delete() {
  _print_header "Deleting resources"
  echo "  Environment: $WXO_ENV"
  echo ""

  # Report dir: WxO/Delete/SystemName/YYYYMMDD_HHMMSS/Report/
  local delete_datetime
  delete_datetime=$(date +%Y%m%d_%H%M%S)
  local delete_report_dir="$WXO_ROOT/Delete/$WXO_ENV/$delete_datetime"
  local delete_report_file="$delete_report_dir/Report/delete_report.txt"
  mkdir -p "$(dirname "$delete_report_file")"

  local delete_entries=()
  local agent_ok=0 agent_fail=0 tool_ok=0 tool_fail=0 flow_ok=0 flow_fail=0 conn_ok=0 conn_fail=0

  _record_delete() {
    local type="$1" name="$2" status="$3" notes="${4:-}"
    delete_entries+=("$type|$name|$status|$notes")
    case "$type" in
      Agent)   [[ "$status" == "OK" ]] && agent_ok=$((agent_ok+1)) || agent_fail=$((agent_fail+1)) ;;
      Tool)    [[ "$status" == "OK" ]] && tool_ok=$((tool_ok+1)) || tool_fail=$((tool_fail+1)) ;;
      Flow)    [[ "$status" == "OK" ]] && flow_ok=$((flow_ok+1)) || flow_fail=$((flow_fail+1)) ;;
      Connection) [[ "$status" == "OK" ]] && conn_ok=$((conn_ok+1)) || conn_fail=$((conn_fail+1)) ;;
      *)       [[ "$status" == "OK" ]] && tool_ok=$((tool_ok+1)) || tool_fail=$((tool_fail+1)) ;;
    esac
  }

  local tmpdir=""
  local out
  for name in "${DELETE_SEL[@]}"; do
    if [[ "$DELETE_TYPE" -eq 1 ]]; then
      echo "  → Removing agent: $name"
      rc=0
      out=$(orchestrate agents remove -n "$name" -k native 2>&1) || rc=$?
      echo "$out"
      if [[ ${rc:-0} -eq 0 ]]; then
        _record_delete "Agent" "$name" "OK" ""
      else
        rc=0
        out=$(orchestrate agents remove -n "$name" -k external 2>&1) || rc=$?
        echo "$out"
        if [[ ${rc:-0} -eq 0 ]]; then
          echo "     (removed as external)"
          _record_delete "Agent" "$name" "OK" "removed as external"
        else
          rc=0
          out=$(orchestrate agents remove -n "$name" -k assistant 2>&1) || rc=$?
          echo "$out"
          if [[ ${rc:-0} -eq 0 ]]; then
            echo "     (removed as assistant)"
            _record_delete "Agent" "$name" "OK" "removed as assistant"
          else
            echo "     [WARN] Failed. Try: orchestrate agents remove -n \"$name\" -k native|external|assistant"
            _record_delete "Agent" "$name" "FAILED" "${out:0:60}"
          fi
        fi
      fi
      if [[ "$DELETE_WITH_DEPS" -eq 2 ]]; then
        tmpdir=$(mktemp -d 2>/dev/null || echo "/tmp/wxo_del_$$")
        if orchestrate agents export -n "$name" -k native -o "$tmpdir/agent.zip" 2>/dev/null; then
          unzip -o -q "$tmpdir/agent.zip" -d "$tmpdir" 2>/dev/null || true
          for tool_dir in "$tmpdir"/*/tools/*/; do
            [[ -d "$tool_dir" ]] || continue
            local tname; tname=$(basename "$tool_dir")
            echo "     → Removing tool (dependency): $tname"
            if orchestrate tools remove -n "$tname" 2>/dev/null; then
              _record_delete "Tool" "$tname" "OK" "(dependency)"
            else
              _record_delete "Tool" "$tname" "FAILED" "(dependency)"
            fi
          done
        fi
        rm -rf "$tmpdir" 2>/dev/null || true
      fi
    elif [[ "$DELETE_TYPE" -eq 2 ]] || [[ "$DELETE_TYPE" -eq 3 ]]; then
      local res_type="Tool"
      [[ "$DELETE_TYPE" -eq 3 ]] && res_type="Flow"
      echo "  → Removing $res_type: $name"
      rc=0
      out=$(orchestrate tools remove -n "$name" 2>&1) || rc=$?
      echo "$out"
      if [[ ${rc:-0} -eq 0 ]]; then
        _record_delete "$res_type" "$name" "OK" ""
      else
        echo "     [WARN] Failed"
        _record_delete "$res_type" "$name" "FAILED" "${out:0:60}"
      fi
      if [[ "$DELETE_WITH_DEPS" -eq 2 ]]; then
        tmpdir=$(mktemp -d 2>/dev/null || echo "/tmp/wxo_del_$$")
        if orchestrate tools export -n "$name" -o "$tmpdir/tool.zip" 2>/dev/null; then
          unzip -o -q "$tmpdir/tool.zip" -d "$tmpdir" 2>/dev/null || true
          for conn_yml in "$tmpdir"/connections/*.yml "$tmpdir"/*/connections/*.yml "$tmpdir"/connections/*.yaml "$tmpdir"/*/connections/*.yaml; do
            [[ -f "$conn_yml" ]] || continue
            local app_id; app_id=$(grep -E '^[[:space:]]*app_id:' "$conn_yml" 2>/dev/null | head -1 | sed 's/.*app_id:[[:space:]]*\([^[:space:]]*\).*/\1/')
            [[ -z "$app_id" ]] && { app_id=$(basename "$conn_yml"); app_id="${app_id%.yml}"; app_id="${app_id%.yaml}"; }
            [[ -z "$app_id" ]] && continue
            echo "     → Removing connection (dependency): $app_id"
            if orchestrate connections remove -a "$app_id" 2>/dev/null; then
              _record_delete "Connection" "$app_id" "OK" "(dependency)"
            else
              _record_delete "Connection" "$app_id" "FAILED" "(dependency)"
            fi
          done
        fi
        rm -rf "$tmpdir" 2>/dev/null || true
      fi
    elif [[ "$DELETE_TYPE" -eq 4 ]]; then
      echo "  → Removing connection: $name"
      rc=0
      out=$(orchestrate connections remove -a "$name" 2>&1) || rc=$?
      echo "$out"
      if [[ ${rc:-0} -eq 0 ]]; then
        _record_delete "Connection" "$name" "OK" ""
      else
        echo "     [WARN] Failed"
        _record_delete "Connection" "$name" "FAILED" "${out:0:60}"
      fi
    fi
  done

  # Write delete report
  {
    echo "=== Delete Report $(date '+%Y-%m-%dT%H:%M:%S') ==="
    echo ""
    echo "  ═════════════════════════════════════════════════════════════════════════════════════════════"
    echo "  DELETE REPORT"
    echo "  ═════════════════════════════════════════════════════════════════════════════════════════════"
    echo "  Environment: $WXO_ENV"
    echo "  With dependencies: $([[ "$DELETE_WITH_DEPS" -eq 2 ]] && echo "Yes" || echo "No")"
    echo ""
    echo "  $(printf '%-10s  %-36s  %-10s  %s' 'TYPE' 'NAME' 'STATUS' 'NOTES')"
    echo "  ───────────────────────────────────────────────────────────────────────────────────────────"
    for entry in "${delete_entries[@]}"; do
      IFS='|' read -r type name status notes <<< "$entry"
      local icon="✓"
      [[ "$status" == "FAILED" ]] && icon="✗"
      echo "  $(printf '%-10s  %-36s  %s %-8s  %s' "$type" "${name:0:36}" "$icon" "$status" "${notes:0:50}")"
    done
    echo "  ───────────────────────────────────────────────────────────────────────────────────────────"
    echo "  SUMMARY:  agents: ✓ $agent_ok OK, ✗ $agent_fail failed  |  tools: ✓ $tool_ok OK, ✗ $tool_fail failed  |  flows: ✓ $flow_ok OK, ✗ $flow_fail failed  |  connections: ✓ $conn_ok OK, ✗ $conn_fail failed"
    echo "  ═════════════════════════════════════════════════════════════════════════════════════════════"
    echo ""
  } > "$delete_report_file"

  echo ""
  echo "  Done."
  echo "  Report saved: $delete_report_file"
  echo ""
  _breadcrumb_pop
}

# --- Validation (Action 4) ---
_run_validate() {
  _breadcrumb_push "Validate"
  _print_header "Validate — Invoke agents with test prompt"
  echo "Environment: $WXO_ENV (active)"
  echo ""

  local all_agents=()
  while IFS= read -r line; do [[ -n "$line" ]] && all_agents+=("$line"); done < <(_fetch_agents)
  if [[ ${#all_agents[@]} -eq 0 ]]; then
    echo "  No agents found in this environment."
    _breadcrumb_pop
    return 0
  fi

  _breadcrumb_push "Select agents"
  _print_header "Select agents to validate"
  local i=1
  for a in "${all_agents[@]}"; do
    echo "  [$i] $a"
    ((i++))
  done
  echo "  [0] Back"
  echo ""
  read -p "Enter numbers (comma/space-separated), 'all', '0' for Back, or Enter for all: " choice
  choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
  if [[ "$choice" == "0" ]]; then
    _breadcrumb_pop
    _breadcrumb_pop
    NAV_BACK=1
    return
  fi
  local agents_arr=()
  if [[ "$choice" == "all" ]] || [[ -z "${choice// }" ]]; then
    agents_arr=("${all_agents[@]}")
  else
    for num in $(echo "$choice" | tr ',' ' '); do
      num=$(echo "$num" | tr -cd '0-9')
      [[ -n "$num" ]] && [[ "$num" -ge 1 ]] && [[ "$num" -le ${#all_agents[@]} ]] && agents_arr+=("${all_agents[$((num-1))]}")
    done
  fi
  [[ ${#agents_arr[@]} -eq 0 ]] && { echo "  No agents selected."; return 0; }
  local validate_sel="${#agents_arr[@]} agent(s)"
  [[ ${#agents_arr[@]} -le 3 ]] && validate_sel=$(IFS=,; echo "${agents_arr[*]}")
  _breadcrumb_set_selection "$validate_sel" 45
  echo "  Selected: ${agents_arr[*]}"
  echo ""
  echo "  Test prompt:"
  echo "  [1] Quick test (Hello) — just check if agent responds"
  echo "  [2] Custom — enter your own prompt"
  echo ""
  local prompt_choice=$(_read_choice "Choose (1-2): " 2)
  local test_prompt="Hello"
  if [[ "$prompt_choice" -eq 2 ]]; then
    echo ""
    read -p "  Enter prompt (e.g. tell me a joke): " test_prompt
    test_prompt=$(echo "$test_prompt" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$test_prompt" ]] && test_prompt="Hello"
  fi
  echo "  Using prompt: \"$test_prompt\""
  echo ""
  echo "  Compare with another system?"
  echo "  [1] No — only check agents respond"
  echo "  [2] Yes — also run on source and compare"
  echo ""
  local cmp=$(_read_choice "Choose (1-2): " 2)
  local compare_env=""
  if [[ "$cmp" -eq 2 ]]; then
    local env_list
    env_list=$(orchestrate env list 2>&1) || true
    local envs=()
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      local name
      name=$(echo "$line" | awk '{print $1}')
      [[ -n "$name" ]] && [[ "$name" != "Name" ]] && [[ "$name" != "$WXO_ENV" ]] && envs+=("$name")
    done <<< "$env_list"
    if [[ ${#envs[@]} -gt 0 ]]; then
      echo ""
      echo "  Select source environment to compare:"
      local ei=1
      for e in "${envs[@]}"; do
        echo "  [$ei] $e"
        ((ei++))
      done
      echo ""
      local ec=$(_read_choice "Choose (1-${#envs[@]}): " "${#envs[@]}")
      compare_env="${envs[$((ec-1))]}"
    fi
  fi

  _load_env

  # Create validation report directory
  local validate_dir
  if [[ -n "$compare_env" ]]; then
    validate_dir="$WXO_ROOT/Validate/${WXO_ENV}->${compare_env}/$(date +%Y%m%d_%H%M%S)"
  else
    validate_dir="$WXO_ROOT/Validate/$WXO_ENV/$(date +%Y%m%d_%H%M%S)"
  fi
  mkdir -p "$validate_dir"
  local report_file="$validate_dir/validation_report.txt"

  _get_env_key() {
    local env="$1"
    local key_var="WXO_API_KEY_${env}"
    local key="${!key_var}"
    [[ -z "$key" ]] && [[ "$env" == "bootcamp" ]] && key="${WO_API_KEY}"
    echo "$key"
  }

  _invoke_agent() {
    local env="$1" agent="$2"
    local key out
    key=$(_get_env_key "$env")
    [[ -z "$key" ]] && { echo "(no key for $env)"; return 1; }
    _log_cmd "env activate $env --api-key <hidden>"
    orchestrate env activate "$env" --api-key "$key" 2>/dev/null || return 1
    _log_cmd "chat ask -n \"$agent\" \"$test_prompt\" -r  # pipe q to exit"
    # Pipe 'q' so CLI exits after response instead of staying in interactive chat mode
    out=$(printf 'q\n' | orchestrate chat ask -n "$agent" "$test_prompt" -r 2>&1) || true
    [[ -z "$out" ]] && { echo "(invoke failed or timed out)"; return 1; }
    echo "$out" | grep -qE 'timed out|Terminated' && { echo "(timed out)"; return 1; }
    out=$(echo "$out" | sed 's/\x1b\[[0-9;]*m//g')
    if [[ -z "${out// }" ]]; then echo "(empty)"; return 1; fi
    if echo "$out" | grep -qE '\[ERROR\]|Error:|error:|not found'; then echo "(error)"; return 1; fi
    echo "$out"
    return 0
  }

  echo ""
  echo "  ═══════════════════════════════════════════════════════════════════════════════════"
  echo "  VALIDATION — Invoking agents with test prompt: \"$test_prompt\""
  echo "  ═══════════════════════════════════════════════════════════════════════════════════"
  echo "  Target env: $WXO_ENV"
  [[ -n "$compare_env" ]] && echo "  Compare with: $compare_env"
  echo "  Agents: ${agents_arr[*]}"
  echo ""
  local has_failures=0
  local validation_records=()
  local systems_col
  [[ -n "$compare_env" ]] && systems_col="${WXO_ENV}, ${compare_env}" || systems_col="$WXO_ENV"
  for agent in "${agents_arr[@]}"; do
    echo ""
    echo "  → $agent"
    local target_out="" source_out="" target_ok=false source_ok=false
    echo "     Invoking on target ($WXO_ENV)... (LLM call, may take 30-90s)"
    target_out=$(_invoke_agent "$WXO_ENV" "$agent") && target_ok=true
    if [[ "$target_ok" == "true" ]]; then
      echo "     Target ($WXO_ENV): ✓ responded"
      echo "$target_out" | head -20 | sed "s/^/       /"
      [[ $(echo "$target_out" | wc -l) -gt 20 ]] && echo "       ..."
    else
      echo "     Target ($WXO_ENV): ✗ no response or error"
      has_failures=1
    fi

    if [[ -n "$compare_env" ]]; then
      echo "     Invoking on source ($compare_env)... (LLM call, may take 30-90s)"
      source_out=$(_invoke_agent "$compare_env" "$agent") && source_ok=true
      if [[ "$source_ok" == "true" ]]; then
        echo "     Source ($compare_env): ✓ responded"
        echo "$source_out" | head -20 | sed "s/^/       /"
        [[ $(echo "$source_out" | wc -l) -gt 20 ]] && echo "       ..."
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
        echo "     Source ($compare_env): ✗ no response or error"
      fi
    fi

    # Record for validation report
    local target_status="fail" target_preview="" source_status="" source_preview="" match_status="-"
    [[ "$target_ok" == "true" ]] && target_status="OK"
    target_preview=$(echo "$target_out" | tr '\n' ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | head -c 150 | tr '|' '-')
    if [[ -n "$compare_env" ]]; then
      [[ "$source_ok" == "true" ]] && source_status="OK" || source_status="fail"
      source_preview=$(echo "$source_out" | tr '\n' ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | head -c 150 | tr '|' '-')
      if [[ "$target_ok" == "true" ]] && [[ "$source_ok" == "true" ]]; then
        local norm_src norm_tgt
        norm_src=$(echo "$source_out" | tr -d '[:space:]' | head -c 200)
        norm_tgt=$(echo "$target_out" | tr -d '[:space:]' | head -c 200)
        [[ "$norm_src" == "$norm_tgt" ]] && match_status="PASS" || match_status="different"
      else
        match_status="-"
      fi
    fi
    validation_records+=("${agent}|${systems_col}|${target_status}|${target_preview}|${source_status}|${source_preview}|${match_status}")

    local key
    key=$(_get_env_key "$WXO_ENV")
    [[ -n "$key" ]] && orchestrate env activate "$WXO_ENV" --api-key "$key" 2>/dev/null || true
  done

  # Write validation report
  {
    echo "=== WXO Validation Report $(date '+%Y-%m-%dT%H:%M:%S') ==="
    echo "Target: $WXO_ENV"
    [[ -n "$compare_env" ]] && echo "Source: $compare_env" || echo "Source: (single env)"
    echo ""
    printf "%-30s | %-20s | %-40s | %-40s | %s\n" "Agent" "Systems" "Target Response" "Source Response" "Match/Pass"
    printf "%-30s-+-%-20s-+-%-40s-+-%-40s-+-%s\n" "------------------------------" "--------------------" "----------------------------------------" "----------------------------------------" "---------"
    for rec in "${validation_records[@]}"; do
      IFS='|' read -r agent sys tgt_status tgt_preview src_status src_preview match <<< "$rec"
      local tgt_col=""
      [[ "$tgt_status" == "OK" ]] && tgt_col="OK: ${tgt_preview:0:37}" || tgt_col="fail: ${tgt_preview:0:35}"
      [[ ${#tgt_col} -gt 40 ]] && tgt_col="${tgt_col:0:37}..."
      local src_col="-"
      if [[ -n "$src_status" ]]; then
        [[ "$src_status" == "OK" ]] && src_col="OK: ${src_preview:0:37}" || src_col="fail: ${src_preview:0:35}"
        [[ ${#src_col} -gt 40 ]] && src_col="${src_col:0:37}..."
      fi
      [[ -z "$match" ]] && match="-"
      printf "%-30s | %-20s | %-40s | %-40s | %s\n" "$agent" "$sys" "$tgt_col" "$src_col" "$match"
    done
  } > "$report_file"

  echo ""
  echo "  ═══════════════════════════════════════════════════════════════════════════════════"
  echo ""
  echo "  Report saved: $report_file"
  echo ""
  [[ $has_failures -eq 1 ]] && exit 1
}

# --- Run ---
_run_export() {
  _print_header "Running Export"
  echo "Environment: $WXO_ENV (active)"
  echo "Output: $SYS_DIR"
  echo ""
  echo "  $ bash \"$EXPORT_SCRIPT\" $EXPORT_ARGS"
  _load_env
  _log "EXPORT: bash $EXPORT_SCRIPT $EXPORT_ARGS"
  echo ""
  eval "bash \"$EXPORT_SCRIPT\" $EXPORT_ARGS"
}

_run_import() {
  _print_header "Running Import"
  echo "Environment: $WXO_ENV (active)"
  echo "Source: $SYS_DIR"
  echo ""
  echo "  $ bash \"$DEPLOY_SCRIPT\" $IMPORT_ARGS"
  _load_env
  _log "IMPORT: bash $DEPLOY_SCRIPT $IMPORT_ARGS"
  echo ""
  eval "bash \"$DEPLOY_SCRIPT\" $IMPORT_ARGS"
}

# --- Main ---
main() {
  WXO_ENV=""
  SYS_DIR=""
  ACTION=""
  EXPORT_ARGS=""
  IMPORT_ARGS=""
  ALREADY_ACTIVATED=0

  _init_debug_log

  while true; do
    NAV_BACK=0
    _select_environment
    while true; do
      if ! _select_action; then
        break
      fi
      NAV_BACK=0
      if [[ "$ACTION" -eq 1 ]]; then
        _select_local_dir
        [[ "$NAV_BACK" -eq 1 ]] && { _breadcrumb_pop; continue; }
        [[ ! -d "$SYS_DIR" ]] && mkdir -p "$SYS_DIR"
        _activate_environment
        _export_options
        [[ "$NAV_BACK" -eq 1 ]] && { _breadcrumb_pop; continue; }
        _run_export
      elif [[ "$ACTION" -eq 2 ]]; then
        _select_local_dir
        [[ "$NAV_BACK" -eq 1 ]] && { _breadcrumb_pop; continue; }
        if [[ ! -d "$SYS_DIR" ]] || [[ ! -d "$SYS_DIR/agents" && ! -d "$SYS_DIR/tools" && ! -d "$SYS_DIR/flows" && ! -d "$SYS_DIR/plugins" && ! -d "$SYS_DIR/connections" ]]; then
          echo "Error: No agents/, tools/, flows/, plugins/, or connections/ in $SYS_DIR"
          exit 1
        fi
        _activate_environment
        _import_options
        [[ "$NAV_BACK" -eq 1 ]] && { _breadcrumb_pop; continue; }
        _run_import
      elif [[ "$ACTION" -eq 3 ]]; then
        echo "  $ bash $COMPARE_SCRIPT"
        _log "COMPARE: bash $COMPARE_SCRIPT"
        bash "$COMPARE_SCRIPT"
      elif [[ "$ACTION" -eq 4 ]]; then
        _activate_environment
        _run_validate
        [[ "$NAV_BACK" -eq 1 ]] && { continue; }
      elif [[ "$ACTION" -eq 5 ]]; then
        _select_replicate_envs
        [[ "$NAV_BACK" -eq 1 ]] && { continue; }
        _replicate_options
        [[ "$NAV_BACK" -eq 1 ]] && { [[ "${WXO_DEBUG:-0}" == "1" ]] && echo "  [REPL-DEBUG] NAV_BACK=1 after _replicate_options"; continue; }
        [[ "${WXO_DEBUG:-0}" == "1" ]] && echo "  [REPL-DEBUG] Calling _run_replicate"
        _run_replicate
      elif [[ "$ACTION" -eq 6 ]]; then
        _activate_environment
        [[ "$NAV_BACK" -eq 1 ]] && { continue; }
        if ! _danger_zone_menu; then
          [[ "$NAV_BACK" -eq 1 ]] && { continue; }
        else
          _delete_options
          [[ "$NAV_BACK" -eq 1 ]] && { _breadcrumb_pop; continue; }
          _run_delete
        fi
      else
        echo "  Unknown action."
        exit 1
      fi
      echo ""
      echo "Done."
      break 2
    done
  done
}

main "$@"
