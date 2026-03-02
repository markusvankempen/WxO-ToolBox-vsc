#!/bin/bash
#
# Script: remove_tool_from_agents.sh
# Version: 1.0.0
# Description:
#   Removes a tool or plugin from all agents that reference it, using orchestrate CLI only.
#   Uses: orchestrate agents list -v, export --agent-only, import.
#   Before deleting a tool, run this to clean agent assignments and avoid orphaned references.
#
# Usage:
#   ./remove_tool_from_agents.sh -n <tool_name> [-d] [-y]
#
# Options:
#   -n, --name <name>   Tool or plugin name to remove from agents (required)
#   -d, --dry-run       Show which agents would be updated, do not modify
#   -y, --yes           Skip confirmation prompt
#   -h, --help          Show this help
#
# Requires: orchestrate CLI (active env), jq, python3 with PyYAML (pip install pyyaml)
#
# Example:
#   orchestrate env activate TZ1
#   ./remove_tool_from_agents.sh -n my_plugin -d    # dry run
#   ./remove_tool_from_agents.sh -n my_plugin -y   # actually remove from agents
#
set -e

TOOL_NAME=""
DRY_RUN=false
SKIP_CONFIRM=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -n|--name)   TOOL_NAME="${2:-}"; [[ $# -ge 2 ]] && shift 2 || shift ;;
        -d|--dry-run) DRY_RUN=true; shift ;;
        -y|--yes)     SKIP_CONFIRM=true; shift ;;
        -h|--help)
            echo "Usage: $0 -n <tool_name> [-d] [-y]"
            echo "  -n, --name <name>   Tool or plugin name to remove from agents (required)"
            echo "  -d, --dry-run       Show which agents would be updated, do not modify"
            echo "  -y, --yes           Skip confirmation prompt"
            exit 0
            ;;
        *) echo "[WARN] Unknown option: $1"; shift ;;
    esac
done

[[ -z "$TOOL_NAME" ]] && { echo "[ERROR] -n <tool_name> is required."; exit 1; }

# Strip leading non-JSON lines from orchestrate output
_strip_json() {
    local raw="$1"
    local first
    first=$(echo "$raw" | head -1)
    if [[ -n "$first" ]] && ! echo "$first" | grep -qE '^[\[{]'; then
        echo "$raw" | tail -n +2
    else
        echo "$raw"
    fi
}

# Get agents list JSON
AGENTS_RAW=$(orchestrate agents list -v 2>&1) || { echo "[ERROR] orchestrate agents list failed. Activate env: orchestrate env activate <name>"; exit 1; }
AGENTS_JSON=$(_strip_json "$AGENTS_RAW")

