function emit(level, message, meta) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [Kuruma] [${level}] ${message}`;

  if (meta !== undefined) {
    console.log(prefix, meta);
    return;
  }

  console.log(prefix);
}

export const logger = {
  info(message, meta) {
    emit('INFO', message, meta);
  },
  warn(message, meta) {
    emit('WARN', message, meta);
  },
  error(message, meta) {
    emit('ERROR', message, meta);
  }
};
