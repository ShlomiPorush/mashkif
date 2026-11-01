CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"install_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"enrollment_key_id" bigint NOT NULL,
	"label" text,
	"trust_tier" text DEFAULT 'normal' NOT NULL,
	"agent_version" text NOT NULL,
	"os_version" text,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"address" "inet",
	"site_key" text,
	"asn" integer,
	"as_organization" text,
	"reported_cell" text,
	"assigned_cell" text,
	"infrastructure" text DEFAULT 'unknown' NOT NULL,
	"interval_reported_seconds" integer,
	"interval_sent_seconds" integer,
	"silence_interval_seconds" integer,
	"last_boot_id" uuid,
	"last_sequence" bigint,
	"last_event_kind" text,
	"last_event_at" timestamp with time zone,
	"dropped_events" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_install_id_unique" UNIQUE("install_id"),
	CONSTRAINT "agent_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "agent_enrollment_key_id_unique" UNIQUE("enrollment_key_id"),
	CONSTRAINT "agent_trust_tier_known" CHECK ("agent"."trust_tier" in ('trusted', 'normal', 'suspicious', 'blocked')),
	CONSTRAINT "agent_infrastructure_known" CHECK ("agent"."infrastructure" in ('unknown', 'bezeq', 'hot', 'ibc', 'partner_fiber', 'cellcom_fiber', 'other'))
);
--> statement-breakpoint
CREATE TABLE "agent_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"boot_id" uuid NOT NULL,
	"sync_id" text,
	"elapsed_ms" bigint,
	"occurred_at" timestamp with time zone,
	"time_uncertain" boolean NOT NULL,
	"uncertain_reason" text,
	"agent_time" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_event_agent_event_id" UNIQUE("agent_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "blocked_range" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"range" "cidr" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "blocked_range_range_unique" UNIQUE("range")
);
--> statement-breakpoint
CREATE TABLE "enrollment_key" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "enrollment_key_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "heartbeat" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"sync_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"boot_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"address" "inet" NOT NULL,
	"site_key" text NOT NULL,
	"asn" integer,
	"as_organization" text,
	"area_cell" text,
	"infrastructure" text NOT NULL,
	"interval_reported_seconds" integer NOT NULL,
	"interval_sent_seconds" integer NOT NULL,
	"round_trip_ms" integer,
	"dns_ms" integer,
	"agent_version" text,
	CONSTRAINT "heartbeat_sync_id_unique" UNIQUE("sync_id"),
	CONSTRAINT "heartbeat_agent_boot_sequence" UNIQUE("agent_id","boot_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "provider" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "provider_asn" (
	"asn" integer PRIMARY KEY NOT NULL,
	"provider_id" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_enrollment_key_id_enrollment_key_id_fk" FOREIGN KEY ("enrollment_key_id") REFERENCES "public"."enrollment_key"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_event" ADD CONSTRAINT "agent_event_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat" ADD CONSTRAINT "heartbeat_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_asn" ADD CONSTRAINT "provider_asn_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_site_key_idx" ON "agent" USING btree ("site_key");--> statement-breakpoint
CREATE INDEX "agent_event_received_at_idx" ON "agent_event" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "agent_event_agent_occurred_at_idx" ON "agent_event" USING btree ("agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "heartbeat_received_at_idx" ON "heartbeat" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "heartbeat_agent_received_at_idx" ON "heartbeat" USING btree ("agent_id","received_at");--> statement-breakpoint
CREATE INDEX "provider_asn_provider_idx" ON "provider_asn" USING btree ("provider_id");