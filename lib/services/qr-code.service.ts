import QRCode from "qrcode";
import { v2 as cloudinary } from "cloudinary";
import { Readable } from "node:stream";
import { prisma } from "@/server/lib/prisma";
import { buildVCardPublicUrl, generateQRCodeDataUrl } from "@/server/lib/qr";
import { buildVCardContentForQR } from "@/lib/bizcard/vcard-content";
import {
  generateBizcardQrVcfAssets,
  type BizcardQrVcfRecord,
} from "@/lib/bizcard/qr-vcf-assets";
import { AppError } from "@/lib/errors/types";
import { QRErrorCode, toErrorCode } from "@/lib/errors/qr-errors";
import { cacheGet, cacheSet } from "@/lib/vcard/cache";

const prismaAny = prisma as any;

type CloudinaryUpload = {
  public_id: string;
  secure_url: string;
};

const MAX_QR_PAYLOAD_LENGTH = 4096;

function validatePortfolioUrl(url: string): boolean {
  if (!url || url.length === 0 || url.length > 512) return false;
  if (!url.startsWith("https://") && !url.startsWith("http://") && !url.startsWith("/")) {
    return false;
  }

  try {
    new URL(url, "https://example.com");
    return true;
  } catch {
    return false;
  }
}

function validateQrPayload(text: string): boolean {
  if (!text || text.length === 0 || text.length > MAX_QR_PAYLOAD_LENGTH) return false;
  if (text.startsWith("BEGIN:VCARD")) return true;
  return validatePortfolioUrl(text);
}

