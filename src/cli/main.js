#!/usr/bin/env node
"use strict";

if (process.argv[2] === "deploy") {
  require("../deploy/cli.js").main(process.argv.slice(3));
} else {
  require("../tui/app.js");
}
