/**
 * Pillar 2 — persistent dockable Director chat sidebar.
 *
 * Conversation with the Top-Level Director Agent (`director`): an
 * append-only message list plus a compose box. Messages starting with
 * `/ship <spec>` open a mission charter preview with a 1-click DAG
 * injection button that decomposes the spec into task cards on the
 * Kanban board via `onInjectDag`. The sidebar stays mounted (dockable
 * left/right via the `dock` prop) so steering context is never lost.
 */
import { useState } from "react";
import { buttonStyle, ghostButtonStyle, mutedStyle, palette, panelStyle } from "./theme.js";

export interface DirectorMessageView {
  seq: number;
  author: string;
  text: string;
  timestamp: string;
}

export interface DirectorChatProps {
  messages: DirectorMessageView[];
  dock?: "left" | "right" | undefined;
  charterPreview?: string | null | undefined;
  onSend?: ((message: string) => void) | undefined;
  onInjectDag?: ((spec: string) => void) | undefined;
}

export const SHIP_COMMAND = "/ship";

/** Extract the mission spec from a `/ship <spec>` command, or null. */
export function parseShipCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(`${SHIP_COMMAND} `) && trimmed !== SHIP_COMMAND) {
    return null;
  }
  const spec = trimmed.slice(SHIP_COMMAND.length).trim();
  return spec.length > 0 ? spec : null;
}

/** Decompose a charter spec into candidate task titles (bullets, else first line). */
export function decomposeCharter(spec: string): string[] {
  const titles: string[] = [];
  for (const line of spec.split("\n")) {
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/.exec(line);
    if (bullet !== null && bullet[1] !== undefined && bullet[1].length > 0) {
      titles.push(bullet[1]);
    }
  }
  if (titles.length > 0) return titles;
  const first = spec.split("\n")[0]?.trim() ?? "";
  return first.length > 0 ? [first.length > 80 ? `${first.slice(0, 77)}...` : first] : [];
}

export function DirectorChat(props: DirectorChatProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const dock = props.dock ?? "right";
  const pendingSpec = parseShipCommand(draft);
  const previewSpec = props.charterPreview ?? pendingSpec;
  const previewTasks = previewSpec === null || previewSpec === undefined ? [] : decomposeCharter(previewSpec);

  function submit(): void {
    const message = draft.trim();
    if (message.length === 0) return;
    props.onSend?.(message);
    setDraft("");
  }

  return (
    <aside
      aria-label="Director chat"
      data-testid="director-chat"
      data-dock={dock}
      style={{
        ...panelStyle(),
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 320,
        borderLeft: dock === "right" ? `1px solid ${palette.panelBorder}` : undefined,
        borderRight: dock === "left" ? `1px solid ${palette.panelBorder}` : undefined,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Director</h2>
        <span style={mutedStyle()}>docked {dock}</span>
      </header>
      <ol data-testid="director-messages" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", flex: 1 }}>
        {props.messages.length === 0 ? (
          <li style={mutedStyle()}>No steering messages yet. Try “{SHIP_COMMAND} &lt;mission spec&gt;”.</li>
        ) : (
          props.messages.map((message) => (
            <li key={message.seq} data-testid={`director-message-${message.seq}`} style={{ backgroundColor: palette.appBg, borderRadius: 6, padding: 6 }}>
              <div style={{ ...mutedStyle(), marginBottom: 2 }}>
                <strong style={{ color: palette.text }}>{message.author}</strong> · {message.timestamp}
              </div>
              <div style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{message.text}</div>
            </li>
          ))
        )}
      </ol>
      {previewSpec !== null && previewSpec !== undefined ? (
        <div data-testid="charter-preview" style={{ backgroundColor: palette.infoBg, borderRadius: 6, padding: 8 }}>
          <h3 style={{ fontSize: 13, margin: "0 0 4px 0", color: palette.infoText }}>Mission charter preview</h3>
          <p style={{ fontSize: 13, margin: "0 0 4px 0", whiteSpace: "pre-wrap" }}>{previewSpec}</p>
          <ul style={{ margin: "0 0 8px 16px", padding: 0, fontSize: 13 }}>
            {previewTasks.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
          <button type="button" data-testid="inject-dag" style={buttonStyle()} onClick={() => props.onInjectDag?.(previewSpec)}>
            Inject DAG onto board
          </button>
        </div>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <label htmlFor="director-compose" style={{ position: "absolute", left: -10000, width: 1, height: 1, overflow: "hidden" }}>
          Message the Director
        </label>
        <input
          id="director-compose"
          data-testid="director-compose"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`${SHIP_COMMAND} <mission spec> or steering note`}
          style={{
            flex: 1,
            backgroundColor: palette.inputBg,
            color: palette.text,
            border: `1px solid ${palette.panelBorder}`,
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 14,
            minHeight: 24,
          }}
        />
        <button type="submit" data-testid="director-send" style={ghostButtonStyle()}>
          Send
        </button>
      </form>
    </aside>
  );
}
