// Public hostnames for each audience. Values come from configuration so local,
// staging and production can differ; defaults are the planned production hosts.
//
//   nesthealthstaff.com           public website (existing Sites frontend)
//   staff.nesthealthstaff.com     clinician portal (applicants and their profiles)
//   employers.nesthealthstaff.com facility portal (hospital staff, applicant review)
//   ward.nesthealthstaff.com      agency admin and recruiter back office
//
// A hostname is never an authorization boundary: every portal uses the same
// Supabase project and RLS decides what each signed-in user can read.

export type PortalUrls = {
  publicSite: string;
  clinicianPortal: string;
  facilityPortal: string;
  adminPortal: string;
};

export const DEFAULT_PORTAL_URLS: PortalUrls = {
  publicSite: "https://nesthealthstaff.com",
  clinicianPortal: "https://staff.nesthealthstaff.com",
  facilityPortal: "https://employers.nesthealthstaff.com",
  adminPortal: "https://ward.nesthealthstaff.com",
};

function origin(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const url = new URL(value);
  return url.origin;
}

export function portalUrlsFromEnv(env: (name: string) => string | undefined): PortalUrls {
  return {
    publicSite: origin(env("PUBLIC_SITE_URL"), DEFAULT_PORTAL_URLS.publicSite),
    clinicianPortal: origin(env("CLINICIAN_PORTAL_URL"), DEFAULT_PORTAL_URLS.clinicianPortal),
    facilityPortal: origin(env("FACILITY_PORTAL_URL"), DEFAULT_PORTAL_URLS.facilityPortal),
    adminPortal: origin(env("ADMIN_PORTAL_URL"), DEFAULT_PORTAL_URLS.adminPortal),
  };
}

// Browser origins allowed to call the public intake endpoint. ALLOWED_ORIGINS
// (comma-separated) replaces the default of the public site plus www.
export function allowedOriginsFromEnv(
  env: (name: string) => string | undefined,
  portals: PortalUrls,
): Set<string> {
  const configured = env("ALLOWED_ORIGINS");
  if (configured) {
    return new Set(configured.split(",").map((o) => o.trim()).filter(Boolean).map((o) => new URL(o).origin));
  }
  const site = new URL(portals.publicSite);
  return new Set([site.origin, `${site.protocol}//www.${site.host}`]);
}
