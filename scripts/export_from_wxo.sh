#!/bin/bash
#
# Script: export_from_wxo.sh
# Version: 1.0.8
# Author: Markus van Kempen <mvankempen@ca.ibm.com>, <markus.van.kempen@gmail.com>
# Date: Feb 25, 2026
#
# Description:
#   Export agents and tools from Watson Orchestrate (WXO) to local filesystem.
#   - By default: exports agents WITH dependencies (tools, flows) + all tools.
#   - Writes export report (type, name, status, ID) to Report/ when --env-name used.
#   - Requires: orchestrate CLI (active env), jq, unzip.
#   - Use orchestrate env activate <name> before running.
#
# Usage: ./export_from_wxo.sh [OPTIONS]
#   --env-name <name>  Structured output: WxO/Exports/<name>/<DateTime>/
#   -o <dir>           Output base (with --env-name) or exact path
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../../.env}"
[[ ! -f "$ENV_FILE" ]] && ENV_FILE="$SCRIPT_DIR/../../.env"
[[ ! -f "$ENV_FILE" ]] && ENV_FILE="$SCRIPT_DIR/.env"
[[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE" 2>/dev/null || true; set +a; }

# --- Parse arguments ---
EXPORT_AGENTS_WITH_DEPS=true   # default: include tools/flows with each agent
EXPORT_AGENTS=true
EXPORT_TOOLS=true
FLOWS_ONLY=false              # when true (--flows-only): export only Flow tools
PLUGINS_ONLY=false            # when true (--plugins-only): export only Plugin tools (agent_pre/post_invoke)
EXPORT_CONNECTIONS=false      # when true (--connections-only): export live connections only
OUTPUT_DIR=""
ENV_NAME=""
AGENT_FILTER=""
TOOL_FILTER=""
TOOL_TYPE_FILTER=""   # comma-separated: python, openapi, flow (empty = all types)
CONNECTION_FILTER=""
REPORT_FILE=""
REPORT_DIR=""
REPLICATE_MODE=false  # when true: use Replicate/ instead of Exports/ (for source->target replication)

while [[ $# -gt 0 ]]; do
    case "$1" in
        --agent-only)    EXPORT_AGENTS_WITH_DEPS=false; shift ;;
        --agents-only)   EXPORT_TOOLS=false; shift ;;
        --tools-only)    EXPORT_AGENTS=false; shift ;;
        --flows-only)    EXPORT_AGENTS=false; FLOWS_ONLY=true; shift ;;
        --plugins-only)  EXPORT_AGENTS=false; PLUGINS_ONLY=true; shift ;;
        --connections-only) EXPORT_AGENTS=false; EXPORT_TOOLS=false; FLOWS_ONLY=false; PLUGINS_ONLY=false; EXPORT_CONNECTIONS=true; shift ;;
        -o|--output-dir) OUTPUT_DIR="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
        --env-name)      ENV_NAME="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
        --agent)         AGENT_FILTER="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
        --tool)          TOOL_FILTER="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
        --tool-type)     TOOL_TYPE_FILTER="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
        --connection)    CONNECTION_FILTER="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
        --report)        REPORT_FILE="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
        --report-dir)    REPORT_DIR="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
        --replicate)     REPLICATE_MODE=true; shift ;;
        -v|--version)
            echo "export_from_wxo.sh 1.0.7"
            exit 0
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo "  WxO Importer/Export/Comparer/Validator — Export script v1.0.8"
            echo ""
            echo "Options:"
            echo "  --agent-only    Export agents without their tool/flow dependencies (YAML only)"
            echo "  --agents-only   Export only agents (skip tools)"
            echo "  --tools-only    Export only tools (skip agents)"
            echo "  --flows-only        Export only Flow tools (skip agents, Python, OpenAPI)"
            echo "  --plugins-only      Export only Plugin tools (agent_pre/post_invoke)"
            echo "  --connections-only  Export only live connections (skip agents, tools, flows)"
            echo "  -o, --output-dir <dir>  Output base dir (with --env-name) or exact path"
            echo "  --env-name <name>       Use <System>/Export/<DateTime>/ structure"
            echo "  --agent <name>          Export only the specified agent(s); comma-separated for multiple"
            echo "  --tool <name>           Export only the specified tool(s); comma-separated for multiple"
            echo "  --tool-type <types>     Export only these tool types; comma-separated: python, openapi, flow (default: all)"
            echo "  --connection <app_id>   Export only the specified connection(s); comma-separated"
            echo "  --report <file>         Write export report to file"
            echo "  --report-dir <dir>       Write report to <dir>/Report/export_report.txt"
            echo "  --replicate              Use Replicate/ instead of Exports/ (for source->target replication)"
            echo "  -h, --help      Show this help"
            echo ""
            echo "With --env-name: output is WxO/Exports/<env>/<YYYYMMDD_HHMMSS>/agents|tools|flows|connections/"
            echo "With --replicate: output is WxO/Replicate/<env>/<YYYYMMDD_HHMMSS>/ (separate from Exports)"
            exit 0
            ;;
        *) echo "[WARN] Unknown option: $1"; shift ;;
    esac
