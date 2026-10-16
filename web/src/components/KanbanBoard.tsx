/**
 * Pillar 1 — 5-column worktree Kanban board.
 *
 * Renders `Backlog`, `Ready`, `In Progress`, `Waiting Approval / QA`,
 * and `Done` with one task card per task: title, worktree branch badge
 * (`fleet/task-101`), owned-path chips, and the model-tier indicator.
 * Clicking a card drills down into the worker inspector (Pillar 3) via
 * `onSelectTask`. Cards are real `<button>` elements (>= 24px targets,
 * keyboard-focusable with visible focus rings).
 */
import type { CSSProperties } from "react";
import { BOARD_COLUMNS, tasksInColumn, type BoardColumn, type ModelTier, type TaskCard } from "../state/fleet-store.js";
import { badgeStyle, ghostButtonStyle, mutedStyle, palette } from "./theme.js";

export interface KanbanBoardProps {
  tasks: TaskCard[];
  activeTier: ModelTier;
  columns?: readonly BoardColumn[] | undefined;
  selectedTaskId?: string | null | undefined;
  onSelectTask?: ((taskId: string) => void) | undefined;
}

function tierBadge(tier: ModelTier): CSSProperties {
  const background = tier === "tier-1-opencode" ? palette.infoBg : tier === "tier-2-commercial" ? palette.warnBg : palette.passBg;
  const foreground = tier === "tier-1-opencode" ? palette.infoText : tier === "tier-2-commercial" ? palette.warnText : palette.passText;
  return badgeStyle(background, foreground, { border: `1px solid ${palette.panelBorder}` });
}

function tierShortName(tier: ModelTier): string {
  if (tier === "tier-1-opencode") return "tier-1";
  if (tier === "tier-2-commercial") return "tier-2";
  return "tier-3";
}

export function KanbanBoard(props: KanbanBoardProps): JSX.Element {
  const columns = props.columns ?? BOARD_COLUMNS;
  const state = {
    tasks: props.tasks,
    dagNodes: [],
    dagEdges: [],
    drilldown: null,
    diffs: {},
    activeTier: props.activeTier,
  };
  return (
    <section aria-label="Fleet Kanban board" style={{ backgroundColor: palette.appBg, color: palette.text, padding: 12 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Fleet Kanban</h2>
        <span style={badgeStyle(palette.infoBg, palette.infoText)} title={`Active model tier: ${props.activeTier}`}>
          active {tierShortName(props.activeTier)}
        </span>
      </header>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8 }}>
        {columns.map((column) => {
          const cards = tasksInColumn(state, column);
          return (
            <div
              key={column}
              data-testid={`column-${column}`}
              style={{ backgroundColor: palette.columnBg, border: `1px solid ${palette.panelBorder}`, borderRadius: 8, padding: 8 }}
            >
              <h3 style={{ fontSize: 13, margin: "0 0 8px 0", color: palette.mutedText }}>
                {column} <span aria-label={`${cards.length} cards`}>({cards.length})</span>
              </h3>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {cards.length === 0 ? (
                  <li style={mutedStyle()}>No cards</li>
                ) : (
                  cards.map((card) => {
                    const selected = props.selectedTaskId === card.id;
                    return (
                      <li key={card.id}>
                        <button
                          type="button"
                          data-testid={`card-${card.id}`}
                          aria-pressed={selected ? "true" : "false"}
                          onClick={() => props.onSelectTask?.(card.id)}
                          style={{
                            ...ghostButtonStyle(),
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            backgroundColor: palette.cardBg,
                            border: selected ? `2px solid ${palette.cardSelectedBorder}` : `1px solid ${palette.panelBorder}`,
                            padding: 8,
                          }}
                        >
                          <span style={{ display: "block", fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{card.title}</span>
                          <span style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
                            <span style={badgeStyle(palette.infoBg, palette.infoText)} title={`Worktree branch ${card.branch}`}>
                              {card.branch}
                            </span>
                            <span style={tierBadge(card.tier)} title={`Model tier ${card.tier}`}>
                              {tierShortName(card.tier)}
                            </span>
                          </span>
                          <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {card.ownedPaths.map((path) => (
                              <code
                                key={path}
                                style={{ ...mutedStyle(), fontFamily: "monospace", backgroundColor: palette.appBg, padding: "1px 6px", borderRadius: 4 }}
                              >
                                {path}
                              </code>
                            ))}
                          </span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
