/**
 * WxO Trace Detail Panel — Human-readable view of exported trace JSON.
 * Parses OpenTelemetry trace data and displays summary, span tree, user input, AI response, tokens.
 *
 * @author Markus van Kempen <markus.van.kempen@gmail.com>
 * @date 2 Mar 2026
 * @license Apache-2.0
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type Span = {
    traceId: string;
    spanId: string;
    name: string;
    kind: string;
    parentSpanId?: string;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    durationMs: number;
    attributes?: Array<{ key: string; value?: { stringValue?: string; intValue?: string } }>;
    status?: { code?: string };
};

const SLOW_SPAN_MS = 500;

type ParsedTrace = {
    traceId: string;
    agentName?: string;
    userId?: string;
    sessionId?: string;
    totalDurationMs: number;
    spanCount: number;
    spans: Span[];
    userInput?: string;
    aiResponse?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    hasErrors: boolean;
    errorSpans: Span[];
    slowSpans: Span[];
    traceStartNano: string;
};

function getAttr(span: Span, key: string): string | undefined {
    const a = span.attributes?.find((x) => x.key === key);
    return a?.value?.stringValue ?? a?.value?.intValue?.toString();
}

function parseTraceJson(json: unknown): ParsedTrace | null {
    const root = json as Record<string, unknown>;
    const traceData = root?.traceData as Record<string, unknown>;
    const resourceSpans = traceData?.resourceSpans as Array<Record<string, unknown>> | undefined;
    if (!resourceSpans?.length) return null;

    const spans: Span[] = [];
    for (const rs of resourceSpans) {
        const scopeSpans = rs.scopeSpans as Array<Record<string, unknown>> | undefined;
        for (const ss of scopeSpans ?? []) {
            const sps = ss.spans as Array<Record<string, unknown>> | undefined;
            for (const s of sps ?? []) {
                const start = parseInt(String(s.startTimeUnixNano ?? 0), 10);
                const end = parseInt(String(s.endTimeUnixNano ?? 0), 10);
                spans.push({
                    traceId: String(s.traceId ?? ''),
                    spanId: String(s.spanId ?? ''),
                    name: String(s.name ?? ''),
                    kind: String(s.kind ?? ''),
                    parentSpanId: s.parentSpanId ? String(s.parentSpanId) : undefined,
                    startTimeUnixNano: String(s.startTimeUnixNano ?? ''),
                    endTimeUnixNano: String(s.endTimeUnixNano ?? ''),
                    durationMs: (end - start) / 1_000_000,
                    attributes: (s.attributes as Span['attributes']) ?? [],
                    status: s.status as Span['status'],
                });
            }
        }
    }

    if (spans.length === 0) return null;

    const rootSpan = spans.find((s) => !s.parentSpanId) ?? spans[0];
    const traceId = rootSpan.traceId;
    const agentName = getAttr(rootSpan, 'agent.name');
    const userId = getAttr(rootSpan, 'user.id');
    const sessionId = getAttr(rootSpan, 'session.id');
    const totalDurationMs = rootSpan.durationMs;

    let userInput: string | undefined;
    let aiResponse: string | undefined;
    let model: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let totalTokens: number | undefined;

    for (const s of spans) {
        const content = getAttr(s, 'gen_ai.completion.0.content');
        if (content) aiResponse = content;
        const prompt = getAttr(s, 'gen_ai.prompt.1.content');
        if (prompt) userInput = prompt;
        const m = getAttr(s, 'gen_ai.request.model');
        if (m) model = m;
        const pt = getAttr(s, 'gen_ai.usage.prompt_tokens');
        if (pt) promptTokens = parseInt(pt, 10);
        const ct = getAttr(s, 'gen_ai.usage.completion_tokens');
        if (ct) completionTokens = parseInt(ct, 10);
        const tt = getAttr(s, 'llm.usage.total_tokens');
        if (tt) totalTokens = parseInt(tt, 10);
    }

    if (!userInput || !aiResponse) {
        for (const s of spans) {
            const input = getAttr(s, 'traceloop.entity.input');
            if (input && !userInput) {
                try {
                    const parsed = JSON.parse(input) as Record<string, unknown>;
                    let inp = parsed.inputs;
                    if (typeof inp === 'string') inp = JSON.parse(inp) as Record<string, unknown>;
                    const msgs = (inp as Record<string, unknown>)?.messages as Array<Record<string, unknown>> | undefined;
                    const human = msgs?.find((m) => m.type === 'human');
                    if (human?.content) userInput = String(human.content);
                } catch {
                    /* ignore */
                }
            }
            const output = getAttr(s, 'traceloop.entity.output');
            if (output && !aiResponse) {
                try {
                    const parsed = JSON.parse(output) as Record<string, unknown>;
                    const out = parsed.outputs as Record<string, unknown>;
                    const msgs = out?.messages as Array<Record<string, unknown>> | undefined;
                    const ai = msgs?.find((m) => m.type === 'ai');
                    if (ai?.content) aiResponse = String(ai.content);
                } catch {
                    /* ignore */
                }
            }
        }
    }

    const errorSpans = spans.filter((s) => s.status?.code === 'STATUS_CODE_ERROR');
    const slowSpans = spans.filter((s) => s.durationMs >= SLOW_SPAN_MS);
    const traceStartNano = spans.reduce(
        (min, s) => (s.startTimeUnixNano.localeCompare(min) < 0 ? s.startTimeUnixNano : min),
        spans[0]?.startTimeUnixNano ?? '0',
    );

    return {
        traceId,
        agentName,
        userId,
        sessionId,
        totalDurationMs,
        spanCount: spans.length,
        spans,
        userInput,
        aiResponse,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        hasErrors: errorSpans.length > 0,
        errorSpans,
        slowSpans,
        traceStartNano,
    };
}

