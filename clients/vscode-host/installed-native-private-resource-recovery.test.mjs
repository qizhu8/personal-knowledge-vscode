import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readlink } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { installedNativePrivateResourceRecoveryUiProgram } from "./installed-native-private-resource-recovery-ui.mjs";

assert(process.env.PKM_TEST_WORKSPACE);assert(process.env.PKM_LEGACY_VSIX,"Pinned oracle cannot be skipped.");
const python=execFileSync(process.env.PKM_TEST_PYTHON??"python3",["-I","-B","-c","import sys;print(sys.executable)"],{encoding:"utf8"}).trim();
test("actual namespace-mounted fixture and pinned original large-resource seed preserve controls while fake recovery/namespace handles remain closed",{timeout:90000},async()=>{
  const witness=Object.fromEntries(await Promise.all(["user","mnt","net","pid"].map(async name=>[name,await readlink(`/proc/self/ns/${name}`)])));
  const output=execFileSync("unshare",["--user","--map-root-user","--mount","--net","--pid","--fork","--mount-proc",
    process.execPath,resolve("clients/vscode-host/installed-native-private-resource-recovery-mount-probe.mjs"),JSON.stringify(witness),python],
  {encoding:"utf8",timeout:90000,maxBuffer:1048576,stdio:["ignore","pipe","pipe"]});
  const proof=JSON.parse(output.trim().split("\n").at(-1));assert.equal(proof.actualMountedBrandAndOriginalOracle,true);
  assert.equal(proof.privatePendingIntentProduced,false);assert.equal(proof.installedRecoveryQualified,false);
});
test("recovery observer syntax is valid without installed/private approval fabrication",()=>{
  execFileSync(python,["-I","-B","-c","import sys;compile(sys.stdin.read(),'<private-recovery-ui>','exec')"],
    {input:installedNativePrivateResourceRecoveryUiProgram,timeout:10000,stdio:["pipe","pipe","pipe"]});
});
