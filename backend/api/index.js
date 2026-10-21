'use strict';
/* Vercel function entry: every /api/* request is routed here (vercel.json). The MongoDB client is cached per instance. */
const { createApp } = require('../src/app');
module.exports = createApp();
