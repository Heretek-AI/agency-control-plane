/**
 * Pillar 2 — persistent dockable Director chat sidebar.
 *
 * Conversation with the Director: a long-lived OpenCode session on the
 * dispatcher (agent `director`). Free-form messages go to the Director,
 * whose reply arrives over SSE; it creates task cards only through a
 * validated ```tasks block (cards it created are listed under its reply).
 * `/ship <spec>` is the explicit manual fallback: the charter preview
 * shows the bullet decomposition and 1-click injection creates exactly
 * those cards via the dispatcher. The sidebar stays mounted (dockable
 * left/right via the `dock` prop) so steering context is never lost.
 */
import { useState } from "react";
import { buttonStyle, ghostButtonStyle, mutedStyle, palette, panelStyle } from "./theme.js";

export interface DirectorMessageView {
  seq: number;
  author: string;
  text: string;
  timestamp: string;
  tasksCreated?: string[] | undefined;
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

/** Text of a markdown bullet line (`- x`, `* x`, `1. x`), or null. Linear scan; mirrors the dispatcher. */
export function bulletText(line: string): string | null {
  const trimmed = line.trim();
  let rest: string | null = null;
  if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
    rest = trimmed.slice(2);
  } else {
    let digits = 0;
    while (digits < trimmed.length && trimmed.charCodeAt(digits) >= 48 && trimmed.charCodeAt(digits) <= 57) digits += 1;
    if (digits > 0 && trimmed[digits] === "." && (trimmed[digits + 1] === " " || trimmed[digits + 1] === "\t")) {
      rest = trimmed.slice(digits + 2);
    }
  }
  if (rest === null) return null;
  const text = rest.trim();
  return text.length > 0 ? text : null;
}

/** Decompose a charter spec into candidate task titles (bullets, else first line). */
export function decomposeCharter(spec: string): string[] {
  const titles: string[] = [];
  for (const line of spec.split("\n")) {
    const bullet = bulletText(line);
    if (bullet !== null) titles.push(bullet);
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
              {message.tasksCreated !== undefined && message.tasksCreated.length > 0 ? (
                <div data-testid={`director-cards-${message.seq}`} style={{ ...mutedStyle(), marginTop: 4 }}>
                  cards: {message.tasksCreated.join(", ")}
                </div>
              ) : null}
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
