// PM2 設定：pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "geo-monitor",
      script: "server.js",
      cwd: __dirname,
      env: { NODE_ENV: "production", HOST: "127.0.0.1", PORT: 3100 },
      max_memory_restart: "400M",
    },
  ],
};