done

# Output directory: WxO/Exports/<System>/<DateTime>/ when --env-name, else flat
# With --replicate: WxO/Replicate/<Source_to_Target>/<DateTime>/ (separate folder)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WXO_ROOT="${WXO_ROOT:-$SCRIPT_DIR/WxO}"
DATETIME=$(date +%Y%m%d_%H%M%S)
if [[ -n "$ENV_NAME" ]]; then
    BASE="${OUTPUT_DIR:-$WXO_ROOT}"
    BASE="${BASE%/}"
    if [[ "$REPLICATE_MODE" == "true" ]]; then
        OUTPUT_DIR="${BASE}/Replicate/${ENV_NAME}/${DATETIME}"
    else
        OUTPUT_DIR="${BASE}/Exports/${ENV_NAME}/${DATETIME}"
    fi
    # Auto-save report to Exports/System/DateTime/Report/ when using structured output
    [[ -z "$REPORT_FILE" ]] && [[ -z "$REPORT_DIR" ]] && REPORT_DIR="$OUTPUT_DIR"
else
    if [[ -z "$OUTPUT_DIR" ]]; then
        SYSNAME=$(hostname 2>/dev/null || echo "local")
        SYSNAME="${SYSNAME//[^a-zA-Z0-9._-]/_}"
        OUTPUT_DIR="export_${SYSNAME}_${DATETIME}"
    fi
fi
if [[ -n "$REPORT_DIR" ]]; then
    REPORT_FILE="${REPORT_DIR%/}/Report/export_report.txt"
    mkdir -p "$(dirname "$REPORT_FILE")"
fi
export OUTPUT_DIR

# Helper: is name in comma-separated filter list? (case-insensitive)
_in_list_filter() {
  local name="$1" filter="$2"
  [[ -z "$filter" ]] && return 0
  local n; n=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
  local IFS=, f
  for f in $filter; do
    f=$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ "$f" == "$n" ]] && return 0
  done
  return 1
}

# Parse connection YAML for environments.live.kind (auth type). Returns kind or empty.
_parse_connection_kind() {
  local yml="$1"
  [[ ! -f "$yml" ]] && return
  grep -A 50 'environments:' "$yml" 2>/dev/null | grep -A 20 'live:' | grep '^\s*kind:' | head -1 | sed 's/.*kind:\s*\([a-z_]*\).*/\1/'
}

# Map connection kind to required env var names for set-credentials
# kind -> space-separated list: API_KEY, TOKEN, USERNAME, PASSWORD, etc.
_connection_kind_to_secrets() {
  case "$1" in
    api_key) echo "API_KEY" ;;
    bearer) echo "TOKEN" ;;
    basic) echo "USERNAME PASSWORD" ;;
    oauth_auth_client_credentials_flow) echo "CLIENT_ID CLIENT_SECRET TOKEN_URL" ;;
    oauth_auth_password_flow) echo "USERNAME PASSWORD CLIENT_ID CLIENT_SECRET TOKEN_URL" ;;
    oauth_auth_on_behalf_of_flow|oauth_auth_token_exchange_flow) echo "CLIENT_ID CLIENT_SECRET TOKEN_URL" ;;
    oauth_auth_code_flow) echo "CLIENT_ID CLIENT_SECRET AUTH_URL TOKEN_URL" ;;
    key_value|kv) echo "ENTRIES" ;;
    *) echo "API_KEY" ;;  # fallback
  esac
}

# --- Guardrails: require orchestrate, jq, unzip ---
command -v orchestrate >/dev/null 2>&1 || { echo "[ERROR] 'orchestrate' CLI not found. Install: https://developer.watson-orchestrate.ibm.com/getting_started/installing"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "[ERROR] 'jq' required. Install: apt-get install jq or brew install jq"; exit 1; }
for PKG in unzip jq; do
    command -v "$PKG" >/dev/null 2>&1 || { echo "[ERROR] '$PKG' required."; exit 1; }
done

echo ""
echo "  Watson Orchestrate — Export"
echo "  ───────────────────────────"
echo "  Output:    $OUTPUT_DIR"
echo "  Agents:   $EXPORT_AGENTS (with deps: $EXPORT_AGENTS_WITH_DEPS)  |  Tools: $EXPORT_TOOLS  |  Connections: $EXPORT_CONNECTIONS"
[[ -n "$AGENT_FILTER" ]] && echo "  Filter:    agents=$AGENT_FILTER"
[[ -n "$TOOL_FILTER" ]] && echo "  Filter:    tools=$TOOL_FILTER"
[[ -n "$CONNECTION_FILTER" ]] && echo "  Filter:    connections=$CONNECTION_FILTER"
[[ -n "$REPORT_FILE" ]] && echo "  Report:    $REPORT_FILE"
echo ""

