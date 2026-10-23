const { getDb, DEFAULT_DB_PATH } = require('../src/db/database');

const db = getDb();
const migrations = db.prepare('SELECT * FROM schema_migrations').all();
console.log('Migrations applied to', DEFAULT_DB_PATH, ':', migrations);
