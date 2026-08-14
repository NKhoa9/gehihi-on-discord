import fs from "fs";

const LOG_FILE = "bot.log";

function isFileLoggingEnabled() {
  try {
    const cfg = JSON.parse(fs.readFileSync("config.json", "utf-8"));
    return cfg.logging !== false;
  } catch {
    return true;
  }
}

function isDebugLoggingEnabled() {
  try {
    const cfg = JSON.parse(fs.readFileSync("config.json", "utf-8"));
    return cfg.debug_logging === true;
  } catch {
    return false;
  }
}

export const logger = {
  debug: (...args) => {
    if (!isDebugLoggingEnabled()) return;
    const msg = `[${new Date().toISOString()}] [DEBUG] ${args.map(a => typeof a === 'object' && !(a instanceof Error) ? JSON.stringify(a) : a).join(" ")}`;
    console.log(msg);
    if (isFileLoggingEnabled()) fs.appendFileSync(LOG_FILE, msg + "\n");
  },
  log: (...args) => {
    const msg = `[${new Date().toISOString()}] [INFO] ${args.map(a => typeof a === 'object' && !(a instanceof Error) ? JSON.stringify(a) : a).join(" ")}`;
    console.log(msg);
    if (isFileLoggingEnabled()) fs.appendFileSync(LOG_FILE, msg + "\n");
  },
  warn: (...args) => {
    const msg = `[${new Date().toISOString()}] [WARN] ${args.map(a => typeof a === 'object' && !(a instanceof Error) ? JSON.stringify(a) : a).join(" ")}`;
    console.warn(msg);
    if (isFileLoggingEnabled()) fs.appendFileSync(LOG_FILE, msg + "\n");
  },
  error: (...args) => {
    const msg = `[${new Date().toISOString()}] [ERROR] ${args.map(a => typeof a === 'object' && !(a instanceof Error) ? JSON.stringify(a) : a).join(" ")}`;
    console.error(msg);
    if (isFileLoggingEnabled()) fs.appendFileSync(LOG_FILE, msg + "\n");
  }
};
