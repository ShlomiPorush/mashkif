ALTER TABLE "agent" DROP CONSTRAINT "agent_trust_tier_known";--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "active_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "last_active_day" date;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "event_window_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "event_window_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_trust_tier_known" CHECK ("agent"."trust_tier" in ('trusted', 'normal', 'low', 'suspicious', 'blocked'));