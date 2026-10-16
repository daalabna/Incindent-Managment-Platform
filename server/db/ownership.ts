const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

// One statement, so autocommit is one transaction. Tables move first: identity sequences follow them.
export const schemaOwnerSql = (schema: string, role: string) => {
  if (!identifier.test(schema) || !identifier.test(role))
    throw new Error("Unsafe SQL identifier");
  return `DO $$
DECLARE item record;
BEGIN
  EXECUTE format('ALTER SCHEMA %I OWNER TO %I', '${schema}', '${role}');
  FOR item IN
    SELECT c.relname AS name, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '${schema}' AND c.relkind IN ('r','p','v','m','f')
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO %I',
      CASE item.relkind
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE'
      END,
      '${schema}', item.name, '${role}');
  END LOOP;
  FOR item IN
    SELECT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '${schema}' AND c.relkind = 'S'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a','i')
      )
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', '${schema}', item.name, '${role}');
  END LOOP;
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', '${schema}');
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', '${schema}', '${role}');
  EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO %I', '${schema}', '${role}');
  EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO %I', '${schema}', '${role}');
END $$`;
};

export const applySchemaOwner = async (
  client: { query: (sql: string) => Promise<unknown> },
  schema: string,
  role: string,
) => {
  await client.query(schemaOwnerSql(schema, role));
};
