// Staff invitations and team management: only admins invite, change roles or
// remove staff; access is granted only to the person who signs in with the
// invited address; the agency always keeps an admin.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, anon, createOrganization, createUser, inquiryPayload, runId, service, submit } from "./setup.ts";

type User = { id: string; client: SupabaseClient };

let orgA: { id: string; slug: string };
let orgB: { id: string; slug: string };
let adminA: User;
let recruiterA: User;
let adminB: User;

beforeAll(async () => {
  orgA = await createOrganization("staff-a");
  orgB = await createOrganization("staff-b");
  [adminA, recruiterA, adminB] = await Promise.all([
    createUser("staff-admin-a"), createUser("staff-recruiter-a"), createUser("staff-admin-b"),
  ]);
  await addMember(orgA.id, adminA.id, "admin");
  await addMember(orgA.id, recruiterA.id, "recruiter");
  await addMember(orgB.id, adminB.id, "admin");
  await service.from("profiles").update({ full_name: "Avery Admin" }).eq("id", adminA.id);
});

// createUser() signs people in as `${label}-${runId}@example.com`.
const address = (label: string) => `${label}-${runId}@example.com`;

const invite = (actorId: string, orgId: string, email: string, role = "recruiter", name: string | null = null) =>
  service.rpc("invite_staff", {
    p_actor_id: actorId, p_organization_id: orgId, p_email: email, p_full_name: name, p_role: role,
  });

async function membership(orgId: string, userId: string) {
  const { data } = await service.from("organization_memberships")
    .select("role").eq("organization_id", orgId).eq("user_id", userId).maybeSingle();
  return data as { role: string } | null;
}

async function outbox(invitationId: string) {
  const { data } = await service.from("notification_outbox")
    .select("template, recipient, template_data, status, dedupe_key")
    .like("dedupe_key", `staff_invitation:${invitationId}:%`)
    .order("dedupe_key");
  return data ?? [];
}

describe("inviting staff", () => {
  it("records the invitation and queues an email with no sign-in token", async () => {
    const { data, error } = await invite(adminA.id, orgA.id, `  ${address("invitee-1").toUpperCase()} `, "recruiter", " Riley Recruiter ");
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "created", email: address("invitee-1") });

    const rows = await outbox(data.invitation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ template: "staff_invitation", recipient: address("invitee-1"), status: "pending" });
    expect(rows[0].template_data).toMatchObject({ organization_name: "Test staff-a", role: "recruiter", inviter_name: "Avery Admin" });
    expect(Object.keys(rows[0].template_data).sort()).toEqual(["expires_at", "inviter_name", "organization_name", "role"]);
  });

  it("resends an open invitation instead of creating a second one, up to five sends", async () => {
    const email = address("invitee-resend");
    const first = await invite(adminA.id, orgA.id, email);
    const second = await invite(adminA.id, orgA.id, email, "admin");
    expect(second.data).toMatchObject({ status: "resent", invitation_id: first.data.invitation_id });

    const { data: row } = await service.from("staff_invitations").select("role, sent_count").eq("id", first.data.invitation_id).single();
    expect(row).toEqual({ role: "admin", sent_count: 2 });
    expect(await outbox(first.data.invitation_id)).toHaveLength(2);

    for (let i = 0; i < 3; i++) await invite(adminA.id, orgA.id, email);
    const sixth = await invite(adminA.id, orgA.id, email);
    expect(sixth.error).toMatchObject({ code: "PT400", message: expect.stringMatching(/five times/) });
  });

  it("refuses recruiters, other agencies' admins and people with no membership", async () => {
    for (const actor of [recruiterA.id, adminB.id, crypto.randomUUID()]) {
      const { error } = await invite(actor, orgA.id, address("invitee-refused"));
      expect(error?.code).toBe("PT403");
    }
    const { count } = await service.from("staff_invitations")
      .select("id", { count: "exact", head: true }).eq("email", address("invitee-refused"));
    expect(count).toBe(0);
  });

  it("validates the address and refuses someone already on staff", async () => {
    expect((await invite(adminA.id, orgA.id, "not-an-email")).error).toMatchObject({ code: "PT400" });
    expect((await invite(adminA.id, orgA.id, address("staff-recruiter-a"))).error)
      .toMatchObject({ code: "PT400", message: "That person is already on your staff" });
  });

  it("can only be called by the server", async () => {
    const { error } = await adminA.client.rpc("invite_staff", {
      p_actor_id: adminA.id, p_organization_id: orgA.id, p_email: address("invitee-direct"), p_full_name: null, p_role: "admin",
    });
    expect(error).not.toBeNull();
    const { error: anonError } = await anon().rpc("invite_staff", {
      p_actor_id: adminA.id, p_organization_id: orgA.id, p_email: address("invitee-direct"), p_full_name: null, p_role: "admin",
    });
    expect(anonError).not.toBeNull();
  });
});

