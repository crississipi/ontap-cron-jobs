/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Escape vCard special characters per RFC 6350 folding rules.
 */
export function escapeVCardString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

export type VCardSocialField = {
  platform?: string | null;
  url?: string | null;
};

export type VCardBizcardFields = {
  first_name?: string | null;
  last_name?: string | null;
  bizcard_name?: string | null;
  email?: string | null;
  alt_email?: string | null;
  contact_number?: string | null;
  occupation?: string | null;
  company?: { name?: string | null } | null;
  socials?: VCardSocialField[] | null;
};

/**
 * Collect unique social profile URLs for offline QR / slim vCard payloads.
 * Excludes blank URLs and `website` entries (portfolio URL already covers the site).
 */
export function collectSocialUrlsForVCard(
  socials?: VCardSocialField[] | null,
  limit = 20
): string[] {
  if (!Array.isArray(socials) || socials.length === 0) return [];

  const unique: string[] = [];
  const seen = new Set<string>();

  for (const item of socials) {
    const platform = (item?.platform ?? "").trim().toLowerCase();
    if (platform === "website") continue;

    const url = (item?.url ?? "").trim().replace(/[\r\n]+/g, " ");
    if (!url) continue;

    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(url);
    if (unique.length >= limit) break;
  }

  return unique;
}

/**
 * Build vCard (VCF) content for offline QR encoding.
 *
 * Format:
 * BEGIN:VCARD
 * VERSION:3.0
 * FN:Full Name
 * TEL:+639XXXXXXXXX
 * EMAIL:user@example.com
 * URL:https://ontap.portal.ph/username
 * X-SOCIALPROFILE:https://...
 * END:VCARD
 */
export function buildVCardContentForQR(
  bizcard: VCardBizcardFields,
  portfolioUrl: string
): string {
  const fullName = `${bizcard.first_name || ""} ${bizcard.last_name || ""}`.trim();
  const displayName =
    fullName || bizcard.bizcard_name || bizcard.email?.split("@")[0] || "User";

  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${escapeVCardString(displayName)}`];

  if (bizcard.contact_number && bizcard.contact_number.trim() !== "") {
    const phone = bizcard.contact_number.replace(/\s+/g, "");
    lines.push(`TEL:${escapeVCardString(phone)}`);
  }

  if (bizcard.email && bizcard.email.trim() !== "") {
    lines.push(`EMAIL:${escapeVCardString(bizcard.email)}`);
  }

  if (
    bizcard.alt_email &&
    bizcard.alt_email.trim() !== "" &&
    bizcard.alt_email !== bizcard.email
  ) {
    lines.push(`EMAIL;TYPE=WORK:${escapeVCardString(bizcard.alt_email)}`);
  }

  if (bizcard.company?.name) {
    lines.push(`ORG:${escapeVCardString(bizcard.company.name)}`);
  }

  if (bizcard.occupation) {
    lines.push(`TITLE:${escapeVCardString(bizcard.occupation)}`);
  }

  lines.push(`URL:${escapeVCardString(portfolioUrl)}`);

  for (const socialUrl of collectSocialUrlsForVCard(bizcard.socials)) {
    lines.push(`X-SOCIALPROFILE:${escapeVCardString(socialUrl)}`);
  }

  lines.push("END:VCARD");

  return lines.join("\n");
}
