module.exports = {
  apps: [
    {
      name: 'bkpsdm-telegram',
      script: 'index.js',
      cwd: __dirname,
      interpreter: 'node',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '200M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/telegram-error.log',
      out_file: 'logs/telegram-out.log',
      merge_logs: true,
    },
    {
      name: 'bkpsdm-whatsapp',
      script: 'index-wa.js',
      cwd: __dirname,
      interpreter: 'node',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '200M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/whatsapp-error.log',
      out_file: 'logs/whatsapp-out.log',
      merge_logs: true,
    },
  ],
};
