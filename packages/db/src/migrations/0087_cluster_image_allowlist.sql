ALTER TABLE "cluster_connections" ADD COLUMN "image_allowlist" text[] DEFAULT ARRAY[]::text[] NOT NULL;
