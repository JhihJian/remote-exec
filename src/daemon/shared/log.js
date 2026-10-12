"use strict";

function log(event, extra = "") {
  process.stderr.write(`[${new Date().toISOString()}] ${event}${extra ? " " + extra : ""}\n`);
}

module.exports = { log };
