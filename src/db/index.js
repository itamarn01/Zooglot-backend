const config = require('../config');

module.exports = config.mockDb ? require('./mock') : require('./supabase');
