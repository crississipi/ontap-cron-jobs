// ──────────────────────────────────────────────────────────────
// Email Service — Nodemailer SMTP Transport
// ──────────────────────────────────────────────────────────────
// Centralized email sending with error handling.
// Configured via environment variables — no secrets in code.
//
// Functions exported:
//  - sendVerificationEmail       → password reset OTP
//  - sendEmailVerificationOtp    → registration email verification OTP
//  - sendEmailMessage            → generic HTML/text send (cron queue)
//  - sendOrderConfirmationEmail  → checkout confirmation
//  - sendSubscriptionConfirmationEmail → plan activation/upgrade
//  - buildEmailShell / escapeEmailHtml → shared branded shell helpers
//  - buildAbandonedCartEmail     → /api/cron/abandoned-cart
//  - buildSubscriptionExpiryEmail → /api/cron/subscription-expiry
//  - buildTrialExperienceFollowupEmail → /api/cron/trial-experience-followup
//  - buildBizcardDailyReportEmail → /api/cron/bizcard-daily-report
// ──────────────────────────────────────────────────────────────

import nodemailer from "nodemailer";

function getAppBaseUrl(): string {
  return (
    process.env.FRONTEND_URL ||
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
}

function appPageUrl(path: string): string {
  const base = getAppBaseUrl();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${normalized}` : normalized;
}

// ──────────────────────────────────────────
// SMTP Transport (lazy singleton)
// ──────────────────────────────────────────
// Created lazily so cold-start time isn't spent on connection setup
// before an email is actually needed.

// On Vercel serverless, function instances can be frozen and thawed between
// invocations. A singleton transporter holds a socket that gets killed when
// the instance is frozen — the next send hits a dead connection and throws
// "Unexpected socket close". Solution: create a fresh transporter per send
// and explicitly close it when done so the TLS socket is torn down cleanly.
function createTransporter(): nodemailer.Transporter {
  const port = Number(process.env.SMTP_PORT) || 587;
  // Port 465 uses implicit TLS (connect over SSL from the start).
  // Port 587/25 use STARTTLS (upgrade after plain-text greeting).
  // Nodemailer requires the right value here — mismatch causes socket close.
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 10_000, // ms to wait for socket connection
    greetingTimeout:   10_000, // ms to wait for SMTP greeting
    socketTimeout:     30_000, // ms of inactivity before socket is killed
  });
}

// ──────────────────────────────────────────
// Shared HTML Shell
// ──────────────────────────────────────────
// All email templates share the same branded wrapper for consistency.
// Inline CSS is required for email client compatibility (Gmail, Outlook, etc.)

function emailShell(bodyContent: string): string {
  const appName = process.env.EMAIL_FROM_NAME || "OnTap Team";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${appName}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:600px;width:100%;">
          <!-- Header -->
          <tr>
            <td style="background:#3B569F;padding:32px 40px;text-align:center;">
              <img src="https://lightgray-mallard-851601.hostingersite.com/logotap.png" alt="${appName}" style="height:auto;width:120px;object-fit:contain;"/>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              ${bodyContent}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8f9fa;padding:20px 40px;border-top:1px solid #e9ecef;text-align:center;">
              <p style="margin:0;color:#4785B8;font-size:12px;">
                &copy; ${new Date().getFullYear()} ${appName}. All rights reserved.<br/><br/>
                If you did not request this email, you can safely ignore it.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Shared branded HTML wrapper for transactional and cron emails. */
export function buildEmailShell(bodyContent: string): string {
  return emailShell(bodyContent);
}

export function escapeEmailHtml(value: unknown): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ctaButton(href: string, label: string): string {
  return `<p style="margin:28px 0 8px;text-align:center;">
  <a href="${escapeEmailHtml(href)}" style="display:inline-block;background:#2A4792;color:#ffffff;padding:14px 28px;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;">${escapeEmailHtml(label)}</a>
</p>`;
}

export type AbandonedCartEmailItem = {
  name: string;
  quantity: number;
  price?: number;
  variant?: string | null;
};

/** Professional abandoned-cart reminder used by /api/cron/abandoned-cart. */
export function buildAbandonedCartEmail(params: {
  firstName: string;
  items: AbandonedCartEmailItem[];
  cartUrl: string;
  appName?: string;
}): { subject: string; html: string; text: string } {
  const appName = params.appName || process.env.EMAIL_FROM_NAME || "OnTap";
  const firstName = escapeEmailHtml(params.firstName || "there");
  const itemsHtml = params.items
    .map((item) => {
      const name = escapeEmailHtml(item.name);
      const variant = item.variant ? escapeEmailHtml(item.variant) : null;
      const qty = Number(item.quantity) || 1;
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #f0f2f5;color:#495057;">
          <strong>${name}</strong>${variant ? `<br/><span style="color:#868e96;font-size:12px;">${variant}</span>` : ""}
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #f0f2f5;color:#495057;text-align:center;">${qty}</td>
      </tr>`;
    })
    .join("");

  const subject = `Your ${appName} cart is waiting — complete your purchase`;
  const body = `
    <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">Don't miss out, ${firstName}</h2>
    <p style="color:#495057;line-height:1.6;margin:0 0 16px;">
      You left items in your <strong>${escapeEmailHtml(appName)}</strong> cart. Complete checkout now so your selections stay reserved.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
      <thead>
        <tr>
          <th style="padding:8px 0;text-align:left;color:#6c757d;font-size:12px;text-transform:uppercase;">Item</th>
          <th style="padding:8px 0;text-align:center;color:#6c757d;font-size:12px;text-transform:uppercase;">Qty</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml || `<tr><td colspan="2" style="padding:10px 0;color:#495057;">Your saved cart items are still available.</td></tr>`}
      </tbody>
    </table>
    ${ctaButton(params.cartUrl, "Return to cart")}
    <p style="color:#868e96;font-size:13px;margin:16px 0 0;line-height:1.5;">
      If you already checked out or did not add these items, you can safely ignore this message.
    </p>`;

  const text =
    `Hi ${params.firstName || "there"},\n\n` +
    `You still have items in your ${appName} cart.\n` +
    `Complete your purchase: ${params.cartUrl}\n\n` +
    `— The ${appName} Team`;

  return { subject, html: emailShell(body), text };
}

