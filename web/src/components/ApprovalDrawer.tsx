/**
 * Pillar 5 — 1-click / passphrase Ed25519 human approval drawer.
 *
 * Displays the exact `subjectHash`, the diff summary, and the QA
 * verdicts (`qa-functional` + `qa-adversarial`), then gates the human
 * decision behind the Ed25519 signing client:
 *
 * - 1-click approval uses an explicit ephemeral authority
 *   (`oneClickAuthority`) — no human secret involved.
 * - Passphrase approval reads the dialog secret from an UNCONTROLLED
 *   password input at submit time, hands it straight to
 *   `approveWithPassphrase` (where it lives only in a lexical closure
 *   and is zeroed in `finally`), then clears the input element.
 *
 * INVARIANT I1: this drawer never stores the secret in React state,
 * `fleet-store`, `localStorage`, `sessionStorage`, or DOM data
 * attributes. The only secret touchpoint is the local `const` inside
 * the submit handler below.
 */
import { useRef, useState } from "react";
import {
  approveOneClick,
  approveWithPassphrase,
  type ApprovalResult,
  type FetchLike,
  type OneClickAuthority,
} from "../security/approval-client.js";
import { buttonStyle, ghostButtonStyle, mutedStyle, palette, panelStyle } from "./theme.js";

export interface QaVerdict {
  suite: "qa-functional" | "qa-adversarial";
  status: "pass" | "fail" | "pending";
  detail: string;
}

export interface ApprovalDrawerProps {
  taskId: string;
  subjectHash: string;
  additions: number;
  deletions: number;
  files: number;
  verdicts: QaVerdict[];
  /** Single-use 60s-TTL preview ticket, or null when no ticket is minted yet. */
  ticket: string | null;
  csrfToken?: string | undefined;
  oneClickAuthority?: OneClickAuthority | null | undefined;
  fetchImpl?: FetchLike | undefined;
  onApproved?: ((result: ApprovalResult) => void) | undefined;
  onRejected?: ((result: ApprovalResult) => void) | undefined;
  onError?: ((message: string) => void) | undefined;
  onClose?: (() => void) | undefined;
}

function verdictColors(status: QaVerdict["status"]): { bg: string; fg: string } {
  if (status === "pass") return { bg: palette.passBg, fg: palette.passText };
  if (status === "fail") return { bg: palette.failBg, fg: palette.failText };
  return { bg: palette.appBg, fg: palette.mutedText };
}

export function ApprovalDrawer(props: ApprovalDrawerProps): JSX.Element {
  const secretInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function failClosed(message: string): void {
    setNotice(message);
    props.onError?.(message);
  }

  async function submit(approve: boolean): Promise<void> {
    if (busy) return;
    if (props.ticket === null || props.ticket.length === 0) {
      failClosed("approval drawer: no preview ticket minted for this task");
      return;
    }
    // The dialog secret is read here into a handler-local const (closure
    // only), never assigned to state, and the input is cleared below.
    const secret: string = secretInput.current?.value ?? "";
    const options = {
      approve,
      csrfToken: props.csrfToken,
      fetchImpl: props.fetchImpl,
    };
    setBusy(true);
    setNotice(null);
    try {
      let result: ApprovalResult;
      if (secret.length > 0) {
        result = await approveWithPassphrase(props.taskId, props.ticket, secret, props.subjectHash, options);
      } else if (props.oneClickAuthority !== undefined && props.oneClickAuthority !== null) {
        result = await approveOneClick(props.taskId, props.ticket, props.subjectHash, props.oneClickAuthority, options);
      } else {
        failClosed("approval drawer: enter the approval secret or provide a 1-click authority");
        return;
      }
      if (approve) {
        props.onApproved?.(result);
      } else {
        props.onRejected?.(result);
      }
      setNotice(approve ? `approved ${result.taskId} → ${result.status}` : `rejected ${result.taskId} → ${result.status}`);
    } catch (err) {
      failClosed(`approval drawer: ${(err as Error).message}`);
    } finally {
      if (secretInput.current !== null) {
        secretInput.current.value = "";
      }
      setBusy(false);
    }
  }

  return (
    <section aria-label="Human approval" data-testid="approval-drawer" style={panelStyle()}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Approval · {props.taskId}</h2>
        {props.onClose !== undefined ? (
          <button type="button" data-testid="approval-close" style={ghostButtonStyle({ marginLeft: "auto" })} onClick={props.onClose}>
            Close
          </button>
        ) : null}
      </header>
      <dl style={{ display: "flex", gap: 16, margin: "0 0 8px 0", fontSize: 13, flexWrap: "wrap" }}>
        <div>
          <dt style={mutedStyle()}>Subject hash</dt>
          <dd data-testid="approval-subject-hash" style={{ margin: 0, fontFamily: "monospace", wordBreak: "break-all" }}>
            {props.subjectHash}
          </dd>
        </div>
        <div>
          <dt style={mutedStyle()}>Diff summary</dt>
          <dd data-testid="approval-diff-summary" style={{ margin: 0 }}>
            {props.files} file{props.files === 1 ? "" : "s"} · +{props.additions} / -{props.deletions}
          </dd>
        </div>
      </dl>
      <div style={{ marginBottom: 8 }}>
        <h3 style={{ fontSize: 13, margin: "0 0 4px 0", color: palette.mutedText }}>QA verdicts</h3>
        <ul data-testid="approval-qa-verdicts" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {props.verdicts.map((verdict) => {
            const colors = verdictColors(verdict.status);
            return (
              <li
                key={verdict.suite}
                data-testid={`qa-verdict-${verdict.suite}`}
                style={{ backgroundColor: colors.bg, color: colors.fg, borderRadius: 6, padding: "4px 8px", fontSize: 13 }}
              >
                <strong>{verdict.suite}</strong>: {verdict.status} — {verdict.detail}
              </li>
            );
          })}
        </ul>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(true);
        }}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <label htmlFor="approval-secret" style={{ fontSize: 13, color: palette.mutedText }}>
          Approval secret (held in closure only, cleared after signing)
        </label>
        <input
          id="approval-secret"
          ref={secretInput}
          type="password"
          autoComplete="off"
          placeholder="Leave empty to use 1-click authority"
          data-testid="approval-secret"
          style={{
            backgroundColor: palette.inputBg,
            color: palette.text,
            border: `1px solid ${palette.panelBorder}`,
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 14,
            minHeight: 24,
          }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="submit" data-testid="approval-approve" disabled={busy} style={buttonStyle()}>
            {busy ? "Signing…" : "Approve & sign"}
          </button>
          <button
            type="button"
            data-testid="approval-reject"
            disabled={busy}
            style={ghostButtonStyle()}
            onClick={() => {
              void submit(false);
            }}
          >
            Reject
          </button>
        </div>
      </form>
      {notice !== null ? (
        <p data-testid="approval-notice" style={{ ...mutedStyle(), marginTop: 8 }}>
          {notice}
        </p>
      ) : null}
    </section>
  );
}
