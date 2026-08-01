// ──────────────────────────────────────────────────────────────
// Email Service — Nodemailer SMTP Transport
// ──────────────────────────────────────────────────────────────
// Centralized email sending with error handling.
// Configured via environment variables — no secrets in code.
//
// Functions exported:
//  - sendVerificationEmail       → password reset OTP
//  - sendEmailVerificationOtp    → registration email verification OTP
// ──────────────────────────────────────────────────────────────

import nodemailer from "nodemailer";

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
      You can view your order and track its status in your account dashboard under <strong>Purchases</strong>.
    </p>
    <p style="color:#4785B8;font-size:13px;margin:8px 0 0;">
      Thank you for shopping with ${appName}!
    </p>`;

  try {
    await transport.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `Order Confirmed: ${data.orderNumber}`,
      html: emailShell(body),
      text: `Your order ${data.orderNumber} has been confirmed. Total: ${fmt(data.totalAmount)}. Log in to view your order details.`,
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
    <p style="color:#495057;font-size:13px;margin:0;">
      Manage your subscription anytime from your account settings.
    </p>`;

  try {
    await transport.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `${appName} ${title}`,
      html: emailShell(body),
      text: `You've ${action} the ${params.planName} plan. Amount: ${fmt(params.amount)}. Next billing: ${params.expiresAt.toISOString()}.`,
    });
  } finally {
    transport.close();
  }
}