function hasCloudinaryConfig(): boolean {
  return Boolean(
    process.env.CLOUDINARY_URL ||
      (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
  );
}

function configureCloudinary(): void {
  if (process.env.CLOUDINARY_URL) {
    cloudinary.config({
      cloudinary_url: process.env.CLOUDINARY_URL,
      secure: true,
    });
    return;
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export interface QRCodeData {
  qr_code_url: string;
  qr_code_public_id?: string;
  portfolio_qr_code_url?: string;
  vcf_file_url?: string;
  portfolio_url?: string;
  generated_at: Date;
}

/**
 * QR generation result
 */
export interface QRGenerationResult {
  success: boolean;
  qrCodeUrl: string | null;
  generatedAt: Date;
  publicId?: string;
  usedCloudinary?: boolean;
  error?: string;
}

/**
 * Error class for QR generation failures
 */
export class QRGenerationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class QRCodeService {
  private readonly requestId: string;

  constructor(requestId: string) {
    this.requestId = requestId;
    if (hasCloudinaryConfig()) {
      configureCloudinary();
    }
  }

  async generatePNGBuffer(payload: string): Promise<Buffer> {
    if (!validateQrPayload(payload)) {
      throw new AppError(
        toErrorCode(QRErrorCode.QR_CODE_INVALID_URL),
        `Invalid payload for QR code generation`,
        400,
        { payloadLength: payload?.length ?? 0 },
        this.requestId
      );
    }

    return QRCode.toBuffer(payload, {
      errorCorrectionLevel: "H",
      margin: 1,
      width: 500,
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
    });
  }

  async generateDownloadImage(
    payload: string
  ): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
    try {
      const pngBuffer = await this.generatePNGBuffer(payload);
      return {
        buffer: pngBuffer,
        contentType: "image/png",
        extension: "png",
      };
    } catch (pngError) {
      console.warn("[QRCodeService] PNG generation failed, falling back to branded SVG", {
        requestId: this.requestId,
        error: pngError instanceof Error ? pngError.message : String(pngError),
      });

      const dataUrl = generateQRCodeDataUrl(payload);
      if (!dataUrl) {
        throw new AppError(
          toErrorCode(QRErrorCode.QR_CODE_GENERATION_FAILED),
          "Failed to generate QR code image",
          500,
          { payloadLength: payload.length },
          this.requestId
        );
      }

      const base64 = dataUrl.split(",")[1];
      if (!base64) {
        throw new AppError(
          toErrorCode(QRErrorCode.QR_CODE_GENERATION_FAILED),
          "Failed to encode QR code fallback image",
          500,
          { payloadLength: payload.length },
          this.requestId
        );
      }

      return {
        buffer: Buffer.from(base64, "base64"),
        contentType: "image/svg+xml",
        extension: "svg",
      };
    }
  }

  async buildOfflineQrPayload(
    bizcardId: bigint
  ): Promise<{ payload: string; portfolioUrl: string }> {
    const bizcard = await prismaAny.bizcard.findUnique({
      where: { bizcard_id: bizcardId },
      select: {
        bizcard_id: true,
        url_alias: true,
        bizcard_name: true,
        first_name: true,
        last_name: true,
        email: true,
        alt_email: true,
        contact_number: true,
        occupation: true,
        company: {
          select: { name: true },
        },
        socials: {
          where: { is_visible: true },
          select: { platform: true, url: true },
          orderBy: { display_order: "asc" },
        },
      },
    });

    if (!bizcard) {
      throw new AppError(
        toErrorCode(QRErrorCode.QR_CODE_NOT_FOUND),
        `Bizcard ${bizcardId.toString()} not found`,
        404,
        { bizcardId: bizcardId.toString() },
        this.requestId
      );
    }

    if (!bizcard.url_alias) {
      throw new AppError(
        toErrorCode(QRErrorCode.QR_CODE_INVALID_URL),
        "Bizcard has no url_alias for offline QR generation",
        400,
        { bizcardId: bizcardId.toString() },
        this.requestId
      );
    }

    const portfolioUrl = buildVCardPublicUrl(bizcard.url_alias);
    if (!portfolioUrl) {
      throw new AppError(
        toErrorCode(QRErrorCode.QR_CODE_INVALID_URL),
        "Unable to build portfolio URL for offline QR generation",
        500,
        { bizcardId: bizcardId.toString(), urlAlias: bizcard.url_alias },
        this.requestId
      );
    }

    const payload = buildVCardContentForQR(bizcard, portfolioUrl);
    return { payload, portfolioUrl };
  }

  async generateOfflineVCardQRCode(bizcardId: bigint): Promise<QRCodeData> {
    const { payload, portfolioUrl } = await this.buildOfflineQrPayload(bizcardId);
    const pngBuffer = await this.generatePNGBuffer(payload);

    if (!hasCloudinaryConfig()) {
      const dataUrl = generateQRCodeDataUrl(payload);
      if (!dataUrl) {
        throw new AppError(
          toErrorCode(QRErrorCode.QR_CODE_GENERATION_FAILED),
          "Failed to generate offline QR code fallback data URL",
          500,
          { bizcardId: bizcardId.toString() },
          this.requestId
        );
      }

      const generatedAt = new Date();
      await prismaAny.bizcard.update({
        where: { bizcard_id: bizcardId },
        data: {
          qr_code_url: dataUrl,
          qr_code_generated_at: generatedAt,
          portfolio_url: portfolioUrl,
        },
      });

      return {
        qr_code_url: dataUrl,
        generated_at: generatedAt,
      };
    }

    try {
      const uploadResult = await this.uploadToCloudinary(pngBuffer, bizcardId);
      const generatedAt = new Date();

      await prismaAny.bizcard.update({
        where: { bizcard_id: bizcardId },
        data: {
          qr_code_url: uploadResult.secure_url,
          qr_code_generated_at: generatedAt,
          portfolio_url: portfolioUrl,
        },
      });

      return {
        qr_code_url: uploadResult.secure_url,
        qr_code_public_id: uploadResult.public_id,
        generated_at: generatedAt,
      };
    } catch (error) {
      console.error("[QRCodeService] Cloudinary upload failed for offline QR, falling back to SVG", {
        requestId: this.requestId,
        bizcardId: bizcardId.toString(),
        error: error instanceof Error ? error.message : String(error),
      });

      const fallbackDataUrl = generateQRCodeDataUrl(payload);
      if (!fallbackDataUrl) {
        throw new AppError(
          toErrorCode(QRErrorCode.QR_CODE_GENERATION_FAILED),
          "Failed to generate offline QR via Cloudinary and fallback SVG",
          500,
          { bizcardId: bizcardId.toString() },
          this.requestId
        );
      }

      const generatedAt = new Date();
      await prismaAny.bizcard.update({
        where: { bizcard_id: bizcardId },
        data: {
          qr_code_url: fallbackDataUrl,
          qr_code_generated_at: generatedAt,
          portfolio_url: portfolioUrl,
        },
      });

      return {
        qr_code_url: fallbackDataUrl,
        generated_at: generatedAt,
      };
    }
  }

  async generateQRCode(bizcardId: bigint, url: string): Promise<QRCodeData> {
    if (!validatePortfolioUrl(url)) {
      throw new AppError(
        toErrorCode(QRErrorCode.QR_CODE_INVALID_URL),
        `Invalid URL for QR code generation: ${url}`,
        400,
        { bizcardId: bizcardId.toString(), url },
        this.requestId
      );
    }

    const pngBuffer = await this.generatePNGBuffer(url);

    if (!hasCloudinaryConfig()) {
      const dataUrl = generateQRCodeDataUrl(url);
      if (!dataUrl) {
        throw new AppError(
          toErrorCode(QRErrorCode.QR_CODE_GENERATION_FAILED),
          "Failed to generate QR code fallback data URL",
          500,
          { bizcardId: bizcardId.toString(), url },
          this.requestId
        );
      }

      return {
        qr_code_url: dataUrl,
        generated_at: new Date(),
      };
    }

    try {
      const uploadResult = await this.uploadToCloudinary(pngBuffer, bizcardId);
      return {
        qr_code_url: uploadResult.secure_url,
        qr_code_public_id: uploadResult.public_id,
        generated_at: new Date(),
      };
    } catch (error) {
      console.error("[QRCodeService] Cloudinary upload failed, falling back to SVG", {
        requestId: this.requestId,
        bizcardId: bizcardId.toString(),
        error: error instanceof Error ? error.message : String(error),
      });

      const fallbackDataUrl = generateQRCodeDataUrl(url);
      if (!fallbackDataUrl) {
        throw new AppError(
          toErrorCode(QRErrorCode.QR_CODE_GENERATION_FAILED),
          "Failed to generate QR code via Cloudinary and fallback SVG",
          500,
          { bizcardId: bizcardId.toString(), url },
          this.requestId
        );
      }

      return {
        qr_code_url: fallbackDataUrl,
        generated_at: new Date(),
      };
    }
  }

  private async uploadToCloudinary(buffer: Buffer, bizcardId: bigint): Promise<CloudinaryUpload> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `ontap/qrcodes/${bizcardId.toString()}`,
          resource_type: "image",
          public_id: `qr_code_${bizcardId.toString()}`,
          overwrite: true,
          invalidate: true,
          tags: [`bizcard_${bizcardId.toString()}`, "qr_code"],
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
        }
      );

      const readableStream = new Readable();
      readableStream.push(buffer);
      readableStream.push(null);
      readableStream.pipe(uploadStream);
    });
  }

  async getOrGenerateQRCode(bizcardId: bigint, urlAlias: string): Promise<QRCodeData> {
    const bizcard = await prismaAny.bizcard.findUnique({
      where: { bizcard_id: bizcardId },
      select: {
        bizcard_id: true,
        url_alias: true,
        qr_code_url: true,
        qr_code_generated_at: true,
      },
    });

    if (!bizcard) {
      throw new AppError(
        toErrorCode(QRErrorCode.QR_CODE_NOT_FOUND),
        `Bizcard ${bizcardId.toString()} not found`,
        404,
        { bizcardId: bizcardId.toString() },
        this.requestId
      );
    }

    if (bizcard.qr_code_url) {
      return {
        qr_code_url: bizcard.qr_code_url,
        generated_at: bizcard.qr_code_generated_at ?? new Date(),
      };
    }

    if (!urlAlias) {
      throw new AppError(
        toErrorCode(QRErrorCode.QR_CODE_INVALID_URL),
        "Unable to build portfolio URL for QR generation",
        500,
        { bizcardId: bizcardId.toString() },
        this.requestId
      );
    }

    return this.generateOfflineVCardQRCode(bizcardId);
  }

  async regenerateQRCode(bizcardId: bigint, urlAlias: string): Promise<QRCodeData> {
    if (!urlAlias) {
      throw new AppError(
        toErrorCode(QRErrorCode.QR_CODE_INVALID_URL),
        "Unable to build portfolio URL for QR regeneration",
        500,
        { bizcardId: bizcardId.toString(), urlAlias },
        this.requestId
      );
    }

    return this.regenerateAllBizcardAssets(bizcardId);
  }

  async regenerateAllBizcardAssets(bizcardId: bigint): Promise<QRCodeData> {
    const bizcard = await prismaAny.bizcard.findUnique({
      where: { bizcard_id: bizcardId },
      select: {
        bizcard_id: true,
        url_alias: true,
        bizcard_name: true,
        first_name: true,
        last_name: true,
        middle_name: true,
        email: true,
        alt_email: true,
        contact_number: true,
        alt_contact_number: true,
        occupation: true,
        professional_title: true,
        profile_img: true,
        company: { select: { name: true } },
        addresses: {
          select: {
            area: true,
            brgy: true,
            city: true,
            region: true,
            zipcode: true,
          },
          take: 1,
        },
        socials: {
          where: { is_visible: true },
          select: { platform: true, url: true },
          orderBy: { display_order: "asc" },
        },
      },
    });

    if (!bizcard?.url_alias?.trim()) {
      throw new AppError(
        toErrorCode(QRErrorCode.QR_CODE_INVALID_URL),
        "Bizcard has no url_alias for QR/VCF regeneration",
        400,
        { bizcardId: bizcardId.toString() },
        this.requestId
      );
    }

    if (!hasCloudinaryConfig()) {
      const { payload, portfolioUrl } = await this.buildOfflineQrPayload(bizcardId);
      const dataUrl = generateQRCodeDataUrl(payload);
      if (!dataUrl) {
        throw new AppError(
          toErrorCode(QRErrorCode.QR_CODE_GENERATION_FAILED),
          "Failed to generate QR code fallback data URL",
          500,
          { bizcardId: bizcardId.toString() },
          this.requestId
        );
      }
      const generatedAt = new Date();
      await prismaAny.bizcard.update({
        where: { bizcard_id: bizcardId },
        data: {
          qr_code_url: dataUrl,
          qr_code_generated_at: generatedAt,
          portfolio_url: portfolioUrl,
        },
      });
      return {
        qr_code_url: dataUrl,
        portfolio_url: portfolioUrl,
        generated_at: generatedAt,
      };
    }

    const record: BizcardQrVcfRecord = {
      ...bizcard,
      url_alias: bizcard.url_alias.trim(),
    };
    const assets = await generateBizcardQrVcfAssets(record);
    await prismaAny.bizcard.update({
      where: { bizcard_id: bizcardId },
      data: {
        // Never store a Cloudinary VCF URL — VCF is generated on demand.
        vcf_file_url: null,
        portfolio_qr_code_url: assets.portfolioQrCodeUrl,
        qr_code_url: assets.vcfQrCodeUrl,
        portfolio_url: assets.portfolioUrl,
        qr_code_generated_at: assets.generatedAt,
        updated_at: assets.generatedAt,
      },
    });

    return {
      qr_code_url: assets.vcfQrCodeUrl,
      portfolio_qr_code_url: assets.portfolioQrCodeUrl,
      vcf_file_url: undefined,
      portfolio_url: assets.portfolioUrl,
      generated_at: assets.generatedAt,
    };
  }
}