function escapeHtml(s: string): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '<br>');
}

function formatAttrValue(v: string, maxLen = 200): string {
    if (v.length <= maxLen) return v;
    try {
        const parsed = JSON.parse(v);
        return JSON.stringify(parsed, null, 2).slice(0, maxLen * 2) + (v.length > maxLen * 2 ? '…' : '');
    } catch {
        return v.slice(0, maxLen) + '…';
    }
}

function summarizeEntityJson(v: string, maxLen = 400): string {
    try {
        const o = JSON.parse(v) as Record<string, unknown>;
        if (o.inputs) {
            let inp = o.inputs;
            if (typeof inp === 'string') inp = JSON.parse(inp) as Record<string, unknown>;
            const msgs = (inp as Record<string, unknown>)?.messages as Array<Record<string, unknown>> | undefined;
            const human = msgs?.find((m) => m.type === 'human');
            if (human?.content) return String(human.content).slice(0, maxLen) + (String(human.content).length > maxLen ? '…' : '');
        }
        if (o.outputs) {
            const out = o.outputs as Record<string, unknown>;
            const msgs = out?.messages as Array<Record<string, unknown>> | undefined;
            const ai = msgs?.find((m) => m.type === 'ai');
            if (ai?.content) return String(ai.content).slice(0, maxLen) + (String(ai.content).length > maxLen ? '…' : '');
        }
    } catch {
        /* ignore */
    }
    return v.length > maxLen ? v.slice(0, maxLen) + '…' : v;
}

function getImportantAttrs(span: Span): Array<{ key: string; value: string }> {
    const important = [
        'traceloop.entity.name',
        'gen_ai.request.model',
        'gen_ai.prompt.0.content',
        'gen_ai.prompt.1.content',
        'gen_ai.completion.0.content',
        'gen_ai.usage.prompt_tokens',
        'gen_ai.usage.completion_tokens',
        'traceloop.entity.input',
        'traceloop.entity.output',
    ];
    const result: Array<{ key: string; value: string }> = [];
    for (const k of important) {
        const v = getAttr(span, k);
        if (v) {
            const displayVal = k.includes('entity.input') || k.includes('entity.output') ? summarizeEntityJson(v) : formatAttrValue(v, 500);
            result.push({ key: k.replace(/^gen_ai\.|^traceloop\.entity\./, ''), value: displayVal });
        }
    }
    return result;
}

