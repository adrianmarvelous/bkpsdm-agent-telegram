module.exports = {
  apps: [{
    name: 'pengaduan-listener',
    script: 'index.js',
    cwd: __dirname,
    interpreter: 'node',
    env: {
      NODE_ENV: 'production',
    },
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '200M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/pengaduan-error.log',
    out_file: 'logs/pengaduan-out.log',
    merge_logs: true,
    time: true,
  }],
};
