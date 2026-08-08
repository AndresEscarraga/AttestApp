// routes/index.js — Registers all route modules with shared dependencies
const registerAuth = require('./auth');
const registerReview = require('./review');
const registerCompliance = require('./compliance');
const registerAdmin = require('./admin');
const registerDashboard = require('./dashboard');

module.exports = function registerAllRoutes(deps) {
  registerAuth(deps);
  registerReview(deps);
  registerCompliance(deps);
  registerAdmin(deps);
  registerDashboard(deps);
};
