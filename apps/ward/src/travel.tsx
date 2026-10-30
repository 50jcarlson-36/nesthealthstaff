// Location and travel on a job: the facility's address, the GSA per diem with
// a check of the partner's stipends against it, housing searches and maps.
// Nothing about the candidate's own location is stored: the "directions from"
// field only builds a link.

import { FunctionsHttpError } from "@supabase/supabase-js";
import { type FormEvent, useEffect, useState } from "react";
import {
  fiscalYear, housingLinks, mapLinks, type PerDiemRate, perDiemLookup, stipendCheck,
} from "../../../supabase/functions/_shared/travel.ts";
import { dollars, type JobTerms } from "./partners.tsx";
import { formatDate, type Save, useSave } from "./shared.tsx";
import { type Job, supabase } from "./supabase.ts";

export type JobLocation = { facility_address: string | null; facility_zip: string | null };
type CachedRate = PerDiemRate & { fetched_at: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function TravelCard({ job, location, terms, save }: { job: Job; location: JobLocation; terms: JobTerms | null; save: Save }) {
  const place = { city: job.city, state: job.state, address: location.facility_address, zip: location.facility_zip };
  const [editing, setEditing] = useState(false);
  const [origin, setOrigin] = useState("");

  return (
    <>
      <h2>Location and travel</h2>
      <div className="card travel">
        <div className="toolbar">
          <h3>Facility location</h3>
          {!editing && <button className="link" onClick={() => setEditing(true)}>{location.facility_address || location.facility_zip ? "Edit" : "Add address"}</button>}
        </div>
        {editing
          ? <LocationForm key={job.version} job={job} location={location} save={save} onDone={() => setEditing(false)} />
          : <p>{location.facility_address ? `${location.facility_address}, ` : ""}{job.city}, {job.state}{location.facility_zip ? ` ${location.facility_zip}` : ""}
              {!location.facility_zip && <span className="muted"> · Add the ZIP code for an exact per diem.</span>}</p>}
        <p className="muted hint">Internal, like the facility name: the public listing shows only the city and state.</p>

        <PerDiem job={job} location={location} terms={terms} />

        <h3>Housing near the facility</h3>
        <p className="muted hint">Furnished, month-to-month searches for {job.city}, {job.state}. These sites don't share data with Nest: they open in a new tab.</p>
        <p className="links">{housingLinks(place).map((l) => <a key={l.name} href={l.url} target="_blank" rel="noopener noreferrer">{l.name} ↗</a>)}</p>

        <h3>Maps and commute</h3>
        <label className="inline">Directions from
          <input placeholder="Candidate's town or ZIP (not saved)" maxLength={200} value={origin} onChange={(e) => setOrigin(e.target.value)} />
        </label>
        <p className="links">{mapLinks(place, origin).map((l) => <a key={l.name} href={l.url} target="_blank" rel="noopener noreferrer">{l.name} ↗</a>)}</p>
      </div>
    </>
  );
}

function LocationForm({ job, location, save, onDone }: { job: Job; location: JobLocation; save: Save; onDone: () => void }) {
  const [address, setAddress] = useState(location.facility_address ?? "");
  const [zip, setZip] = useState(location.facility_zip ?? "");
  const { saving, error, run } = useSave(save);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => supabase.rpc("set_job_location", {
      p_job_id: job.id, p_expected_version: job.version, p_facility_address: address.trim() || null, p_facility_zip: zip.trim() || null,
    }))) onDone();
  }

  return (
    <form onSubmit={submit}>
      <div className="row wrap">
        <input aria-label="Street address" placeholder="Street address" maxLength={200} value={address} onChange={(e) => setAddress(e.target.value)} />
        <input aria-label="ZIP code" placeholder="ZIP" inputMode="numeric" pattern="\d{5}" maxLength={5} value={zip} onChange={(e) => setZip(e.target.value)} />
        <button disabled={saving}>{saving ? "Saving…" : "Save location"}</button>
        <button type="button" className="link" onClick={onDone}>Cancel</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}

