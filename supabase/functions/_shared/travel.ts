// Location and travel: GSA per diem lookups, stipend guidance, and housing and
// map links. Shared by the travel-data function and ward. Plain TypeScript.

// --- GSA per diem ----------------------------------------------------------------

// Federal fiscal years run October to September and are named for the year
// they end in: October 2026 is in fiscal 2027.
export function fiscalYear(isoDate: string): number {
  const [year, month] = isoDate.split("-").map(Number);
  return month >= 10 ? year + 1 : year;
}

export type PerDiemLookup = { key: string; path: string };

// A ZIP code is exact. Without one, GSA's city search is used and its result
// matched by name (see parseGsaRates).
export function perDiemLookup(
  place: { zip: string | null; city: string; state: string },
  year: number,
): PerDiemLookup | null {
  if (place.zip && /^\d{5}$/.test(place.zip)) {
    return { key: `zip:${place.zip}`, path: `rates/zip/${place.zip}/year/${year}` };
  }
  const city = place.city.trim().toLowerCase().replace(/\s+/g, " ");
  const state = place.state.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state) || !/^[a-z0-9 .'-]{1,100}$/.test(city)) return null;
  return {
    key: `city:${state}:${city}`,
    path: `rates/city/${encodeURIComponent(place.city.trim())}/state/${state}/year/${year}`,
  };
}

export type PerDiemRate = {
  fiscal_year: number;
  lookup_key: string;
  state: string;
  gsa_location: string;
  county: string | null;
  is_standard: boolean;
  lodging_by_month: number[];
  meals_daily: number;
};

type GsaRate = {
  city?: string;
  county?: string | null;
  zip?: string | null;
  meals?: number;
  months?: { month?: { value?: number; number?: number }[] };
};
type GsaReply = { rates?: { state?: string; year?: number; rate?: GsaRate[] }[] };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// GSA's city search can return a nearby special-rate area alongside the
// standard rate (for example, Kansas City for an unknown Kansas town). Only an
// area whose name includes the city counts; otherwise the standard rate applies.
export function parseGsaRates(body: unknown, lookup: PerDiemLookup, city: string, year: number): PerDiemRate | null {
  const reply = body as GsaReply;
  const group = reply?.rates?.[0];
  const rates = group?.rate ?? [];
  if (!group?.state || rates.length === 0) return null;

  let chosen: GsaRate | undefined;
  if (lookup.key.startsWith("zip:")) chosen = rates[0];
  else {
    chosen = rates.find((r) => r.city && r.city !== "Standard Rate" && r.city.split("/").some((part) => sameName(part, city)))
      ?? rates.find((r) => r.city === "Standard Rate");
  }
  if (!chosen?.city || typeof chosen.meals !== "number") return null;

  const lodging = Array<number>(12).fill(NaN);
  for (const m of chosen.months?.month ?? []) {
    if (typeof m.number === "number" && m.number >= 1 && m.number <= 12 && typeof m.value === "number") {
      lodging[m.number - 1] = m.value;
    }
  }
  if (lodging.some(Number.isNaN)) return null;

  return {
    fiscal_year: year,
    lookup_key: lookup.key,
    state: group.state,
    gsa_location: chosen.city,
    county: chosen.county ?? null,
    is_standard: chosen.city === "Standard Rate",
    lodging_by_month: lodging,
    meals_daily: chosen.meals,
  };
}

// --- Stipend guidance --------------------------------------------------------------

export type StipendCheck = {
  // Weekly ceilings from the per diem: average nightly lodging over the
  // assignment's months × 7, and daily meals × 7, in cents.
  lodging_weekly_cents: number;
  meals_weekly_cents: number;
  months: number[];
  housing_over_cents: number | null;
  meals_over_cents: number | null;
};

// Months (1–12) an assignment covers; just the start month when the length
// is unknown.
export function assignmentMonths(startIso: string, weeks: number | null): number[] {
  const start = new Date(`${startIso}T12:00:00Z`);
  const end = new Date(start.getTime() + Math.max((weeks ?? 0) * 7 - 1, 0) * 86400000);
  const months: number[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end || months.length === 0) {
    months.push(cursor.getUTCMonth() + 1);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export function stipendCheck(
  rate: Pick<PerDiemRate, "lodging_by_month" | "meals_daily">,
  startIso: string,
  weeks: number | null,
  housingWeeklyCents: number | null,
  mealsWeeklyCents: number | null,
): StipendCheck {
  const months = assignmentMonths(startIso, weeks);
  const nightly = months.reduce((sum, m) => sum + rate.lodging_by_month[m - 1], 0) / months.length;
  const lodging = Math.round(nightly * 7 * 100);
  const meals = rate.meals_daily * 7 * 100;
  return {
    lodging_weekly_cents: lodging,
    meals_weekly_cents: meals,
    months,
    housing_over_cents: housingWeeklyCents === null ? null : Math.max(housingWeeklyCents - lodging, 0),
    meals_over_cents: mealsWeeklyCents === null ? null : Math.max(mealsWeeklyCents - meals, 0),
  };
}

// --- Links ------------------------------------------------------------------------------

export type Place = { city: string; state: string; address?: string | null; zip?: string | null };

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Search pages for furnished, month-to-month housing near the opening. None of
// these sites offers an API to Nest; they're links, opened by the recruiter.
export function housingLinks(place: Place): { name: string; url: string }[] {
  const city = slug(place.city);
  const state = place.state.trim().toLowerCase();
  return [
    { name: "Furnished Finder", url: `https://www.furnishedfinder.com/housing/us--${state}--${city}` },
    {
      name: "Airbnb monthly stays",
      url: `https://www.airbnb.com/s/${encodeURIComponent(place.city.trim().replace(/\s+/g, "-"))}--${place.state.trim().toUpperCase()}/homes?monthly_stays=true`,
    },
    { name: "Zillow rentals", url: `https://www.zillow.com/${city}-${state}/rentals/` },
  ];
}

// The facility's address when known, else its city.
export function placeQuery(place: Place): string {
  const area = `${place.city.trim()}, ${place.state.trim().toUpperCase()}${place.zip ? ` ${place.zip}` : ""}`;
  return place.address?.trim() ? `${place.address.trim()}, ${area}` : area;
}

// Google's Maps URLs need no key. The origin is typed by the recruiter and
// only ever goes into the link.
export function mapLinks(place: Place, origin?: string | null): { name: string; url: string }[] {
  const destination = encodeURIComponent(placeQuery(place));
  const links = [
    { name: "Google Maps", url: `https://www.google.com/maps/search/?api=1&query=${destination}` },
    { name: "Apple Maps", url: `https://maps.apple.com/?q=${destination}` },
  ];
  if (origin?.trim()) {
    links.push({
      name: "Driving directions",
      url: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin.trim())}&destination=${destination}&travelmode=driving`,
    });
  }
  return links;
}
