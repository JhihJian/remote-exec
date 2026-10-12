"use strict";

function rpcError(code, message) {
  const err = new Error(message);
  err.rpcCode = code;
  return err;
}

module.exports = { rpcError };