function renderTraceHtml(data: ParsedTrace): string {
    const rows: string[] = [];
    const traceStart = BigInt(data.traceStartNano);
    const totalNano = data.spans.reduce((max, s) => {
        const end = BigInt(s.endTimeUnixNano);
        return end > max ? end : max;
    }, BigInt(0));
    const totalRangeNano = Number(totalNano - traceStart) || 1;

    // ── Insights ──
    rows.push('<div class="insights-bar">');
    rows.push(
        `<span class="insight-badge ${data.hasErrors ? 'insight-error' : 'insight-ok'}">${data.hasErrors ? '⚠ Errors' : '✓ OK'}</span>`,
    );
    if (data.slowSpans.length > 0) {
        rows.push(`<span class="insight-badge insight-warn">${data.slowSpans.length} slow span(s) (>${SLOW_SPAN_MS}ms)</span>`);
    }
    if (data.promptTokens != null || data.completionTokens != null) {
        rows.push(
            `<span class="insight-badge insight-tokens">Tokens: ${data.promptTokens ?? 0} in / ${data.completionTokens ?? 0} out</span>`,
        );
    }
    if (data.model) {
        rows.push(`<span class="insight-badge insight-model">${escapeHtml(data.model)}</span>`);
    }
    rows.push('</div>');

    // ── Summary ──
    rows.push('<div class="trace-summary">');
    rows.push('<h3>Trace Summary</h3>');
    rows.push('<table class="trace-meta"><tbody>');
    rows.push(`<tr><th>Trace ID</th><td><code>${escapeHtml(data.traceId)}</code></td></tr>`);
    if (data.agentName) rows.push(`<tr><th>Agent</th><td>${escapeHtml(data.agentName)}</td></tr>`);
    if (data.userId) rows.push(`<tr><th>User</th><td>${escapeHtml(data.userId)}</td></tr>`);
    if (data.sessionId) rows.push(`<tr><th>Session</th><td><code class="session-id">${escapeHtml(data.sessionId.slice(0, 40))}…</code></td></tr>`);
    rows.push(`<tr><th>Duration</th><td>${data.totalDurationMs.toFixed(0)} ms</td></tr>`);
    rows.push(`<tr><th>Spans</th><td>${data.spanCount}</td></tr>`);
    if (data.model) rows.push(`<tr><th>Model</th><td>${escapeHtml(data.model)}</td></tr>`);
    if (data.promptTokens != null || data.completionTokens != null) {
        rows.push(`<tr><th>Tokens</th><td>prompt: ${data.promptTokens ?? '—'}, completion: ${data.completionTokens ?? '—'}${data.totalTokens != null ? `, total: ${data.totalTokens}` : ''}</td></tr>`);
    }
    rows.push('</tbody></table></div>');

    // ── Conversation (larger, easier to read) ──
    if (data.userInput || data.aiResponse) {
        rows.push('<div class="trace-conversation">');
        rows.push('<h3>Conversation</h3>');
        if (data.userInput) {
            rows.push('<div class="trace-block user"><div class="block-label">👤 User</div><div class="block-content">' + escapeHtml(data.userInput) + '</div></div>');
        }
        if (data.aiResponse) {
            rows.push('<div class="trace-block ai"><div class="block-label">🤖 AI</div><div class="block-content">' + escapeHtml(data.aiResponse) + '</div></div>');
        }
        rows.push('</div>');
    }

    // ── Visual timeline ──
    rows.push('<div class="trace-timeline">');
    rows.push('<h3>Timeline</h3>');
    rows.push('<div class="gantt">');
    const sorted = [...data.spans].sort((a, b) => a.startTimeUnixNano.localeCompare(b.startTimeUnixNano));
    for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        const startPct = (Number(BigInt(s.startTimeUnixNano) - traceStart) / totalRangeNano) * 100;
        const durPct = Math.max(0.5, (s.durationMs / (totalRangeNano / 1e6)) * 100);
        const isError = s.status?.code === 'STATUS_CODE_ERROR';
        const isSlow = s.durationMs >= SLOW_SPAN_MS;
        const cls = ['gantt-bar', isError ? 'gantt-error' : '', isSlow ? 'gantt-slow' : ''].filter(Boolean).join(' ');
        rows.push(
            `<div class="gantt-row"><span class="gantt-name">${escapeHtml(s.name)}</span><div class="gantt-track">` +
                `<div class="${cls}" style="left:${startPct.toFixed(1)}%;width:${durPct.toFixed(1)}%;" title="${escapeHtml(s.name)} (${s.durationMs.toFixed(0)} ms)">` +
                `<span class="gantt-label">${s.durationMs.toFixed(0)}ms</span></div></div></div>`,
        );
    }
    rows.push('</div></div>');

    // ── Expandable span tree ──
    rows.push('<div class="trace-spans">');
    rows.push('<h3>Spans</h3>');
    rows.push('<p class="span-hint">Click a span to expand and see details.</p>');
    rows.push('<div class="span-tree">');
    for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        const isChild = !!s.parentSpanId;
        const indent = isChild ? 20 : 0;
        const statusIcon = s.status?.code === 'STATUS_CODE_OK' ? '✓' : s.status?.code === 'STATUS_CODE_ERROR' ? '✗' : '—';
        const statusCls = s.status?.code === 'STATUS_CODE_ERROR' ? 'span-error' : s.durationMs >= SLOW_SPAN_MS ? 'span-slow' : '';
        const attrs = getImportantAttrs(s);
        const attrsHtml =
            attrs.length > 0
                ? attrs
                      .map(
                          (a) =>
                              `<div class="attr-row"><span class="attr-key">${escapeHtml(a.key)}</span><pre class="attr-val">${escapeHtml(a.value)}</pre></div>`,
                      )
                      .join('')
                : '<p class="attr-empty">No notable attributes</p>';
        rows.push(
            `<div class="span-row ${statusCls}" style="padding-left:${indent}px" data-id="${i}">` +
                `<div class="span-header" onclick="this.parentElement.classList.toggle('expanded')">` +
                `<span class="span-toggle">▸</span>` +
                `<span class="span-name">${escapeHtml(s.name)}</span>` +
                `<span class="span-dur">${s.durationMs.toFixed(0)} ms</span>` +
                `<span class="span-status">${statusIcon}</span>` +
                `</div>` +
                `<div class="span-details">${attrsHtml}</div>` +
                `</div>`,
        );
    }
    rows.push('</div></div>');

    return rows.join('');
}

