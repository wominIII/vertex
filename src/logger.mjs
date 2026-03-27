export function createLogger(logLevel = "debug") {
  const order = { error: 0, info: 1, debug: 2 };
  const current = order[logLevel] ?? order.debug;

  function log(level, message, details) {
    const target = order[level] ?? order.debug;
    if (target > current) return;

    const timestamp = new Date().toISOString();
    if (details === undefined) {
      console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
      return;
    }

    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`, details);
  }

  return {
    error: (message, details) => log("error", message, details),
    info: (message, details) => log("info", message, details),
    debug: (message, details) => log("debug", message, details),
  };
}
