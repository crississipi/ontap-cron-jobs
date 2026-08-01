import sharp from "sharp";

export interface VcfAddress {
  area?: string | null;
  city?: string | null;
  region?: string | null;
  zipcode?: string | null;
  country?: string | null;
}

export type VcfSocialLink =
  | string
  | {
      platform?: string | null;
      url?: string | null;
    };

export interface VcfPayload {
  firstName?: string | null;
  lastName?: string | null;
  middleName?: string | null;
  fullName?: string | null;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  altPhone?: string | null;
  email?: string | null;
  altEmail?: string | null;
  website?: string | null;
  profileUrl?: string | null;
  portfolioUrl?: string | null;
  address?: VcfAddress | null;
  socialLinks?: VcfSocialLink[];
}

type EmbeddedPhoto = {
  base64: string;
  type: string;
};

const PHOTO_FETCH_TIMEOUT_MS = 8000;
/** Reject source downloads larger than this before decompress/re-encode. */
const PHOTO_MAX_BYTES = 700 * 1024;
/**
 * Hard cap for the JPEG bytes embedded in the .vcf (base64 expands ~33%).
 * Contact apps often fail or truncate oversized PHOTO fields — keep this small.
 */
const PHOTO_EMBED_MAX_BYTES = 28 * 1024;
/** Contact thumbnails are tiny; 160px is enough for phone address books. */
const PHOTO_MAX_DIMENSION = 160;

function clean(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Strip CR/LF to prevent line injection in VCF content.
  return trimmed.replace(/[\r\n]+/g, " ");
}

function escapeVcf(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function pushLine(lines: string[], key: string, value?: string | null): void {
  const cleaned = clean(value);
  if (!cleaned) return;
  lines.push(`${key}:${escapeVcf(cleaned)}`);
}

function foldVcfLine(line: string): string {
  const maxBytes = 75;
  const segments: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of line) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > maxBytes) {
      segments.push(current);
      current = char;
      currentBytes = charBytes;
      continue;
    }
    current += char;
    currentBytes += charBytes;
  }

  if (current) segments.push(current);
  return segments.map((segment, index) => (index === 0 ? segment : ` ${segment}`)).join("\r\n");
}