/** Professional subscription expiry / trial reminder used by subscription-expiry cron. */
export function buildSubscriptionExpiryEmail(params: {
  firstName: string;
  title: string;
  message: string;
  renewUrl: string;
  expiresAt: Date;
  planLabel?: string | null;
  bizcardName?: string | null;
  kind?: "trial" | "paid" | "expired" | string;
  appName?: string;
}): { subject: string; html: string; text: string } {
  const appName = params.appName || process.env.EMAIL_FROM_NAME || "OnTap";
  const firstName = escapeEmailHtml(params.firstName || "there");
  const title = escapeEmailHtml(params.title);
  const message = escapeEmailHtml(params.message);
  const plan = params.planLabel ? escapeEmailHtml(params.planLabel) : null;
  const bizcard = params.bizcardName ? escapeEmailHtml(params.bizcardName) : null;
  const expiry = escapeEmailHtml(
    params.expiresAt.toLocaleDateString("en-US", { dateStyle: "long" }),
  );
  const tone =
    params.kind === "expired"
      ? { bg: "#fff5f5", border: "#ffa8a8", color: "#c92a2a", label: "Action required" }
      : { bg: "#fff9db", border: "#ffe066", color: "#e67700", label: "Upcoming renewal" };

  const subject = `${appName}: ${params.title}`;
  const body = `
    <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">${title}</h2>
    <p style="color:#495057;line-height:1.6;margin:0 0 16px;">Hi ${firstName},</p>
    <p style="color:#495057;line-height:1.6;margin:0 0 16px;">${message}</p>
    <div style="background:${tone.bg};border:1px solid ${tone.border};border-radius:10px;padding:16px;margin:0 0 20px;">
      <p style="margin:0 0 6px;color:${tone.color};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">${tone.label}</p>
      ${plan ? `<p style="margin:0 0 4px;color:#495057;font-size:14px;"><strong>Plan:</strong> ${plan}</p>` : ""}
      ${bizcard ? `<p style="margin:0 0 4px;color:#495057;font-size:14px;"><strong>BizCard:</strong> ${bizcard}</p>` : ""}
      <p style="margin:0;color:#495057;font-size:14px;"><strong>Expiry date:</strong> ${expiry}</p>
    </div>
    ${ctaButton(params.renewUrl, "Renew or manage subscription")}
    <p style="color:#868e96;font-size:13px;margin:16px 0 0;line-height:1.5;">
      Keeping your plan active ensures uninterrupted access to premium ${escapeEmailHtml(appName)} features.
    </p>`;

  const text =
    `${params.title}\n\n` +
    `Hi ${params.firstName || "there"},\n\n` +
    `${params.message}\n` +
    `${params.planLabel ? `Plan: ${params.planLabel}\n` : ""}` +
    `${params.bizcardName ? `BizCard: ${params.bizcardName}\n` : ""}` +
    `Expiry date: ${params.expiresAt.toLocaleDateString()}\n\n` +
    `Renew or manage: ${params.renewUrl}\n\n` +
    `— The ${appName} Team`;

  return { subject, html: emailShell(body), text };
}

