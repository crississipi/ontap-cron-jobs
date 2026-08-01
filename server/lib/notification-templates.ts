type TemplateInput = Record<string, unknown>;

function esc(value: unknown): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(title)}</title>
</head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#f6f8fb;padding:24px;color:#1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;">
    <tr><td style="padding:24px;">
      ${body}
    </td></tr>
  </table>
</body>
</html>`;
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

export function renderNotificationTemplate(template: string, data: TemplateInput): { subject: string; html: string; text: string } {
  const app = esc(data.app_name ?? "OnTap");
  const user = esc(data.user_name ?? "there");
  const url = esc(data.app_url ?? "");

  switch (template) {
    case "daily-digest": {
      const subject = `${app} Daily Digest`;
      const rows = Array.isArray(data.items) ? data.items : [];
      const items = rows
        .map((row) => {
          const r = row as Record<string, unknown>;
          return `<li><strong>${esc(r.title ?? "Update")}</strong> - ${esc(r.message ?? "")}</li>`;
        })
        .join("");
      const html = shell(
        subject,
        `<h2 style="margin-top:0;">Hi ${user},</h2>
<p>Here is your daily digest.</p>
<ul>${items || "<li>No new updates today.</li>"}</ul>
<p><a href="${url}/notifications">Open Notifications</a></p>`
      );
      const text = `Hi ${user},\n\nHere is your daily digest.\nOpen: ${url}/notifications`;
      return { subject, html, text };
    }

    case "friend-request": {
      const sender = esc(data.sender_name ?? "Someone");
      const subject = `${sender} wants to connect with you`;
      const html = shell(
        subject,
        `<h2 style="margin-top:0;">Hi ${user},</h2>
<p>${sender} sent you a friend request.</p>
<p><a href="${url}/connections">Review Request</a></p>`
      );
      const text = `${sender} sent you a friend request. Open ${url}/connections`;
      return { subject, html, text };
    }

    case "profile-view": {
      const viewer = esc(data.viewer_name ?? "Someone");
      const subject = `New profile view`;
      const html = shell(subject, `<h2 style="margin-top:0;">Hi ${user},</h2><p>${viewer} viewed your profile.</p><p><a href="${url}/insights">View Insights</a></p>`);
      const text = `${viewer} viewed your profile. Open ${url}/insights`;
      return { subject, html, text };
    }

    case "contact-download": {
      const subject = `Contact download alert`;
      const html = shell(subject, `<h2 style="margin-top:0;">Hi ${user},</h2><p>Someone downloaded your contact details.</p><p><a href="${url}/insights/contacts">View Contact Insights</a></p>`);
      const text = `Someone downloaded your contact details. Open ${url}/insights/contacts`;
      return { subject, html, text };
    }

    case "system-update": {
      const update = esc(data.update_title ?? "Platform update");
      const subject = `${app} Update - ${update}`;
      const html = shell(subject, `<h2 style="margin-top:0;">Hi ${user},</h2><p>${update}</p><p><a href="${url}/updates">Read Update</a></p>`);
      const text = `${update}. Open ${url}/updates`;
      return { subject, html, text };
    }

    case "weekly-roundup": {
      const subject = `${app} Weekly Roundup`;
      const html = shell(subject, `<h2 style="margin-top:0;">Hi ${user},</h2><p>Your weekly summary is ready.</p><p><a href="${url}/insights">View Report</a></p>`);
      const text = `Your weekly summary is ready. Open ${url}/insights`;
      return { subject, html, text };
    }

    case "company-daily-summary": {
      const company = esc(data.company_name ?? "Your company");
      const metrics = toRecord(data.metrics) ?? {};
      const profileViews = toNumber(metrics.profile_views);
      const leads = toNumber(metrics.leads_generated);
      const inquiries = toNumber(metrics.inquiries);
      const employees = toNumber(metrics.total_employees);
      const top = toRecord(data.top_employee);
      const topName = top ? esc(top.name ?? "N/A") : null;
      const topViews = top ? toNumber(top.profile_views) : 0;

      const subject = `${company} Daily Team Summary`;
      const html = shell(
        subject,
        `<h2 style="margin-top:0;">Hi ${user},</h2>
<p>Here is your daily team summary for ${company}.</p>
<ul>
  <li><strong>Profile views:</strong> ${profileViews}</li>
  <li><strong>Leads generated:</strong> ${leads}</li>
  <li><strong>Inquiries:</strong> ${inquiries}</li>
  <li><strong>Active employees tracked:</strong> ${employees}</li>