function normalizePhotoUrl(raw?: string | null): string | null {
  const value = clean(raw);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchEmbeddedPhoto(profileUrl?: string | null): Promise<EmbeddedPhoto | null> {
  const photoUrl = normalizePhotoUrl(profileUrl);
  if (!photoUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHOTO_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(photoUrl, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "image/*",
      },
    });

    if (!response.ok) return null;

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > PHOTO_MAX_BYTES) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > PHOTO_MAX_BYTES) return null;

    // Only embed a compressed JPEG. Never fall back to the raw download —
    // large originals blow past contact-app VCF size limits.
    const compressed = await compressPhotoForVcf(bytes);
    if (!compressed) return null;

    return {
      type: "JPEG",
      base64: compressed.toString("base64"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function compressPhotoForVcf(bytes: Buffer): Promise<Buffer | null> {
  try {
    const createPipeline = (dimension: number) =>
      sharp(bytes, { limitInputPixels: 4096 * 4096 })
        .rotate()
        .resize(dimension, dimension, {
          fit: "cover",
          position: "centre",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" });

    const jpegOpts = (quality: number) =>
      ({
        quality,
        mozjpeg: true,
        progressive: false,
        chromaSubsampling: "4:2:0" as const,
        trellisQuantisation: true,
        overshootDeringing: true,
        optimiseScans: true,
      });

    // Steep ladder: prefer small contact-safe JPEGs over visual fidelity.
    const attempts: Array<{ dimension: number; quality: number }> = [
      { dimension: PHOTO_MAX_DIMENSION, quality: 55 },
      { dimension: PHOTO_MAX_DIMENSION, quality: 42 },
      { dimension: 128, quality: 40 },
      { dimension: 128, quality: 32 },
      { dimension: 96, quality: 30 },
      { dimension: 80, quality: 28 },
    ];

    for (const attempt of attempts) {
      const output = await createPipeline(attempt.dimension)
        .jpeg(jpegOpts(attempt.quality))
        .toBuffer();

      if (output.length > 0 && output.length <= PHOTO_EMBED_MAX_BYTES) {
        return output;
      }
    }

    // Last resort: tiny square if nothing fit under the hard cap.
    const smallest = await createPipeline(64)
      .jpeg(jpegOpts(25))
      .toBuffer();

    if (smallest.length > 0 && smallest.length <= PHOTO_EMBED_MAX_BYTES) {
      return smallest;
    }

    return null;
  } catch {
    return null;
  }
}

function normalizeSocialEntries(
  socialLinks: VcfSocialLink[] | undefined,
): Array<{ platform: string | null; url: string }> {
  if (!Array.isArray(socialLinks)) return [];

  const seen = new Set<string>();
  const entries: Array<{ platform: string | null; url: string }> = [];

  for (const item of socialLinks) {
    const url =
      typeof item === "string"
        ? clean(item)
        : clean(item?.url ?? null);
    if (!url) continue;

    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const platform =
      typeof item === "string"
        ? null
        : clean(item?.platform ?? null);

    entries.push({ platform, url });
  }

  return entries.slice(0, 30);
}

/**
 * Build a vCard 3.0 (.vcf) string on demand.
 * Includes name, role/title, phones, emails, address, profile image,
 * portfolio URL, and all social profile URLs.
 */
export async function buildVcfContent(payload: VcfPayload): Promise<string> {
  const lines: string[] = [
    "BEGIN:VCARD",
    "VERSION:3.0",
  ];

  const first = clean(payload.firstName) ?? "";
  const last = clean(payload.lastName) ?? "";
  const middle = clean(payload.middleName) ?? "";

  lines.push(`N:${escapeVcf(last)};${escapeVcf(first)};${escapeVcf(middle)};;`);

  const fullName = clean(payload.fullName) ?? [first, middle, last].filter(Boolean).join(" ");
  pushLine(lines, "FN", fullName);
  pushLine(lines, "ORG", payload.company);
  pushLine(lines, "TITLE", payload.title);

  pushLine(lines, "TEL;TYPE=CELL", payload.phone);
  pushLine(lines, "TEL;TYPE=WORK,VOICE", payload.altPhone);
  pushLine(lines, "EMAIL;TYPE=INTERNET", payload.email);
  pushLine(lines, "EMAIL;TYPE=INTERNET,ALT", payload.altEmail);

  if (payload.address) {
    const street = clean(payload.address.area) ?? "";
    const city = clean(payload.address.city) ?? "";
    const region = clean(payload.address.region) ?? "";
    const postal = clean(payload.address.zipcode) ?? "";
    const country = clean(payload.address.country) ?? "";

    if (street || city || region || postal || country) {
      lines.push(
        `ADR;TYPE=WORK:;;${escapeVcf(street)};${escapeVcf(city)};${escapeVcf(region)};${escapeVcf(postal)};${escapeVcf(country)}`
      );
    }
  }

  const embeddedPhoto = await fetchEmbeddedPhoto(payload.profileUrl);
  if (embeddedPhoto) {
    lines.push(`PHOTO;ENCODING=b;TYPE=${embeddedPhoto.type}:${embeddedPhoto.base64}`);
  } else {
    pushLine(lines, "PHOTO;VALUE=URI", payload.profileUrl);
  }

  const portfolioUrl = clean(payload.portfolioUrl);
  const website = clean(payload.website);
  if (portfolioUrl) {
    pushLine(lines, "URL;TYPE=Portfolio", portfolioUrl);
  }
  if (website && website.toLowerCase() !== portfolioUrl?.toLowerCase()) {
    pushLine(lines, "URL;TYPE=Website", website);
  }

  const socials = normalizeSocialEntries(payload.socialLinks);
  let itemIndex = 1;
  for (const social of socials) {
    if (
      portfolioUrl &&
      social.url.toLowerCase() === portfolioUrl.toLowerCase()
    ) {
      continue;
    }
    if (website && social.url.toLowerCase() === website.toLowerCase()) {
      continue;
    }

    const type = social.platform
      ? social.platform.replace(/[^a-zA-Z0-9_-]+/g, "")
      : "Social";
    pushLine(lines, `X-SOCIALPROFILE;TYPE=${type || "Social"}`, social.url);
    pushLine(lines, `item${itemIndex}.URL`, social.url);
    if (social.platform) {
      pushLine(lines, `item${itemIndex}.X-ABLabel`, social.platform);
    }
    itemIndex += 1;
  }

  lines.push("END:VCARD");
  return `${lines.map(foldVcfLine).join("\r\n")}\r\n`;
}
