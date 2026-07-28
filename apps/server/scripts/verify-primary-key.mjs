export const PRIMARY_KEY_METADATA_QUERY = `
  SELECT
    constraint_record.oid::text AS "constraintId",
    constraint_record.conname AS "constraintName",
    json_agg(
      attribute.attname
      ORDER BY key_column.ordinality
    ) AS "columns"
  FROM pg_constraint constraint_record
  JOIN LATERAL unnest(constraint_record.conkey)
    WITH ORDINALITY AS key_column(attnum, ordinality)
    ON true
  LEFT JOIN pg_attribute attribute
    ON attribute.attrelid = constraint_record.conrelid
    AND attribute.attnum = key_column.attnum
  WHERE constraint_record.conrelid = 'public.infrastructure_smoke_probe'::regclass
    AND constraint_record.contype = 'p'
  GROUP BY constraint_record.oid, constraint_record.conname
  ORDER BY constraint_record.oid
`;

const EXPECTED_METADATA_KEYS = new Set([
  'constraintId',
  'constraintName',
  'columns',
]);

export function isExpectedSmokePrimaryKey(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    return false;
  }

  const row = rows[0];
  if (!isExactRecord(row, EXPECTED_METADATA_KEYS)) {
    return false;
  }

  return (
    typeof row.constraintId === 'string' &&
    row.constraintId.length > 0 &&
    typeof row.constraintName === 'string' &&
    row.constraintName.length > 0 &&
    Array.isArray(row.columns) &&
    row.columns.length === 1 &&
    row.columns[0] === 'probe_key'
  );
}

function isExactRecord(value, expectedKeys) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.size &&
    keys.every((key) => expectedKeys.has(key))
  );
}
