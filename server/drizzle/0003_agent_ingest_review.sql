CREATE TABLE "agent_dropped_events" (
	"agent_id" uuid NOT NULL,
	"boot_id" uuid NOT NULL,
	"count" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_dropped_events_agent_id_boot_id_pk" PRIMARY KEY("agent_id","boot_id")
);
--> statement-breakpoint
CREATE TABLE "sync_anchor" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"boot_id" uuid NOT NULL,
	"server_time" timestamp with time zone NOT NULL,
	CONSTRAINT "sync_anchor_sync_id_unique" UNIQUE("sync_id")
);
--> statement-breakpoint
ALTER TABLE "heartbeat" DROP CONSTRAINT "heartbeat_sync_id_unique";--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "asn" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "heartbeat" ALTER COLUMN "asn" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "provider_asn" ALTER COLUMN "asn" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "agent_dropped_events" ADD CONSTRAINT "agent_dropped_events_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_anchor" ADD CONSTRAINT "sync_anchor_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_anchor_agent_boot_idx" ON "sync_anchor" USING btree ("agent_id","boot_id","id");--> statement-breakpoint
CREATE INDEX "sync_anchor_server_time_idx" ON "sync_anchor" USING btree ("server_time");--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "dropped_events";--> statement-breakpoint
ALTER TABLE "agent_event" DROP COLUMN "agent_time";--> statement-breakpoint
-- Existing sync IDs become anchors, so events that refer to them still find their time.
INSERT INTO "sync_anchor" ("sync_id", "agent_id", "boot_id", "server_time") SELECT "sync_id", "agent_id", "boot_id", "received_at" FROM "heartbeat" ORDER BY "id";--> statement-breakpoint
ALTER TABLE "heartbeat" DROP COLUMN "sync_id";