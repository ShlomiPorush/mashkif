DROP TABLE "admin_reset_token" CASCADE;--> statement-breakpoint
DROP TABLE "admin_setup_token" CASCADE;--> statement-breakpoint
ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_assurance_known";--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "assurance";--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "authenticated_at";--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "last_active_at";