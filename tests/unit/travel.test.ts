import { describe, expect, it } from "vitest";
import {
  assignmentMonths, fiscalYear, housingLinks, mapLinks, parseGsaRates, perDiemLookup, stipendCheck,
} from "../../supabase/functions/_shared/travel.ts";

// Shaped like GSA Per Diem API v2 replies.
const months = (values: number[]) => ({ month: values.map((value, i) => ({ value, number: i + 1 })) });
const flat = (n: number) => Array(12).fill(n);
const zipReply = {
  rates: [{ state: "TX", year: 2026, rate: [{ city: "Austin", county: "Travis", zip: "78701", meals: 80, months: months([187, 187, 187, ...flat(173).slice(3)]) }] }],
};
const cityReply = {
  rates: [{
    state: "KS", year: 2026,
    rate: [
      { city: "Kansas City / Overland Park", county: "Wyandotte / Johnson", zip: null, meals: 80, months: months(flat(135)) },
      { city: "Standard Rate", county: null, zip: null, meals: 68, months: months(flat(110)) },
    ],
  }],
};

describe("fiscalYear", () => {
  it("starts in October", () => {
    expect(fiscalYear("2026-09-30")).toBe(2026);
    expect(fiscalYear("2026-10-01")).toBe(2027);
    expect(fiscalYear("2027-01-15")).toBe(2027);
  });
});

describe("perDiemLookup", () => {
  it("prefers the ZIP code", () => {
    expect(perDiemLookup({ zip: "78701", city: "Austin", state: "TX" }, 2027)).toEqual({ key: "zip:78701", path: "rates/zip/78701/year/2027" });
  });
  it("falls back to the city and state", () => {
    expect(perDiemLookup({ zip: null, city: " San  Antonio ", state: "tx" }, 2027))
      .toEqual({ key: "city:TX:san antonio", path: "rates/city/San%20%20Antonio/state/TX/year/2027" });
  });
  it("refuses what it can't look up", () => {
    expect(perDiemLookup({ zip: "7870", city: "Austin/../x", state: "TX" }, 2027)).toBeNull();
    expect(perDiemLookup({ zip: null, city: "Austin", state: "Texas" }, 2027)).toBeNull();
  });
});

describe("parseGsaRates", () => {
  it("reads a ZIP reply", () => {
    const lookup = perDiemLookup({ zip: "78701", city: "Austin", state: "TX" }, 2026)!;
    expect(parseGsaRates(zipReply, lookup, "Austin", 2026)).toEqual({
      fiscal_year: 2026, lookup_key: "zip:78701", state: "TX", gsa_location: "Austin", county: "Travis",
      is_standard: false, lodging_by_month: [187, 187, 187, ...flat(173).slice(3)], meals_daily: 80,
    });
  });

  it("matches a city by name, or uses the standard rate, never a nearby area", () => {
    const smallville = perDiemLookup({ zip: null, city: "Smallville", state: "KS" }, 2026)!;
    expect(parseGsaRates(cityReply, smallville, "Smallville", 2026)).toMatchObject({ gsa_location: "Standard Rate", is_standard: true, meals_daily: 68 });
    const overland = perDiemLookup({ zip: null, city: "Overland Park", state: "KS" }, 2026)!;
    expect(parseGsaRates(cityReply, overland, "overland park", 2026)).toMatchObject({ gsa_location: "Kansas City / Overland Park", is_standard: false, meals_daily: 80 });
  });

  it("rejects replies it can't trust", () => {
    const lookup = perDiemLookup({ zip: "78701", city: "Austin", state: "TX" }, 2026)!;
    expect(parseGsaRates({ rates: [] }, lookup, "Austin", 2026)).toBeNull();
    expect(parseGsaRates(null, lookup, "Austin", 2026)).toBeNull();
    const missingMonth = { rates: [{ state: "TX", rate: [{ city: "Austin", meals: 80, months: { month: [{ value: 1, number: 1 }] } }] }] };
    expect(parseGsaRates(missingMonth, lookup, "Austin", 2026)).toBeNull();
  });
});

describe("stipendCheck", () => {
  const rate = { lodging_by_month: [200, 200, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100], meals_daily: 80 };

  it("lists the months an assignment covers", () => {
    expect(assignmentMonths("2026-12-15", 13)).toEqual([12, 1, 2, 3]);
    expect(assignmentMonths("2026-03-01", null)).toEqual([3]);
    expect(assignmentMonths("2026-03-01", 4)).toEqual([3]);
  });

  it("averages lodging over those months and flags stipends above the ceiling", () => {
    // Jan and Feb at $200, Mar at $100: average $166.67 a night.
    const check = stipendCheck(rate, "2026-01-01", 12, 125000, 50000);
    expect(check.months).toEqual([1, 2, 3]);
    expect(check.lodging_weekly_cents).toBe(116667);
    expect(check.meals_weekly_cents).toBe(56000);
    expect(check.housing_over_cents).toBe(8333);
    expect(check.meals_over_cents).toBe(0);
    expect(stipendCheck(rate, "2026-01-01", 12, null, null)).toMatchObject({ housing_over_cents: null, meals_over_cents: null });
  });
});

describe("links", () => {
  const place = { city: "San Antonio", state: "TX" };

  it("builds housing searches in each site's own URL format", () => {
    expect(housingLinks(place).map((l) => l.url)).toEqual([
      "https://www.furnishedfinder.com/housing/us--tx--san-antonio",
      "https://www.airbnb.com/s/San-Antonio--TX/homes?monthly_stays=true",
      "https://www.zillow.com/san-antonio-tx/rentals/",
    ]);
  });

  it("maps the facility address when known, and adds directions only with an origin", () => {
    const links = mapLinks({ ...place, address: "100 Main St", zip: "78205" }, " Austin, TX ");
    expect(links.map((l) => l.name)).toEqual(["Google Maps", "Apple Maps", "Driving directions"]);
    expect(links[0].url).toBe("https://www.google.com/maps/search/?api=1&query=100%20Main%20St%2C%20San%20Antonio%2C%20TX%2078205");
    expect(links[2].url).toBe("https://www.google.com/maps/dir/?api=1&origin=Austin%2C%20TX&destination=100%20Main%20St%2C%20San%20Antonio%2C%20TX%2078205&travelmode=driving");
    expect(mapLinks(place, "  ")).toHaveLength(2);
  });
});