/** One-time follow-up after free trial has been expired for 7+ days. */
export function buildTrialExperienceFollowupEmail(params: {
  firstName: string;
  daysExpired: number;
  shopUrl: string;
  feedbackUrl: string;
  appName?: string;
}): { subject: string; html: string; text: string } {
  const appName = params.appName || process.env.EMAIL_FROM_NAME || "OnTap";
  const firstName = escapeEmailHtml(params.firstName || "there");
  const days = Math.max(1, Number(params.daysExpired) || 7);
  const subject = `How was your ${appName} free trial? We'd love your feedback`;
  const body = `
    <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">We miss you, ${firstName}</h2>
    <p style="color:#495057;line-height:1.6;margin:0 0 16px;">
      Your free trial ended about <strong>${days} day${days === 1 ? "" : "s"}</strong> ago.
      We hope you got a feel for how ${escapeEmailHtml(appName)} helps you share your professional presence.
    </p>
    <p style="color:#495057;line-height:1.6;margin:0 0 16px;">
      Would you tell us about your experience? Your feedback helps us improve — and when you're ready,
      you can unlock a physical BizCard or browse other ${escapeEmailHtml(appName)} products anytime.
    </p>
    <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:10px;padding:16px;margin:0 0 12px;">
      <p style="margin:0 0 8px;color:#212529;font-weight:700;">Ready to continue?</p>
      <ul style="margin:0;padding-left:18px;color:#495057;line-height:1.6;">
        <li>Order a physical BizCard and keep networking offline + online</li>
        <li>Browse subscriptions, templates, and limited offers in E-Market</li>
        <li>Share a quick note about what worked (or what didn't)</li>
      </ul>
    </div>
    ${ctaButton(params.shopUrl, "Browse BizCards & products")}
    <p style="text-align:center;margin:8px 0 0;">
      <a href="${escapeEmailHtml(params.feedbackUrl)}" style="color:#2A4792;font-size:13px;">Share your experience</a>
    </p>
    <p style="color:#868e96;font-size:12px;margin:20px 0 0;line-height:1.5;">
      If you already upgraded or no longer wish to hear from us, you can ignore this message or manage email preferences in Settings.
    </p>`;

  const text =
    `Hi ${params.firstName || "there"},\n\n` +
    `Your ${appName} free trial ended about ${days} days ago. We'd love to hear about your experience.\n` +
    `Browse BizCards & products: ${params.shopUrl}\n` +
    `Share feedback: ${params.feedbackUrl}\n\n` +
    `— The ${appName} Team`;

  return { subject, html: emailShell(body), text };
}