</ul>
${topName ? `<p><strong>Top performer:</strong> ${topName} (${topViews} views)</p>` : ""}
<p><a href="${url}/company/dashboard">Open Company Dashboard</a></p>`
      );

      const text =
        `${company} daily summary\n` +
        `Profile views: ${profileViews}\n` +
        `Leads generated: ${leads}\n` +
        `Inquiries: ${inquiries}\n` +
        `Active employees tracked: ${employees}\n` +
        `${topName ? `Top performer: ${topName} (${topViews} views)\n` : ""}` +
        `Open: ${url}/company/dashboard`;

      return { subject, html, text };
    }

    case "company-weekly-summary": {
      const company = esc(data.company_name ?? "Your company");
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
          return `<li>#${index + 1} ${name} - ${metric} views (${trend})</li>`;
        })
        .join("");

      const subject = `${company} Weekly Team Summary`;
      const html = shell(
        subject,
        `<h2 style="margin-top:0;">Hi ${user},</h2>
<p>Your weekly summary for ${company} is ready.</p>
<ul>
  <li><strong>Profile views:</strong> ${profileViews}</li>
  <li><strong>Leads generated:</strong> ${leads}</li>
  <li><strong>Inquiries:</strong> ${inquiries}</li>
</ul>
<h3 style="margin-bottom:8px;">Top performers</h3>
<ul>${rankingItems || "<li>No ranking data available this week.</li>"}</ul>
<p><a href="${url}/company/dashboard">Open Company Dashboard</a></p>`
      );

      const text =
        `${company} weekly summary\n` +
        `Profile views: ${profileViews}\n` +
        `Leads generated: ${leads}\n` +
        `Inquiries: ${inquiries}\n` +
        `${rankings.length > 0 ? "Top performers included in this email.\n" : ""}` +
        `Open: ${url}/company/dashboard`;

      return { subject, html, text };
    }

    case "company-top-performer": {
      const company = esc(data.company_name ?? "Your company");
      const performer = esc(data.performer_name ?? "Unknown");
      const role = esc(data.performer_role ?? "employee");
      const views = toNumber(data.profile_views);

      const subject = `${company} Top Performer Alert`;
      const html = shell(
        subject,
        `<h2 style="margin-top:0;">Hi ${user},</h2>
<p><strong>${performer}</strong> is currently leading profile views today at ${company}.</p>
<p>Role: ${role}<br/>Views: ${views}</p>
<p><a href="${url}/company/dashboard/top-employee/today">View Live Leaderboard</a></p>`
      );

      const text =
        `${performer} is currently leading profile views today at ${company}.\n` +
        `Role: ${role}\n` +
        `Views: ${views}\n` +
        `Open: ${url}/company/dashboard/top-employee/today`;

      return { subject, html, text };
    }

    case "marketing_campaign": {
      const title = esc(data.title ?? "Newsletter");
      const recipientName = esc(data.recipientName ?? user);
      const rawContent = typeof data.content === "string" ? data.content : String(data.content ?? "");
      const contentHtml = rawContent.trim()
        ? rawContent
            .split("\n")
            .map((line) => `<p style="margin:0 0 12px;">${esc(line)}</p>`)
            .join("")
        : "";
      const imageUrls = Array.isArray(data.image_urls)
        ? data.image_urls.filter((url): url is string => typeof url === "string" && url.trim().length > 0)
        : typeof data.image_urls === "string" && data.image_urls.trim()
          ? [data.image_urls.trim()]
          : [];
      const imagesHtml = imageUrls
        .map(
          (url) =>
            `<div style="margin:16px 0;text-align:center;">
  <img src="${esc(url)}" alt="${title}" style="max-width:100%;width:auto;height:auto;display:inline-block;border:0;outline:none;text-decoration:none;" />
</div>`,
        )
        .join("");
      const subject = typeof data.title === "string" ? data.title : "Newsletter";
      const html = shell(
        title,
        `<h2 style="margin-top:0;">Hi ${recipientName},</h2>
${contentHtml}
${imagesHtml}
<p style="margin-top:24px;font-size:12px;color:#6b7280;">You received this because you opted in to promotional emails.</p>`
      );
      const text =
        `Hi ${recipientName},\n\n${rawContent}` +
        (imageUrls.length ? `\n\nImages:\n${imageUrls.join("\n")}` : "");
      return { subject, html, text };
    }

    case "order-feedback-request": {
      const orderNumber = esc(data.order_number ?? "");
      const itemSummary = esc(data.item_summary ?? "your recent purchase");
      const feedbackUrl = esc(data.feedback_url ?? `${url}/feedback`);
      const subject = `Thank you for your ${app} purchase — we'd love your feedback`;
      const html = shell(
        subject,
        `<h2 style="margin-top:0;">Thank you, ${user}!</h2>
<p>We truly appreciate you trusting <strong>${app}</strong> and purchasing with us.</p>
<p>Your order <strong>${orderNumber}</strong> (${itemSummary}) means a lot to our team.</p>
<p>When you have a moment, we'd love to hear how everything went — your feedback helps us keep improving.</p>
<p style="margin:28px 0;">
  <a href="${feedbackUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;padding:12px 22px;text-decoration:none;border-radius:8px;font-weight:600;">Share your feedback</a>
</p>
<p style="font-size:13px;color:#6b7280;">Or copy this link: ${feedbackUrl}</p>
<p style="margin-bottom:0;">With appreciation,<br/>The ${app} Team</p>`
      );
      const text =
        `Thank you, ${String(data.user_name ?? "there")}!\n\n` +
        `We appreciate you trusting ${String(data.app_name ?? "OnTap")} and purchasing with us.\n` +
        `Order ${String(data.order_number ?? "")}: ${String(data.item_summary ?? "your recent purchase")}.\n\n` +
        `Please share your feedback: ${String(data.feedback_url ?? "")}\n\n` +
        `— The ${String(data.app_name ?? "OnTap")} Team`;
      return { subject, html, text };
    }

    default: {
      const title = esc(data.title ?? "Notification");
      const message = esc(data.message ?? "You have an update.");
      const subject = `${app} Notification`;
      const html = shell(subject, `<h2 style="margin-top:0;">${title}</h2><p>${message}</p><p><a href="${url}/notifications">Open Notifications</a></p>`);
      const text = `${title}: ${message}`;
      return { subject, html, text };
    }
  }
}
