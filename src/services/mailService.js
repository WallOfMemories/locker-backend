// ------------------------------------------------------------
// NEW: sends the admin an email when someone places a bid.
//
// Uses Resend (https://resend.com) over plain HTTPS, so there is no new
// package to install. Set these in the backend environment:
//
//   RESEND_API_KEY   your Resend API key
//   BID_NOTIFY_EMAIL where bid emails go (comma separated for several)
//   MAIL_FROM        optional, e.g. "TheLocker <bids@thelocker.in>".
//                    Default is Resend's test sender, which can only email
//                    the address you signed up to Resend with — fine for a
//                    single admin inbox. To email anyone else, verify your
//                    domain in Resend and set MAIL_FROM.
//
// Email is a bonus, never a requirement: if it isn't set up, or Resend is
// down, the bid is still saved and the admin still sees it on /admin/bids.
// ------------------------------------------------------------

const DEFAULT_FROM = "TheLocker <onboarding@resend.dev>";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendMail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey || to.length === 0) {
    return { skipped: true };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || DEFAULT_FROM,
      to,
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    throw new Error(`Resend ${response.status}: ${body.slice(0, 200)}`);
  }

  return { sent: true };
}

function adminRecipients() {
  return (process.env.BID_NOTIFY_EMAIL || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

// bid = { boxLabel, amount, user: { name, username, email, uid }, isUpdate }
async function sendBidEmailToAdmin(bid) {
  const { user } = bid;
  // Link to the admin page: FRONTEND_URL, or the first CORS_ORIGINS entry.
  const siteUrl =
    process.env.FRONTEND_URL ||
    (process.env.CORS_ORIGINS || "").split(",")[0].trim();
  const adminUrl = siteUrl ? `${siteUrl.replace(/\/$/, "")}/admin/bids` : "";

  const rows = [
    ["Box", bid.boxLabel],
    ["Bid", `₹${bid.amount}`],
    ["Name", user.name || "—"],
    ["Username", user.username ? `@${user.username}` : "—"],
    ["Email", user.email || "—"],
    ["User ID", user.uid],
  ];

  const text =
    `${bid.isUpdate ? "Updated bid" : "New bid"} on box ${bid.boxLabel}\n\n` +
    rows.map(([label, value]) => `${label}: ${value}`).join("\n") +
    (adminUrl ? `\n\nAccept, reject or counter: ${adminUrl}` : "");

  const html =
    `<div style="font-family:Arial,sans-serif;max-width:480px">` +
    `<h2 style="margin:0 0 12px">${bid.isUpdate ? "Updated bid" : "New bid"} on box ${escapeHtml(bid.boxLabel)}</h2>` +
    `<table style="border-collapse:collapse;width:100%">` +
    rows
      .map(
        ([label, value]) =>
          `<tr><td style="padding:6px 12px 6px 0;color:#666">${escapeHtml(label)}</td>` +
          `<td style="padding:6px 0"><strong>${escapeHtml(value)}</strong></td></tr>`
      )
      .join("") +
    `</table>` +
    (adminUrl
      ? `<p style="margin-top:18px"><a href="${escapeHtml(adminUrl)}" style="background:#b4502a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Accept, reject or counter</a></p>`
      : "") +
    `</div>`;

  return sendMail({
    to: adminRecipients(),
    subject: `${bid.isUpdate ? "Updated bid" : "New bid"}: ₹${bid.amount} on box ${bid.boxLabel}`,
    html,
    text,
  });
}

// ---------- emails to the BIDDER ----------
//
// NOTE: Resend's free test sender (onboarding@resend.dev) can only deliver to
// the address you signed up to Resend with. To email bidders you must verify
// your domain in Resend and set MAIL_FROM (e.g. "TheLocker <hello@thelocker.in>").
// Until then these emails simply fail quietly; the in-app notification still works.

function siteUrl() {
  const url =
    process.env.FRONTEND_URL ||
    (process.env.CORS_ORIGINS || "").split(",")[0].trim();

  return url ? url.replace(/\/$/, "") : "";
}

function formatDeadline(date) {
  return new Date(date).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  }) + " IST";
}

// kind: "accepted" | "countered" | "rejected" | "expired" | "counterExpired"
// info: { to, boxLabel, amount, counterAmount, payBy, payHours }
async function sendBidderEmail(kind, info) {
  const box = info.boxLabel;

  const templates = {
    accepted: {
      subject: `Your bid for box ${box} was accepted — pay ₹${info.amount}`,
      heading: "Your bid was accepted 🎉",
      lines: [
        `Great news — your bid of <strong>₹${info.amount}</strong> for box ${box} was accepted.`,
        `Pay within <strong>${info.payHours} hours</strong>${
          info.payBy ? ` (by ${formatDeadline(info.payBy)})` : ""
        } and create your Snap to claim the box. If you don't, the box opens up for other bidders.`,
      ],
      button: "Pay & create my Snap",
    },
    countered: {
      subject: `Counter offer for box ${box}: ₹${info.counterAmount}`,
      heading: "You have a counter offer",
      lines: [
        `You bid <strong>₹${info.amount}</strong> for box ${box}. The admin offers it for <strong>₹${info.counterAmount}</strong> instead.`,
        `Please answer within <strong>${info.replyHours || 48} hours</strong>${
          info.counterBy ? ` (by ${formatDeadline(info.counterBy)})` : ""
        } — open the box on the wall to accept or decline. After that the offer expires.`,
      ],
      button: "View the offer",
    },
    rejected: {
      subject: `Your bid for box ${box} was not accepted`,
      heading: "Your bid wasn't accepted",
      lines: [
        `Your bid of <strong>₹${info.amount}</strong> for box ${box} wasn't accepted this time.`,
        "You're welcome to place a new bid anytime.",
      ],
      button: "Bid again",
    },
    counterExpired: {
      subject: `The counter offer for box ${box} has expired`,
      heading: "Counter offer expired",
      lines: [
        `The counter offer of <strong>₹${info.counterAmount}</strong> for box ${box} wasn't answered in time, so it has expired.`,
        "You're welcome to place a new bid if the box is still available.",
      ],
      button: "Back to the wall",
    },
    expired: {
      subject: `Your hold on box ${box} has expired`,
      heading: "Time ran out",
      lines: [
        `You didn't complete payment for box ${box} within ${info.payHours} hours, so it has been opened up for other bidders.`,
        "You're welcome to bid again if it's still available.",
      ],
      button: "Back to the wall",
    },
  };

  const template = templates[kind];

  if (!template || !info.to) return { skipped: true };

  const link = siteUrl();

  const html =
    `<div style="font-family:Arial,sans-serif;max-width:480px">` +
    `<h2 style="margin:0 0 12px">${template.heading}</h2>` +
    template.lines.map((line) => `<p style="line-height:1.5">${line}</p>`).join("") +
    (link
      ? `<p style="margin-top:18px"><a href="${escapeHtml(link)}" style="background:#b4502a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${template.button}</a></p>`
      : "") +
    `<p style="color:#888;font-size:12px;margin-top:24px">TheLocker — My memory on the earth</p>` +
    `</div>`;

  const text =
    template.lines.map((line) => line.replace(/<[^>]+>/g, "")).join("\n\n") +
    (link ? `\n\n${link}` : "");

  return sendMail({ to: [info.to], subject: template.subject, html, text });
}

module.exports = { sendBidEmailToAdmin, sendBidderEmail };