import QRCode from "qrcode";
import { v2 as cloudinary } from "cloudinary";
import { Readable } from "node:stream";
import { buildVCardContentForQR } from "./vcard-content";
import { buildVcfContent, type VcfPayload } from "@/server/lib/vcf";
import { buildVCardPublicUrl } from "@/server/lib/qr";

export interface BizcardQrVcfRecord {
  bizcard_id: bigint;
  url_alias: string;
  bizcard_name: string;
  first_name: string;
  last_name: string;
  middle_name?: string | null;
  email: string;
  alt_email?: string | null;
  contact_number: string;
  alt_contact_number?: string | null;
  occupation?: string | null;
  professional_title?: string | null;
  profile_img?: string | null;
  user_profile_img?: string | null;
  company?: { name: string | null } | null;
  addresses?: Array<{
    area?: string | null;
    brgy?: string | null;
    city?: string | null;
    region?: string | null;
    zipcode?: string | null;
  }>;
  socials?: Array<{ platform: string; url: string }>;
}

export interface BizcardQrVcfAssets {
  portfolioUrl: string;
  /** Always null — VCF files are generated on demand, never uploaded to Cloudinary. */
  vcfFileUrl: null;
  portfolioQrCodeUrl: string;
  vcfQrCodeUrl: string;
  generatedAt: Date;
}

export function sanitizeVcfFileName(alias: string): string {
  return alias
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 100) || "contact";
}

export function buildBizcardVcfPayload(bizcard: BizcardQrVcfRecord, portfolioUrl: string): VcfPayload {
  const address = bizcard.addresses?.[0];
  const website =
    bizcard.socials?.find((s) => s.platform.toLowerCase() === "website")?.url ?? null;
  const socialLinks =
    bizcard.socials
      ?.filter((s) => Boolean(s.url?.trim()))
      .map((s) => ({ platform: s.platform, url: s.url })) ?? [];

  const displayName =
    [bizcard.first_name, bizcard.middle_name, bizcard.last_name].filter(Boolean).join(" ").trim() ||
    bizcard.bizcard_name;

  return {
    firstName: bizcard.first_name,
    lastName: bizcard.last_name,
    middleName: bizcard.middle_name,
    fullName: displayName,
    company: bizcard.company?.name ?? null,
    // Role: prefer professional title, then occupation
    title: bizcard.professional_title ?? bizcard.occupation ?? null,
    phone: bizcard.contact_number,
    altPhone: bizcard.alt_contact_number ?? null,
    email: bizcard.email,
    altEmail: bizcard.alt_email ?? null,
    website,
    profileUrl: bizcard.profile_img ?? bizcard.user_profile_img ?? null,
    portfolioUrl,
    address: address
      ? {
          area: [address.area, address.brgy].filter(Boolean).join(", ") || null,
          city: address.city,
          region: address.region,
          zipcode: address.zipcode,
          country: "Philippines",
        }
      : null,
    socialLinks,
  };
}

export async function buildBizcardVcfFileContent(
  bizcard: BizcardQrVcfRecord,
  portfolioUrl: string,
): Promise<string> {
  return buildVcfContent(buildBizcardVcfPayload(bizcard, portfolioUrl));
}

export function buildBizcardVcfQrPayload(
  bizcard: BizcardQrVcfRecord,
  portfolioUrl: string,
): string {
  return buildVCardContentForQR(bizcard, portfolioUrl);
}

export function resolveBizcardPortfolioUrl(urlAlias: string): string {
  const url = buildVCardPublicUrl(urlAlias);
  if (!url) {
    throw new Error(`MIGRATE_QR_VCF_REGEN_FAILED: invalid url_alias ${urlAlias}`);
  }
  return url;
}

async function uploadBufferToCloudinary(
  buffer: Buffer,
  options: {
    resourceType: "image" | "raw";
    publicId: string;
    tags: string[];
  },
): Promise<{ public_id: string; secure_url: string }> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: options.resourceType,
        public_id: options.publicId,
        overwrite: true,
        invalidate: true,
        tags: options.tags,
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error("Cloudinary returned empty upload result"));
          return;
        }
        resolve({
          public_id: result.public_id,
          secure_url: result.secure_url,
        });
      },
    );

    const readableStream = new Readable();
    readableStream.push(buffer);
    readableStream.push(null);
    readableStream.pipe(uploadStream);
  });
}

export async function uploadVcfFile(
  _bizcardId: bigint,
  _urlAlias: string,
  _vcfContent: string,
): Promise<string> {
  // Intentionally disabled: VCF files must not be uploaded to Cloudinary.
  // They are generated on demand at download / save-contact time.
  throw new Error(
    "VCF Cloudinary upload is disabled. Generate VCF content on demand instead.",
  );
}

export async function uploadPortfolioQrCode(
  bizcardId: bigint,
  portfolioUrl: string,
): Promise<string> {
  const pngBuffer = await QRCode.toBuffer(portfolioUrl, {
    errorCorrectionLevel: "H",
    margin: 1,
    width: 500,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  const publicId = `ontap/qrcodes/${bizcardId.toString()}/portfolio_qr_${bizcardId.toString()}`;
  const result = await uploadBufferToCloudinary(pngBuffer, {
    resourceType: "image",
    publicId,
    tags: [`bizcard_${bizcardId.toString()}`, "qr_code", "portfolio", "migrated"],
  });
  return result.secure_url;
}

export async function uploadVcfQrCode(
  bizcardId: bigint,
  vcfQrPayload: string,
): Promise<string> {
  const pngBuffer = await QRCode.toBuffer(vcfQrPayload, {
    errorCorrectionLevel: "H",
    margin: 1,
    width: 500,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  const publicId = `ontap/qrcodes/${bizcardId.toString()}/qr_code_${bizcardId.toString()}`;
  const result = await uploadBufferToCloudinary(pngBuffer, {
    resourceType: "image",
    publicId,
    tags: [`bizcard_${bizcardId.toString()}`, "qr_code", "vcf", "migrated"],
  });
  return result.secure_url;
}

/**
 * Generate QR assets for a bizcard.
 * VCF files are NOT uploaded — they are built on demand when a visitor saves contact.
 */
export async function generateBizcardQrVcfAssets(
  bizcard: BizcardQrVcfRecord,
): Promise<BizcardQrVcfAssets> {
  const portfolioUrl = resolveBizcardPortfolioUrl(bizcard.url_alias);
  // Compact VCF payload for QR encoding only (size-limited). Full VCF is generated on download.
  const vcfQrPayload = buildBizcardVcfQrPayload(bizcard, portfolioUrl);

  const [portfolioQrCodeUrl, vcfQrCodeUrl] = await Promise.all([
    uploadPortfolioQrCode(bizcard.bizcard_id, portfolioUrl),
    uploadVcfQrCode(bizcard.bizcard_id, vcfQrPayload),
  ]);

  return {
    portfolioUrl,
    vcfFileUrl: null,
    portfolioQrCodeUrl,
    vcfQrCodeUrl,
    generatedAt: new Date(),
  };
}