export class WxOTraceDetailPanel {
    private static _panel: WxOTraceDetailPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;

    static show(extensionUri: vscode.Uri, filePath: string): void {
        if (WxOTraceDetailPanel._panel) {
            WxOTraceDetailPanel._panel._panel.reveal(vscode.ViewColumn.Beside);
            WxOTraceDetailPanel._panel._load(filePath);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'wxoTraceDetail',
            `Trace: ${path.basename(filePath)}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true },
        );
        WxOTraceDetailPanel._panel = new WxOTraceDetailPanel(panel, extensionUri);
        WxOTraceDetailPanel._panel._load(filePath);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.onDidDispose(() => {
            WxOTraceDetailPanel._panel = undefined;
        });
    }

    private _load(filePath: string): void {
        this._panel.title = `Trace: ${path.basename(filePath)}`;
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const json = JSON.parse(raw);
            const parsed = parseTraceJson(json);
            if (parsed) {
                const html = this._getHtml(renderTraceHtml(parsed));
                this._panel.webview.html = html;
            } else {
                this._panel.webview.html = this._getHtml('<p class="err">Could not parse trace data.</p>');
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._panel.webview.html = this._getHtml(`<p class="err">Error loading trace: ${escapeHtml(msg)}</p>`);
        }
    }

    private _getHtml(body: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trace Detail</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; line-height: 1.5; max-width: 960px; margin: 0 auto; }
    h3 { font-size: 14px; margin: 16px 0 8px 0; color: var(--vscode-foreground); }
    .trace-summary, .trace-conversation, .trace-timeline, .trace-spans { margin-bottom: 24px; }
    .trace-meta { border-collapse: collapse; font-size: 12px; }
    .trace-meta th { text-align: left; padding: 6px 12px 6px 0; color: var(--vscode-descriptionForeground); font-weight: 500; }
    .trace-meta td { padding: 6px 0; }
    .trace-meta code { font-size: 11px; background: var(--vscode-textBlockQuote-background); padding: 2px 6px; border-radius: 4px; }
    .session-id { font-size: 10px; word-break: break-all; }

    /* Insights bar */
    .insights-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; padding: 12px; background: var(--vscode-input-background); border-radius: 8px; }
    .insight-badge { font-size: 11px; padding: 4px 10px; border-radius: 6px; font-weight: 500; }
    .insight-ok { background: rgba(0, 180, 80, 0.2); color: var(--vscode-testing-iconPassed); }
    .insight-error { background: rgba(200, 60, 60, 0.25); color: var(--vscode-errorForeground); }
    .insight-warn { background: rgba(200, 150, 0, 0.2); color: var(--vscode-editorWarning-foreground); }
    .insight-tokens { background: rgba(100, 150, 255, 0.15); color: var(--vscode-charts-blue); }
    .insight-model { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

    /* Conversation - larger, easier to read */
    .trace-block { margin: 12px 0; padding: 14px 16px; background: var(--vscode-input-background); border-radius: 8px; border-left: 4px solid var(--vscode-focusBorder); }
    .trace-block.user { border-left-color: var(--vscode-testing-iconPassed); }
    .trace-block.ai { border-left-color: var(--vscode-charts-blue); }
    .block-label { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
    .block-content { font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }

    /* Gantt timeline */
    .gantt { padding: 8px 0; }
    .gantt-row { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; font-size: 11px; }
    .gantt-row:last-child { margin-bottom: 0; }
    .gantt-name { min-width: 140px; font-family: monospace; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gantt-track { flex: 1; position: relative; height: 22px; background: var(--vscode-input-background); border-radius: 4px; }
    .gantt-bar { position: absolute; top: 2px; height: 18px; min-width: 6px; background: var(--vscode-charts-blue); border-radius: 4px; overflow: hidden; }
    .gantt-bar.gantt-error { background: var(--vscode-errorForeground); }
    .gantt-bar.gantt-slow { background: var(--vscode-editorWarning-foreground); }
    .gantt-label { font-size: 10px; padding: 0 4px; line-height: 18px; color: var(--vscode-foreground); white-space: nowrap; overflow: hidden; }

    /* Expandable span tree */
    .span-hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 0 0 8px 0; }
    .span-tree { border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; }
    .span-row { border-bottom: 1px solid var(--vscode-panel-border); }
    .span-row:last-child { border-bottom: none; }
    .span-row.span-error { background: rgba(200, 60, 60, 0.08); }
    .span-row.span-slow { background: rgba(200, 150, 0, 0.06); }
    .span-header { display: flex; align-items: center; padding: 8px 12px; cursor: pointer; gap: 8px; }
    .span-header:hover { background: var(--vscode-list-hoverBackground); }
    .span-toggle { font-size: 10px; color: var(--vscode-descriptionForeground); transition: transform 0.15s; }
    .span-row.expanded .span-toggle { transform: rotate(90deg); }
    .span-name { flex: 1; font-family: monospace; font-size: 12px; }
    .span-dur { font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 55px; }
    .span-status { font-size: 12px; min-width: 18px; }
    .span-row.span-error .span-status { color: var(--vscode-errorForeground); }
    .span-details { display: none; padding: 12px 16px 12px 32px; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); font-size: 11px; max-height: 300px; overflow-y: auto; }
    .span-row.expanded .span-details { display: block; }
    .attr-row { margin: 8px 0; }
    .attr-row:first-child { margin-top: 0; }
    .attr-key { font-weight: 600; color: var(--vscode-descriptionForeground); display: block; margin-bottom: 4px; }
    .attr-val { margin: 0; padding: 8px; background: var(--vscode-input-background); border-radius: 4px; white-space: pre-wrap; word-break: break-word; font-size: 11px; max-height: 150px; overflow-y: auto; }
    .attr-empty { margin: 0; color: var(--vscode-descriptionForeground); font-style: italic; }

    .err { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
    }
}
