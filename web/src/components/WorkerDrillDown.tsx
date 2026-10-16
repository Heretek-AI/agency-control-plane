/**
 * Pillar 3 — DAG & worker drill-down SSE inspector.
 *
 * Clicking any Kanban card opens this inspector for the active worker:
 * live SSE tool-call timeline, stage gates, token/cost telemetry with
 * the model-tier badge, the DAG dependency graph, and the Docker
 * Compose profile badge (`core` / `appsec` / `android` / `game` /
 * `research`). Pure rendering over `DrilldownWorker` state — the SSE
 * subscription itself lives in `app.tsx`, events land via
 * `fleet-store.appendToolEvent`.
 */
import type { DagEdge, DrilldownWorker, StageGate } from "../state/fleet-store.js";
import { badgeStyle, ghostButtonStyle, mutedStyle, palette, panelStyle } from "./theme.js";

export interface WorkerDrillDownProps {
  worker: DrilldownWorker | null;
  dagEdges: DagEdge[];
  onClose?: (() => void) | undefined;
}

function gateBadge(gate: StageGate): JSX.Element {
  const mapping = {
    pass: { bg: palette.passBg, fg: palette.passText },
    fail: { bg: palette.failBg, fg: palette.failText },
    running: { bg: palette.infoBg, fg: palette.infoText },
    pending: { bg: palette.appBg, fg: palette.mutedText },
  } as const;
  const colors = mapping[gate.status];
  return (
    <span key={gate.name} style={badgeStyle(colors.bg, colors.fg)} title={`Stage ${gate.name}: ${gate.status}`}>
      {gate.name}: {gate.status}
    </span>
  );
}

export function WorkerDrillDown(props: WorkerDrillDownProps): JSX.Element {
  if (props.worker === null) {
    return (
      <section aria-label="Worker drill-down" data-testid="worker-drilldown-empty" style={panelStyle()}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Worker inspector</h2>
        <p style={mutedStyle()}>Select a task card on the Kanban board to inspect its worker.</p>
      </section>
    );
  }
  const worker = props.worker;
  const related = props.dagEdges.filter((edge) => edge.from === worker.taskId || edge.to === worker.taskId);
  return (
    <section aria-label="Worker drill-down" data-testid="worker-drilldown" style={panelStyle()}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Worker {worker.sessionId}</h2>
        <span style={badgeStyle(palette.infoBg, palette.infoText)} title={`Model tier ${worker.tier}`}>
          {worker.tier}
        </span>
        <span style={badgeStyle(palette.warnBg, palette.warnText)} title={`Docker Compose profile ${worker.profile}`}>
          profile:{worker.profile}
        </span>
        {props.onClose !== undefined ? (
          <button type="button" data-testid="drilldown-close" style={ghostButtonStyle({ marginLeft: "auto" })} onClick={props.onClose}>
            Close
          </button>
        ) : null}
      </header>
      <dl style={{ display: "flex", gap: 16, margin: "0 0 8px 0", fontSize: 13 }}>
        <div>
          <dt style={mutedStyle()}>Task</dt>
          <dd style={{ margin: 0 }}>{worker.taskId}</dd>
        </div>
        <div>
          <dt style={mutedStyle()}>Status</dt>
          <dd style={{ margin: 0 }}>{worker.status}</dd>
        </div>
        <div>
          <dt style={mutedStyle()}>Tokens</dt>
          <dd style={{ margin: 0 }} data-testid="drilldown-tokens">{worker.tokens}</dd>
        </div>
        <div>
          <dt style={mutedStyle()}>Cost</dt>
          <dd style={{ margin: 0 }} data-testid="drilldown-cost">${worker.cost.toFixed(4)}</dd>
        </div>
      </dl>
      <div style={{ marginBottom: 8 }}>
        <h3 style={{ fontSize: 13, margin: "0 0 4px 0", color: palette.mutedText }}>Stage gates</h3>
        <div data-testid="stage-gates" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {worker.stageGates.map((gate) => gateBadge(gate))}
        </div>
      </div>
      <div style={{ marginBottom: 8 }}>
        <h3 style={{ fontSize: 13, margin: "0 0 4px 0", color: palette.mutedText }}>Live tool timeline (SSE)</h3>
        {worker.toolStream.length === 0 ? (
          <p style={mutedStyle()}>No tool calls yet.</p>
        ) : (
          <ol data-testid="tool-timeline" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {worker.toolStream.map((event) => (
              <li key={event.seq} data-testid={`tool-event-${event.seq}`} style={{ backgroundColor: palette.appBg, borderRadius: 6, padding: 6, fontSize: 13 }}>
                <div>
                  <strong>#{event.seq} {event.tool}</strong> <span style={mutedStyle()}>{event.timestamp}</span>
                </div>
                <div style={mutedStyle()}>in: {event.input}</div>
                <div>out: {event.output}</div>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div>
        <h3 style={{ fontSize: 13, margin: "0 0 4px 0", color: palette.mutedText }}>DAG dependencies</h3>
        {related.length === 0 ? (
          <p style={mutedStyle()}>No DAG edges for this task.</p>
        ) : (
          <ul data-testid="dag-graph" style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 13 }}>
            {related.map((edge) => (
              <li key={`${edge.from}->${edge.to}`}>
                <code style={{ fontFamily: "monospace" }}>{edge.from} → {edge.to}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
