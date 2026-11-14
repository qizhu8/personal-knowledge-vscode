"use strict";
const fs = require("node:fs"), path = require("node:path"), { createHash } = require("node:crypto");
module.exports = cache => {
  const identity = file => {
    const stat = fs.lstatSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  };
  const snapshot = [[".", identity(cache)]];
  for (const name of fs.readdirSync(cache).sort()) {
    const file = path.join(cache, name); snapshot.push([name, identity(file)]);
    if (!fs.lstatSync(file).isDirectory()) continue;
    const metadata = path.join(file, "info/repodata_record.json");
    if (fs.existsSync(metadata)) snapshot.push([`${name}/info/repodata_record.json`, identity(metadata),
      createHash("sha256").update(fs.readFileSync(metadata)).digest("hex")]);
  }
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
};
