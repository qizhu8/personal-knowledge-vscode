"use strict";
const net = require("node:net");
const [host, port] = process.argv[2].split(":");
if (host !== "127.0.0.1" || !Number.isInteger(Number(port))) throw new Error("Expected loopback fixture endpoint");
const socket = net.connect(Number(port), host);
socket.on("error", error => { console.error(error); process.exitCode = 1; process.stdin.destroy(); });
process.stdin.pipe(socket);
socket.pipe(process.stdout);