mkdir -p "$OUTPUT_DIR"

# --- Helpers for readable output ---
_strip_ansi() { echo "$1" | sed 's/\x1b\[[0-9;]*m//g' 2>/dev/null || echo "$1"; }
_status_icon() { case "$1" in OK) echo "✓";; FAILED) echo "✗";; SKIPPED) echo "⊘";; *) echo " "; esac; }

# --- Export report tracking ---
# Entry format: type|name|status|id|notes
EXPORT_ENTRIES=()
_record_export() { local type="$1" name="$2" status="$3" id="$4" notes="$5"; EXPORT_ENTRIES+=("${type}|${name}|${status}|${id:-}|${notes:-}"); }

# List tools bundled with an agent (from unzipped agents/<agent_dir>/tools/)
_list_agent_deps() {
  local agent_name="$1"
  local agents_dir="${OUTPUT_DIR}/agents"
  [[ ! -d "$agents_dir" ]] && return
  for adir in "$agents_dir"/${agent_name}*; do
    [[ -d "$adir/tools" ]] || continue
    for tdir in "$adir/tools"/*/; do
      [[ -d "$tdir" ]] || continue
      basename "$tdir"
    done
    return
  done
}

_print_export_report() {
  local agent_ok=0 agent_fail=0 tool_ok=0 tool_fail=0 conn_ok=0 conn_fail=0
  # Build report content once (same for console and file)
  local REPORT_CONTENT=""
  REPORT_CONTENT+=$'\n'
  REPORT_CONTENT+="  ═════════════════════════════════════════════════════════════════════════════════════════════"$'\n'
  REPORT_CONTENT+="  EXPORT REPORT"$'\n'
  REPORT_CONTENT+="  ═════════════════════════════════════════════════════════════════════════════════════════════"$'\n'
  REPORT_CONTENT+="  $(printf '%-8s  %-36s  %-10s  %-24s  %s' 'TYPE' 'NAME' 'STATUS' 'ID' 'NOTES')"$'\n'
  REPORT_CONTENT+="  ───────────────────────────────────────────────────────────────────────────────────────────"$'\n'
  for entry in "${EXPORT_ENTRIES[@]}"; do
    IFS='|' read -r type name status id notes <<< "$entry"
    notes="$(_strip_ansi "${notes:-}")"
    notes="${notes:0:28}"
    id="${id:0:22}"
    icon="$(_status_icon "$status")"
    REPORT_CONTENT+="  $(printf '%-8s  %-36s  %s %-8s  %-24s  %s' "$type" "${name:0:36}" "$icon" "${status}" "$id" "$notes")"$'\n'
    { [[ "$type" == "Agent" ]] && [[ "$status" == "OK" ]] && agent_ok=$((agent_ok + 1)); } || true
    { [[ "$type" == "Agent" ]] && [[ "$status" == "FAILED" ]] && agent_fail=$((agent_fail + 1)); } || true
    { [[ "$type" == "Tool"* ]] && [[ "$status" == "OK" ]] && tool_ok=$((tool_ok + 1)); } || true
    { [[ "$type" == "Tool"* ]] && [[ "$status" == "FAILED" ]] && tool_fail=$((tool_fail + 1)); } || true
    { [[ "$type" == "Connection"* ]] && [[ "$status" == "OK" ]] && conn_ok=$((conn_ok + 1)); } || true
    { [[ "$type" == "Connection"* ]] && [[ "$status" == "FAILED" ]] && conn_fail=$((conn_fail + 1)); } || true
  done
  REPORT_CONTENT+="  ───────────────────────────────────────────────────────────────────────────────────────────"$'\n'
  REPORT_CONTENT+="  SUMMARY:  agents: ✓ $agent_ok OK, ✗ $agent_fail failed  |  tools: ✓ $tool_ok OK, ✗ $tool_fail failed  |  connections: ✓ $conn_ok OK, ✗ $conn_fail failed"$'\n'
  REPORT_CONTENT+="  ═════════════════════════════════════════════════════════════════════════════════════════════"$'\n'
  REPORT_CONTENT+=$'\n'

  # Console output
  echo "$REPORT_CONTENT"

  # File: same formatted content + timestamp header
  if [[ -n "$REPORT_FILE" ]]; then
    {
      echo "=== Export Report $(date '+%Y-%m-%dT%H:%M:%S') ==="
      echo "$REPORT_CONTENT"
    } > "$REPORT_FILE"
    echo "  Report saved: $REPORT_FILE"
    echo ""
  fi
}

if [[ "$EXPORT_AGENTS" == "true" ]]; then
echo "  Fetching agents..."

AGENT_LIST_JSON=$(orchestrate agents list -v 2>&1) || {
    echo "Failed to run 'orchestrate agents list -v'."
    echo "This usually means no environment is active."
    echo ""
    echo "Activate an environment and rerun the script:"
    echo "  orchestrate env activate <env name>"
    exit 1
}

# Extract name|id from JSON (one per line)
# orchestrate agents list -v returns { "native": [...] }; also handle raw array or other wrappers
AGENT_ENTRIES=$(echo "$AGENT_LIST_JSON" | jq -r '
  (.native // .agents // .data // .items // .) |
  if type == "array" then . else [] end |
  .[] | select(type == "object") |
  ((.name // .id) // "?") as $n |
  ((.id // ._id // "") | tostring) as $id |
  "\($n)|\($id)"
')

if [ -z "$AGENT_ENTRIES" ]; then
    echo "No agents found or failed to parse JSON output."
    exit 1
fi

echo "  Found: $(echo "$AGENT_ENTRIES" | wc -l | tr -d ' ') agent(s)"
echo ""

# Ensure agents directory exists
mkdir -p "$OUTPUT_DIR/agents"

# Export each agent (with or without dependencies)
while IFS='|' read -r AGENT AGENT_ID; do
    [[ -z "$AGENT" ]] && continue
    _in_list_filter "$AGENT" "$AGENT_FILTER" || continue
    if [[ "$EXPORT_AGENTS_WITH_DEPS" == "true" ]]; then
        ZIP_FILE="$OUTPUT_DIR/agents/${AGENT}.zip"
        echo "  → $AGENT (with deps)"
        [[ "${WXO_DEBUG:-0}" == "1" || "${WXO_LOG:-0}" == "1" ]] && echo "  $ orchestrate agents export -n \"$AGENT\" -k native -o \"$ZIP_FILE\""
        set +e
        out=$(orchestrate agents export -n "$AGENT" -k native -o "$ZIP_FILE" 2>&1)
        rc=$?
        set -e
        if [[ $rc -eq 0 ]] && [[ -f "$ZIP_FILE" ]]; then
            echo "     unzipped"
            unzip -o -q "$ZIP_FILE" -d "$OUTPUT_DIR/agents" || true
            rm -f "$ZIP_FILE"
            _record_export "Agent" "$AGENT" "OK" "$AGENT_ID" ""
            # Record tools bundled with agent (agents-only mode)
            for dep_tool in $(_list_agent_deps "$AGENT"); do
                _record_export "Tool(dep)" "$dep_tool" "OK" "-" "with $AGENT"
            done
        else
            errmsg=$(echo "$out" | grep -E '\[ERROR\]|Error|error:' | tail -1 | cut -c1-50)
            [[ -z "$errmsg" ]] && errmsg="Export failed"
            _record_export "Agent" "$AGENT" "FAILED" "$AGENT_ID" "$errmsg"
            echo "     ✗ $errmsg"
        fi
    else
        YAML_FILE="$OUTPUT_DIR/agents/${AGENT}.yaml"
        echo "  → $AGENT (YAML only)"
        [[ "${WXO_DEBUG:-0}" == "1" || "${WXO_LOG:-0}" == "1" ]] && echo "  $ orchestrate agents export --agent-only -n \"$AGENT\" -k native -o \"$YAML_FILE\""
        set +e
        out=$(orchestrate agents export --agent-only -n "$AGENT" -k native -o "$YAML_FILE" 2>&1)
        rc=$?
        set -e
        if [[ $rc -eq 0 ]] && [[ -f "$YAML_FILE" ]]; then
            _record_export "Agent" "$AGENT" "OK" "$AGENT_ID" ""
        else
            errmsg=$(echo "$out" | grep -E '\[ERROR\]|Error|error:' | tail -1 | cut -c1-50)
            [[ -z "$errmsg" ]] && errmsg="Export failed"
            _record_export "Agent" "$AGENT" "FAILED" "$AGENT_ID" "$errmsg"
            echo "     ✗ $errmsg"
        fi
    fi
done <<< "$AGENT_ENTRIES"

echo "  Done."
echo ""
fi

if [[ "$EXPORT_TOOLS" == "true" ]]; then
echo "  Fetching tools..."

# Ensure tools, flows, and plugins directories exist
mkdir -p "$OUTPUT_DIR/tools"
mkdir -p "$OUTPUT_DIR/flows"
mkdir -p "$OUTPUT_DIR/plugins"

TOOL_LIST_JSON=$(orchestrate tools list -v 2>&1) || {
    echo "Failed to run 'orchestrate tools list -v'."
    echo "This usually means no environment is active."
    echo ""
    echo "Activate an environment and rerun the script:"
    echo "  orchestrate env activate <env name>"
    exit 1
}

# Extract tool name|kind|id from JSON
# Output: "name|kind|id" per line; kind = python | openapi | flow | langflow | plugin | skill | other
# .binding.skill = catalog skill (IBM prebuilt, not exportable)
# .binding.python.type = agent_pre_invoke | agent_post_invoke => plugin
# .binding.flow, .binding.langflow = flow tools
TOOL_ENTRIES=$(echo "$TOOL_LIST_JSON" | jq -r '
  (if type == "array" then . else (.tools // .native // .agents // .data // .items) end) |
  if type == "array" then . else [] end |
  .[] | select(type == "object") |
  (.name // .id) as $n |
  ((.id // ._id // "") | tostring) as $id |
  ((.binding.python.type // .binding.python.kind // "") | if type == "string" then ascii_downcase else "" end) as $ptype |
  (if ($ptype == "agent_pre_invoke" or $ptype == "agent_post_invoke") then "plugin"
   elif .binding.python then "python"
   elif .binding.skill then "skill"
   elif .binding.openapi then "openapi"
   elif .binding.langflow then "langflow"
   elif .binding.flow or (.spec.kind == "flow") or (.kind == "flow") then "flow"
   else "other"
   end) as $k |
  "\($n)|\($k)|\($id)"
')

if [ -z "$TOOL_ENTRIES" ]; then
    echo "No tools found or failed to parse JSON output."
    exit 1
fi

echo "  Found: $(echo "$TOOL_ENTRIES" | wc -l | tr -d ' ') tool(s)"
echo ""

# Export each tool via ADK (orchestrate tools export works for Python, OpenAPI, Flow, etc.)
# Skip intrinsic tools (e.g. i__get_flow_status_intrinsic_tool__) — platform-built, not exportable
# Flow/langflow tools go to flows/, others to tools/
while IFS='|' read -r TOOL KIND TOOL_ID; do
    [[ -z "$TOOL" ]] && continue
    [[ "$FLOWS_ONLY" == "true" ]] && [[ "$KIND" != "flow" ]] && [[ "$KIND" != "langflow" ]] && continue
    [[ "$PLUGINS_ONLY" == "true" ]] && [[ "$KIND" != "plugin" ]] && continue
    if [[ "$TOOL" == *intrinsic* ]]; then
        echo "  ⊘ $TOOL ($KIND) — intrinsic (skipped, not exportable)"
        _record_export "Tool" "$TOOL" "SKIPPED" "$TOOL_ID" "(intrinsic, platform-built)"
        continue
    fi
    if [[ "$KIND" == "skill" ]]; then
        echo "  ⊘ $TOOL (catalog skill) — binding.skill (not exportable)"
        _record_export "Tool" "$TOOL" "SKIPPED" "$TOOL_ID" "(catalog skill, binding.skill)"
        continue
    fi
    _in_list_filter "$TOOL" "$TOOL_FILTER" || continue
    # Filter by tool type when --tool-type is set (python, openapi, flow; flow includes langflow)
    if [[ -n "$TOOL_TYPE_FILTER" ]]; then
      kind_match=0
      old_ifs="$IFS"
      IFS=,
      for t in $TOOL_TYPE_FILTER; do
        t=$(echo "$t" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
        [[ "$t" == "flow" ]] && { [[ "$KIND" == "flow" ]] || [[ "$KIND" == "langflow" ]] && kind_match=1; break; }
        [[ "$t" == "$KIND" ]] && { kind_match=1; break; }
      done
      IFS="$old_ifs"
      [[ $kind_match -eq 0 ]] && continue
    fi
    if [[ "$KIND" == "flow" ]] || [[ "$KIND" == "langflow" ]]; then
        TOOL_SUBDIR="flows"
    elif [[ "$KIND" == "plugin" ]]; then
        TOOL_SUBDIR="plugins"
    else
        TOOL_SUBDIR="tools"
    fi
    ZIP_PATH="$OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}.zip"
    echo "  → $TOOL ($KIND)"
    [[ "${WXO_DEBUG:-0}" == "1" || "${WXO_LOG:-0}" == "1" ]] && echo "  $ orchestrate tools export -n \"$TOOL\" -o \"$ZIP_PATH\""
    set +e
    out=$(orchestrate tools export -n "$TOOL" -o "$ZIP_PATH" 2>&1)
    rc=$?
    set -e
    if [[ $rc -eq 0 ]] && [[ -f "$ZIP_PATH" ]]; then
        echo "     unzipped"
        unzip -o -q "$ZIP_PATH" -d "$OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}" || true
        if [[ "$KIND" == "python" ]]; then
            PY_FILE=$(ls "$OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}"/*.py 2>/dev/null | head -1)
            if [[ -n "$PY_FILE" ]]; then
                PY_BASENAME=$(basename "$PY_FILE")
                if [[ ! -f "$OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}/README_REIMPORT.txt" ]]; then
                    cat > "$OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}/README_REIMPORT.txt" << EOF
Re-import this Python tool:
  cd $OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}
  orchestrate tools import -k python -p . -f ${PY_BASENAME} -r requirements.txt
EOF
                fi
            fi
        elif [[ "$KIND" == "flow" ]] || [[ "$KIND" == "langflow" ]]; then
            FLOW_JSON=$(find "$OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}" -maxdepth 1 -name "*.json" ! -name "tool-spec.json" 2>/dev/null | head -1)
            if [[ -n "$FLOW_JSON" ]] && [[ ! -f "$OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}/README_REIMPORT.txt" ]]; then
                FLOW_BASENAME=$(basename "$FLOW_JSON")
                cat > "$OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}/README_REIMPORT.txt" << EOF
Re-import this Flow tool:
  cd $OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}
  orchestrate tools import -k flow -f ${FLOW_BASENAME}
EOF
            fi
        fi
        _record_export "Tool" "$TOOL" "OK" "$TOOL_ID" "(${KIND})"
        # Record bundled connections in export report
        for conn_yml in "$OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}"/connections/*.yml "$OUTPUT_DIR/${TOOL_SUBDIR}/${TOOL}"/connections/*.yaml; do
          [[ -f "$conn_yml" ]] || continue
          conn_app_id=$(grep -E '^\s*app_id:' "$conn_yml" 2>/dev/null | head -1 | sed 's/.*app_id:\s*\([^[:space:]]*\).*/\1/')
          [[ -z "$conn_app_id" ]] && { conn_app_id=$(basename "$conn_yml"); conn_app_id="${conn_app_id%.yml}"; conn_app_id="${conn_app_id%.yaml}"; }
          _record_export "Connection" "$conn_app_id" "OK" "" "(bundled with $TOOL)"
        done
    else
        errmsg=$(echo "$out" | grep -E '\[ERROR\]|\[WARNING\]|Error|error:|Skipping|could not find|not exportable' | tail -1 | cut -c1-50)
        [[ -z "$errmsg" ]] && errmsg=$(echo "$out" | tail -1 | cut -c1-50)
        [[ -z "$errmsg" ]] && errmsg="Export failed"
        if echo "$out" | grep -q "could not find uploaded OpenAPI specification"; then
            _record_export "Tool" "$TOOL" "SKIPPED" "$TOOL_ID" "(catalog skill, no spec)"
            echo "     ⊘ catalog skill (no uploaded spec, not exportable)"
        else
            _record_export "Tool" "$TOOL" "FAILED" "$TOOL_ID" "$errmsg"
            echo "     ✗ $errmsg"
        fi
    fi
done <<< "$TOOL_ENTRIES"

echo "  Done."
echo ""
echo "  Output: $OUTPUT_DIR"
echo "  Python:  tools/<name>/*.py, requirements.txt"
echo "  OpenAPI: tools/<name>/skill_v2.json"
echo "  Flow:    flows/<name>/*.json"

    # Create connection secrets report for tool-bundled connections (when tools-only; skip if also exporting connections)
    # Skip when --replicate: ENV_NAME is Source_to_Target (e.g. TZ1_to_TZ2), never used; replicate import uses source's .env_connection
    if [[ -n "$ENV_NAME" ]] && [[ "$REPLICATE_MODE" != "true" ]] && [[ "$EXPORT_CONNECTIONS" != "true" ]] && [[ ! -d "$OUTPUT_DIR/connections" ]]; then
      _conn_base="${BASE:-}"
      [[ -z "$_conn_base" ]] && [[ "$OUTPUT_DIR" == *"/Exports/"* ]] && _conn_base="$(cd "$(dirname "$(dirname "$(dirname "$OUTPUT_DIR")")")" 2>/dev/null && pwd)" || true
      [[ -z "$_conn_base" ]] && _conn_base="$WXO_ROOT"
      SYSTEMS_CONN_DIR="${_conn_base}/Systems/${ENV_NAME}/Connections"
      mkdir -p "$SYSTEMS_CONN_DIR"
      _CONN_YAMLS=()
      for _td in "$OUTPUT_DIR"/tools/*/ "$OUTPUT_DIR"/flows/*/; do
        [[ -d "$_td" ]] || continue
        for f in "$_td"connections/*.yml "$_td"connections/*.yaml; do [[ -f "$f" ]] && _CONN_YAMLS+=("$f"); done
      done
      if [[ ${#_CONN_YAMLS[@]} -gt 0 ]]; then
        REPORT_PATH="$SYSTEMS_CONN_DIR/connection_secrets_report.txt"
        ENV_TEMPLATE="$SYSTEMS_CONN_DIR/.env_connection_${ENV_NAME}"
        write_env=false
        { echo "════════════════════════════════════════════════════════════════════"; echo "  CONNECTION SECRETS (from tools) for $ENV_NAME"; echo "════════════════════════════════════════════════════════════════════"; echo ""; printf "  %-36s  %-35s  %s\n" "app_id" "kind" "required env vars"; echo "  ───────────────────────────────────────────────────────────────────────────"; } > "$REPORT_PATH"
        if [[ ! -f "$ENV_TEMPLATE" ]]; then
          { echo "# Connection secrets for $ENV_NAME (from tool bundles)"; echo "# Format: CONN_<app_id>_<SECRET_NAME>=<value>"; echo "# DEFAULT_LLM: optional, used when importing agents with no llm field (e.g. groq/openai/gpt-oss-120b)"; echo "DEFAULT_LLM=groq/openai/gpt-oss-120b"; echo ""; } > "$ENV_TEMPLATE"
          write_env=true
        fi
        for YML_FILE in "${_CONN_YAMLS[@]}"; do
          [[ -f "$YML_FILE" ]] || continue
          APP_ID=$(grep -E '^\s*app_id:' "$YML_FILE" 2>/dev/null | head -1 | sed 's/.*app_id:\s*\([^[:space:]]*\).*/\1/')
          [[ -z "$APP_ID" ]] && { APP_ID=$(basename "$YML_FILE"); APP_ID="${APP_ID%.yml}"; APP_ID="${APP_ID%.yaml}"; }
          KIND=$(_parse_connection_kind "$YML_FILE"); [[ -z "$KIND" ]] && KIND="api_key"
          SECRETS=$(_connection_kind_to_secrets "$KIND")
          VAR_LIST=""; for SEC in $SECRETS; do [[ -n "$VAR_LIST" ]] && VAR_LIST="$VAR_LIST, "; VAR_LIST="${VAR_LIST}CONN_${APP_ID}_${SEC}"; done
          printf "  %-36s  %-35s  %s\n" "$APP_ID" "$KIND" "$VAR_LIST" >> "$REPORT_PATH"
          [[ "$write_env" == "true" ]] && for SEC in $SECRETS; do echo "CONN_${APP_ID}_${SEC}=" >> "$ENV_TEMPLATE"; done
        done
        [[ "$write_env" == "false" ]] && echo "  (.env_connection preserved — file exists)"
        echo "  Connection secrets (tool bundles): $REPORT_PATH"
      fi
    fi
fi

if [[ "$EXPORT_CONNECTIONS" == "true" ]]; then
echo "  Fetching connections (live only)..."

mkdir -p "$OUTPUT_DIR/connections"

# CLI may prefix JSON with [INFO]; strip first line if it's not JSON (portable: works on macOS BSD sed)
_CONN_RAW=$(orchestrate connections list -v --env live 2>&1) || true
CONN_LIST_JSON="$_CONN_RAW"
_firstline=$(echo "$_CONN_RAW" | head -1)
if [[ -n "$_firstline" ]] && ! echo "$_firstline" | grep -qE '^[\[{]'; then
    CONN_LIST_JSON=$(echo "$_CONN_RAW" | tail -n +2)
fi
# If parse still fails (e.g. ANSI codes), try without first line
if ! echo "$CONN_LIST_JSON" | jq -e . >/dev/null 2>&1 && [[ -n "$_CONN_RAW" ]]; then
    CONN_LIST_JSON=$(echo "$_CONN_RAW" | tail -n +2)
fi
if [[ -z "$CONN_LIST_JSON" ]]; then
    echo "  Failed to run 'orchestrate connections list -v --env live'."
    echo "  Activate an environment and rerun: orchestrate env activate <env name>"
    exit 1
fi

# Parse app_id: only entries with environment=="live" and credentials_entered==true (exclude draft, inactive)
CONN_ENTRIES=$(echo "$CONN_LIST_JSON" | jq -r '
  (if type == "array" then . else (.live // .connections // .data // .) end) |
  if type == "array" then . else [] end |
  .[] | select(type == "object") |
  select(.environment == "live") |
  select(.credentials_entered == true) |
  (.app_id // .appId // .id // .name) // empty |
  select(length > 0)
' 2>/dev/null | sort -u) || true

if [[ -z "$CONN_ENTRIES" ]]; then
    echo "  No live connections found or failed to parse JSON."
    echo "  (Tip: Use orchestrate connections list -v --env live to inspect format)"
else
    echo "  Found: $(echo "$CONN_ENTRIES" | grep -c . 2>/dev/null || echo "0") connection(s)"
    echo ""
    while IFS= read -r APP_ID; do
        [[ -z "$APP_ID" ]] && continue
        _in_list_filter "$APP_ID" "$CONNECTION_FILTER" || continue
        YML_FILE="$OUTPUT_DIR/connections/${APP_ID}.yml"
        echo "  → $APP_ID"
        [[ "${WXO_DEBUG:-0}" == "1" || "${WXO_LOG:-0}" == "1" ]] && echo "  $ orchestrate connections export -a \"$APP_ID\" -o \"$YML_FILE\""
        set +e
        out=$(orchestrate connections export -a "$APP_ID" -o "$YML_FILE" 2>&1)
        rc=$?
        set -e
        if [[ $rc -eq 0 ]] && [[ -f "$YML_FILE" ]]; then
            _record_export "Connection" "$APP_ID" "OK" "" "(live)"
        else
            errmsg=$(echo "$out" | grep -E '\[ERROR\]|Error|error:' | tail -1 | cut -c1-50)
            [[ -z "$errmsg" ]] && errmsg="Export failed"
            _record_export "Connection" "$APP_ID" "FAILED" "" "$errmsg"
            echo "     ✗ $errmsg"
        fi
    done <<< "$CONN_ENTRIES"
    echo "  Done."
    echo ""
    echo "  Output: $OUTPUT_DIR"
    echo "  Connections: connections/<app_id>.yml"

    # Create WxO/Systems/<ENV_NAME>/Connections/ with secrets report + .env template
    # Include top-level connections/ and tool-bundled tools/*/connections/
    # Do not overwrite .env_connection_<ENV> if it already exists
    # Skip when --replicate: ENV_NAME is Source_to_Target, never used
    if [[ -n "$ENV_NAME" ]] && [[ "$REPLICATE_MODE" != "true" ]]; then
      _conn_base="${BASE:-}"
      [[ -z "$_conn_base" ]] && [[ "$OUTPUT_DIR" == *"/Exports/"* ]] && _conn_base="$(cd "$(dirname "$(dirname "$(dirname "$OUTPUT_DIR")")")" 2>/dev/null && pwd)" || true
      [[ -z "$_conn_base" ]] && _conn_base="$WXO_ROOT"
      SYSTEMS_CONN_DIR="${_conn_base}/Systems/${ENV_NAME}/Connections"
      mkdir -p "$SYSTEMS_CONN_DIR"
      REPORT_PATH="$SYSTEMS_CONN_DIR/connection_secrets_report.txt"
      ENV_TEMPLATE="$SYSTEMS_CONN_DIR/.env_connection_${ENV_NAME}"
      write_env=false

      {
        echo "════════════════════════════════════════════════════════════════════════════════════════════"
        echo "  CONNECTION SECRETS REQUIRED for $ENV_NAME"
        echo "════════════════════════════════════════════════════════════════════════════════════════════"
        echo ""
        echo "  Fill in .env_connection_${ENV_NAME} with the values below, then run import."
        echo ""
        printf "  %-36s  %-35s  %s\n" "app_id" "kind" "required env vars"
        echo "  ───────────────────────────────────────────────────────────────────────────────────────────"
      } > "$REPORT_PATH"

      if [[ ! -f "$ENV_TEMPLATE" ]]; then
        {
          echo "# Connection secrets for $ENV_NAME — fill in before import"
          echo "# Used when importing connections to $ENV_NAME or when Replicate targets $ENV_NAME"
          echo "# Format: CONN_<app_id>_<SECRET_NAME>=<value>"
          echo "# DEFAULT_LLM: optional, used when importing agents with no llm field (e.g. groq/openai/gpt-oss-120b)"
          echo "DEFAULT_LLM=groq/openai/gpt-oss-120b"
          echo ""
        } > "$ENV_TEMPLATE"
        write_env=true
      fi

      # Collect connection YAMLs: top-level connections/ + tools/*/connections/
      _CONN_YAMLS=()
      for f in "$OUTPUT_DIR"/connections/*.yml "$OUTPUT_DIR"/connections/*.yaml; do [[ -f "$f" ]] && _CONN_YAMLS+=("$f"); done
      for _td in "$OUTPUT_DIR"/tools/*/ "$OUTPUT_DIR"/flows/*/; do
        [[ -d "$_td" ]] || continue
        for f in "$_td"connections/*.yml "$_td"connections/*.yaml; do [[ -f "$f" ]] && _CONN_YAMLS+=("$f"); done
      done
      for YML_FILE in "${_CONN_YAMLS[@]}"; do
        [[ -f "$YML_FILE" ]] || continue
        APP_ID=$(basename "$YML_FILE" .yml)
        APP_ID="${APP_ID%.yaml}"
        KIND=$(_parse_connection_kind "$YML_FILE")
        [[ -z "$KIND" ]] && KIND="api_key"
        SECRETS=$(_connection_kind_to_secrets "$KIND")
        VAR_LIST=""
        for SEC in $SECRETS; do
          [[ -n "$VAR_LIST" ]] && VAR_LIST="$VAR_LIST, "
          VAR_LIST="${VAR_LIST}CONN_${APP_ID}_${SEC}"
        done
        printf "  %-36s  %-35s  %s\n" "$APP_ID" "$KIND" "$VAR_LIST" >> "$REPORT_PATH"
        [[ "$write_env" == "true" ]] && for SEC in $SECRETS; do echo "CONN_${APP_ID}_${SEC}=" >> "$ENV_TEMPLATE"; done
      done

      {
        echo "  ───────────────────────────────────────────────────────────────────────────────────────────"
        echo ""
        echo "  Report: $REPORT_PATH"
        echo "  Template: $ENV_TEMPLATE"
        echo "════════════════════════════════════════════════════════════════════════════════════════════"
      } >> "$REPORT_PATH"
      echo ""
      echo "  Connection secrets report: $REPORT_PATH"
      [[ "$write_env" == "false" ]] && echo "  (.env_connection preserved — file exists)"
      echo "  Secrets template: $ENV_TEMPLATE (fill in before import)"
    fi
fi
fi

_print_export_report

echo ""
echo "  All outputs saved to: $OUTPUT_DIR"