describe("accepting an invitation", () => {
  it("grants the invited role to the person who signs in with that address", async () => {
    const { data } = await invite(adminA.id, orgA.id, address("invitee-accept"), "recruiter", "Jordan Newhire");
    const invitee = await createUser("invitee-accept");
    expect(await membership(orgA.id, invitee.id)).toBeNull();

    const { data: result, error } = await invitee.client.rpc("accept_staff_invitations");
    expect(error).toBeNull();
    expect(result).toEqual({ accepted: 1 });
    expect(await membership(orgA.id, invitee.id)).toEqual({ role: "recruiter" });

    const { data: profile } = await service.from("profiles").select("full_name").eq("id", invitee.id).single();
    expect(profile?.full_name).toBe("Jordan Newhire");
    const { data: row } = await service.from("staff_invitations").select("accepted_by").eq("id", data.invitation_id).single();
    expect(row?.accepted_by).toBe(invitee.id);

    // Accepting again changes nothing.
    expect((await invitee.client.rpc("accept_staff_invitations")).data).toEqual({ accepted: 0 });
  });

  it("ignores invitations for other addresses, revoked ones and expired ones", async () => {
    await invite(adminA.id, orgA.id, address("invitee-someone-else"));
    const revoked = await invite(adminA.id, orgA.id, address("invitee-revoked"));
    expect((await adminA.client.rpc("revoke_staff_invitation", { p_invitation_id: revoked.data.invitation_id })).error).toBeNull();
    const expired = await invite(adminA.id, orgA.id, address("invitee-expired"));
    await service.from("staff_invitations").update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", expired.data.invitation_id);

    for (const label of ["invitee-revoked", "invitee-expired"]) {
      const user = await createUser(label);
      expect((await user.client.rpc("accept_staff_invitations")).data).toEqual({ accepted: 0 });
      expect(await membership(orgA.id, user.id)).toBeNull();
    }
    // Someone signed in under a different address can't take another's invitation.
    expect((await recruiterA.client.rpc("accept_staff_invitations")).data).toEqual({ accepted: 0 });
  });

  it("keeps an existing member's role", async () => {
    await invite(adminB.id, orgB.id, address("staff-admin-a"), "recruiter");
    expect((await adminA.client.rpc("accept_staff_invitations")).data).toEqual({ accepted: 1 });
    expect(await membership(orgB.id, adminA.id)).toEqual({ role: "recruiter" });
    expect(await membership(orgA.id, adminA.id)).toEqual({ role: "admin" });
  });
});

describe("revoking an invitation", () => {
  it("cancels its unsent email, and only an admin of that agency can revoke", async () => {
    const { data } = await invite(adminA.id, orgA.id, address("invitee-cancel"));
    for (const client of [recruiterA.client, adminB.client]) {
      const { error } = await client.rpc("revoke_staff_invitation", { p_invitation_id: data.invitation_id });
      expect(error?.code).toBe("PT404");
    }
    expect((await adminA.client.rpc("revoke_staff_invitation", { p_invitation_id: data.invitation_id })).error).toBeNull();
    expect((await outbox(data.invitation_id)).map((r) => r.status)).toEqual(["cancelled"]);
    expect((await adminA.client.rpc("revoke_staff_invitation", { p_invitation_id: data.invitation_id })).error)
      .toMatchObject({ code: "PT400" });
  });

  it("is visible only to the agency's admins", async () => {
    const own = await adminA.client.from("staff_invitations").select("organization_id");
    expect(own.data?.length).toBeGreaterThan(0);
    expect(own.data?.every((r) => r.organization_id === orgA.id)).toBe(true);
    expect((await recruiterA.client.from("staff_invitations").select("id")).data).toEqual([]);
    expect((await anon().from("staff_invitations").select("id")).error).not.toBeNull();
  });
});

