CREATE TABLE "admin_reset_token" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "admin_reset_token_token_hash_unique" UNIQUE("token_hash")
);
