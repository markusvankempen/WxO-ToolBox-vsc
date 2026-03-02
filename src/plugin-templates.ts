/**
 * Plugin templates for WxO Create Plugin Panel.
 * Pre-invoke and Post-invoke plugins based on ibm-watsonx-orchestrate ADK.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 2 Mar 2026
 * @license Apache-2.0
 */

export type PluginTemplateId = 'dad_joke' | 'response_suffix';

export type PluginTemplate = {
    id: PluginTemplateId;
    name: string;
    kind: 'pre-invoke' | 'post-invoke';
    description: string;
    pyContent: string;
    requirements: string;
    toolSpecTemplate: Record<string, unknown>;
};

/** Minimal tool-spec template for reference (platform generates real one on import). */
function minimalToolSpec(name: string, description: string, kind: 'pre-invoke' | 'post-invoke'): Record<string, unknown> {
    return {
        name,
        description,
        input_schema: {
            type: 'object',
            properties: {
                plugin_context: { title: 'Plugin Context' },
                ...(kind === 'pre-invoke'
                    ? { agent_pre_invoke_payload: { type: 'object', title: 'AgentPreInvokePayload' } }
                    : { agent_post_invoke_payload: { type: 'object', title: 'AgentPostInvokePayload' } }),
            },
        },
    };
}

export function getPluginTemplate(id: PluginTemplateId): PluginTemplate {
    switch (id) {
        case 'dad_joke':
            return {
                id: 'dad_joke',
                name: 'dad_joke_plugin',
                kind: 'pre-invoke',
                description: 'Pre-invoke plugin that greets users with a random dad joke before the agent responds.',
                requirements: 'ibm-watsonx-orchestrate>=2.5.0',
                pyContent: `"""
Dad Joke Pre-Invoke Plugin for Watson Orchestrate.
Runs before the agent processes the user's message.
Fetches a random dad joke from icanhazdadjoke.com and prepends it.
"""

import urllib.request
import json
from typing import Any

from ibm_watsonx_orchestrate.agent_builder.tools import tool
from ibm_watsonx_orchestrate.agent_builder.tools.types import (
    PythonToolKind,
    AgentPreInvokePayload,
    AgentPreInvokeResult,
    TextContent,
    Message,
)

DAD_JOKE_API = "https://icanhazdadjoke.com/"

def _fetch_joke() -> str:
    try:
        req = urllib.request.Request(
            DAD_JOKE_API,
            headers={"Accept": "application/json", "User-Agent": "WxO-DadJokePlugin/1.0"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("joke", "")
    except Exception:
        return "Why don't scientists trust atoms? Because they make up everything!"

@tool(
    description=(
        "Pre-invoke plugin that greets users with a random dad joke before the agent responds. "
        "Fetches a joke from icanhazdadjoke.com and prepends it to the user message."
    ),
    kind=PythonToolKind.AGENTPREINVOKE,
)
def dad_joke_plugin(
    plugin_context: Any,
    agent_pre_invoke_payload: AgentPreInvokePayload,
) -> AgentPreInvokeResult:
    """Prepends a random dad joke greeting to the user's input message."""

    if agent_pre_invoke_payload is None:
        return AgentPreInvokeResult(continue_processing=False)

    messages = agent_pre_invoke_payload.messages
    if not messages:
        return AgentPreInvokeResult(continue_processing=False)

    last_msg = messages[-1]
    if last_msg.content is None or last_msg.content.text is None:
        return AgentPreInvokeResult(continue_processing=False)

    joke = _fetch_joke()
    joke_prefix = (
        f'Dad Joke: "{joke}" Now, answer the user\\'s prompt: '
    ) if joke else ""

    modified_text = joke_prefix + last_msg.content.text
    new_content = TextContent(type="text", text=modified_text)
    new_message = Message(role=last_msg.role, content=new_content)
    modified_payload = agent_pre_invoke_payload.copy(deep=True)
    modified_payload.messages[-1] = new_message

    return AgentPreInvokeResult(
        continue_processing=True,
        modified_payload=modified_payload,
    )
`,
                toolSpecTemplate: minimalToolSpec('dad_joke_plugin', 'Pre-invoke plugin that greets users with a random dad joke.', 'pre-invoke'),
            };

        case 'response_suffix':
            return {
                id: 'response_suffix',
                name: 'response_suffix_plugin',
                kind: 'post-invoke',
                description: 'Post-invoke plugin that appends a suffix to the agent response.',
                requirements: 'ibm-watsonx-orchestrate>=2.5.0',
                pyContent: `"""
Response Suffix Post-Invoke Plugin for Watson Orchestrate.
Runs after the agent generates a response.
Appends a custom suffix (e.g. disclaimer, signature) to the response.
"""

from typing import Any

from ibm_watsonx_orchestrate.agent_builder.tools import tool
from ibm_watsonx_orchestrate.agent_builder.tools.types import (
    PythonToolKind,
    AgentPostInvokePayload,
    AgentPostInvokeResult,
    TextContent,
    Message,
)

# Customize this suffix as needed
RESPONSE_SUFFIX = "\\n\\n--- Generated with Watson Orchestrate ---"

@tool(
    description=(
        "Post-invoke plugin that appends a suffix to the agent response. "
        "Useful for adding disclaimers, signatures, or formatting."
    ),
    kind=PythonToolKind.AGENTPOSTINVOKE,
)
def response_suffix_plugin(
    plugin_context: Any,
    agent_post_invoke_payload: AgentPostInvokePayload,
) -> AgentPostInvokeResult:
    """Appends a suffix to the last assistant message."""

    if agent_post_invoke_payload is None:
        return AgentPostInvokeResult(continue_processing=True)

    messages = agent_post_invoke_payload.messages
    if not messages:
        return AgentPostInvokeResult(continue_processing=True)

    # Find last assistant message and append suffix
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if msg.role == "assistant" and msg.content and msg.content.text:
            modified_text = msg.content.text.rstrip() + RESPONSE_SUFFIX
            new_content = TextContent(type="text", text=modified_text)
            new_message = Message(role=msg.role, content=new_content)
            modified_payload = agent_post_invoke_payload.copy(deep=True)
            modified_payload.messages[i] = new_message
            return AgentPostInvokeResult(
                continue_processing=True,
                modified_payload=modified_payload,
            )

    return AgentPostInvokeResult(continue_processing=True)
`,
                toolSpecTemplate: minimalToolSpec('response_suffix_plugin', 'Post-invoke plugin that appends a suffix to the agent response.', 'post-invoke'),
            };

        default:
            return getPluginTemplate('dad_joke');
    }
}
