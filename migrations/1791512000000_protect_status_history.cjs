/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER FUNCTION record_transaction_status()
      SECURITY DEFINER
      SET search_path = pg_catalog, public;
  `);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER FUNCTION record_transaction_status()
      SECURITY INVOKER
      RESET search_path;
  `);
};
