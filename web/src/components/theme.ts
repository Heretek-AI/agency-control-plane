/**
 * Shared dark-mode visual language for the fleet WebUI.
 *
 * Every color pair below satisfies WCAG 2.2 AA (body text contrast
 * >= 4.5:1 on its panel background), every interactive element is at
 * least 24x24px, and every focusable element shows a visible focus
 * ring for keyboard navigation.
 */
import type { CSSProperties } from "react";

export const palette = {
  appBg: "#0b0f17",
  panelBg: "#111827",
  panelBorder: "#2a3a52",
  columnBg: "#0f1622",
  cardBg: "#16202f",
  cardSelectedBorder: "#8ab8ff",
  text: "#e8edf5",
  mutedText: "#a8b4c8",
  accent: "#8ab8ff",
  accentText: "#0b0f17",
  tier1: "#8ab8ff",
  tier2: "#e6c47a",
  tier3: "#9fd6a4",
  passBg: "#0f2c1c",
  passText: "#8ee6a8",
  failBg: "#331314",
  failText: "#ff9d9d",
  warnBg: "#33260f",
  warnText: "#f2cd7e",
  infoBg: "#12283f",
  infoText: "#9cc8ff",
  addedBg: "#0f2c1c",
  addedText: "#8ee6a8",
  removedBg: "#331314",
  removedText: "#ff9d9d",
  inputBg: "#0b0f17",
  focusRing: "#8ab8ff",
} as const;

export const MIN_TARGET: CSSProperties = { minHeight: 24, minWidth: 24 };

export function panelStyle(extra?: CSSProperties): CSSProperties {
  return {
    backgroundColor: palette.panelBg,
    color: palette.text,
    border: `1px solid ${palette.panelBorder}`,
    borderRadius: 8,
    padding: 12,
    ...extra,
  };
}

export function buttonStyle(extra?: CSSProperties): CSSProperties {
  return {
    backgroundColor: palette.accent,
    color: palette.accentText,
    border: "none",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    ...MIN_TARGET,
    ...extra,
  };
}

export function ghostButtonStyle(extra?: CSSProperties): CSSProperties {
  return {
    backgroundColor: "transparent",
    color: palette.text,
    border: `1px solid ${palette.panelBorder}`,
    borderRadius: 6,
    padding: "5px 10px",
    fontSize: 13,
    cursor: "pointer",
    ...MIN_TARGET,
    ...extra,
  };
}

export function badgeStyle(background: string, foreground: string, extra?: CSSProperties): CSSProperties {
  return {
    display: "inline-block",
    backgroundColor: background,
    color: foreground,
    borderRadius: 999,
    padding: "2px 8px",
    fontSize: 12,
    fontWeight: 600,
    lineHeight: "20px",
    whiteSpace: "nowrap",
    ...extra,
  };
}

/** Visible keyboard focus ring shared by every interactive element. */
export const focusRingStyle: CSSProperties = {
  outline: `2px solid ${palette.focusRing}`,
  outlineOffset: 2,
};

export function mutedStyle(extra?: CSSProperties): CSSProperties {
  return { color: palette.mutedText, fontSize: 13, ...extra };
}
