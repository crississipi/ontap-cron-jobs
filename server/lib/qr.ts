// ──────────────────────────────────────────────────────────────
// QR Code Generator — Branded SVG Output
// ──────────────────────────────────────────────────────────────
// Generates a styled QR code that encodes a URL and returns it
// as a base64-encoded SVG data URL suitable for:
//   • Direct use in <img src="..." />
//   • Storing in the database as a TEXT field
//   • Embedding in API JSON responses
//
// Style (matches brand / reference design):
//   • Dark modules:    #1a1a2e  (brand navy)
//   • Background:      #ffffff
//   • Module shape:    rounded rectangles (rx = 30% of module size)
//   • Finder patterns: three nested rounded squares (outer ring,
//                      white clearing, inner dot) — distinctly styled
//                      so QR scanners can orient the code reliably
//   • Card border:     16px rounded corners on the SVG background
//
// Why SVG (not PNG)?
//   SVG is resolution-independent, so the frontend can display it
//   at any size without blurring. It's also smaller than a PNG for
//   the same visual output (~25–40 KB base64 vs ~15–50 KB for PNG
//   at display resolution), and needs no image codec on the server.
//
// Error correction level: M (15% recovery) — good balance between
// data density and damage tolerance for URL payloads.
// ──────────────────────────────────────────────────────────────

// ── Matrix API ─────────────────────────────────────────────────
// qrcode's public API exports `create(data, options)`, which
// returns a QR symbol whose `.modules` property is a BitMatrix:
//   • modules.size  — grid width/height in modules
//   • modules.get(row, col) — raw byte; non-zero means dark

/* eslint-disable @typescript-eslint/no-require-imports */
interface QRCoreModule {
  create(
    data: string,
    options: { errorCorrectionLevel: "L" | "M" | "Q" | "H" }
  ): {
    modules: {
      size: number;
      get(row: number, col: number): number;
    };
  };
}
const qrcore = require("qrcode") as QRCoreModule;
/* eslint-enable @typescript-eslint/no-require-imports */

// ── Render constants ───────────────────────────────────────────
const DARK_COLOR  = "#1a1a2e"; // Brand navy — matches email template + UI palette
const LIGHT_COLOR = "#ffffff";
const MODULE_PX   = 8;         // Pixels per QR module (vector units — SVG scales freely)
const QUIET_ZONE  = 3;         // Modules of white space around the code (standard: 4)
const DOT_RADIUS  = 0.30;      // Rounded corner radius as fraction of MODULE_PX
const CARD_RADIUS = 10;        // Overall card background corner radius (px)

// ── Finder pattern skipping ────────────────────────────────────
// The three finder pattern regions occupy fixed 7×7 blocks in the
// top-left, top-right, and bottom-left corners of every QR code.
// We skip those positions in the main module loop and render them
// separately with a distinct three-ring visual style so scanners
// can locate and orient the code.
function isFinderRegion(row: number, col: number, size: number): boolean {
  const inTL = row < 8 && col < 8;               // top-left     (0-7, 0-7)
  const inTR = row < 8 && col >= size - 8;        // top-right    (0-7, n-8 to n-1)
  const inBL = row >= size - 8 && col < 8;        // bottom-left  (n-8 to n-1, 0-7)
  return inTL || inTR || inBL;
}