/**
 * Generate offline vCard QR code for a bizcard (soft-failure for async queue).
 */
export async function generateOfflineQRCodeForBizcard(
  bizcardId: bigint
): Promise<QRGenerationResult> {
  const startTime = Date.now();
  const requestId = `qr_offline_${Date.now()}`;
  const qrService = new QRCodeService(requestId);
  const cacheKey = `qr:bizcard:${bizcardId}`;

  try {
    const qrData = await qrService.generateOfflineVCardQRCode(bizcardId);
    const ttlSeconds = 3600;
    cacheSet(cacheKey, qrData.qr_code_url, ttlSeconds);

    console.debug(
      `[QRCodeService] Generated offline QR (${Date.now() - startTime}ms) for bizcard ${bizcardId}`
    );

    return {
      success: true,
      qrCodeUrl: qrData.qr_code_url,
      generatedAt: qrData.generated_at,
      publicId: qrData.qr_code_public_id,
      usedCloudinary: Boolean(qrData.qr_code_public_id),
    };
  } catch (err) {
    console.error(
      `[QRCodeService] Offline QR exception (${Date.now() - startTime}ms) for bizcard ${bizcardId}:`,
      err
    );
    return {
      success: false,
      qrCodeUrl: null,
      generatedAt: new Date(),
      error: err instanceof Error ? err.message : "UNKNOWN_ERROR",
    };
  }
}