/** Daily BizCard activity summary (only when there was activity). */
export function buildBizcardDailyReportEmail(params: {
  firstName: string;
  reportDate: string;
  profileViews: number;
  contactSaves: number;
  inquiries: number;
  analyticsUrl: string;
  inquiryUrl: string;
  appName?: string;
}): { subject: string; html: string; text: string } {
  const appName = params.appName || process.env.EMAIL_FROM_NAME || "OnTap";
  const firstName = escapeEmailHtml(params.firstName || "there");
  const views = Math.max(0, Number(params.profileViews) || 0);
  const saves = Math.max(0, Number(params.contactSaves) || 0);
  const inquiries = Math.max(0, Number(params.inquiries) || 0);
  const reportDate = escapeEmailHtml(params.reportDate);
  const subject = `Your BizCard daily report — ${params.reportDate}`;

  const metric = (label: string, value: number) => `<td style="width:33%;padding:8px;">
  <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:10px;padding:14px;text-align:center;">
    <p style="margin:0 0 4px;color:#868e96;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">${label}</p>
    <p style="margin:0;color:#2A4792;font-size:22px;font-weight:700;">${value}</p>
  </div>
</td>`;

  const body = `
    <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">BizCard activity for ${reportDate}</h2>
    <p style="color:#495057;line-height:1.6;margin:0 0 18px;">
      Hi ${firstName}, here is your daily ${escapeEmailHtml(appName)} BizCard report. You had new engagement today:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
      <tr>
        ${metric("Profile views", views)}
        ${metric("Contact saves", saves)}
        ${metric("Inquiries", inquiries)}
      </tr>
    </table>
    <p style="color:#495057;line-height:1.6;margin:0 0 8px;">
      Open Analytics for visitor details, or check Inquiry to reply to new messages.
    </p>
    ${ctaButton(params.analyticsUrl, "View analytics")}
    ${
      inquiries > 0
        ? `<p style="text-align:center;margin:8px 0 0;">
      <a href="${escapeEmailHtml(params.inquiryUrl)}" style="color:#2A4792;font-size:13px;">Open inquiries (${inquiries})</a>
    </p>`
        : ""
    }`;

  const text =
    `Hi ${params.firstName || "there"},\n\n` +
    `BizCard daily report for ${params.reportDate}:\n` +
    `Profile views: ${views}\nContact saves: ${saves}\nInquiries: ${inquiries}\n\n` +
    `Analytics: ${params.analyticsUrl}\n` +
    (inquiries > 0 ? `Inquiries: ${params.inquiryUrl}\n` : "") +
    `\n— The ${appName} Team`;

  return { subject, html: emailShell(body), text };
}

// ──────────────────────────────────────────
// OTP Code Block (reusable HTML block)
// ──────────────────────────────────────────
// Renders the prominent OTP code box used in multiple email types.

function otpBlock(otp: string): string {
  // Split OTP into individual characters for visual spacing
  const chars = otp.split("").map(
    (c) => `<span style="display:inline-block;width:40px;height:52px;line-height:52px;
                         text-align:center;font-size:28px;font-weight:700;color:#2A4792;
                         background:#f0f2f5;border-radius:8px;margin:0 4px;">${c}</span>`
  ).join("");

  return `
    <div style="background:#f8f9fa;border:2px dashed #dee2e6;border-radius:12px;
                padding:24px;text-align:center;margin:18px 0;">
      <p style="margin:0 0 12px;color:#6c757d;font-size:13px;text-transform:uppercase;
                letter-spacing:1px;">Your One-Time Code</p>
      <div style="display:inline-block;">${chars}</div>
    </div>`;
}

// ──────────────────────────────────────────
// 1. Password Reset Email
// ──────────────────────────────────────────

/**
 * Send a password reset verification code to the user.
 * Used by the forgot-password → verify-code → reset-password flow.
 *
 * @param to         - Recipient email address
 * @param code       - Plain-text 6-char code (BEFORE hashing)
 * @param expiryMins - Minutes until expiry (shown in email body)
 */
export async function sendVerificationEmail(
  to: string,
  code: string,
  expiryMins: number = 10
): Promise<void> {
  const transport = createTransporter();
  const appName = process.env.EMAIL_FROM_NAME || "OnTap Team";

  const body = `
    <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">Password Reset Request</h2>
    <p style="color:#495057;line-height:1.6;margin:0 0 16px;">
      We received a request to reset the password for your <strong>${appName}</strong> account.
      Use the code below to proceed. This code is valid for <strong>${expiryMins} minutes</strong>.
    </p>
    ${otpBlock(code)}
    <p style="color:#495057;line-height:1.6;margin:16px 0 0;">
      Enter this code on the password reset page. Do <strong>not</strong> share it with anyone.
    </p>
    <p style="color:#4785B8;font-size:13px;margin:16px 0 0;">
      Didn't request a password reset? No action is needed &mdash; your account remains secure.
    </p>`;

  try {
    await transport.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `Your ${appName} Password Reset Code`,
      html: emailShell(body),
      text: `Your ${appName} password reset code is: ${code}\n\nThis code expires in ${expiryMins} minutes.\n\nIf you did not request this, ignore this email.`,
    });
  } finally {
    transport.close();
  }
}

// ──────────────────────────────────────────
// 2. Registration Email Verification OTP
// ──────────────────────────────────────────