// ── Finder pattern SVG renderer ────────────────────────────────
// Each corner draws three concentric rounded squares:
//   7×7 dark outer ring → 5×5 white clearing → 3×3 dark inner dot
function renderFinderPatterns(size: number, px: number, margin: number): string {
  const outerR = px * 1.0;        // outer ring corner radius
  const clearR = px * 0.7;        // clearing square corner radius
  const dotR   = px * 0.9;        // inner dot corner radius

  const corners = [
    { row: 0,        col: 0        }, // top-left
    { row: 0,        col: size - 7 }, // top-right
    { row: size - 7, col: 0        }, // bottom-left
  ];

  return corners
    .map(({ row, col }) => {
      const x = (col + margin) * px;
      const y = (row + margin) * px;
      return [
        // 7×7 dark outer square
        `<rect x="${x}" y="${y}" width="${7 * px}" height="${7 * px}" rx="${outerR}" ry="${outerR}" fill="${DARK_COLOR}"/>`,
        // 5×5 white clearing (1-module inset on each side)
        `<rect x="${x + px}" y="${y + px}" width="${5 * px}" height="${5 * px}" rx="${clearR}" ry="${clearR}" fill="${LIGHT_COLOR}"/>`,
        // 3×3 dark inner dot (2-module inset on each side)
        `<rect x="${x + 2 * px}" y="${y + 2 * px}" width="${3 * px}" height="${3 * px}" rx="${dotR}" ry="${dotR}" fill="${DARK_COLOR}"/>`,
      ].join("\n");
    })
    .join("\n");
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Generate a branded QR code that encodes `text` and return it as a
 * base64 SVG data URL (`data:image/svg+xml;base64,...`).
 *
 * The returned string can be used directly as:
 *   • `<img src={qrCode} />`  — React / Next.js frontend
 *   • `<img src="..." />`     — plain HTML
 *   • stored in a DB TEXT column for later retrieval
 *
 * Returns `null` if generation fails (e.g., text is too long for a
 * QR code, or the qrcode library throws). Callers should treat null
 * as a soft failure and not block the primary operation.
 *
 * @param text - Content to encode. Should be a full HTTPS URL.
 */
export function generateQRCodeDataUrl(text: string): string | null {
  try {
    // Build the QR module matrix at error correction level M.
    // Level M recovers up to 15% damaged codewords — a good balance
    // between data density (shorter URL → smaller QR) and resilience.
    const qr      = qrcore.create(text, { errorCorrectionLevel: "M" });
    const { size } = qr.modules;

    const px     = MODULE_PX;
    const margin = QUIET_ZONE;
    const total  = (size + margin * 2) * px;
    const rx     = Math.round(px * DOT_RADIUS); // module corner radius

    // Build data module rectangles (skip finder pattern regions)
    let dataRects = "";
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (isFinderRegion(row, col, size)) continue;
        if (!qr.modules.get(row, col)) continue;         // light module — skip

        const x = (col + margin) * px;
        const y = (row + margin) * px;
        dataRects += `<rect x="${x}" y="${y}" width="${px}" height="${px}" rx="${rx}" ry="${rx}" fill="${DARK_COLOR}"/>`;
      }
    }

    // Render the three finder pattern corners separately
    const finderRects = renderFinderPatterns(size, px, margin);

    // Assemble the final SVG:
    //   1. White card background with rounded corners
    //   2. Styled finder patterns (top-left, top-right, bottom-left)
    //   3. Data modules as rounded rectangles
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}">`,
      `  <rect width="${total}" height="${total}" rx="${CARD_RADIUS}" ry="${CARD_RADIUS}" fill="${LIGHT_COLOR}"/>`,
      finderRects,
      dataRects,
      `</svg>`,
    ].join("\n");

    // Encode as base64 → safe for JSON serialization and <img src> usage.
    // Using Buffer (available in Node.js / Bun) to avoid btoa's Unicode issues.
    const b64 = Buffer.from(svg, "utf-8").toString("base64");
    return `data:image/svg+xml;base64,${b64}`;
  } catch {
    // Never let QR generation crash the caller — return null and let
    // the caller decide how to handle the absence of a QR code.
    return null;
  }
}

/**
 * Build the canonical public portfolio URL for a given custom URI.
 *
 * Uses NEXT_PUBLIC_APP_URL (set in Vercel env vars) as the base.
 * Falls back to Vercel's auto-set deployment URL for non-production
 * environments (prefixed with https://).
 *
 * Returns `null` if no app URL is configured — in that case QR
 * generation should be skipped to avoid encoding a broken URL.
 *
 * @param customUri - The user's chosen slug (e.g. "johndoe")
 */
function resolvePublicAppBaseUrl(): string | null {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.APP_URL,
    process.env.FRONTEND_URL,
    process.env.BACKEND_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname === "0.0.0.0") continue;
      return parsed.origin.replace(/\/$/, "");
    } catch {
      return trimmed.replace(/\/$/, "");
    }
  }

  return null;
}

export function buildVCardPublicUrl(customUri: string): string | null {
  const base = resolvePublicAppBaseUrl();
  if (!base) return null;

  // Portfolio URLs follow the pattern: https://www.portal.ontap.ph/{customUri}
  // e.g. https://www.portal.ontap.ph/johndoe
  return `${base}/${encodeURIComponent(customUri)}`;
}
