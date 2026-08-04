import { buildEmailShell, escapeEmailHtml } from "@/server/lib/email";

type TemplateInput = Record<string, unknown>;

/** Canonical in-app destinations used by email CTAs (must match Next.js app/ routes). */
const PATHS = {
  userDashboard: "/user/dashboard",
  userAnalytics: "/user/analytics",
  userAssociate: "/user/associate",
  userOrders: "/user/orders",
  userSettings: "/user/settings",
  userAffiliate: "/user/affiliate",
  userCart: "/user/emarket?tab=cart",
  userEmarket: "/user/emarket",
  userSubscription: "/user/emarket?tab=subscription",
  userInquiry: "/user/inquiry",
  adminDashboard: "/admin/dashboard",
} as const;

function esc(value: unknown): string {
  return escapeEmailHtml(value);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Join app base URL with a relative path, or pass through absolute http(s)/mailto links. */
function resolveAppLink(appUrl: unknown, pathOrUrl: string): string {
  const raw = String(pathOrUrl ?? "").trim();
  if (!raw) return String(appUrl ?? "").trim().replace(/\/$/, "");
  if (/^https?:\/\//i.test(raw) || raw.startsWith("mailto:")) return raw;
  const base = String(appUrl ?? "").trim().replace(/\/$/, "");
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return `${base}${path}`;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function cta(href: string, label: string): string {
  if (!href.trim()) return "";
  return `<p style="margin:28px 0 8px;text-align:center;">
  <a href="${esc(href)}" style="display:inline-block;background:#2A4792;color:#ffffff;padding:14px 28px;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;">${esc(label)}</a>
</p>`;
}

function metricCard(label: string, value: string | number): string {
  return `<td style="width:33%;padding:8px;">
  <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:10px;padding:14px;text-align:center;">
    <p style="margin:0 0 4px;color:#868e96;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">${esc(label)}</p>
    <p style="margin:0;color:#2A4792;font-size:22px;font-weight:700;">${esc(value)}</p>
  </div>
</td>`;
}

/**
 * Renders queued notification / cron email HTML.
 * Templates used by cron jobs:
 * - daily-digest, weekly-roundup
 * - company-daily-summary, company-weekly-summary, company-top-performer
 * - marketing_campaign (scheduled newsletters)
 * - order-feedback-request
 * - system-update (and related event templates processed by the email queue)
 */
export function renderNotificationTemplate(
  template: string,
  data: TemplateInput,
): { subject: string; html: string; text: string } {
  const app = esc(data.app_name ?? "OnTap");
  const user = esc(data.user_name ?? "there");
  const appUrl = String(data.app_url ?? "").trim();

  switch (template) {
    case "daily-digest": {
      const subject = `${app} Daily Digest — your activity summary`;
      const openUrl = resolveAppLink(appUrl, PATHS.userDashboard);
      const rows = Array.isArray(data.items) ? data.items : [];
      const items = rows
        .map((row) => {
          const r = row as Record<string, unknown>;
          const count = toNumber(r.count);
          return `<tr>
            <td style="padding:12px 0;border-bottom:1px solid #f1f3f5;color:#212529;">
              <strong style="color:#2A4792;">${esc(r.title ?? "Update")}</strong>
              ${count > 1 ? `<span style="color:#868e96;font-size:12px;"> × ${count}</span>` : ""}
              <div style="color:#495057;font-size:13px;margin-top:4px;line-height:1.5;">${esc(r.message ?? "")}</div>
            </td>
          </tr>`;
        })
        .join("");
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">Good day, ${user}</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 20px;">
          Here is your <strong>daily digest</strong> of notifications and activity on ${app}.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0">${items || `<tr><td style="padding:12px 0;color:#868e96;">No new updates today. You're all caught up.</td></tr>`}</table>
        ${cta(openUrl, "Open dashboard")}
        <p style="color:#868e96;font-size:12px;margin:16px 0 0;">You can change digest preferences anytime in Settings → Notifications.</p>
      `);
      const text =
        `Hi ${String(data.user_name ?? "there")},\n\nYour ${String(data.app_name ?? "OnTap")} daily digest is ready.\n` +
        `Open dashboard: ${openUrl}\n`;
      return { subject, html, text };
    }

    case "weekly-roundup": {
      const subject = `${app} Weekly Roundup — insights & activity`;
      const openUrl = resolveAppLink(appUrl, PATHS.userAnalytics);
      const rows = Array.isArray(data.items) ? data.items : [];
      const items = rows
        .map((row) => {
          const r = row as Record<string, unknown>;
          const count = toNumber(r.count);
          return `<li style="margin:0 0 10px;color:#495057;line-height:1.5;">
            <strong style="color:#2A4792;">${esc(r.title ?? "Update")}</strong>${count > 1 ? ` (${count})` : ""} — ${esc(r.message ?? "")}
          </li>`;
        })
        .join("");
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">Your week on ${app}</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">Hi ${user}, here is your weekly roundup of important activity.</p>
        <ul style="padding-left:18px;margin:0 0 8px;">${items || "<li style='color:#868e96;'>No notable updates this week.</li>"}</ul>
        ${cta(openUrl, "View analytics")}
        <p style="color:#868e96;font-size:12px;margin:16px 0 0;">Tip: Weekly digests help you catch profile views, connections, and system updates without inbox noise.</p>
      `);
      const text =
        `Hi ${String(data.user_name ?? "there")},\n\nYour ${String(data.app_name ?? "OnTap")} weekly roundup is ready.\n` +
        `Open analytics: ${openUrl}\n`;
      return { subject, html, text };
    }

    case "friend-request": {
      const sender = esc(data.sender_name ?? "Someone");
      const openUrl = resolveAppLink(appUrl, PATHS.userAssociate);
      const subject = `${sender} wants to connect with you on ${app}`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">New connection request</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">Hi ${user}, <strong>${sender}</strong> sent you a friend request.</p>
        <p style="color:#495057;line-height:1.6;margin:0 0 8px;">Accepting helps grow your professional network and keep conversations organized in one place.</p>
        ${cta(openUrl, "Review request")}
      `);
      const text = `${String(data.sender_name ?? "Someone")} sent you a friend request. Open ${openUrl}`;
      return { subject, html, text };
    }

    case "profile-view": {
      const viewer = esc(data.viewer_name ?? "Someone");
      const openUrl = resolveAppLink(appUrl, PATHS.userAnalytics);
      const subject = `New profile view on ${app}`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">Someone viewed your profile</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">Hi ${user}, <strong>${viewer}</strong> recently viewed your digital profile.</p>
        ${cta(openUrl, "View analytics")}
      `);
      const text = `${String(data.viewer_name ?? "Someone")} viewed your profile. Open ${openUrl}`;
      return { subject, html, text };
    }

    case "contact-download": {
      const openUrl = resolveAppLink(appUrl, PATHS.userAnalytics);
      const subject = `Contact download alert — ${app}`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">Your contact details were saved</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">Hi ${user}, someone downloaded your contact details from your ${app} profile.</p>
        ${cta(openUrl, "View analytics")}
      `);
      const text = `Someone downloaded your contact details. Open ${openUrl}`;
      return { subject, html, text };
    }

    case "system-update": {
      const update = esc(data.update_title ?? "Platform update");
      const message = esc(data.message ?? "");
      const actionPath =
        firstString(data.action_url, data.cta_url, data.ctaUrl, data.survey_url, data.surveyUrl) ||
        PATHS.userDashboard;
      const actionLabel =
        firstString(data.action_text, data.cta_label, data.ctaLabel) || "Open dashboard";
      const openUrl = resolveAppLink(appUrl, actionPath);
      const subject = `${app} Update — ${String(data.update_title ?? "Platform update")}`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">${update}</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">Hi ${user},</p>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">${message || "We published an important platform update for your account."}</p>
        <div style="background:#e8f4fd;border-left:4px solid #339af0;border-radius:8px;padding:14px 16px;margin:0 0 8px;">
          <p style="margin:0;color:#1971c2;font-size:13px;line-height:1.5;">Stay informed about feature releases, maintenance windows, and security notices from the ${app} team.</p>
        </div>
        ${cta(openUrl, actionLabel)}
      `);
      const text = `${String(data.update_title ?? "Platform update")}\n${String(data.message ?? "")}\nOpen ${openUrl}`;
      return { subject, html, text };
    }

    case "company-daily-summary": {
      const company = esc(data.company_name ?? "Your company");
      const openUrl = resolveAppLink(appUrl, PATHS.adminDashboard);
      const metrics = toRecord(data.metrics) ?? {};
      const profileViews = toNumber(metrics.profile_views);
      const leads = toNumber(metrics.leads_generated);
      const inquiries = toNumber(metrics.inquiries);
      const employees = toNumber(metrics.total_employees);
      const top = toRecord(data.top_employee);
      const topName = top ? esc(top.name ?? "N/A") : null;
      const topViews = top ? toNumber(top.profile_views) : 0;

      const subject = `${String(data.company_name ?? "Company")} — Daily team summary`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">Daily team summary</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 18px;">Hi ${user}, here is today's performance snapshot for <strong>${company}</strong>.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
          <tr>
            ${metricCard("Profile views", profileViews)}
            ${metricCard("Leads", leads)}
            ${metricCard("Inquiries", inquiries)}
          </tr>
        </table>
        <p style="color:#495057;margin:0 0 8px;font-size:14px;"><strong>Active employees tracked:</strong> ${employees}</p>
        ${
          topName
            ? `<div style="background:#f0f9f0;border:1px solid #a9e34b;border-radius:10px;padding:14px;margin:12px 0 8px;">
          <p style="margin:0;color:#2f9e44;font-size:14px;"><strong>Top performer today:</strong> ${topName} (${topViews} views)</p>
        </div>`
            : ""
        }
        ${cta(openUrl, "Open company dashboard")}
      `);

      const text =
        `${String(data.company_name ?? "Company")} daily summary\n` +
        `Profile views: ${profileViews}\nLeads: ${leads}\nInquiries: ${inquiries}\nEmployees: ${employees}\n` +
        `${topName ? `Top performer: ${String(top?.name)} (${topViews} views)\n` : ""}` +
        `Open: ${openUrl}`;
      return { subject, html, text };
    }

    case "company-weekly-summary": {
      const company = esc(data.company_name ?? "Your company");
      const openUrl = resolveAppLink(appUrl, PATHS.adminDashboard);
      const metrics = toRecord(data.metrics) ?? {};
      const profileViews = toNumber(metrics.profile_views);
      const leads = toNumber(metrics.leads_generated);
      const inquiries = toNumber(metrics.inquiries);
      const rankings = Array.isArray(data.top_rankings) ? data.top_rankings : [];

      const rankingItems = rankings
        .map((row, index) => {
          const r = toRecord(row) ?? {};
          const name = esc(r.name ?? "Unknown");
          const metric = toNumber(r.metric_value);
          const trend = esc(r.trend ?? "0%");
          return `<tr>
            <td style="padding:10px 0;border-bottom:1px solid #f1f3f5;color:#212529;font-weight:700;">#${index + 1}</td>
            <td style="padding:10px 0;border-bottom:1px solid #f1f3f5;color:#495057;">${name}</td>
            <td style="padding:10px 0;border-bottom:1px solid #f1f3f5;color:#2A4792;text-align:right;">${metric} views</td>
            <td style="padding:10px 0;border-bottom:1px solid #f1f3f5;color:#868e96;text-align:right;">${trend}</td>
          </tr>`;
        })
        .join("");

      const subject = `${String(data.company_name ?? "Company")} — Weekly team summary`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">Weekly team summary</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 18px;">Hi ${user}, your 7-day performance report for <strong>${company}</strong> is ready.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
          <tr>
            ${metricCard("Profile views", profileViews)}
            ${metricCard("Leads", leads)}
            ${metricCard("Inquiries", inquiries)}
          </tr>
        </table>
        <h3 style="margin:8px 0 8px;color:#212529;font-size:16px;">Top performers</h3>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${rankingItems || `<tr><td style="padding:10px 0;color:#868e96;">No ranking data available this week.</td></tr>`}
        </table>
        ${cta(openUrl, "Open company dashboard")}
      `);

      const text =
        `${String(data.company_name ?? "Company")} weekly summary\n` +
        `Profile views: ${profileViews}\nLeads: ${leads}\nInquiries: ${inquiries}\n` +
        `Open: ${openUrl}`;
      return { subject, html, text };
    }

    case "company-top-performer": {
      const company = esc(data.company_name ?? "Your company");
      const performer = esc(data.performer_name ?? "Unknown");
      const role = esc(data.performer_role ?? "employee");
      const views = toNumber(data.profile_views);
      const openUrl = resolveAppLink(appUrl, PATHS.adminDashboard);

      const subject = `${String(data.company_name ?? "Company")} — Top performer alert`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">Top performer alert</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">Hi ${user},</p>
        <div style="background:#f0f9f0;border:1px solid #a9e34b;border-radius:12px;padding:18px;margin:0 0 16px;">
          <p style="margin:0 0 6px;color:#2f9e44;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">Leading today</p>
          <p style="margin:0 0 4px;color:#212529;font-size:18px;font-weight:700;">${performer}</p>
          <p style="margin:0;color:#495057;font-size:14px;">Role: ${role}<br/>Profile views: <strong>${views}</strong><br/>Company: ${company}</p>
        </div>
        ${cta(openUrl, "View company dashboard")}
      `);

      const text =
        `${String(data.performer_name ?? "Unknown")} is leading profile views today at ${String(data.company_name ?? "your company")}.\n` +
        `Role: ${String(data.performer_role ?? "employee")}\nViews: ${views}\n` +
        `Open: ${openUrl}`;
      return { subject, html, text };
    }

    case "marketing_campaign": {
      const title = esc(data.title ?? "Newsletter");
      const recipientName = esc(data.recipientName ?? user);
      const settingsUrl = resolveAppLink(appUrl, PATHS.userSettings);
      const rawContent = typeof data.content === "string" ? data.content : String(data.content ?? "");
      const contentHtml = rawContent.trim()
        ? rawContent
            .split("\n")
            .map((line) => `<p style="margin:0 0 12px;color:#495057;line-height:1.6;">${esc(line)}</p>`)
            .join("")
        : "";
      const imageUrls = Array.isArray(data.image_urls)
        ? data.image_urls.filter((u): u is string => typeof u === "string" && u.trim().length > 0)
        : typeof data.image_urls === "string" && data.image_urls.trim()
          ? [data.image_urls.trim()]
          : [];
      const imagesHtml = imageUrls
        .map(
          (img) =>
            `<div style="margin:16px 0;text-align:center;">
  <img src="${esc(img)}" alt="${title}" style="max-width:100%;width:auto;height:auto;display:inline-block;border:0;outline:none;text-decoration:none;border-radius:8px;" />
</div>`,
        )
        .join("");
      const subject = typeof data.title === "string" ? data.title : "Newsletter";
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">${title}</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">Hi ${recipientName},</p>
        ${contentHtml}
        ${imagesHtml}
        <p style="margin-top:24px;font-size:12px;color:#868e96;line-height:1.5;">
          You received this because you opted in to promotional emails from ${app}.
          <a href="${esc(settingsUrl)}" style="color:#2A4792;">Manage preferences</a>
        </p>
      `);
      const text =
        `Hi ${String(data.recipientName ?? data.user_name ?? "there")},\n\n${rawContent}` +
        (imageUrls.length ? `\n\nImages:\n${imageUrls.join("\n")}` : "") +
        `\n\nManage preferences: ${settingsUrl}\n`;
      return { subject, html, text };
    }

    case "order-feedback-request": {
      const orderNumber = esc(data.order_number ?? "");
      const itemSummary = esc(data.item_summary ?? "your recent purchase");
      const feedbackUrlRaw =
        firstString(data.feedback_url, data.feedbackUrl) ||
        resolveAppLink(appUrl, PATHS.userOrders);
      const feedbackUrl = /^https?:\/\//i.test(feedbackUrlRaw)
        ? feedbackUrlRaw
        : resolveAppLink(appUrl, feedbackUrlRaw);
      const ctaLabel = firstString(data.feedback_url, data.feedbackUrl)
        ? "Share your feedback"
        : "View your orders";
      const subject = `Thank you for your ${String(data.app_name ?? "OnTap")} purchase — we'd love your feedback`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">Thank you, ${user}!</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 14px;">
          We appreciate you trusting <strong>${app}</strong> and shopping with us.
        </p>
        <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:10px;padding:16px;margin:0 0 16px;">
          <p style="margin:0;color:#495057;font-size:14px;line-height:1.6;">
            <strong>Order:</strong> ${orderNumber}<br/>
            <strong>Items:</strong> ${itemSummary}
          </p>
        </div>
        <p style="color:#495057;line-height:1.6;margin:0 0 8px;">
          When you have a moment, your feedback helps us improve quality, fulfillment, and support.
        </p>
        ${cta(feedbackUrl, ctaLabel)}
        <p style="font-size:12px;color:#868e96;margin:12px 0 0;word-break:break-all;">Or copy this link: ${esc(feedbackUrl)}</p>
        <p style="margin:20px 0 0;color:#495057;">With appreciation,<br/><strong>The ${app} Team</strong></p>
      `);
      const text =
        `Thank you, ${String(data.user_name ?? "there")}!\n\n` +
        `We appreciate your purchase with ${String(data.app_name ?? "OnTap")}.\n` +
        `Order ${String(data.order_number ?? "")}: ${String(data.item_summary ?? "your recent purchase")}.\n\n` +
        `${ctaLabel}: ${feedbackUrl}\n`;
      return { subject, html, text };
    }

    case "abandoned_cart":
    case "abandoned-cart": {
      const cartUrl = resolveAppLink(
        appUrl,
        firstString(data.cartUrl, data.cart_url) || PATHS.userCart,
      );
      const items = Array.isArray(data.items) ? data.items : [];
      const itemLines = items
        .map((row) => {
          const r = toRecord(row) ?? {};
          return `<li style="margin:0 0 8px;color:#495057;"><strong>${esc(r.name ?? "Item")}</strong> × ${toNumber(r.quantity) || 1}</li>`;
        })
        .join("");
      const subject = `Your ${String(data.app_name ?? "OnTap")} cart is waiting — complete your purchase`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">Don't miss out, ${user}</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">You left items in your cart. Complete checkout when you're ready.</p>
        <ul style="padding-left:18px;">${itemLines || "<li style='color:#868e96;'>Your saved cart is still available.</li>"}</ul>
        ${cta(cartUrl, "Return to cart")}
      `);
      const text = `Hi ${String(data.user_name ?? "there")},\nYour cart is waiting: ${cartUrl}\n`;
      return { subject, html, text };
    }

    case "subscription-expiry": {
      const title = esc(data.title ?? "Subscription reminder");
      const message = esc(data.message ?? "Your subscription needs attention.");
      const renewUrl = resolveAppLink(
        appUrl,
        firstString(data.renew_url, data.renewUrl) || PATHS.userSubscription,
      );
      const expiry = esc(data.expires_at_label ?? data.expires_at ?? "");
      const plan = data.plan_label ? esc(data.plan_label) : null;
      const subject = `${String(data.app_name ?? "OnTap")}: ${String(data.title ?? "Subscription reminder")}`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">${title}</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 14px;">Hi ${user},</p>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">${message}</p>
        <div style="background:#fff9db;border:1px solid #ffe066;border-radius:10px;padding:16px;margin:0 0 12px;">
          ${plan ? `<p style="margin:0 0 4px;color:#495057;"><strong>Plan:</strong> ${plan}</p>` : ""}
          ${expiry ? `<p style="margin:0;color:#495057;"><strong>Expiry:</strong> ${expiry}</p>` : ""}
        </div>
        ${cta(renewUrl, "Renew or manage subscription")}
      `);
      const text = `${String(data.title ?? "Subscription reminder")}\n${String(data.message ?? "")}\nRenew: ${renewUrl}\n`;
      return { subject, html, text };
    }

    case "trial-experience-followup":
    case "trial_experience_followup": {
      const days = toNumber(data.days_expired) || 7;
      const shopUrl = resolveAppLink(
        appUrl,
        firstString(data.shop_url, data.shopUrl) || PATHS.userEmarket,
      );
      const feedbackUrl = resolveAppLink(
        appUrl,
        firstString(data.feedback_url, data.feedbackUrl) || PATHS.userInquiry,
      );
      const subject = `How was your ${String(data.app_name ?? "OnTap")} free trial? We'd love your feedback`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">We miss you, ${user}</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">
          Your free trial ended about <strong>${days} days</strong> ago. We'd love to hear about your experience —
          and when you're ready, browse BizCards and other ${app} products in E-Market.
        </p>
        ${cta(shopUrl, "Browse BizCards & products")}
        <p style="text-align:center;margin:8px 0 0;">
          <a href="${esc(feedbackUrl)}" style="color:#2A4792;font-size:13px;">Share your experience</a>
        </p>
      `);
      const text = `Hi ${String(data.user_name ?? "there")},\nYour trial ended ~${days} days ago. Shop: ${shopUrl}\nFeedback: ${feedbackUrl}\n`;
      return { subject, html, text };
    }

    case "bizcard-daily-report":
    case "bizcard_daily_report": {
      const reportDate = esc(data.report_date ?? "");
      const views = toNumber(data.profile_views);
      const saves = toNumber(data.contact_saves);
      const inquiries = toNumber(data.inquiries);
      const analyticsUrl = resolveAppLink(
        appUrl,
        firstString(data.analytics_url, data.analyticsUrl) || PATHS.userAnalytics,
      );
      const inquiryUrl = resolveAppLink(
        appUrl,
        firstString(data.inquiry_url, data.inquiryUrl) || PATHS.userInquiry,
      );
      const subject = `Your BizCard daily report — ${String(data.report_date ?? "")}`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">BizCard activity for ${reportDate}</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 18px;">Hi ${user}, here is your daily BizCard report.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
          <tr>
            ${metricCard("Profile views", views)}
            ${metricCard("Contact saves", saves)}
            ${metricCard("Inquiries", inquiries)}
          </tr>
        </table>
        ${cta(analyticsUrl, "View analytics")}
        ${
          inquiries > 0
            ? `<p style="text-align:center;margin:8px 0 0;"><a href="${esc(inquiryUrl)}" style="color:#2A4792;font-size:13px;">Open inquiries (${inquiries})</a></p>`
            : ""
        }
      `);
      const text =
        `BizCard report ${String(data.report_date ?? "")}: views ${views}, saves ${saves}, inquiries ${inquiries}.\n` +
        `Analytics: ${analyticsUrl}\n`;
      return { subject, html, text };
    }

    default: {
      const title = esc(data.title ?? "Notification");
      const message = esc(data.message ?? "You have an update.");
      const actionPath =
        firstString(data.action_url, data.cta_url, data.ctaUrl) || PATHS.userDashboard;
      const actionLabel =
        firstString(data.action_text, data.cta_label, data.ctaLabel) || "Open dashboard";
      const openUrl = resolveAppLink(appUrl, actionPath);
      const subject = `${String(data.app_name ?? "OnTap")} Notification`;
      const html = buildEmailShell(`
        <h2 style="margin:0 0 8px;color:#2A4792;font-size:22px;">${title}</h2>
        <p style="color:#495057;line-height:1.6;margin:0 0 16px;">Hi ${user},</p>
        <p style="color:#495057;line-height:1.6;margin:0 0 8px;">${message}</p>
        ${cta(openUrl, actionLabel)}
      `);
      const text = `${String(data.title ?? "Notification")}: ${String(data.message ?? "You have an update.")}\nOpen: ${openUrl}`;
      return { subject, html, text };
    }
  }
}