/**
 * Send an email verification OTP after user registration.
 * The user must verify their email before the account is fully activated.
 *
 * @param to         - Recipient email address
 * @param firstName  - User's first name for personalization
 * @param otp        - Plain-text 6-char OTP (BEFORE hashing)
 * @param expiryMins - Minutes until expiry (shown in email body)
 */
export async function sendEmailVerificationOtp(
  to: string,
  firstName: string,
  otp: string,
  expiryMins: number = 10
): Promise<void> {
  const transport = createTransporter();
  const appName = process.env.EMAIL_FROM_NAME || "OnTap Team";

  const body = `
    <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">
      Welcome to ${appName}, ${firstName}!
    </h2>
    <p style="color:#495057;line-height:1.6;margin:0 0 16px;">
      You're almost there! To finish creating your account, please verify your email address
      by entering the code below. This code expires in <strong>${expiryMins} minutes</strong>.
    </p>
    ${otpBlock(otp)}
    <p style="color:#495057;line-height:1.6;margin:16px 0 0;">
      Simply enter this code on the verification page to activate your account.
      Do <strong>not</strong> share this code with anyone.
    </p>
    <div style="margin-top:24px;padding:16px;background:#e8f4fd;border-radius:8px;border-left:4px solid #339af0;">
      <p style="margin:0;color:#1971c2;font-size:13px;">
        <strong>Why verify?</strong> Email verification keeps your account secure and ensures
        you can recover access if you ever forget your password.
      </p>
    </div>
    <p style="color:#4785B8;font-size:13px;margin:20px 0 0;">
      Didn't create an account? You can safely ignore this email.
    </p>`;

  try {
    await transport.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `Verify your ${appName} email address`,
      html: emailShell(body),
      text: `Welcome to ${appName}, ${firstName}!\n\nYour email verification code is: ${otp}\n\nThis code expires in ${expiryMins} minutes.\n\nIf you didn't create this account, ignore this email.`,
    });
  } finally {
    transport.close();
  }
}

export async function sendEmailMessage(params: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}): Promise<void> {
  const transport = createTransporter();
  const appName = process.env.EMAIL_FROM_NAME || "OnTap Team";

  try {
    await transport.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    });
  } finally {
    transport.close();
  }
}

// ──────────────────────────────────────────
// 3. Order Confirmation Email
// ──────────────────────────────────────────

export interface OrderEmailItem {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  type: "merchandise" | "template" | "subscription";
}

