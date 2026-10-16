/**
 * Pillar 4 — side-by-side / unified Git diff viewer.
 *
 * Renders per-file diffs (`DiffHunk[]`) with a file-tree navigator,
 * addition/deletion counters, and syntax-tinted hunk lines (added
 * green, removed red, hunk headers blue). The `mode` toggle switches
 * between side-by-side (added-left / removed-right columns) and
 * unified (single interleaved column) rendering. File selection is a
 * controlled prop (`selectedFile` + `onSelectFile`); all interactive
 * targets are >= 24px with visible focus rings.
 */
import { useState } from "react";
import type { DiffHunk } from "../state/fleet-store.js";
import { badgeStyle, ghostButtonStyle, mutedStyle, palette, panelStyle } from "./theme.js";

export type DiffViewMode = "side-by-side" | "unified";

export interface SplitDiffViewerProps {
  hunks: DiffHunk[];
  selectedFile?: string | null | undefined;
  initialMode?: DiffViewMode | undefined;
  onSelectFile?: ((file: string) => void) | undefined;
}

export interface DiffLine {
  kind: "context" | "added" | "removed" | "header" | "marker";
  text: string;
}

/** Split a unified patch body into classified display lines. */
export function parsePatchLines(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      lines.push({ kind: "header", text: raw });
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      lines.push({ kind: "added", text: raw });
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      lines.push({ kind: "removed", text: raw });
    } else if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("---") || raw.startsWith("+++")) {
      lines.push({ kind: "marker", text: raw });
    } else {
      lines.push({ kind: "context", text: raw });
    }
  }
  return lines;
}

/** Aggregate addition/deletion counters across all hunks. */
export function diffTotals(hunks: DiffHunk[]): { additions: number; deletions: number; files: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    additions += hunk.additions;
    deletions += hunk.deletions;
  }
  return { additions, deletions, files: hunks.length };
}

function lineStyle(kind: DiffLine["kind"]): { backgroundColor: string; color: string } {
  if (kind === "added") return { backgroundColor: palette.addedBg, color: palette.addedText };
  if (kind === "removed") return { backgroundColor: palette.removedBg, color: palette.removedText };
  if (kind === "header") return { backgroundColor: palette.infoBg, color: palette.infoText };
  return { backgroundColor: "transparent", color: palette.text };
}

function statusLabel(status: DiffHunk["status"]): string {
  if (status === "added") return "added";
  if (status === "deleted") return "deleted";
  if (status === "renamed") return "renamed";
  return "modified";
}

export function SplitDiffViewer(props: SplitDiffViewerProps): JSX.Element {
  const [mode, setMode] = useState<DiffViewMode>(props.initialMode ?? "side-by-side");
  const totals = diffTotals(props.hunks);
  const activeFile = props.selectedFile ?? props.hunks[0]?.file ?? null;
  const active = props.hunks.find((hunk) => hunk.file === activeFile) ?? props.hunks[0] ?? null;
  const lines = active === null ? [] : parsePatchLines(active.patch);
  const left = lines.filter((line) => line.kind !== "added");
  const right = lines.filter((line) => line.kind !== "removed");

  function renderLine(line: DiffLine, key: string): JSX.Element {
    const colors = lineStyle(line.kind);
    return (
      <div
        key={key}
        data-testid={`diff-line-${line.kind}`}
        style={{ ...colors, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap", padding: "1px 8px" }}
      >
        {line.text.length === 0 ? " " : line.text}
      </div>
    );
  }

  return (
    <section aria-label="Diff viewer" data-testid="diff-viewer" style={panelStyle()}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Diff</h2>
        <span style={badgeStyle(palette.passBg, palette.passText)} title={`${totals.additions} additions`}>
          +{totals.additions}
        </span>
        <span style={badgeStyle(palette.failBg, palette.failText)} title={`${totals.deletions} deletions`}>
          -{totals.deletions}
        </span>
        <span style={mutedStyle()} data-testid="diff-file-count">
          {totals.files} file{totals.files === 1 ? "" : "s"}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }} role="group" aria-label="Diff view mode">
          <button
            type="button"
            data-testid="diff-mode-side-by-side"
            aria-pressed={mode === "side-by-side" ? "true" : "false"}
            style={ghostButtonStyle()}
            onClick={() => setMode("side-by-side")}
          >
            Side-by-side
          </button>
          <button
            type="button"
            data-testid="diff-mode-unified"
            aria-pressed={mode === "unified" ? "true" : "false"}
            style={ghostButtonStyle()}
            onClick={() => setMode("unified")}
          >
            Unified
          </button>
        </span>
      </header>
      {props.hunks.length === 0 ? (
        <p style={mutedStyle()}>No diffs for this task yet.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 240px) 1fr", gap: 8 }}>
          <nav aria-label="Changed files" style={{ backgroundColor: palette.appBg, borderRadius: 6, padding: 6 }}>
            <ul data-testid="diff-file-tree" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              {props.hunks.map((hunk) => {
                const selected = hunk.file === active?.file;
                return (
                  <li key={hunk.file}>
                    <button
                      type="button"
                      data-testid={`diff-file-${hunk.file}`}
                      aria-pressed={selected ? "true" : "false"}
                      style={{
                        ...ghostButtonStyle(),
                        display: "flex",
                        width: "100%",
                        justifyContent: "space-between",
                        gap: 8,
                        textAlign: "left",
                        border: selected ? `2px solid ${palette.cardSelectedBorder}` : `1px solid ${palette.panelBorder}`,
                        fontFamily: "monospace",
                        fontSize: 12,
                      }}
                      onClick={() => props.onSelectFile?.(hunk.file)}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                        {hunk.file} <span style={mutedStyle()}>({statusLabel(hunk.status)})</span>
                      </span>
                      <span style={{ whiteSpace: "nowrap" }}>
                        <span style={{ color: palette.addedText }}>+{hunk.additions}</span>{" "}
                        <span style={{ color: palette.removedText }}>-{hunk.deletions}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div data-testid={`diff-view-${mode}`} style={{ backgroundColor: palette.appBg, borderRadius: 6, padding: 6, overflowX: "auto" }}>
            {active === null ? (
              <p style={mutedStyle()}>Select a file.</p>
            ) : mode === "unified" ? (
              <div>{lines.map((line, index) => renderLine(line, `u-${index}`))}</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                <div data-testid="diff-pane-removed">{left.map((line, index) => renderLine(line, `l-${index}`))}</div>
                <div data-testid="diff-pane-added">{right.map((line, index) => renderLine(line, `r-${index}`))}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
