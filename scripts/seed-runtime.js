const { seedRuntimeDatabase } = require('../src/services/seed-service');

const result = seedRuntimeDatabase({ forceReseed: process.argv.includes('--force') });
console.log('Runtime seed result:', result);