export interface OrderEmailData {
  orderNumber: string;
  customerName: string;
  items: OrderEmailItem[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  shippingAmount: number;
  totalAmount: number;
  currency: string;
  paymentMethod?: string;
  shippingAddress?: Record<string, unknown> | null;
}

/**
 * Send an order confirmation email after a successful checkout.
 */
export async function sendOrderConfirmationEmail(
  to: string,
  data: OrderEmailData
): Promise<void> {
  const transport = createTransporter();
  const appName = process.env.EMAIL_FROM_NAME || "OnTap Team";
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: data.currency }).format(n);

  const itemRows = data.items
    .map(
      (item) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #f0f2f5;color:#495057;">
          ${item.name}
          <span style="color:#adb5bd;font-size:12px;margin-left:4px;">(${item.type})</span>
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #f0f2f5;color:#495057;text-align:center;">${item.quantity}</td>
        <td style="padding:10px 0;border-bottom:1px solid #f0f2f5;color:#495057;text-align:right;">${fmt(item.totalPrice)}</td>
      </tr>`
    )
    .join("");

  const discountRow =
    data.discountAmount > 0
      ? `<tr>
          <td colspan="2" style="padding:6px 0;color:#2f9e44;text-align:right;">Discount</td>
          <td style="padding:6px 0;color:#2f9e44;text-align:right;">-${fmt(data.discountAmount)}</td>
        </tr>`
      : "";

  const shippingRow =
    data.shippingAmount > 0
      ? `<tr>
          <td colspan="2" style="padding:6px 0;color:#495057;text-align:right;">Shipping</td>
          <td style="padding:6px 0;color:#495057;text-align:right;">${fmt(data.shippingAmount)}</td>
        </tr>`
      : "";

  const ordersUrl = appPageUrl(
    data.orderNumber
      ? `/user/orders/${encodeURIComponent(data.orderNumber)}`
      : "/user/orders",
  );

  const body = `
    <h2 style="margin:0 0 4px;color:#2A4792;font-size:22px;">Order Confirmed!</h2>
    <p style="color:#495057;margin:0 0 20px;">
      Hi ${data.customerName}, your order <strong>${data.orderNumber}</strong> has been received and is being processed.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <thead>
        <tr style="border-bottom:2px solid #dee2e6;">
          <th style="padding:8px 0;text-align:left;color:#6c757d;font-size:12px;text-transform:uppercase;">Item</th>
          <th style="padding:8px 0;text-align:center;color:#6c757d;font-size:12px;text-transform:uppercase;">Qty</th>
          <th style="padding:8px 0;text-align:right;color:#6c757d;font-size:12px;text-transform:uppercase;">Price</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="padding:6px 0;color:#6c757d;text-align:right;">Subtotal</td>
          <td style="padding:6px 0;color:#6c757d;text-align:right;">${fmt(data.subtotal)}</td>
        </tr>
        ${discountRow}
        <tr>
          <td colspan="2" style="padding:6px 0;color:#495057;text-align:right;">Tax</td>
          <td style="padding:6px 0;color:#495057;text-align:right;">${fmt(data.taxAmount)}</td>
        </tr>
        ${shippingRow}
        <tr style="border-top:2px solid #dee2e6;">
          <td colspan="2" style="padding:10px 0;font-weight:700;color:#2A4792;text-align:right;font-size:16px;">Total</td>
          <td style="padding:10px 0;font-weight:700;color:#2A4792;text-align:right;font-size:16px;">${fmt(data.totalAmount)}</td>
        </tr>
      </tfoot>
    </table>

    <p style="color:#495057;margin:16px 0 4px;font-size:13px;">
      You can view your order and track its status under <strong>Purchases</strong> in your account.
    </p>
    ${ctaButton(ordersUrl, "View order")}
    <p style="color:#4785B8;font-size:13px;margin:8px 0 0;">
      Thank you for shopping with ${appName}!
    </p>`;

  try {
    await transport.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `Order Confirmed: ${data.orderNumber}`,
      html: emailShell(body),
      text: `Your order ${data.orderNumber} has been confirmed. Total: ${fmt(data.totalAmount)}. View order: ${ordersUrl}`,
    });
  } finally {
    transport.close();
  }
}

// ──────────────────────────────────────────
// 4. Subscription Confirmation Email
// ──────────────────────────────────────────

/**
 * Notify a user when their subscription is activated, upgraded, or renewed.
 */
export async function sendSubscriptionConfirmationEmail(
  to: string,
  params: {
    customerName: string;
    planName: string;
    billingCycle: "monthly" | "yearly";
    amount: number;
    currency: string;
    expiresAt: Date;
    isUpgrade: boolean;
  }
): Promise<void> {
  const transport = createTransporter();
  const appName = process.env.EMAIL_FROM_NAME || "OnTap Team";
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: params.currency }).format(n);

  const title = params.isUpgrade ? "Subscription Upgraded!" : "Subscription Activated!";
  const action = params.isUpgrade ? "upgraded to" : "subscribed to";
  const manageUrl = appPageUrl("/user/emarket?tab=subscription");

  const body = `
    <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">${title}</h2>
    <p style="color:#495057;line-height:1.6;margin:0 0 16px;">
      Hi ${params.customerName}, you've successfully ${action} the
      <strong>${params.planName}</strong> plan
      (${params.billingCycle === "yearly" ? "Yearly" : "Monthly"} billing).
    </p>
    <div style="background:#f0f9f0;border:1px solid #a9e34b;border-radius:8px;padding:16px;margin:0 0 16px;">
      <p style="margin:0;color:#2f9e44;font-size:14px;">
        <strong>Amount charged:</strong> ${fmt(params.amount)}<br/>
        <strong>Next billing date:</strong> ${params.expiresAt.toLocaleDateString("en-US", { dateStyle: "long" })}
      </p>
    </div>
    <p style="color:#495057;font-size:13px;margin:0 0 8px;">
      Manage your subscription anytime from the E-Market subscription tab.
    </p>
    ${ctaButton(manageUrl, "Manage subscription")}`;

  try {
    await transport.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `${appName} ${title}`,
      html: emailShell(body),
      text: `You've ${action} the ${params.planName} plan. Amount: ${fmt(params.amount)}. Next billing: ${params.expiresAt.toISOString()}. Manage: ${manageUrl}`,
    });
  } finally {
    transport.close();
  }
}