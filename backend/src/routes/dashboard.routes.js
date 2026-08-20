const express = require("express");
const router = express.Router();
const { protect } = require("../middlewares/auth.middleware");
const requirePasswordChange = require("../middlewares/password-change.middleware");
const dashboardCtrl = require("../controllers/dashboard.controller");

router.use(protect);
// Must follow protect: it reads req.user, which protect populates.
router.use(requirePasswordChange);

// Read-only and open to every authenticated role, matching the panels it
// replaces. Note this means a cashier sees whole-day store revenue, which was
// already true of daily-summary and is an open question in docs/07 section 3.
router.get("/stats", dashboardCtrl.getStats);

module.exports = router;
