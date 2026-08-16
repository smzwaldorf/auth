import { z } from "zod";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const lifecycleStatus = z.enum(["active", "disabled"]);
const membershipStatus = z.enum(["active", "inactive"]);

const personSchema = z.object({
  id: uuid,
  kind: z.enum(["adult", "student"]),
  displayName: z.string().min(1),
  loginEmail: z.string().email().optional(),
  status: lifecycleStatus.default("active"),
  roles: z.array(z.enum(["admin", "teacher", "parent", "student"])).min(1),
  invitation: z
    .object({
      id: uuid,
      status: z.enum(["pending", "activated", "expired", "revoked"]).default("pending"),
      expiresAt: z.string().datetime().optional(),
    })
    .optional(),
});

const effectiveMembership = {
  id: uuid,
  personId: uuid,
  status: membershipStatus.default("active"),
  startsOn: isoDate.optional(),
  endsOn: isoDate.optional(),
};

const applicationSchema = z.object({
  clientId: z.string().min(1),
  displayName: z.string().min(1),
  clientType: z.enum(["public", "confidential"]),
  clientSecretEnv: z.string().min(1).optional(),
  publicOrigin: z.string().url().optional(),
  redirectUris: z.array(z.string().url()).min(1),
  postLogoutRedirectUris: z.array(z.string().url()).default([]),
  scopes: z.array(z.string().min(1)).min(1),
  enabled: z.boolean().default(true),
});

export const directorySeedSchema = z.object({
  version: z.literal(1),
  school: z.object({ code: z.string().min(1), displayName: z.string().min(1) }),
  people: z.array(personSchema),
  families: z.array(
    z.object({
      id: uuid,
      code: z.string().min(1),
      displayName: z.string().min(1),
      status: lifecycleStatus.default("active"),
      memberships: z.array(
        z.object({
          ...effectiveMembership,
          relationship: z.enum(["father", "mother", "guardian", "child"]),
        }),
      ),
    }),
  ),
  classes: z.array(
    z.object({
      id: uuid,
      code: z.string().min(1),
      displayName: z.string().min(1),
      status: lifecycleStatus.default("active"),
      memberships: z.array(
        z.object({
          ...effectiveMembership,
          relationship: z.enum(["teacher", "student"]),
        }),
      ),
    }),
  ),
  applications: z.array(applicationSchema),
  appAccess: z.array(
    z.object({
      personId: uuid,
      clientId: z.string().min(1),
      status: z.enum(["active", "revoked"]).default("active"),
    }),
  ),
});

export type DirectorySeed = z.infer<typeof directorySeedSchema>;

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(values.filter((value) => (seen.has(value) ? true : (seen.add(value), false))))];
}

export function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
}

export function validateDirectorySeed(input: unknown): DirectorySeed {
  const seed = directorySeedSchema.parse(input);
  const issues: string[] = [];
  const personById = new Map(seed.people.map((person) => [person.id, person]));
  const appIds = new Set(seed.applications.map((app) => app.clientId));

  for (const duplicate of duplicates(seed.people.map((person) => person.id))) issues.push(`duplicate person id: ${duplicate}`);
  for (const duplicate of duplicates(seed.people.flatMap((person) => person.loginEmail ? [normalizeEmail(person.loginEmail)] : []))) {
    issues.push(`duplicate normalized login email: ${duplicate}`);
  }
  for (const duplicate of duplicates(seed.families.map((family) => family.code))) issues.push(`duplicate family code: ${duplicate}`);
  for (const duplicate of duplicates(seed.classes.map((schoolClass) => schoolClass.code))) issues.push(`duplicate class code: ${duplicate}`);
  for (const duplicate of duplicates(seed.applications.map((app) => app.clientId))) issues.push(`duplicate application client id: ${duplicate}`);

  for (const person of seed.people) {
    if (person.kind === "adult" && (!person.loginEmail || !person.invitation)) {
      issues.push(`adult ${person.id} must have loginEmail and invitation`);
    }
    if (person.kind === "student" && (person.loginEmail || person.invitation)) {
      issues.push(`student ${person.id} cannot have login credentials or invitation`);
    }
    if (person.kind === "student" && !person.roles.includes("student")) issues.push(`student ${person.id} must have the student role`);
    if (person.kind === "adult" && person.roles.includes("student")) issues.push(`adult ${person.id} cannot have the student role`);
  }

  for (const family of seed.families) {
    for (const membership of family.memberships) {
      const person = personById.get(membership.personId);
      if (!person) {
        issues.push(`family ${family.code} references unknown person ${membership.personId}`);
        continue;
      }
      const child = membership.relationship === "child";
      if (child !== (person.kind === "student")) issues.push(`family ${family.code} has an invalid ${membership.relationship} relationship for ${person.id}`);
      if (membership.startsOn && membership.endsOn && membership.startsOn > membership.endsOn) issues.push(`family membership ${membership.id} ends before it starts`);
    }
  }

  for (const schoolClass of seed.classes) {
    for (const membership of schoolClass.memberships) {
      const person = personById.get(membership.personId);
      if (!person) {
        issues.push(`class ${schoolClass.code} references unknown person ${membership.personId}`);
        continue;
      }
      const student = membership.relationship === "student";
      if (student !== (person.kind === "student")) issues.push(`class ${schoolClass.code} has an invalid ${membership.relationship} relationship for ${person.id}`);
      if (membership.startsOn && membership.endsOn && membership.startsOn > membership.endsOn) issues.push(`class membership ${membership.id} ends before it starts`);
    }
  }

  for (const app of seed.applications) {
    if (app.clientType === "public" && app.clientSecretEnv) issues.push(`public client ${app.clientId} cannot have a client secret`);
    if (app.clientType === "confidential" && !app.clientSecretEnv) issues.push(`confidential client ${app.clientId} requires clientSecretEnv`);
    if (app.clientType === "public" && !app.publicOrigin) issues.push(`public client ${app.clientId} requires publicOrigin`);
  }

  for (const access of seed.appAccess) {
    const person = personById.get(access.personId);
    if (!person) issues.push(`app access references unknown person ${access.personId}`);
    else if (person.kind !== "adult") issues.push(`student ${person.id} cannot receive application access`);
    if (!appIds.has(access.clientId)) issues.push(`app access references unknown client ${access.clientId}`);
  }
  for (const duplicate of duplicates(seed.appAccess.map((access) => `${access.personId}:${access.clientId}`))) {
    issues.push(`duplicate app access: ${duplicate}`);
  }

  if (issues.length) throw new Error(`Invalid directory seed:\n- ${issues.join("\n- ")}`);
  return seed;
}

export function seedSummary(seed: DirectorySeed) {
  return {
    school: seed.school.code,
    people: seed.people.length,
    adults: seed.people.filter((person) => person.kind === "adult").length,
    students: seed.people.filter((person) => person.kind === "student").length,
    families: seed.families.length,
    classes: seed.classes.length,
    applications: seed.applications.length,
    appAccess: seed.appAccess.length,
  };
}
