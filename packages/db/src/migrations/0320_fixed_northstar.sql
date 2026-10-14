ALTER TABLE "agents" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
-- specs/002-agent-governance: record the creator of agents created before this column existed.
UPDATE "agents" AS a SET "created_by_user_id" = creator."actor_id"
FROM (
  SELECT DISTINCT ON ("entity_id") "entity_id", "actor_id"
  FROM "activity_log"
  WHERE "entity_type" = 'agent'
    AND "action" IN ('agent.created', 'agent.hire_created')
    AND "actor_type" = 'user'
  ORDER BY "entity_id", "created_at"
) AS creator
WHERE creator."entity_id" = a."id"::text
  AND a."created_by_user_id" IS NULL;