describe("managing the team", () => {
  it("lists members with emails for admins only", async () => {
    const { data, error } = await adminA.client.rpc("organization_members", { p_organization_id: orgA.id });
    expect(error).toBeNull();
    expect(data).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: adminA.id, email: address("staff-admin-a"), role: "admin" }),
    ]));
    expect((await recruiterA.client.rpc("organization_members", { p_organization_id: orgA.id })).error?.code).toBe("PT404");
    expect((await adminB.client.rpc("organization_members", { p_organization_id: orgA.id })).error?.code).toBe("PT404");
  });

  it("changes roles but never leaves the agency without an admin", async () => {
    const org = await createOrganization("staff-roles");
    const [solo, other] = await Promise.all([createUser("roles-admin"), createUser("roles-recruiter")]);
    await addMember(org.id, solo.id, "admin");
    await addMember(org.id, other.id, "recruiter");
    const change = (client: SupabaseClient, userId: string, role: string) =>
      client.rpc("change_staff_role", { p_organization_id: org.id, p_user_id: userId, p_role: role });

    expect((await change(solo.client, solo.id, "recruiter")).error)
      .toMatchObject({ code: "PT400", message: "The agency needs at least one admin" });
    expect((await change(other.client, solo.id, "recruiter")).error?.code).toBe("PT404");
    expect((await change(solo.client, other.id, "recruiter")).error?.code).toBe("PT400");

    expect((await change(solo.client, other.id, "admin")).error).toBeNull();
    expect((await change(solo.client, solo.id, "recruiter")).error).toBeNull();
    expect(await membership(org.id, solo.id)).toEqual({ role: "recruiter" });
  });

  it("removes a member, ending their access and unassigning their inquiries", async () => {
    const leaver = await createUser("staff-leaver");
    await addMember(orgA.id, leaver.id, "recruiter");
    const created = await submit(orgA.slug, inquiryPayload());
    const { data: before } = await service.from("inquiries").select("version").eq("id", created.inquiry_id!).single();
    expect((await adminA.client.rpc("assign_inquiry", {
      p_inquiry_id: created.inquiry_id, p_expected_version: before!.version, p_assignee_id: leaver.id,
    })).error).toBeNull();
    expect((await leaver.client.from("inquiries").select("id").eq("id", created.inquiry_id!)).data).toHaveLength(1);

    expect((await recruiterA.client.rpc("remove_staff_member", { p_organization_id: orgA.id, p_user_id: leaver.id })).error?.code)
      .toBe("PT404");
    const { data, error } = await adminA.client.rpc("remove_staff_member", { p_organization_id: orgA.id, p_user_id: leaver.id });
    expect(error).toBeNull();
    expect(data).toEqual({ user_id: leaver.id, unassigned_inquiries: 1 });

    expect(await membership(orgA.id, leaver.id)).toBeNull();
    expect((await leaver.client.from("inquiries").select("id").eq("id", created.inquiry_id!)).data).toEqual([]);
    const { data: inquiry } = await service.from("inquiries").select("assigned_recruiter_id").eq("id", created.inquiry_id!).single();
    expect(inquiry?.assigned_recruiter_id).toBeNull();
  });

  it("doesn't let an admin remove themselves", async () => {
    const { error } = await adminA.client.rpc("remove_staff_member", { p_organization_id: orgA.id, p_user_id: adminA.id });
    expect(error).toMatchObject({ code: "PT400" });
    expect(await membership(orgA.id, adminA.id)).toEqual({ role: "admin" });
  });
});