function PerDiem({ job, location, terms }: { job: Job; location: JobLocation; terms: JobTerms | null }) {
  const year = fiscalYear(job.start_date ?? new Date().toISOString().slice(0, 10));
  const lookup = perDiemLookup({ zip: location.facility_zip, city: job.city, state: job.state }, year);
  const [rate, setRate] = useState<CachedRate | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRate(undefined);
    setError(null);
    if (!lookup) return setRate(null);
    supabase.from("per_diem_rates").select("*").eq("fiscal_year", year).eq("lookup_key", lookup.key).maybeSingle()
      .then(({ data }) => setRate(data as CachedRate | null));
  }, [year, lookup?.key]);

  async function fetchRate() {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.functions.invoke("travel-data", { body: { job_id: job.id } });
    setBusy(false);
    if (!error) return setRate((data as { rate: CachedRate }).rate);
    const body = error instanceof FunctionsHttpError ? await error.context.json().catch(() => null) as { error?: string } | null : null;
    setError(body?.error ?? "Couldn't look up the per diem. Try again.");
  }

  const check = rate && job.start_date
    ? stipendCheck(rate, job.start_date, job.duration_weeks, terms?.housing_stipend_weekly_cents ?? null, terms?.meals_stipend_weekly_cents ?? null)
    : null;
  const startMonth = job.start_date ? Number(job.start_date.slice(5, 7)) : null;

  return (
    <>
      <div className="toolbar">
        <h3>GSA per diem, fiscal {year}</h3>
        {lookup && <button className="link" disabled={busy} onClick={fetchRate}>{busy ? "Looking up…" : rate ? "Refresh" : "Look up"}</button>}
      </div>
      {rate === undefined && <p className="muted">Loading…</p>}
      {rate === null && !error && <p className="muted">Not looked up yet.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {rate && (
        <>
          <dl className="fields compact">
            <div><dt>Area</dt><dd>{rate.gsa_location}{rate.county ? ` (${rate.county} County)` : ""}, {rate.state}</dd></div>
            <div><dt>Lodging, per night</dt><dd>{startMonth ? `$${rate.lodging_by_month[startMonth - 1]} in ${MONTHS[startMonth - 1]}` : `$${Math.min(...rate.lodging_by_month)}–$${Math.max(...rate.lodging_by_month)}`}</dd></div>
            <div><dt>Meals and incidentals, per day</dt><dd>${rate.meals_daily}</dd></div>
            {check && <div><dt>Weekly ceiling over the assignment</dt><dd>{dollars(check.lodging_weekly_cents)} lodging · {dollars(check.meals_weekly_cents)} meals</dd></div>}
          </dl>
          {check && (check.housing_over_cents !== null || check.meals_over_cents !== null) && (
            <ul className="stipend-check">
              {check.housing_over_cents !== null && <StipendLine name="Housing stipend" weekly={terms!.housing_stipend_weekly_cents!} over={check.housing_over_cents} />}
              {check.meals_over_cents !== null && <StipendLine name="Meals stipend" weekly={terms!.meals_stipend_weekly_cents!} over={check.meals_over_cents} />}
            </ul>
          )}
          {!job.start_date && <p className="muted hint">Add a start date to compare stipends over the assignment.</p>}
          <p className="muted hint">
            From the GSA Per Diem API, fetched {formatDate(rate.fetched_at)}. Guidance only: the partner, as employer, sets stipends and decides who qualifies for them tax-free.
          </p>
        </>
      )}
    </>
  );
}

function StipendLine({ name, weekly, over }: { name: string; weekly: number; over: number }) {
  return over > 0
    ? <li className="over">{name} {dollars(weekly)}/week is {dollars(over)} over the per diem ceiling. Confirm with the partner how the excess is treated.</li>
    : <li>{name} {dollars(weekly)}/week is within the per diem ceiling.</li>;
}
