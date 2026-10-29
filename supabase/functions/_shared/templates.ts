// Email templates for outbox notifications.
//
// Bodies deliberately omit applicant details (phone, location, specialty notes,
// documents, accommodation). Staff follow a link to the authenticated back
// office to see the record.

import type { PortalUrls } from "./portals.ts";

export type RenderedEmail = { subject: string; text: string; html: string };

type TemplateData = Record<string, unknown>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function str(data: TemplateData, key: string, fallback: string): string {
  const value = data[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

// Staff-entered text (a job title) on one line, for subjects.
function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
}

function layout(paragraphs: string[], link?: { href: string; label: string }): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
  const button = link
    ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2933">${body}${button}</body></html>`;
}

export function renderTemplate(
  template: string,
  data: TemplateData,
  portals: PortalUrls,
): RenderedEmail {
  const agency = str(data, "organization_name", "Nest Health Staff");

  switch (template) {
    case "clinician_inquiry_confirmation": {
      const lines = [
        "Thank you for joining the Nest Health Staff interest list.",
        `The ${agency} team has received your details and will follow up as opportunities and services develop.`,
        "Joining the interest list is not an application, job offer, or guarantee of placement.",
        "Please don't reply with patient information or credential documents.",
      ];
      return {
        subject: "We received your interest — Nest Health Staff",
        text: `${lines.join("\n\n")}\n\n${portals.publicSite}`,
        html: layout(lines, { href: portals.publicSite, label: "Visit Nest Health Staff" }),
      };
    }

    case "facility_inquiry_confirmation": {
      const lines = [
        "Thank you for contacting Nest Health Staff about your staffing needs.",
        `The ${agency} team has received your request and will be in touch to start the conversation.`,
        "Please don't include patient information in replies.",
      ];
      return {
        subject: "We received your staffing inquiry — Nest Health Staff",
        text: `${lines.join("\n\n")}\n\n${portals.publicSite}`,
        html: layout(lines, { href: portals.publicSite, label: "Visit Nest Health Staff" }),
      };
    }

    case "staff_new_inquiry_alert": {
      const kind = data.inquiry_type === "facility" ? "facility staffing" : "clinician";
      const inquiryId = str(data, "inquiry_id", "");
      const href = inquiryId
        ? `${portals.adminPortal}/inquiries/${encodeURIComponent(inquiryId)}`
        : `${portals.adminPortal}/inquiries`;
      const lines = [
        `A new ${kind} inquiry was submitted through the website.`,
        "Sign in to review the details and assign a recruiter.",
      ];
      return {
        subject: `New ${kind} inquiry`,
        text: `${lines.join("\n\n")}\n\n${href}`,
        html: layout(lines, { href, label: "Review inquiry" }),
      };
    }

    case "job_application_confirmation": {
      const job = str(data, "job_title", "the job you chose");
      const lines = [
        `Thank you for applying for ${job}.`,
        `The ${agency} team has received your application and a recruiter will be in touch if it's a match.`,
        "Applying is not a job offer or a guarantee of placement.",
        "Please don't reply with patient information or credential documents.",
      ];
      return {
        subject: "We received your application — Nest Health Staff",
        text: `${lines.join("\n\n")}\n\n${portals.publicSite}`,
        html: layout(lines, { href: portals.publicSite, label: "Visit Nest Health Staff" }),
      };
    }

    case "staff_new_application_alert": {
      const job = str(data, "job_title", "a job");
      const jobId = str(data, "job_id", "");
      const href = jobId
        ? `${portals.adminPortal}/jobs/${encodeURIComponent(jobId)}`
        : `${portals.adminPortal}/jobs`;
      const lines = [
        `Someone applied for ${job} through the website.`,
        "Sign in to review the application.",
      ];
      return {
        subject: `New application: ${oneLine(job)}`,
        text: `${lines.join("\n\n")}\n\n${href}`,
        html: layout(lines, { href, label: "Review application" }),
      };
    }

    case "staff_invitation": {
      // No sign-in token: the link opens ward's ordinary sign-in, and access
      // is granted only after a magic link to this same address.
      const role = str(data, "role", "recruiter") === "admin" ? "an admin" : "a recruiter";
      const inviter = str(data, "inviter_name", "");
      const expires = str(data, "expires_at", "");
      const expiresOn = expires
        ? new Date(expires).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" })
        : "";
      const lines = [
        `${inviter ? `${inviter} has invited you` : "You've been invited"} to join ${agency} in Ward, its recruiting workspace, as ${role}.`,
        "To accept, open Ward and sign in with this email address. We'll email you a sign-in link; there's no password.",
        ...(expiresOn ? [`The invitation expires on ${expiresOn}.`] : []),
        "If you weren't expecting this, you can ignore this email.",
      ];
      const href = `${portals.adminPortal}/`;
      return {
        subject: `You're invited to ${oneLine(agency)} on Ward`,
        text: `${lines.join("\n\n")}\n\n${href}`,
        html: layout(lines, { href, label: "Open Ward" }),
      };
    }

    default:
      throw new Error(`Unknown notification template: ${template}`);
  }
}
