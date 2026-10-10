#!/usr/bin/env node
"use strict";

// 保留历史 daemon 入口，实际实现位于 src/daemon/。
require("./src/daemon/main.js").main();