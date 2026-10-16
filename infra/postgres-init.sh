#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=a_pass="$TENANT_A_DB_PASSWORD" --set=b_pass="$TENANT_B_DB_PASSWORD" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE ROLE tenant_a LOGIN PASSWORD :'a_pass';
CREATE ROLE tenant_b LOGIN PASSWORD :'b_pass';
CREATE SCHEMA tenant_alpha AUTHORIZATION tenant_a;
CREATE SCHEMA tenant_beta AUTHORIZATION tenant_b;
REVOKE ALL ON SCHEMA tenant_alpha FROM PUBLIC;
REVOKE ALL ON SCHEMA tenant_beta FROM PUBLIC;
SQL