/**
 * Validate a portfolio URL before attempting QR generation
 */
/**
 * Generate QR code for a bizcard portfolio URL
 *
 * @param bizcardId - The bizcard ID (for logging/cache key)
 * @param portfolioUrl - The public portfolio URL to encode (e.g., https://domain.com/john-doe)
 * @returns QRGenerationResult with success status and QR code data URL (or null on failure)
 *
 * Process:
 *   1. Validate input URL
 *   2. Check cache (1-hour TTL)
 *   3. Generate using server/lib/qr.ts
 *   4. Cache result
 *   5. Return result with timestamp
 *
 * On failure:
 *   - Logs error with code and message
 *   - Returns success: false with error description
 *   - Does NOT throw (soft failure for async queue)
 */
export async function generateQRCodeForBizcard(
  bizcardId: bigint,
  portfolioUrl: string
): Promise<QRGenerationResult> {
  const startTime = Date.now();
  const requestId = `qr_${Date.now()}`;
  const qrService = new QRCodeService(requestId);
  const cacheKey = `qr:bizcard:${bizcardId}`;

  try {
    if (!validatePortfolioUrl(portfolioUrl)) {
      console.error(
        `[QRCodeService] Invalid portfolio URL for bizcard ${bizcardId}: ${portfolioUrl}`
      );
      return {
        success: false,
        qrCodeUrl: null,
        generatedAt: new Date(),
        error: "INVALID_PORTFOLIO_URL",
      };
    }

    const cachedQR = cacheGet<string>(cacheKey);
    if (cachedQR) {
      console.debug(
        `[QRCodeService] Cache hit (${Date.now() - startTime}ms) for bizcard ${bizcardId}`
      );
      return {
        success: true,
        qrCodeUrl: cachedQR,
        generatedAt: new Date(),
      };
    }

    const qrData = await qrService.generateQRCode(bizcardId, portfolioUrl);
    const ttlSeconds = 3600; // 1 hour
    cacheSet(cacheKey, qrData.qr_code_url, ttlSeconds);

    console.debug(
      `[QRCodeService] Generated (${Date.now() - startTime}ms) for bizcard ${bizcardId}`
    );

    return {
      success: true,
      qrCodeUrl: qrData.qr_code_url,
      generatedAt: qrData.generated_at,
      publicId: qrData.qr_code_public_id,
      usedCloudinary: Boolean(qrData.qr_code_public_id),
    };
  } catch (err) {
    console.error(
      `[QRCodeService] Exception (${Date.now() - startTime}ms) for bizcard ${bizcardId}:`,
      err
    );
    return {
      success: false,
      qrCodeUrl: null,
      generatedAt: new Date(),
      error: err instanceof Error ? err.message : "UNKNOWN_ERROR",
    };
  }
}

