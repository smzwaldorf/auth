import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { people, user, loginInvitations, personRoles, families, classes, familyMemberships, classMemberships, session, auditEvents } from "../db/schema.js";
import { isAdmin } from "./service.js";
import { AdminError } from "./model.js";
import { relationshipSnapshot } from "./relationships.js";
import { escape as e, layout, pageHead } from "./views.js";
import { label, t } from "./i18n.js";

const adultSchema = z.object({ id: z.union([z.uuid(), z.literal("")]), name: z.string().trim().max(120), email: z.union([z.string().trim().toLowerCase().email().max(254), z.literal("")]), relationship: z.enum(["father", "mother", "guardian"]) }).refine(a => a.id || (a.name && a.email), "Choose an existing adult or enter their name and email.");
const draftSchema = z.object({ id: z.uuid(), actor: z.uuid(), expires: z.number(), step: z.number().int().min(1).max(6), student: z.string().trim().max(120), classId: z.union([z.uuid(), z.literal("")]), familyId: z.union([z.uuid(), z.literal("")]), familyName: z.string().trim().max(120), adults: z.array(adultSchema).max(12) });
type Draft = z.infer<typeof draftSchema>;
type Snapshot = Awaited<ReturnType<typeof relationshipSnapshot>>;
const steps = ["Add student", "Associate to class", "Choose family", "Parents and guardians", "Family graph", "Confirm creation"];
export function familyWizard(db: Database, config: RuntimeConfig) {
  function sign(draft: Draft) {
    const payload = Buffer.from(JSON.stringify(draft)).toString("base64url");
    return `${payload}.${createHmac("sha256", config.BETTER_AUTH_SECRET).update(payload).digest("base64url")}`;
  }
  function read(token: string, actor: string) {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) throw new AdminError(t("This setup expired. Start the family wizard again."));
    const expected = createHmac("sha256", config.BETTER_AUTH_SECRET).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AdminError(t("Invalid family setup request."));
    const parsed = draftSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    if (!parsed.success || parsed.data.actor !== actor || parsed.data.expires < Date.now()) throw new AdminError(t("This setup expired. Start the family wizard again."));
    return parsed.data;
  }
  const start = (actor: string): Draft => ({ id: randomUUID(), actor, expires: Date.now() + 3600000, step: 1, student: "", classId: "", familyId: "", familyName: "", adults: [] });
  async function create(d: Draft, sessionId: string) {
    if (d.step !== 6 || !d.student || !d.classId || (!d.familyId && !d.familyName)) throw new AdminError(t("Complete all setup steps before creating the family."));
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(73692041)`);
      const [live] = await tx.select().from(session).where(and(eq(session.id, sessionId), eq(session.userId, d.actor), sql`${session.expiresAt} > now()`));
      if (!live || !(await isAdmin(tx, config, d.actor))) throw new AdminError(t("Administrator access is no longer active."), 403);
      // The student ID also makes repeated confirmation submissions idempotent.
      const [done] = await tx.select().from(auditEvents).where(and(eq(auditEvents.eventType, "admin.family.wizard.created"), eq(auditEvents.personId, d.id)));
      if (done) return (done.detail as { familyId: string }).familyId;
      const [schoolClass] = await tx.select().from(classes).where(and(eq(classes.id, d.classId), eq(classes.status, "active")));
      if (!schoolClass) throw new AdminError(t("The selected class is no longer active. Go back and choose another class."), 409);
      const familyId = d.familyId || randomUUID();
      if (d.familyId) {
        const [family] = await tx.select().from(families).where(and(eq(families.id, familyId), eq(families.status, "active")));
        if (!family) throw new AdminError(t("The selected family is no longer active."), 409);
      } else await tx.insert(families).values({ id: familyId, code: `F-${d.id}`, displayName: d.familyName });
      const existingLinks = await tx.select().from(familyMemberships).where(eq(familyMemberships.familyId, familyId));
      const today = new Date().toISOString().slice(0, 10);
      const active = (l: typeof existingLinks[number]) => l.status === "active" && (!l.startsOn || l.startsOn <= today) && (!l.endsOn || l.endsOn >= today);
      let guardianCount = 0;
      for (const l of existingLinks.filter(l => active(l) && l.relationship !== "child")) {
        const [p] = await tx.select().from(people).where(and(eq(people.id, l.personId), eq(people.status, "active"), eq(people.kind, "adult")));
        if (p) guardianCount++;
      }
      const seen = new Set<string>();
      for (const a of d.adults) {
        let personId = a.id;
        if (personId) {
          const [p] = await tx.select().from(people).where(and(eq(people.id, personId), eq(people.status, "active"), eq(people.kind, "adult")));
          if (!p) throw new AdminError(t("A selected parent or guardian is no longer active."), 409);
        } else {
          const [duplicate] = await tx.select().from(people).where(eq(people.normalizedLoginEmail, a.email));
          if (duplicate) throw new AdminError(t("An account already uses {email}. Go back and select the existing adult.", { email: a.email }), 409);
          personId = randomUUID();
          await tx.insert(people).values({ id: personId, kind: "adult", displayName: a.name, normalizedLoginEmail: a.email });
          await tx.insert(user).values({ id: personId, name: a.name, email: a.email, emailVerified: false });
          await tx.insert(loginInvitations).values({ id: randomUUID(), personId, normalizedEmail: a.email, status: "pending" });
        }
        if (seen.has(personId)) throw new AdminError(t("Each parent or guardian can be added only once."));
        seen.add(personId);
        await tx.insert(personRoles).values({ personId, role: "parent" }).onConflictDoNothing();
        const previous = existingLinks.find(l => l.personId === personId && active(l));
        if (previous && previous.relationship !== a.relationship) throw new AdminError(t("This adult already has a different relationship in the family. Review the family first."), 409);
        if (!previous) await tx.insert(familyMemberships).values({ id: randomUUID(), familyId, personId, relationship: a.relationship });
        guardianCount++;
      }
      if (!d.familyId && !guardianCount) throw new AdminError(t("Add at least one active parent or guardian."));
      await tx.insert(people).values({ id: d.id, kind: "student", displayName: d.student });
      await tx.insert(personRoles).values({ personId: d.id, role: "student" });
      await tx.insert(classMemberships).values({ id: randomUUID(), personId: d.id, classId: d.classId, relationship: "student" });
      await tx.insert(familyMemberships).values({ id: randomUUID(), personId: d.id, familyId, relationship: "child" });
      await tx.insert(auditEvents).values({ eventType: "admin.family.wizard.created", actor: d.actor, personId: d.id, detail: { familyId, classId: d.classId } });
      return familyId;
    });
  }
  function advance(d: Draft, body: Record<string, unknown>, data: Snapshot): Draft {
    const action = String(body.action || "next");
    if (action === "back") return { ...d, step: d.familyId && d.step === 5 ? 3 : Math.max(1, d.step - 1) };
    if (d.step === 1) {
      const student = z.string().trim().min(1, t("Enter a student name.")).max(120).parse(body.student);
      d = { ...d, student, familyName: d.familyName || t("{student}'s Family", { student: student.slice(0, 111) }) };
    } else if (d.step === 2) {
      const classId = String(body.classId || "");
      if (!data.classes.some(c => c.id === classId && c.status === "active")) throw new AdminError(t("Choose an active class."));
      d = { ...d, classId };
    } else if (d.step === 3) {
      const familyId = String(body.familyId || "");
      if (familyId && !data.families.some(f => f.id === familyId && f.status === "active")) throw new AdminError(t("Choose an active family."));
      const familyName = familyId ? "" : z.string().trim().min(1, t("Enter a family name.")).max(120).parse(body.familyName);
      d = { ...d, familyId, familyName };
      if (familyId) return { ...d, adults: [], step: 5 };
    } else if (d.step === 4 && action === "add") {
      const a = adultSchema.parse({ id: body.adultId || "", name: body.adultName || "", email: body.adultEmail || "", relationship: body.relationship });
      if (a.id && !data.persons.some(p => p.id === a.id && p.kind === "adult" && p.status === "active")) throw new AdminError(t("Choose an active adult."));
      if (d.adults.some(p => a.id ? p.id === a.id : !p.id && p.email === a.email)) throw new AdminError(t("This adult is already in the setup."));
      if (d.adults.length >= 12) throw new AdminError(t("A setup can include up to 12 adults."));
      return { ...d, adults: [...d.adults, a] };
    } else if (d.step === 4 && action.startsWith("remove:")) {
      return { ...d, adults: d.adults.filter((_, i) => i !== Number(action.slice(7))) };
    } else if (d.step === 4 && (body.adultId || body.adultName || body.adultEmail)) {
      return { ...advance(d, { ...body, action: "add" }, data), step: 5 };
    } else if (d.step === 4 && !d.adults.length && !familyAdults(d, data).length) throw new AdminError(t("Add at least one parent or guardian."));
    return { ...d, step: Math.min(6, d.step + 1) };
  }
  function familyAdults(d: Draft, data: Snapshot) {
    const today = new Date().toISOString().slice(0, 10);
    return data.familyLinks.filter(l => l.familyId === d.familyId && l.relationship !== "child" && l.status === "active" && (!l.startsOn || l.startsOn <= today) && (!l.endsOn || l.endsOn >= today) && data.persons.some(p => p.id === l.personId && p.status === "active"));
  }
  function view(d: Draft, data: Snapshot, error = "") {
    const field = (name: string, label: string, value = "", type = "text") => `<label>${e(label)}<input name="${name}" type="${type}" maxlength="${type === "email" ? 254 : 120}" value="${e(value)}"></label>`;
    const selectedClass = data.classes.find(c => c.id === d.classId);
    const familyName = data.families.find(f => f.id === d.familyId)?.displayName || d.familyName;
    const adults = [...familyAdults(d, data).map(l => ({ name: data.persons.find(p => p.id === l.personId)!.displayName, relationship: l.relationship, existing: true })), ...d.adults.filter(a => !familyAdults(d, data).some(l => l.personId === a.id)).map(a => ({ name: data.persons.find(p => p.id === a.id)?.displayName || a.name, relationship: a.relationship, existing: false }))];
    const rel = (r: string) => label(r);
    let content = "";
    if (d.step === 1) content = `<p>${e(t("Create a student record. Students do not receive login accounts."))}</p>${field("student", t("Student name"), d.student)}`;
    if (d.step === 2) content = `<label>${e(t("Class"))}<select name="classId"><option value="">${e(t("Choose a class"))}</option>${data.classes.filter(c => c.status === "active").map(c => `<option value="${c.id}" ${c.id === d.classId ? "selected" : ""}>${e(c.displayName)} (${e(c.code)})</option>`).join("")}</select></label>${!data.classes.some(c => c.status === "active") ? `<p>${t("No active classes. {link}, then return here.", { link: `<a href="/admin/classes/new" target="_blank">${e(t("Create a class"))}</a>` })}</p>` : ""}`;
    if (d.step === 3) content = `<label>${e(t("Family"))}<select name="familyId"><option value="">${e(t("Create a new family"))}</option>${data.families.filter(f => f.status === "active").map(f => `<option value="${f.id}" ${f.id === d.familyId ? "selected" : ""}>${e(f.displayName)} (${e(f.code)})</option>`).join("")}</select></label>${field("familyName", t("New family name (used only when creating a family)"), d.familyName || t("{student}'s Family", { student: d.student.slice(0, 111) }))}<p>${e(t("The suggested name comes from the first student. Existing families keep their name and members and skip the parent and guardian step."))}</p>`;
    if (d.step === 4) content = `<p>${e(t("Add existing adults or create new parent accounts. No email will be sent. Existing family members stay connected."))}</p>${familyAdults(d, data).map(l => `<p>${e(data.persons.find(p => p.id === l.personId)?.displayName)} · ${e(rel(l.relationship))} · ${e(t("already in family"))}</p>`).join("")}${d.adults.map((a,i) => `<p>${e(data.persons.find(p => p.id === a.id)?.displayName || a.name)} · ${e(rel(a.relationship))} <button name="action" value="remove:${i}" formnovalidate>${e(t("Remove"))}</button></p>`).join("")}<fieldset><legend>${e(t("Add parent or guardian"))}</legend><label>${e(t("Existing adult"))}<select name="adultId"><option value="">${e(t("Create a new adult"))}</option>${data.persons.filter(p => p.kind === "adult" && p.status === "active").map(p => `<option value="${p.id}">${e(p.displayName)} · ${e(p.normalizedLoginEmail)}</option>`).join("")}</select></label>${field("adultName", t("New adult name"))}${field("adultEmail", t("New adult email"), "", "email")}<label>${e(t("Relationship"))}<select name="relationship"><option value="father">${e(t("Father"))}</option><option value="mother">${e(t("Mother"))}</option><option value="guardian">${e(t("Guardian"))}</option></select></label><button name="action" value="add">${e(t("Add adult to setup"))}</button></fieldset>`;
    if (d.step >= 5) {
      const siblings = data.familyLinks.filter(l => l.familyId === d.familyId && l.relationship === "child" && l.status === "active").map(l => data.persons.find(p => p.id === l.personId)).filter(Boolean);
      content = `<div class="family-graph" role="img" aria-label="${e(t("Family relationships: {adults}; {family}; child {student} in {class}", { adults: adults.map(a => `${a.name}, ${rel(a.relationship)}`).join("; "), family: familyName, student: d.student, class: selectedClass?.displayName ?? "" }))}"><div class="graph-row">${adults.map(a => `<div class="graph-node">${e(a.name)}<small>${e(rel(a.relationship))}${a.existing ? ` · ${e(t("existing"))}` : ""}</small></div>`).join("")}</div><div class="graph-line">↓</div><div class="graph-node graph-family">${e(familyName)}<small>${e(d.familyId ? t("Existing family") : t("New family"))}</small></div><div class="graph-line">↓</div><div class="graph-row"><div class="graph-node">${e(d.student)}<small>${e(t("New student"))}</small></div>${siblings.map(p => `<div class="graph-node">${e(p!.displayName)}<small>${e(t("Existing child"))}</small></div>`).join("")}</div><div class="graph-line">${e(d.student)} → ${e(selectedClass?.displayName)}</div></div>`;
      if (d.step === 6) content += `<h2>${e(t("Ready to create"))}</h2><ul><li>${e(t("Student"))}: ${e(d.student)}</li><li>${e(t("Class"))}: ${e(selectedClass?.displayName)}</li><li>${e(t("Family"))}: ${e(familyName)} (${e(d.familyId ? t("existing") : t("new"))})</li>${d.adults.map(a => `<li>${e(rel(a.relationship))}: ${e(data.persons.find(p => p.id === a.id)?.displayName || a.name)} · ${e(data.persons.find(p => p.id === a.id)?.normalizedLoginEmail || a.email)} (${e(a.id ? t("existing account") : t("new account"))})</li>`).join("")}</ul><p>${e(t("All records and associations will be saved together. New adults can verify their email through normal sign-in. Existing adults gain the Parent role while keeping their other roles."))}</p>`;
    }
    return layout(t("Family setup"), `<style>.wizard-steps{display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none;margin:0 0 20px}.wizard-steps li{padding:7px 12px;border-radius:8px;background:#e6efe6;font-size:13px;color:#2b4d3b}.wizard-steps [aria-current]{background:#2e5844;color:white;font-weight:650}.wizard label{display:block;margin:14px 0;font-weight:600;font-size:14px}.wizard input,.wizard select{display:block;margin-top:6px;width:100%;max-width:520px}.wizard fieldset{margin-top:18px;padding:16px;border:1px solid #dfe5dd;border-radius:10px;background:#fbfcfa}.wizard fieldset label{margin:10px 0}.family-graph{text-align:center;padding:20px 0}.graph-row{display:flex;flex-wrap:wrap;justify-content:center;gap:16px}.graph-node{background:#f5f8f2;border:1px solid #cbd8c7;border-radius:12px;padding:15px;max-width:260px;overflow-wrap:anywhere}.graph-node small{display:block}.graph-family{margin:auto;background:#e4eee0}.graph-line{padding:12px;color:#3e604b}</style>${pageHead({ crumbs: [[t("Families"), "/admin/families"], [t("Family setup")]], eyebrow: t("Guided setup"), title: t("Family setup"), lede: e(t("Create a student, enroll them in a class, and connect parents and guardians in one flow. Nothing is saved until you confirm.")), actions: `<a class="btn ghost" href="/admin/families">${e(t("Cancel setup"))}</a>` })}<ol class="wizard-steps">${steps.map((s,i)=>`<li ${d.step===i+1?'aria-current="step"':''}>${i+1}. ${e(t(s))}${d.familyId && i === 3 ? ` (${e(t("existing members"))})` : ""}</li>`).join("")}</ol><section class="card wizard"><h2>${d.step}. ${e(t(steps[d.step-1]!))}</h2>${error?`<div class="notice error" role="alert">${e(error)}</div>`:""}<form method="post" action="/admin/families/wizard"><input type="hidden" name="draft" value="${e(sign(d))}">${content}<div class="actions" style="margin-top:18px">${d.step>1?`<button class="secondary" name="action" value="back" formnovalidate>${e(t("Back"))}</button>`:""}<button name="action" value="${d.step===6?'confirm':'next'}" formnovalidate>${e(d.step===6?t("Confirm creation"):t("Continue"))}</button></div></form></section>`, true, "families");
  }
  return { start, read, advance, create, view };
}
