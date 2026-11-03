ALTER TABLE "agent" DROP CONSTRAINT "agent_enrollment_key_id_enrollment_key_id_fk";--> statement-breakpoint
ALTER TABLE "agent" DROP CONSTRAINT "agent_enrollment_key_id_unique";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "enrollment_key_id";--> statement-breakpoint
DROP TABLE "enrollment_key";
