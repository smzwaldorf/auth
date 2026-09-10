UPDATE "auth"."oauth_resource"
SET "allowed_scopes" = ARRAY['openid', 'profile', 'email', 'directory:access', 'offline_access']::text[],
    "updated_at" = now()
WHERE "identifier" = 'http://localhost:3000/api/directory/v1';
