/**
 * Pillar 5 — passphrase / key-file Ed25519 human approval drawer.
 *
 * Shows the server-computed `subjectHash` (and whether it matches the
 * diff on screen), the diff summary, the QA verdicts (`qa-functional` +
 * `qa-adversarial`), and the pinned human key fingerprint, then gates the
 * decision behind `approveWithKeyFile`:
 *
 * - the human picks their key file (`human.key.enc` sealed envelope, or a
 *   PKCS#8 private key) in an UNCONTROLLED file input and types the
 *   passphrase into an UNCONTROLLED password input;
 * - at submit time both are read into handler-local consts and handed
 *   straight to the signing client (which zeroes the bytes), and both
 *   inputs are cleared in `finally`.
 *
 * INVARIANT I1: this drawer never stores the passphrase or key bytes in
 * React state, `fleet-store`, `localStorage`, `sessionStorage`, or DOM
 * data attributes.
 */
import { useRef, useState } from "react";
import {
  approveWithKeyFile,
  type ApprovalResult,
  type ApprovalTicketView,
  type FetchLike,
} from "../security/approval-client.js";
import { buttonStyle, ghostButtonStyle, mutedStyle, palette, panelStyle } from "./theme.js";

export interface QaVerdict {
  suite: "qa-functional" | "qa-adversarial";
  status: "pass" | "fail" | "pending";
  detail: string;
}

export interface ApprovalDrawerProps {
  taskId: string;
  /** Subject hash the UI computed from the diff it displays (null while loading). */
  displayedSubjectHash: string | null;
  additions: number;
  deletions: number;
  files: number;
  verdicts: QaVerdict[];
  /** Single-use 60s-TTL ticket minted by the dispatcher, or null when none is minted yet. */
  ticket: ApprovalTicketView | null;
  /** Why approvals are unavailable (e.g. no pinned key), when known. */
  unavailableReason?: string | null | undefined;
  csrfToken?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  onMintTicket?: (() => void) | undefined;
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
  const keyFileInput = useRef<HTMLInputElement | null>(null);
  const secretInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ticket = props.ticket;
  const subjectHash = ticket?.subjectHash ?? props.displayedSubjectHash ?? "";
  const matches = ticket !== null && props.displayedSubjectHash !== null && ticket.subjectHash === props.displayedSubjectHash;

  function failClosed(message: string): void {
    setNotice(message);
    props.onError?.(message);
  }

  async function submit(approve: boolean): Promise<void> {
    if (busy) return;
    if (ticket === null) {
      failClosed("approval drawer: mint a preview ticket first");
      return;
    }
    const file = keyFileInput.current?.files?.[0];
    if (file === undefined) {
      failClosed("approval drawer: choose your human key file (human.key.enc or a PKCS#8 key)");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      // Handler-local only: read at submit time, consumed and zeroed by the signing client.
      const keyBytes = new Uint8Array(await file.arrayBuffer());
      const secret: string = secretInput.current?.value ?? "";
      const result = await approveWithKeyFile(props.taskId, ticket, keyBytes, secret, {
        approve,
        csrfToken: props.csrfToken,
        fetchImpl: props.fetchImpl,
        expectedSubjectHash: props.displayedSubjectHash ?? undefined,
      });
      if (approve) {
        props.onApproved?.(result);
      } else {
        props.onRejected?.(result);
      }
      setNotice(approve ? `approved ${result.taskId} → ${result.status}` : `rejected ${result.taskId} → ${result.status}`);
    } catch (err) {
      failClosed(`approval drawer: ${(err as Error).message}`);
    } finally {
      if (secretInput.current !== null) secretInput.current.value = "";
      if (keyFileInput.current !== null) keyFileInput.current.value = "";
      setBusy(false);
    }
  }

  const inputStyle = {
    backgroundColor: palette.inputBg,
    color: palette.text,
    border: `1px solid ${palette.panelBorder}`,
    borderRadius: 6,
    padding: "6px 8px",
    fontSize: 14,
    minHeight: 24,
  } as const;

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
            {subjectHash.length > 0 ? subjectHash : "—"}
          </dd>
          {ticket !== null ? (
            <dd data-testid="approval-subject-match" style={{ margin: 0, color: matches ? palette.passText : palette.failText }}>
              {matches ? "matches the diff shown" : "does NOT match the diff shown — do not sign"}
            </dd>
          ) : null}
        </div>
        <div>
          <dt style={mutedStyle()}>Diff summary</dt>
          <dd data-testid="approval-diff-summary" style={{ margin: 0 }}>
            {props.files} file{props.files === 1 ? "" : "s"} · +{props.additions} / -{props.deletions}
          </dd>
        </div>
        {ticket !== null ? (
          <div>
            <dt style={mutedStyle()}>Pinned human key</dt>
            <dd data-testid="approval-key-fingerprint" style={{ margin: 0, fontFamily: "monospace" }}>
              {ticket.keyFingerprint.slice(0, 16)}…
            </dd>
          </div>
        ) : null}
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
      {props.unavailableReason !== undefined && props.unavailableReason !== null ? (
        <p role="alert" data-testid="approval-unavailable" style={{ color: palette.failText, margin: "0 0 8px 0", fontSize: 13 }}>
          Approvals unavailable: {props.unavailableReason}
        </p>
      ) : null}
      {ticket === null ? (
        <button type="button" data-testid="app-mint-ticket" style={ghostButtonStyle()} disabled={props.onMintTicket === undefined} onClick={() => props.onMintTicket?.()}>
          Mint approval ticket
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(true);
          }}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <label htmlFor="approval-key-file" style={{ fontSize: 13, color: palette.mutedText }}>
            Human key file (human.key.enc or PKCS#8 private key; read only while signing)
          </label>
          <input id="approval-key-file" ref={keyFileInput} type="file" data-testid="approval-key-file" style={inputStyle} />
          <label htmlFor="approval-secret" style={{ fontSize: 13, color: palette.mutedText }}>
            Key passphrase (held in closure only, cleared after signing)
          </label>
          <input
            id="approval-secret"
            ref={secretInput}
            type="password"
            autoComplete="off"
            placeholder="Passphrase for human.key.enc"
            data-testid="approval-secret"
            style={inputStyle}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="submit" data-testid="approval-approve" disabled={busy || !matches} style={buttonStyle()}>
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
              Reject & sign
            </button>
          </div>
        </form>
      )}
      {notice !== null ? (
        <p data-testid="approval-notice" style={{ ...mutedStyle(), marginTop: 8 }}>
          {notice}
        </p>
      ) : null}
    </section>
  );
}
