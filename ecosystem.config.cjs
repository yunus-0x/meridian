module.exports = {
  apps: [
    {
      name: "meridian",
      script: "index.js",
      cwd: "/root/meridian",
      env_file: "/root/meridian/.env",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "helius-webhook",
      script: "webhook-server.cjs",
      cwd: "/root/meridian",
      env_file: "/root/meridian/.env",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
