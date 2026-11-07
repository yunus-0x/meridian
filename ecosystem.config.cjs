const path = require("path");

const repoRoot = __dirname;

module.exports = {
  apps: [
    {
      name: "meridian",
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      interpreter: "node",
      node_args: "--import tsx",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      // Always start via this file (npm run pm2:start) so cwd + script path stay pinned to the repo.
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};