// PM2 ecosystem — CaveMemeDesk (paper desk, single instance ONLY: SQLite + one desk)
// Usage: pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: "cavememedesk",
      script: "node_modules/.bin/tsx",
      args: "src/index.ts --headless",
      cwd: __dirname,
      instances: 1, // never cluster — one desk, one SQLite writer
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      min_uptime: "30s",
      kill_timeout: 10000, // graceful SIGTERM → shutdown recap + telegram flush
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
        // Set your timezone for the 08:00 auto-recap (defaults to VPS local/UTC):
        // TZ: "Africa/Lagos",
      },
      out_file: "data/pm2-out.log",
      error_file: "data/pm2-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
