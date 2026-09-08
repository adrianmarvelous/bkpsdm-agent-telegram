module.exports = {
  apps: [
    {
      name: 'organisasi-iko-monitor',
      script: 'monitor.js',
      cwd: __dirname,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '150M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/organisasi-monitor-error.log',
      out_file: 'logs/organisasi-monitor-out.log',
      merge_logs: true,
    },
  ],
};