/**
 * Persist QR code to database after successful generation
 *
 * @param bizcardId - The bizcard ID to update
 * @param qrCodeUrl - The generated QR code data URL
 * @param portfolioUrl - The portfolio URL (for reference)
 * @returns Promise that resolves on success, rejects on DB error
 */
export async function persistQRCodeToBizcard(
  bizcardId: bigint,
  qrCodeUrl: string,
  portfolioUrl: string
): Promise<void> {
  try {
    await prismaAny.bizcard.update({
      where: { bizcard_id: bizcardId },
      data: {
        qr_code_url: qrCodeUrl,
        qr_code_generated_at: new Date(),
        portfolio_url: portfolioUrl,
      },
    });

    console.debug(`[QRCodeService] Persisted QR for bizcard ${bizcardId}`);
  } catch (err) {
    console.error(
      `[QRCodeService] Failed to persist QR for bizcard ${bizcardId}:`,
      err
    );
    throw new QRGenerationError(
      "DB_PERSIST_FAILED",
      `Failed to persist QR code for bizcard ${bizcardId}`
    );
  }
}

/**
 * Batch generate QR codes for multiple bizcards
 * Useful for backfill and recovery operations
 *
 * @param items - Array of { bizcardId, portfolioUrl }
 * @param progressCallback - Optional callback for progress tracking
 * @returns Array of results with success counts
 */
export async function generateQRCodesBatch(
  items: Array<{ bizcardId: bigint; portfolioUrl: string }>,
  progressCallback?: (current: number, total: number) => void
): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  errors: Array<{ bizcardId: bigint; error: string }>;
}> {
  const results = {
    total: items.length,
    succeeded: 0,
    failed: 0,
    errors: [] as Array<{ bizcardId: bigint; error: string }>,
  };

  for (let i = 0; i < items.length; i++) {
    const { bizcardId, portfolioUrl } = items[i];

    try {
      const result = await generateOfflineQRCodeForBizcard(bizcardId);

      if (result.success && result.qrCodeUrl) {
        results.succeeded++;
      } else {
        results.failed++;
        results.errors.push({
          bizcardId,
          error: result.error || "UNKNOWN",
        });
      }
    } catch (err) {
      results.failed++;
      results.errors.push({
        bizcardId,
        error: err instanceof Error ? err.message : "EXCEPTION",
      });
    }

    if (progressCallback) {
      progressCallback(i + 1, items.length);
    }
  }

  return results;
}
