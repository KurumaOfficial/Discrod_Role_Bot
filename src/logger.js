function write(level, message, metadata) {
  const timestamp = new Date().toISOString();

  if (metadata === undefined) {
    console.log(`[${timestamp}] [Kuruma] [${level}] ${message}`);
    return;
  }

  console.log(`[${timestamp}] [Kuruma] [${level}] ${message}`, metadata);
}

export const logger = {
  info(message, metadata) {
    write('INFO', message, metadata);
  },
  warn(message, metadata) {
    write('WARN', message, metadata);
  },
  error(message, metadata) {
    write('ERROR', message, metadata);
  },
};