# Extract agent array (native, agents, data, items)
AGENTS_ARRAY=$(echo "$AGENTS_JSON" | jq -r '
  (.native // .agents // .data // .items // .) |
  if type == "array" then . else [] end
' 2>/dev/null) || { echo "[ERROR] Failed to parse agents JSON. Is jq installed?"; exit 1; }

# Find agents that reference the tool (in tools[] or plugins.agent_pre_invoke / agent_post_invoke)
AFFECTED=$(echo "$AGENTS_ARRAY" | jq -r --arg tool "$TOOL_NAME" '
  .[] | select(type == "object") |
  (.name // .id) as $aname |
  (
    ([.tools[]? | select(type == "string" and . == $tool)] | length > 0) or
    ([.tools[]? | select(type == "object" and (.id // .name) == $tool)] | length > 0) or
    ([.tool_ids[]? | select(. == $tool)] | length > 0) or
    ([.skills[]? | select(type == "string" and . == $tool)] | length > 0) or
    ([.skills[]? | select(type == "object" and (.id // .name) == $tool)] | length > 0) or
    ([.skill_ids[]? | select(. == $tool)] | length > 0) or
    ([.plugins.agent_pre_invoke[]? | select(.plugin_id == $tool or . == $tool)] | length > 0) or
    ([.plugins.agent_post_invoke[]? | select(.plugin_id == $tool or . == $tool)] | length > 0)
  ) | select(.) | $aname
' 2>/dev/null) || true

if [[ -z "$AFFECTED" ]]; then
    echo "  No agents reference tool/plugin \"$TOOL_NAME\". Nothing to do."
    exit 0
fi

AFFECTED_COUNT=$(echo "$AFFECTED" | grep -c . || echo 0)
echo "  Found $AFFECTED_COUNT agent(s) referencing \"$TOOL_NAME\":"
echo "$AFFECTED" | while IFS= read -r a; do [[ -n "$a" ]] && echo "    - $a"; done
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [Dry run] Would remove \"$TOOL_NAME\" from the above agents."
    exit 0
fi

if [[ "$SKIP_CONFIRM" != "true" ]]; then
    read -p "  Remove \"$TOOL_NAME\" from these agents? [y/N] " confirm
    [[ "$(echo "$confirm" | tr '[:upper:]' '[:lower:]')" != "y" ]] && [[ "$(echo "$confirm" | tr '[:upper:]' '[:lower:]')" != "yes" ]] && { echo "  Cancelled."; exit 0; }
fi

TMPDIR=$(mktemp -d 2>/dev/null || echo "/tmp/wxo_remove_tool_$$")
trap "rm -rf '$TMPDIR'" EXIT

# Write Python helper to temp file
PY_HELPER="$TMPDIR/remove_from_yaml.py"
cat > "$PY_HELPER" << 'PYEOF'
import sys
try:
    import yaml
except ImportError:
    print("[ERROR] PyYAML required. Run: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

tool_name = sys.argv[1]
yaml_path = sys.argv[2]

with open(yaml_path, "r") as f:
    data = yaml.safe_load(f)

if not data:
    print("[ERROR] Empty or invalid YAML", file=sys.stderr)
    sys.exit(1)

def id_or_name(x):
    if isinstance(x, str): return x
    if isinstance(x, dict): return x.get("id") or x.get("name") or x.get("plugin_id") or ""
    return ""

def remove_from_list(lst, key_fn):
    if not lst: return lst
    return [x for x in lst if key_fn(x) != tool_name]

# spec.tools or tools (array of strings or {name: X})
for key in ["tools", "tool_ids", "skills", "skill_ids"]:
    for prefix in ["spec", ""]:
        obj = data.get(prefix, data) if prefix else data
        if not isinstance(obj, dict): continue
        arr = obj.get(key)
        if isinstance(arr, list):
            obj[key] = remove_from_list(arr, id_or_name)

# plugins.agent_pre_invoke, agent_post_invoke
plugins = data.get("plugins") or (data.get("spec") or {}).get("plugins")
if isinstance(plugins, dict):
    for hook in ["agent_pre_invoke", "agent_post_invoke"]:
        arr = plugins.get(hook)
        if isinstance(arr, list):
            plugins[hook] = [p for p in arr if (p.get("plugin_id") if isinstance(p, dict) else p) != tool_name]

with open(yaml_path, "w") as f:
    yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
PYEOF

# Check Python + PyYAML
if ! python3 -c "import yaml" 2>/dev/null; then
    echo "[ERROR] Python 3 with PyYAML required. Run: pip install pyyaml"
    exit 1
fi

OK=0
FAIL=0
for AGENT in $AFFECTED; do
    [[ -z "$AGENT" ]] && continue
    echo "  → $AGENT"
    YAML_FILE="$TMPDIR/${AGENT}.yaml"
    rc=0
    out=$(orchestrate agents export --agent-only -n "$AGENT" -k native -o "$YAML_FILE" 2>&1) || rc=$?
    if [[ $rc -ne 0 ]]; then
        out=$(orchestrate agents export --agent-only -n "$AGENT" -k external -o "$YAML_FILE" 2>&1) || rc=$?
    fi
    if [[ $rc -ne 0 ]]; then
        out=$(orchestrate agents export --agent-only -n "$AGENT" -k assistant -o "$YAML_FILE" 2>&1) || rc=$?
    fi
    if [[ $rc -ne 0 ]] || [[ ! -f "$YAML_FILE" ]]; then
        echo "     ✗ export failed: ${out:0:80}"
        ((FAIL++)) || true
        continue
    fi
    if ! python3 "$PY_HELPER" "$TOOL_NAME" "$YAML_FILE" 2>/dev/null; then
        echo "     ✗ failed to edit YAML"
        ((FAIL++)) || true
        continue
    fi
    rc=0
    out=$(orchestrate agents import -f "$YAML_FILE" -k native 2>&1) || rc=$?
    if [[ $rc -ne 0 ]]; then
        out=$(orchestrate agents import -f "$YAML_FILE" -k external 2>&1) || rc=$?
    fi
    if [[ $rc -ne 0 ]]; then
        out=$(orchestrate agents import -f "$YAML_FILE" -k assistant 2>&1) || rc=$?
    fi
    if [[ $rc -eq 0 ]]; then
        echo "     ✓ removed from agent"
        ((OK++)) || true
    else
        echo "     ✗ import failed: ${out:0:80}"
        ((FAIL++)) || true
    fi
done

echo ""
echo "  Done. Updated: $OK, Failed: $FAIL"
